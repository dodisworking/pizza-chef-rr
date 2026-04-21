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

TRANSLATION RULES:
1. If the client shows MONTHLY rent, compute annualRent = monthly × 12.
2. If the client shows ANNUAL rent, compute monthlyRent = annual ÷ 12.
3. If the client shows rent on a PSF basis, compute the totals using sqft.
4. Suite field: strip prefixes like "179-28-CU", "Ste ", "Unit ", leading zeros. Return just the bare suite identifier the way Argus would write it ("02" stays "02"; "179-28-CU" → "28"; "A-100" → "A100").
5. If the client file breaks each tenant into MULTIPLE rows (one for base rent, one per charge like CAM/tax/insurance/management), CONSOLIDATE them back into ONE tenant record. The base rent row is the one used for annualRent/monthlyRent. Other charges go into an "otherCharges" sub-object, do NOT add them to base rent.
6. If the same tenant appears with multiple lease periods (e.g. current period + renewal option), emit them as SEPARATE tenant entries but mark isOption:true on the later ones.
7. Dates must be "M/D/YYYY" (no zero-padding required) or "Mon-YYYY" for escalations.
8. If a field is unknown, use null — do NOT invent values.
9. Ignore rows that are subtotals, headers, vacant placeholder "zz Vacant" summary rows, or non-tenant rows.

Return ONLY valid JSON with this shape, no markdown, no prose:
{
  "property": "string or null",
  "tenants": [ ...tenant records... ]
}`

function stripFences(t) {
  return String(t || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
}

export async function normalizeClient({ parsed, filename, model = 'claude-sonnet-4-6' }) {
  const fullText = parsed?.text || ''
  if (!fullText || fullText.startsWith('[SCANNED PDF')) return []

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
