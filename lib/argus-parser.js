// Deterministic Argus Lease Summary Report parser.
//
// Layout (consistent across all Argus exports we've seen):
//   Rows 1–4 : title, property name, "As of …", scope
//   Row  5   : blank
//   Rows 6–11: multi-row group headers ("General Tenant Information",
//              "Rent Details", …) + column sub-headers
//   Row 12   : blank separator
//   Row 13+  : data — each tenant = 5–6 rows (more if rent steps continue)
//
// Tenant block structure (col indexes are 1-based, 0-based in arrays below):
//   Col 0 (Tenant ID col):
//     row0: "N. Tenant Name" or "N. Tenant Name (Option 1)"
//     row1: "Suite: 02"
//     row2: "10/5/2021 - 10/31/2031"
//     row3: "10 Years 27 Days"
//     row4: "Freehold" (tenure)
//   Col 1: Initial Area SF / Building Share %
//   Col 2: Base/Contract/Speculative  /  Contract  /  Lease Type  /  Tenure
//   Col 3: Rate/Yr  / Amount/Yr  / Rate/Mo  / Amount/Mo  / Rental Value/Yr
//   Cols 4–6: rent escalations (one per row, "Date | $/SF-Annual | $/SF-Monthly")
//
// Retail files add a "% Rent" column group; it shifts some indexes. We locate
// the "Amount Per Year" / "Rate Per Month" / "Amount Per Month" columns by
// scanning the header rows instead of hard-coding positions.

import { parseExcel, parsePdf } from './rr-parser.js'

export async function parseArgus({ buffer, filename, parsed }) {
  const lower = (filename || '').toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const { sheets } = parsed?.sheets ? parsed : await parseExcel(buffer)
    const ws = pickArgusSheet(sheets)
    if (!ws) return []
    return parseArgusRows(ws.rows)
  }
  // PDF path — we fall back to a text-only best-effort reconstruction.
  const text = parsed?.text || (await parsePdf(buffer)).text
  return parseArgusPdfText(text)
}

function pickArgusSheet(sheets) {
  if (!sheets?.length) return null
  // Prefer the sheet that contains the Argus header signature.
  for (const s of sheets) {
    const first20 = s.rows.slice(0, 20).flat().join(' ')
    if (/Rental Value Per Year|Lease Summary Report|Building Share/i.test(first20)) return s
  }
  return sheets[0]
}

/**
 * Map Argus header rows → column indexes we care about.
 * Header rows are 6..11 (0-based: 5..10).
 */
function findArgusColumns(rows) {
  const hdrRows = rows.slice(5, 11).map(r => r.map(c => String(c ?? '').trim()))
  const colCount = Math.max(...hdrRows.map(r => r.length))

  const cols = { tenantId: 0, sf: 1, status: 2, rent: 3, escDate: -1, escAnnual: -1, escMonthly: -1 }

  for (let c = 0; c < colCount; c++) {
    const stack = hdrRows.map(r => (r[c] || '').toLowerCase()).join(' | ')
    if (/rate per year|amount per year|rate per month|amount per month|rental value per year/i.test(stack)) cols.rent = c
    if (/initial area|building share/i.test(stack)) cols.sf = c
    if (/lease status|market leasing|lease type/i.test(stack)) cols.status = c
    if (/^date\b|changes on/i.test(stack) && cols.escDate < 0) cols.escDate = c
    if (/changes to.*\$\/sf-annual|\$\/sf-annual/i.test(stack)) cols.escAnnual = c
    if (/changes to.*\$\/sf-monthly|\$\/sf-monthly/i.test(stack)) cols.escMonthly = c
  }
  return cols
}

export function parseArgusRows(rows) {
  if (!rows?.length) return []
  const cols = findArgusColumns(rows)
  const tenants = []

  // Data starts at row 13 (0-based 12). Walk forward collecting blocks that
  // begin with "N. Tenant Name".
  let i = 12
  while (i < rows.length) {
    const row = rows[i] || []
    const first = String(row[cols.tenantId] ?? '').trim()
    if (!/^\d+\.\s+/.test(first)) { i++; continue }

    // Collect rows until the next tenant header or a blank separator (blank col0 for 2+ rows).
    let end = i + 1
    while (end < rows.length) {
      const r = rows[end] || []
      const f = String(r[cols.tenantId] ?? '').trim()
      if (/^\d+\.\s+/.test(f)) break
      end++
      // Heuristic stop: if we've gone >10 rows past start, bail.
      if (end - i > 12) break
    }
    const block = rows.slice(i, end)
    const tenant = parseTenantBlock(block, cols)
    if (tenant) tenants.push(tenant)
    i = end
  }
  return tenants
}

