// Translate a Client rent roll (arbitrary format) into the same canonical
// shape as the Argus parser. We hand Claude the raw extracted text/rows and
// ask it to emit JSON in the Argus schema, with instructions covering the
// transformations we've seen in real samples:
//   - monthly ↔ annual rent
//   - PSF ↔ totals
//   - suite prefix rewriting (179-28-CU → 28)
//   - multi-row charge explosions (CAM + tax + insurance rows)
//   - split-period tenants
//
// Output is the same canonical Tenant[] the Argus parser produces.

import Anthropic from '@anthropic-ai/sdk'
import { normalizeSuite } from './argus-parser.js'

const client = new Anthropic()

const SYSTEM = `You are a senior commercial real estate paralegal translating a CLIENT accounting rent roll into the canonical ARGUS underwriting schema for side-by-side comparison.

The Argus schema for each tenant is:
{
  "name": "Bagel Toasterie",
  "suite": "02",
  "sqft": 3320,
  "leaseStart": "10/5/2021",
  "leaseEnd":   "10/31/2031",
  "leaseType": "Retail - NNN" or null,
  "annualRent":  98637,
  "monthlyRent": 8220,
  "psfAnnual":   29.71,
  "psfMonthly":  2.48,
  "rentSteps": [
    { "effectiveDate": "Nov-2026", "psfAnnual": 30.60, "psfMonthly": 2.55, "monthlyRent": 8466 }
  ],
  "isVacant": false,
  "isOption": false
}

CLIENT RENT ROLL FORMATS YOU WILL ENCOUNTER:

**Format A — single-row per tenant (tab-separated columns):**
Tenant Name | Suite | SF | Lease Start | Lease End | Rent PSF | Annual Rent
→ trivial — one tenant per row.

**Format B — monthly-rent + itemized charges (multi-row per tenant):**
The base rent row is followed by rows for "MONTHLY CAM", "REAL ESTATE TAX", "ESTIMATED INSURANCE", "MONTHLY MANAGEMENT", etc. Consolidate back to ONE tenant. Only the base rent row feeds annualRent/monthlyRent.

**Format C — suite-on-its-own-line with stacked fields (common in legacy accounting systems):**
Looks like:
\`\`\`
003
MAE JA HAN,              <-- tenant name line
#12345,                  <-- account number line (ignore)
 800                     <-- square footage line
5/1/1992 34,400 4/30/2027 43.00    <-- lease start, annual rent, lease end, $/SF
5/1/2026 35,432   44.29            <-- rent step
MONTHLY CAM YE 0  4,377            <-- line-item charge (ignore)
CONTAINER CHARGE 0  960            <-- line-item charge (ignore)
\`\`\`
For each such block: suite = "003" (the standalone number), name = "MAE JA HAN" (first text line), sqft = 800, leaseStart = 5/1/1992, annualRent = 34400, leaseEnd = 4/30/2027, psfAnnual = 43.00. Skip the account-number line (starts with #), skip the CAM/tax/insurance/management rows.

TRANSLATION RULES:
1. If the client shows MONTHLY rent, compute annualRent = monthly × 12.
2. If the client shows ANNUAL rent, compute monthlyRent = annual ÷ 12.
3. If the client shows rent on a PSF basis, compute totals using sqft.
4. Suite field: strip prefixes like "179-28-CU", "Ste ", "Unit ", leading zeros. Return just the bare suite identifier ("02" stays "02"; "179-28-CU" → "28"; "A-100" → "A100").
5. Consolidate multi-row tenants (Format B/C) into ONE record per tenant. Use the base rent row for annualRent/monthlyRent. Do NOT add CAM/tax/insurance/management to base rent.
6. If the same tenant has multiple lease periods (current + renewal option), emit separate entries with isOption:true on later ones.
7. Dates must be "M/D/YYYY" (no zero-padding required) or "Mon-YYYY" for escalations.
8. If a field is unknown, use null — do NOT invent values.
9. Skip subtotal rows, header rows, "zz Vacant" summary rollup rows, and account-number-only lines.

CRITICAL: If the input has ANY tenant-looking blocks, you MUST return them. NEVER return an empty tenants array unless the text is truly empty or contains no rent data. If the format is unusual, identify what you can (suite + name at minimum) and return those rather than nothing.

Return ONLY valid JSON with this shape, no markdown, no prose:
{
  "property": "string or null",
  "tenants": [ ...tenant records... ]
}`

function stripFences(t) {
  return String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
}

