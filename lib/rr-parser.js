import ExcelJS from 'exceljs'
import pdfParse from 'pdf-parse/lib/pdf-parse.js'

/** Parse Excel buffer → structured { sheets: [{ name, rows: [[cell, ...], ...] }], text } */
export async function parseExcel(buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer))
  const sheets = []
  wb.eachSheet(ws => {
    const rows = []
    ws.eachRow({ includeEmpty: true }, (row) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(normalizeCell(cell.value))
      })
      rows.push(cells)
    })
    sheets.push({ name: ws.name, rows })
  })
  const text = sheets.map(s =>
    `=== SHEET: ${s.name} ===\n` + s.rows.map(r => r.map(c => c ?? '').join('\t')).join('\n')
  ).join('\n\n')
  return { sheets, text }
}

function normalizeCell(val) {
  if (val === null || val === undefined) return ''
  if (val instanceof Date) return val.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  if (typeof val === 'object') {
    if (val.result !== undefined) {
      const r = val.result
      if (r instanceof Date) return r.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
      return r !== null && r !== undefined ? String(r) : ''
    }
    if (val.richText) return val.richText.map(rt => rt.text).join('')
    if (val.text)     return String(val.text)
    if (val.hyperlink) return String(val.text || val.hyperlink)
    return ''
  }
  if (typeof val === 'number') return val
  return String(val)
}

/** Parse PDF buffer → text */
export async function parsePdf(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  try {
    const data = await pdfParse(buf)
    return { text: data.text?.trim() || '', pages: data.numpages || 0 }
  } catch (e) {
    return { text: `[PDF parse error: ${e.message}]`, pages: 0, error: e.message }
  }
}

/** Detect file type and parse → { type, text, sheets?, scanned? } */
export async function parseRRFile(buffer, filename) {
  const lower = (filename || '').toLowerCase()
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
    const { sheets, text } = await parseExcel(buffer)
    return { type: 'excel', text, sheets }
  }
  if (lower.endsWith('.csv')) {
    return { type: 'csv', text: Buffer.from(buffer).toString('utf-8') }
  }
  if (lower.endsWith('.pdf')) {
    const { text } = await parsePdf(buffer)
    const scanned = !text || text.length < 50
    return { type: 'pdf', text: scanned ? '[SCANNED PDF — OCR required]' : text, scanned }
  }
  return { type: 'text', text: Buffer.from(buffer).toString('utf-8') }
}
