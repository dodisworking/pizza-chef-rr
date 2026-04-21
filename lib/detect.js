// Argus rent rolls carry a very specific signature of header strings that no
// typical accounting rent roll would contain. We score by counting hits on
// these markers in the first ~2000 chars of the extracted text.

const ARGUS_MARKERS = [
  /Rental Value Per Year/i,
  /Building Share/i,
  /Initial Area/i,
  /Recovery Structure/i,
  /Market Leasing/i,
  /Lease Summary Report/i,
  /Rate Per Year/i,
  /Amount Per Month/i,
  /Renewal Assumption/i,
  /Rent Changes On/i,
]

const CLIENT_HINTS = [
  /Operating Expense/i,
  /Est CAM/i,
  /Est Insurance/i,
  /Est Management/i,
  /Est Tax/i,
  /Real Estate Tax/i,
  /Total Rent PSF/i,
  /Container Charge/i,
  /Prorated/i,
]

/**
 * @returns {{ score: number, argusHits: string[], clientHits: string[], isArgus: boolean }}
 */
export function detectArgusVsClient(text, filename = '') {
  const haystack = (text || '').slice(0, 3000)
  const argusHits = []
  for (const m of ARGUS_MARKERS) if (m.test(haystack)) argusHits.push(m.source)
  const clientHits = []
  for (const m of CLIENT_HINTS) if (m.test(haystack)) clientHits.push(m.source)

  let score = argusHits.length * 2 - clientHits.length
  if (/argus/i.test(filename)) score += 3
  if (/client/i.test(filename)) score -= 3

  return { score, argusHits, clientHits, isArgus: score >= 3 }
}