export async function normalizeClient({ parsed, filename, model = 'claude-sonnet-4-6' }) {
  const rawText = parsed?.text || ''
  if (!rawText || rawText.startsWith('[SCANNED PDF')) return []

  // Preprocess: strip line-item noise rows (CAM, tax, insurance, sprinkler, container, late charge,
  // management fees, page headers, etc.). These rows are never tenants and confuse Claude when
  // stacked densely. Savings: ~30-50% tokens on dense Mayfair-style PDFs.
  const fullText = preprocessClientText(rawText)

  // For very long client files, process in chunks by splitting on blank-line-separated tenant blocks,
  // then merging results. Keeps Claude focused and avoids truncation.
  const CHUNK = 80000
  const chunks = fullText.length > CHUNK ? splitOnTenantBoundaries(fullText, CHUNK) : [fullText]

  const all = []
  let property = null
  for (let i = 0; i < chunks.length; i++) {
    const partLabel = chunks.length > 1 ? ` [part ${i + 1}/${chunks.length}]` : ''
    const prompt = `Translate this CLIENT rent roll into the Argus canonical schema. File: ${filename || '(unknown)'}${partLabel}.
Format: ${parsed?.type || 'unknown'}.

IMPORTANT: if you see tenants that are split across multiple rows (one row per CAM / tax / insurance / management / rent step), consolidate each tenant into ONE record. Use the BASE RENT row (not the CAM/tax/ins rows) for annualRent/monthlyRent. Dense line-item files are common and must not produce empty output — always return at least the tenants you can identify.

===== RAW CLIENT RENT ROLL${partLabel} =====
${chunks[i]}

Return the JSON now.`

    let raw
    try {
      const resp = await client.messages.create({
        model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      })
      raw = resp.content[0]?.text || '{}'
    } catch (e) {
      throw new Error(`Client normalization failed: ${e.message}`)
    }

    const json = parseJsonSafely(stripFences(raw))
    if (!property && json?.property) property = json.property
    const tenants = Array.isArray(json?.tenants) ? json.tenants : []
    for (const t of tenants) all.push(t)
  }

  return all.map(cleanTenant).filter(t => t.name || t.suite)
}

// Line patterns that are NEVER tenants and can be safely stripped.
// Keep this conservative — better to leave a questionable line in than delete a real tenant.
const NOISE_PATTERNS = [
  /^\s*MONTHLY\s+CAM\b/i,
  /^\s*MONTHLY\s+RE\s*TAX\b/i,
  /^\s*SEMI\s*ANNUAL\s+(TAX|RE\s*TAX)/i,
  /^\s*ESTIMATED?\s+(CAM|TAX|INSURANCE|MANAGEMENT|MGMT)/i,
  /^\s*EST\s+(CAM|TAX|INS|MGMT|MANAGEMENT)/i,
  /^\s*ANNUAL\s+(CAM|RE\s*TAX|TAX|MGMT)/i,
  /^\s*QUARTERLY\s+(CAM|TAX|MGMT)/i,
  /^\s*LATE\s+CHARGE\b/i,
  /^\s*SPRINKLER\b/i,
  /^\s*CONTAINER\s+CHARGE/i,
  /^\s*CONTAINER\s+\#/i,
  /^\s*SUFF\s+CNTY\s+WTR/i,
  /^\s*SCWA\b/i,
  /^\s*SIGN\s+(CHARGE|FEE|RENT)/i,
  /^\s*UTILITY\s+(CHARGE|FEE|RECOVERY)/i,
  /^\s*WATER\s+\#/i,
  /^\s*GAS\s+\#/i,
  /^\s*PERCENTAGE\s+RENT/i,
  /^\s*% RENT\b/i,
  /^\s*Page\s+\d+\s+of\s+\d+/i,
  /^\s*Report\s+(Generated|Date):/i,
  /^\s*Run\s+(Date|Time):/i,
  /^\s*As\s+of\s+\d/i,
]

export function preprocessClientText(text) {
  const lines = text.split('\n')
  const kept = []
  let lastWasBlank = false
  for (const ln of lines) {
    if (NOISE_PATTERNS.some(re => re.test(ln))) continue
    const isBlank = !ln.trim()
    if (isBlank && lastWasBlank) continue  // collapse consecutive blanks
    kept.push(ln)
    lastWasBlank = isBlank
  }
  return kept.join('\n')
}

function splitOnTenantBoundaries(text, size) {
  const out = []
  let i = 0
  while (i < text.length) {
    const end = Math.min(i + size, text.length)
    if (end === text.length) { out.push(text.slice(i)); break }
    // Back off to the nearest blank-line boundary so a tenant block isn't split mid-row
    let split = text.lastIndexOf('\n\n', end)
    if (split < i + size * 0.5) split = end   // give up if no good boundary
    out.push(text.slice(i, split))
    i = split
  }
  return out
}

function parseJsonSafely(s) {
  try { return JSON.parse(s) } catch {}
  const m = s.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  return null
}

function cleanTenant(t) {
  const suite = t.suite ? String(t.suite).trim() : null
  return {
    name: t.name ? String(t.name).trim() : null,
    suite,
    suiteNormalized: normalizeSuite(suite),
    sqft: toNum(t.sqft),
    leaseStart: t.leaseStart || null,
    leaseEnd: t.leaseEnd || null,
    leaseType: t.leaseType || null,
    leaseTerm: null,
    tenure: null,
    leaseStatus: null,
    buildingShare: null,
    annualRent: toNum(t.annualRent),
    monthlyRent: toNum(t.monthlyRent),
    psfAnnual: toNum(t.psfAnnual),
    psfMonthly: toNum(t.psfMonthly),
    rentSteps: Array.isArray(t.rentSteps) ? t.rentSteps.map(s => ({
      effectiveDate: s.effectiveDate || null,
      psfAnnual: toNum(s.psfAnnual),
      psfMonthly: toNum(s.psfMonthly),
      monthlyRent: toNum(s.monthlyRent),
    })) : [],
    otherCharges: t.otherCharges || null,
    isVacant: !!t.isVacant,
    isOption: !!t.isOption,
  }
}

function toNum(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''))
  return isFinite(n) ? n : null
}
