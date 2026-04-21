// 3-tab Excel output:
//   1. Argus RR           — canonical tenants parsed from Argus
//   2. Client RR (normal) — client tenants translated into Argus schema
//   3. Reconciliation     — row per tenant with ✓/✗ per field + evidence

import ExcelJS from 'exceljs'

const NAVY       = 'FF0F172A'
const WHITE      = 'FFFFFFFF'
const GRAY_BG    = 'FFF8FAFC'
const LIGHT_GRN  = 'FFD1FAE5'
const LIGHT_RED  = 'FFFEE2E2'
const LIGHT_ORG  = 'FFFED7AA'
const LIGHT_YEL  = 'FFFEF3C7'
const MATCH_GRN  = 'FF059669'
const MISS_RED   = 'FFDC2626'
const ARGUS_HDR  = 'FF1E3A5F'
const CLIENT_HDR = 'FF1A3B2A'
const CHECK_HDR  = 'FF374151'
const PIZZA_RED  = 'FFB91C1C'

function cell(ws, r, c, value, opts = {}) {
  const cl = ws.getRow(r).getCell(c)
  cl.value = value
  if (opts.fill) cl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: opts.fill } }
  cl.font = { name: 'Calibri', size: opts.size || 10, bold: !!opts.bold, color: { argb: opts.color || 'FF111827' } }
  cl.alignment = { vertical: 'middle', horizontal: opts.align || 'left', wrapText: !!opts.wrap }
  cl.border = {
    top:    { style: 'thin', color: { argb: 'FFE5E7EB' } },
    bottom: { style: 'thin', color: { argb: 'FFE5E7EB' } },
    left:   { style: 'thin', color: { argb: 'FFE5E7EB' } },
    right:  { style: 'thin', color: { argb: 'FFE5E7EB' } },
  }
}

const fmt      = v => (v == null || v === '') ? '—' : String(v)
const fmtMoney = v => (v == null) ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtSF    = v => (v == null) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
const fmtPSF   = v => (v == null) ? '—' : `$${Number(v).toFixed(2)}/SF`
const fmtSteps = steps => !steps?.length ? '—' : steps.map(s => `${s.effectiveDate || '?'}: ${fmtPSF(s.psfMonthly)}${s.monthlyRent ? ` (${fmtMoney(s.monthlyRent)})` : ''}`).join('\n')

function reviewLabel(v) {
  if (v === 'good') return '👍 Real'
  if (v === 'bad')  return '👎 False positive'
  return ''
}

export async function buildExcel(result) {
  const wb = new ExcelJS.Workbook()
  wb.creator = "Todd's Pizzeria — Rent Roll the Dough"
  wb.created = new Date()

  buildArgusSheet(wb, result.argus || [], result.property)
  buildClientSheet(wb, result.client || [], result.property)
  buildReconciliationSheet(wb, result)
  buildSummarySheet(wb, result)

  return Buffer.from(await wb.xlsx.writeBuffer())
}

