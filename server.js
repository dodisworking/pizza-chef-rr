import 'dotenv/config'
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import { parseRRFile } from './lib/rr-parser.js'
import { detectArgusVsClient } from './lib/detect.js'
import { parseArgus } from './lib/argus-parser.js'
import { normalizeClient } from './lib/client-normalizer.js'
import { matchTenants } from './lib/matcher.js'
import { diffTenants } from './lib/diff.js'
import { buildExcel } from './lib/excel-out.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 3456
const HOST = process.env.HOST?.trim() || '0.0.0.0'

app.use(express.json({ limit: '200mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'pizza-chef-rr' }))

/**
 * POST /api/detect
 * Body: { fileA: { name, base64 }, fileB: { name, base64 } }
 * Returns which file looks like Argus vs Client so the UI can confirm with the user.
 */
app.post('/api/detect', async (req, res) => {
  try {
    const { fileA, fileB } = req.body || {}
    if (!fileA?.base64 || !fileB?.base64) return res.status(400).json({ error: 'fileA and fileB required' })
    const bufA = Buffer.from(fileA.base64, 'base64')
    const bufB = Buffer.from(fileB.base64, 'base64')
    const parsedA = await parseRRFile(bufA, fileA.name)
    const parsedB = await parseRRFile(bufB, fileB.name)
    const a = detectArgusVsClient(parsedA.text, fileA.name)
    const b = detectArgusVsClient(parsedB.text, fileB.name)

    let argus, client
    if (a.score > b.score) { argus = 'A'; client = 'B' }
    else if (b.score > a.score) { argus = 'B'; client = 'A' }
    else { argus = /argus/i.test(fileA.name) ? 'A' : 'B'; client = argus === 'A' ? 'B' : 'A' }

    res.json({
      argus, client,
      detection: { A: { ...a, filename: fileA.name }, B: { ...b, filename: fileB.name } }
    })
  } catch (e) {
    console.error('detect error:', e)
    res.status(500).json({ error: e.message })
  }
})

/**
 * POST /api/compare
 * Body: { argus: { name, base64 }, client: { name, base64 }, useOpus?: boolean }
 * Streams SSE events: pc-progress (stage, percent, message) + pc-complete (result, excelBase64) or pc-error
 */
app.post('/api/compare', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const emit = (event, data) => {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)

  try {
    const { argus, client, useOpus } = req.body || {}
    if (!argus?.base64 || !client?.base64) throw new Error('argus and client files required')
    const model = useOpus ? 'claude-opus-4-7' : 'claude-sonnet-4-6'

    emit('pc-progress', { stage: 'dough', percent: 5, message: 'Kneading the dough — loading Argus rent roll…' })
    const argusBuf = Buffer.from(argus.base64, 'base64')
    const parsedArgus = await parseRRFile(argusBuf, argus.name)

    emit('pc-progress', { stage: 'dough', percent: 15, message: 'Kneading the dough — loading Client rent roll…' })
    const clientBuf = Buffer.from(client.base64, 'base64')
    const parsedClient = await parseRRFile(clientBuf, client.name)

    emit('pc-progress', { stage: 'roll', percent: 25, message: 'Rolling the dough — parsing Argus schema…' })
    const argusTenants = await parseArgus({ buffer: argusBuf, filename: argus.name, parsed: parsedArgus })

    emit('pc-progress', { stage: 'sauce', percent: 45, message: 'Spreading the sauce — translating Client into Argus format…' })
    const clientTenants = await normalizeClient({ parsed: parsedClient, filename: client.name, model })

    emit('pc-progress', { stage: 'toppings', percent: 65, message: 'Adding toppings — matching tenants suite by suite…' })
    const matches = matchTenants(argusTenants, clientTenants)

    emit('pc-progress', { stage: 'oven', percent: 80, message: 'Baking the pizza — diffing every field with evidence…' })
    const diffed = await diffTenants(matches, { model })

    emit('pc-progress', { stage: 'ding', percent: 95, message: 'DING! — plating the Excel report…' })
    const result = {
      property: deriveProperty(parsedArgus) || deriveProperty(parsedClient) || null,
      argusTenantsTotal: argusTenants.length,
      clientTenantsTotal: clientTenants.length,
      argus: argusTenants,
      client: clientTenants,
      tenantGroups: diffed.groups,
      summary: diffed.summary,
    }
    const excelBuf = await buildExcel(result)

    emit('pc-complete', {
      result,
      excelBase64: excelBuf.toString('base64'),
      excelFilename: `RentRoll-Reconciliation-${safeSlug(result.property || 'property')}-${Date.now()}.xlsx`,
    })
  } catch (e) {
    console.error('compare error:', e)
    emit('pc-error', { error: e.message || String(e) })
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
})

// Words/phrases that appear in Argus schema headers but are NOT property names.
const ARGUS_NOISE = new Set([
  'tenure','freehold','leasehold','base','contract','speculative','option',
  'retail','office','anchor','jr anchor','large shop',
  'rent details','general tenant information','cpi','free rent','% rent',
  'miscellaneous rent','recovery','tenant improvements','leasing commissions',
  'incentives','security deposits','renewal assumption','lease summary report',
  'all tenants','all tenants/ base and option lease',
  'tenant name','suite number','lease dates','lease term','initial area',
  'building share %','lease status','market leasing','lease type',
  'rate per year','amount per year','rate per month','amount per month','rental value per year',
])

function isArgusNoise(s) {
  const lower = s.toLowerCase().trim()
  if (ARGUS_NOISE.has(lower)) return true
  if (/^as of\b/i.test(s)) return true
  if (/^={2,}\s*sheet/i.test(s)) return true
  return false
}

function deriveProperty(parsed) {
  if (!parsed) return null

  // Preferred path — use parsed sheets directly (XLSX). Property name is usually row 2.
  if (parsed.sheets?.length) {
    const ws = parsed.sheets.find(s => /lease summary|rent roll/i.test(s.rows.slice(0, 5).flat().join(' '))) || parsed.sheets[0]
    for (let r = 0; r < Math.min(8, ws.rows.length); r++) {
      const row = ws.rows[r] || []
      for (const cell of row) {
        const t = String(cell ?? '').trim()
        if (!t) continue
        if (t.length < 5 || t.length > 120) continue
        if (isArgusNoise(t)) continue
        if (/rent roll|tenant name|suite/i.test(t)) continue
        // Split on ' - ' and pick the longest non-noise segment
        // (handles "BRX UW - Northwood Plaza (2026.02.10)- BEFORE (Amounts...)")
        const segments = t.split(/ - |- /).map(s => s.trim()).filter(Boolean)
        let best = null
        for (const seg of segments) {
          if (seg.length < 5) continue
          if (isArgusNoise(seg)) continue
          if (/^\(.*\)$/.test(seg)) continue          // pure parenthetical
          if (/before|after|amounts|measures|sf\)|usd/i.test(seg)) continue
          // Strip trailing paren suffix: "Northwood Plaza (2026.02.10)" → "Northwood Plaza"
          const cleaned = seg.replace(/\s*\(.*\)\s*$/, '').trim()
          if (!cleaned) continue
          if (!best || cleaned.length > best.length) best = cleaned
        }
        if (best) return best
        return t
      }
    }
  }

  // Text fallback for PDFs.
  const text = parsed.text || ''
  const lines = text.split('\n').slice(0, 40)
  for (const ln of lines) {
    const t = String(ln).split('\t')[0].trim()
    if (!t) continue
    if (t.length < 5 || t.length > 80) continue
    if (isArgusNoise(t)) continue
    if (/rent roll|tenant name|suite|lease dates|lease term|initial area|recovery/i.test(t)) continue
    if (/^\d|^suite|^tenant|^unit/i.test(t)) continue
    if (/property:/i.test(t)) return t.replace(/property:\s*/i, '').replace(/[,;].*$/, '').trim()
    if (/[A-Z][a-z]/.test(t)) return t
  }
  return null
}

function safeSlug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'property'
}

app.listen(PORT, HOST, () => {
  console.log(`🍕  Pizza Chef RR listening on http://${HOST}:${PORT}`)
})
