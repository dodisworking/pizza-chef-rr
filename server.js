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
      property: deriveProperty(parsedArgus.text) || deriveProperty(parsedClient.text) || null,
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

function deriveProperty(text) {
  if (!text) return null
  const lines = text.split('\n').slice(0, 30)
  for (const ln of lines) {
    const t = ln.trim()
    if (!t) continue
    if (/rent roll|tenant|suite|lease/i.test(t)) continue
    if (/^as of/i.test(t)) continue
    if (t.length > 4 && t.length < 100 && /[a-zA-Z]/.test(t) && !/^\d/.test(t)) return t.replace(/\s*\|\s*.*$/, '').trim()
  }
  return null
}

function safeSlug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'property'
}

app.listen(PORT, HOST, () => {
  console.log(`🍕  Pizza Chef RR listening on http://${HOST}:${PORT}`)
})