function buildTenantSheet(wb, title, tabColor, tenants, propertyName, sourceLabel) {
  const ws = wb.addWorksheet(title, { tabColor: { argb: tabColor }, views: [{ state: 'frozen', ySplit: 3 }] })
  const COLS = [
    { h: 'Suite',       w: 10 },
    { h: 'Tenant',      w: 32 },
    { h: 'SF',          w: 11, fmt: 'sf' },
    { h: 'Lease Start', w: 13 },
    { h: 'Lease End',   w: 13 },
    { h: 'Lease Type',  w: 22 },
    { h: 'Annual Rent', w: 15, fmt: 'money' },
    { h: 'Monthly Rent',w: 15, fmt: 'money' },
    { h: '$/SF Annual', w: 12, fmt: 'psf' },
    { h: '$/SF Month',  w: 12, fmt: 'psf' },
    { h: 'Rent Steps',  w: 44 },
    { h: 'Vacant?',     w: 9 },
  ]
  ws.columns = COLS.map(c => ({ width: c.w }))

  ws.mergeCells(1, 1, 1, COLS.length)
  cell(ws, 1, 1, `${title} — ${propertyName || 'Rent Roll'}`, { fill: NAVY, color: WHITE, bold: true, size: 13, align: 'center' })
  ws.getRow(1).height = 26

  ws.mergeCells(2, 1, 2, COLS.length)
  cell(ws, 2, 1, sourceLabel, { fill: GRAY_BG, color: 'FF374151', size: 9, align: 'center' })
  ws.getRow(2).height = 16

  COLS.forEach((c, i) => cell(ws, 3, i + 1, c.h, { fill: NAVY, color: WHITE, bold: true, size: 10, align: 'center' }))
  ws.getRow(3).height = 20

  tenants.forEach((t, idx) => {
    const r = 4 + idx
    const rowFill = t.isVacant ? LIGHT_YEL : (idx % 2 === 0 ? WHITE : GRAY_BG)
    const vals = [
      { v: fmt(t.suite) },
      { v: fmt(t.name) },
      { v: t.sqft == null ? '—' : t.sqft, align: 'right' },
      { v: fmt(t.leaseStart), align: 'center' },
      { v: fmt(t.leaseEnd),   align: 'center' },
      { v: fmt(t.leaseType) },
      { v: t.annualRent  == null ? '—' : t.annualRent,  align: 'right' },
      { v: t.monthlyRent == null ? '—' : t.monthlyRent, align: 'right' },
      { v: fmtPSF(t.psfAnnual),  align: 'right' },
      { v: fmtPSF(t.psfMonthly), align: 'right' },
      { v: fmtSteps(t.rentSteps), wrap: true },
      { v: t.isVacant ? 'Yes' : '', align: 'center' },
    ]
    vals.forEach((v, i) => cell(ws, r, i + 1, v.v, { fill: rowFill, align: v.align, wrap: v.wrap }))
    // number formats
    ws.getRow(r).getCell(3).numFmt = '#,##0'
    ws.getRow(r).getCell(7).numFmt = '"$"#,##0.00'
    ws.getRow(r).getCell(8).numFmt = '"$"#,##0.00'
    const lines = (fmtSteps(t.rentSteps).match(/\n/g) || []).length + 1
    ws.getRow(r).height = Math.min(90, Math.max(18, lines * 14))
  })

  if (!tenants.length) {
    ws.mergeCells(4, 1, 4, COLS.length)
    cell(ws, 4, 1, '(no tenants parsed)', { fill: GRAY_BG, color: 'FF6B7280', align: 'center' })
  }

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
}

function buildArgusSheet(wb, tenants, property) {
  buildTenantSheet(wb, 'Argus RR', '1E3A5F', tenants, property, 'Parsed directly from Argus Enterprise export (deterministic).')
}

function buildClientSheet(wb, tenants, property) {
  buildTenantSheet(wb, 'Client RR (normalized)', '065F46', tenants, property, 'Translated from client accounting rent roll into Argus canonical schema.')
}