function parseTenantBlock(block, cols) {
  if (!block?.length) return null
  const nameRow = block[0] || []
  const suiteRow = block[1] || []
  const datesRow = block[2] || []
  const termRow = block[3] || []
  const tenureRow = block[4] || []

  const name = cleanTenantName(String(nameRow[cols.tenantId] ?? '').trim())
  const suite = parseSuite(String(suiteRow[cols.tenantId] ?? ''))
  const { leaseStart, leaseEnd } = parseDateRange(String(datesRow[cols.tenantId] ?? ''))
  const leaseTerm = String(termRow[cols.tenantId] ?? '').trim() || null
  const tenure = String(tenureRow[cols.tenantId] ?? '').trim() || null

  const sqft = toNumber(nameRow[cols.sf])
  const buildingShare = toNumber(suiteRow[cols.sf])

  const leaseStatus = String(nameRow[cols.status] ?? '').trim() || null
  const leaseType = String(datesRow[cols.status] ?? '').trim() || null

  // Rent column: 4 values stacked vertically
  const ratePerYear   = toNumber(nameRow[cols.rent])
  const amountPerYear = toNumber(suiteRow[cols.rent])
  const ratePerMonth  = toNumber(datesRow[cols.rent])
  const amountPerMonth= toNumber(termRow[cols.rent])

  const annualRent  = amountPerYear ?? (sqft && ratePerYear ? sqft * ratePerYear : null)
  const monthlyRent = amountPerMonth ?? (annualRent ? annualRent / 12 : null)
  const psfAnnual   = ratePerYear ?? (sqft && annualRent ? annualRent / sqft : null)
  const psfMonthly  = ratePerMonth ?? (psfAnnual ? psfAnnual / 12 : null)

  // Rent steps: walk all rows, look for a date-looking value in cols.escDate
  const rentSteps = []
  if (cols.escDate >= 0) {
    for (const r of block) {
      const d = String(r[cols.escDate] ?? '').trim()
      if (!d || !/[a-zA-Z0-9]/.test(d)) continue
      if (!/\d{4}|\d{1,2}\/\d{1,2}/.test(d)) continue
      const annual  = toNumber(r[cols.escAnnual])
      const monthly = toNumber(r[cols.escMonthly])
      rentSteps.push({
        effectiveDate: d,
        psfAnnual: annual,
        psfMonthly: monthly,
        monthlyRent: sqft && monthly ? sqft * monthly : (sqft && annual ? (sqft * annual) / 12 : null),
      })
    }
  }

  const isVacant = /^zz\s*vacant/i.test(name)
  const isOption = /\(option\s*\d+\)/i.test(name)

  return {
    name,
    suite,
    suiteNormalized: normalizeSuite(suite),
    sqft,
    buildingShare,
    leaseStart, leaseEnd, leaseTerm, tenure,
    leaseStatus, leaseType,
    annualRent, monthlyRent, psfAnnual, psfMonthly,
    rentSteps,
    isVacant, isOption,
  }
}

function cleanTenantName(s) {
  return s.replace(/^\d+\.\s*/, '').trim()
}

function parseSuite(s) {
  const m = String(s).match(/Suite:\s*(.+?)\s*$/i)
  return m ? m[1].trim() : String(s).trim() || null
}

export function normalizeSuite(s) {
  if (!s) return null
  return String(s).toLowerCase().replace(/^(suite|ste|unit)[\s#:]*/, '').replace(/^0+/, '').replace(/[^a-z0-9]/g, '').trim() || null
}

function parseDateRange(s) {
  const m = String(s).match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/)
  if (!m) return { leaseStart: null, leaseEnd: null }
  return { leaseStart: m[1], leaseEnd: m[2] }
}

function toNumber(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const cleaned = String(v).replace(/[$,\s]/g, '').replace(/%$/, '')
  const n = parseFloat(cleaned)
  return isFinite(n) ? n : null
}

// PDF fallback — scans the text for tenant blocks. Lower quality than XLSX.
function parseArgusPdfText(text) {
  if (!text) return []
  const tenants = []
  const blocks = text.split(/\n(?=\d+\.\s+[A-Z])/g)
  for (const blk of blocks) {
    const headerMatch = blk.match(/^(\d+)\.\s+(.+?)\s*$/m)
    if (!headerMatch) continue
    const name = cleanTenantName(headerMatch[0])
    const suiteMatch = blk.match(/Suite:\s*([A-Za-z0-9\-\/]+)/i)
    const dateMatch  = blk.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/)
    const sfMatch    = blk.match(/\b(\d{3,6})\b/)   // first big integer is usually SF
    const annualRentMatch = blk.match(/\$?\s*([\d,]{5,})\s*(?:\/|per)?\s*(?:yr|year)?/i)

    tenants.push({
      name,
      suite: suiteMatch?.[1] || null,
      suiteNormalized: normalizeSuite(suiteMatch?.[1]),
      sqft: sfMatch ? toNumber(sfMatch[1]) : null,
      leaseStart: dateMatch?.[1] || null,
      leaseEnd: dateMatch?.[2] || null,
      annualRent: annualRentMatch ? toNumber(annualRentMatch[1]) : null,
      monthlyRent: null, psfAnnual: null, psfMonthly: null,
      rentSteps: [],
      isVacant: /zz\s*vacant/i.test(name),
      isOption: /option\s*\d+/i.test(name),
      _sourcePdf: true,
    })
  }
  return tenants
}