function buildReconciliationSheet(wb, data) {
  const ws = wb.addWorksheet('Reconciliation', { tabColor: { argb: 'B91C1C' }, views: [{ state: 'frozen', ySplit: 3 }] })
  const colWidths = [
    10, 14,
    28, 28, 7,       // tenant name + tick
    11, 11, 7,       // SF + tick
    13, 13, 7,       // start + tick
    13, 13, 7,       // end + tick
    15, 15, 7, 13, 13, // rent + tick + PSF
    8,               // steps tick
    14, 60,          // status + evidence
    14, 40,          // your review + your note
  ]
  ws.columns = colWidths.map(w => ({ width: w }))

  const groupHdr = [
    { col: 1,  span: 2,  label: 'IDENTIFIER',      fill: NAVY },
    { col: 3,  span: 3,  label: 'TENANT NAME',     fill: ARGUS_HDR },
    { col: 6,  span: 3,  label: 'SQUARE FOOTAGE',  fill: ARGUS_HDR },
    { col: 9,  span: 3,  label: 'LEASE START',     fill: ARGUS_HDR },
    { col: 12, span: 3,  label: 'LEASE END',       fill: ARGUS_HDR },
    { col: 15, span: 5,  label: 'CURRENT RENT',    fill: ARGUS_HDR },
    { col: 20, span: 1,  label: 'STEPS',           fill: ARGUS_HDR },
    { col: 21, span: 1,  label: 'STATUS',          fill: PIZZA_RED },
    { col: 22, span: 1,  label: 'EVIDENCE',        fill: PIZZA_RED },
    { col: 23, span: 1,  label: 'YOUR REVIEW',     fill: 'FF065F46' },
    { col: 24, span: 1,  label: 'YOUR NOTE',       fill: 'FF065F46' },
  ]
  for (const g of groupHdr) {
    if (g.span > 1) ws.mergeCells(1, g.col, 1, g.col + g.span - 1)
    cell(ws, 1, g.col, g.label, { fill: g.fill, color: WHITE, bold: true, size: 9, align: 'center' })
  }
  ws.getRow(1).height = 16

  const fieldHdr = [
    'Suite', 'Matched By',
    'Argus', 'Client', '✓',
    'Argus SF', 'Client SF', '✓',
    'Argus Start', 'Client Start', '✓',
    'Argus End', 'Client End', '✓',
    'Argus $/Mo', 'Client $/Mo', '✓', 'Argus $/SF', 'Client $/SF',
    '✓',
    'Status', 'Evidence',
    'Review', 'Note'
  ]
  const fieldFill = [
    NAVY, NAVY,
    ARGUS_HDR, CLIENT_HDR, CHECK_HDR,
    ARGUS_HDR, CLIENT_HDR, CHECK_HDR,
    ARGUS_HDR, CLIENT_HDR, CHECK_HDR,
    ARGUS_HDR, CLIENT_HDR, CHECK_HDR,
    ARGUS_HDR, CLIENT_HDR, CHECK_HDR, ARGUS_HDR, CLIENT_HDR,
    CHECK_HDR,
    PIZZA_RED, PIZZA_RED,
    'FF065F46', 'FF065F46',
  ]
  fieldHdr.forEach((h, i) => cell(ws, 2, i + 1, h, { fill: fieldFill[i], color: WHITE, bold: true, size: 9, align: 'center' }))
  ws.getRow(2).height = 18

  // row 3 is a section spacer to keep the freeze pane visually clean
  ws.mergeCells(3, 1, 3, 24)
  cell(ws, 3, 1, '', { fill: 'FFF3F4F6' })
  ws.getRow(3).height = 4

  const groups = data.tenantGroups || []
  let r = 4
  for (const g of groups) {
    const a = g.argus || {}
    const c = g.client || {}
    const diffs = g.differences || []
    const rowFill = g.argusOnly || g.clientOnly ? LIGHT_ORG : (!g.allMatch ? LIGHT_RED : LIGHT_GRN)
    const hasField = k => diffs.some(d => d.field === k || d.field.startsWith(k))
    const ok  = k => !hasField(k)
    const tick = flag => flag ? '✓' : '✗'
    const tickFill = flag => flag ? LIGHT_GRN : LIGHT_RED
    const tickClr  = flag => flag ? MATCH_GRN : MISS_RED

    const stepsOk = !hasField('rent_steps')

    const status = g.argusOnly ? 'ARGUS ONLY' : g.clientOnly ? 'CLIENT ONLY' : g.allMatch ? 'MATCH' : 'DIFFERENCES'
    const statusClr = g.allMatch ? MATCH_GRN : (g.argusOnly || g.clientOnly) ? 'FFC2410C' : MISS_RED

    const cells = [
      { v: fmt(g.suite) },
      { v: fmt(g.matchedBy) },
      { v: fmt(a.name) },
      { v: fmt(c.name) },
      { v: tick(ok('tenant_name')), fill: tickFill(ok('tenant_name')), color: tickClr(ok('tenant_name')), align: 'center', bold: true },
      { v: fmtSF(a.sqft), align: 'right' },
      { v: fmtSF(c.sqft), align: 'right' },
      { v: tick(ok('sqft')), fill: tickFill(ok('sqft')), color: tickClr(ok('sqft')), align: 'center', bold: true },
      { v: fmt(a.leaseStart), align: 'center' },
      { v: fmt(c.leaseStart), align: 'center' },
      { v: tick(ok('lease_start')), fill: tickFill(ok('lease_start')), color: tickClr(ok('lease_start')), align: 'center', bold: true },
      { v: fmt(a.leaseEnd), align: 'center' },
      { v: fmt(c.leaseEnd), align: 'center' },
      { v: tick(ok('lease_end')), fill: tickFill(ok('lease_end')), color: tickClr(ok('lease_end')), align: 'center', bold: true },
      { v: fmtMoney(a.monthlyRent ?? (a.annualRent ? a.annualRent / 12 : null)), align: 'right' },
      { v: fmtMoney(c.monthlyRent ?? (c.annualRent ? c.annualRent / 12 : null)), align: 'right' },
      { v: tick(ok('monthly_rent')), fill: tickFill(ok('monthly_rent')), color: tickClr(ok('monthly_rent')), align: 'center', bold: true },
      { v: fmtPSF(a.psfMonthly ?? (a.psfAnnual ? a.psfAnnual / 12 : null)), align: 'right' },
      { v: fmtPSF(c.psfMonthly ?? (c.psfAnnual ? c.psfAnnual / 12 : null)), align: 'right' },
      { v: tick(stepsOk), fill: tickFill(stepsOk), color: tickClr(stepsOk), align: 'center', bold: true },
      { v: status, bold: true, align: 'center', color: statusClr },
      { v: g.evidence || '', wrap: true },
      // Your Review + Note
      { v: reviewLabel(g.review?.verdict), bold: true, align: 'center',
        fill: g.review?.verdict === 'good' ? LIGHT_GRN : g.review?.verdict === 'bad' ? LIGHT_RED : undefined,
        color: g.review?.verdict === 'good' ? MATCH_GRN : g.review?.verdict === 'bad' ? MISS_RED : undefined },
      { v: g.review?.note || '', wrap: true },
    ]

    cells.forEach((o, i) => {
      cell(ws, r, i + 1, o.v, {
        fill: o.fill || rowFill,
        color: o.color,
        bold: !!o.bold,
        align: o.align || 'left',
        wrap: !!o.wrap,
      })
    })
    const evLines = g.evidence ? g.evidence.split('\n').length : 1
    ws.getRow(r).height = Math.min(140, Math.max(18, evLines * 14))
    r++
  }

  if (!groups.length) {
    ws.mergeCells(r, 1, r, 24)
    cell(ws, r, 1, '(no tenants to reconcile)', { fill: GRAY_BG, color: 'FF6B7280', align: 'center' })
  }

  ws.pageSetup = { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
}

function buildSummarySheet(wb, data) {
  const ws = wb.addWorksheet('Summary', { tabColor: { argb: '10B981' } })
  ws.columns = [{ width: 40 }, { width: 22 }]
  let r = 1

  ws.mergeCells(r, 1, r, 2)
  cell(ws, r, 1, "TODD'S PIZZERIA — RENT ROLL THE DOUGH", { fill: NAVY, color: WHITE, bold: true, size: 13, align: 'center' })
  ws.getRow(r).height = 26; r++

  ws.mergeCells(r, 1, r, 2)
  cell(ws, r, 1, `Property: ${data.property || 'Unknown'}`, { fill: GRAY_BG, bold: true, size: 11, align: 'center' })
  r++
  ws.mergeCells(r, 1, r, 2)
  cell(ws, r, 1, `Generated: ${new Date().toLocaleString()}`, { fill: GRAY_BG, size: 9, align: 'center', color: 'FF6B7280' })
  r++; r++

  ws.mergeCells(r, 1, r, 2)
  cell(ws, r, 1, 'RECONCILIATION STATISTICS', { fill: NAVY, color: WHITE, bold: true, align: 'center' })
  r++

  const s = data.summary || {}
  const stat = (lbl, val, hl) => {
    cell(ws, r, 1, lbl, { fill: GRAY_BG })
    cell(ws, r, 2, val, { fill: hl ? LIGHT_RED : GRAY_BG, color: hl ? MISS_RED : 'FF111827', bold: hl, align: 'center' })
    r++
  }
  stat('Total Argus Tenants',  data.argusTenantsTotal  ?? 0)
  stat('Total Client Tenants', data.clientTenantsTotal ?? 0)
  stat('Matched Pairs',        s.matched ?? 0)
  stat('Clean Matches (all fields ✓)', s.cleanMatch ?? 0)
  stat('With Differences',     s.withDifferences ?? 0, (s.withDifferences ?? 0) > 0)
  stat('In Argus Only',        s.argusOnly ?? 0, (s.argusOnly ?? 0) > 0)
  stat('In Client Only',       s.clientOnly ?? 0, (s.clientOnly ?? 0) > 0)
}
