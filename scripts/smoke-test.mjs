// End-to-end smoke test against the three sample properties.
// Calls /api/compare with each pair and summarizes the result.

import fs from 'node:fs/promises'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:3789'
const SAMPLES = '/Users/jarvis/Downloads/Rent Roll Tests for Isaac for 3 Sample Properties'

const PAIRS = [
  {
    name: 'Mayfair',
    argus:  `${SAMPLES}/Mayfair Shopping Center/Argus RR/Mayfair Shopping Center - Argus RR- BEFORE.xlsx`,
    client: `${SAMPLES}/Mayfair Shopping Center/Client RR/Mayfair Shopping Center - Rent Roll- Client RR.pdf`,
  },
  {
    name: 'Northwood',
    argus:  `${SAMPLES}/Northwood Plaza/Argus RR /BRX UW - Northwood Plaza- Argus RR- BEFORE.xlsx`,
    client: `${SAMPLES}/Northwood Plaza/Client RR/2026-02 12 Rent Roll 179- Client RR.pdf`,
  },
  {
    name: 'Vintage',
    argus:  `${SAMPLES}/Vintage Marketplace/Argus RR 9/Vintage Marketplace (Jan-25) - Argus RR- BEFORE.xlsx`,
    client: `${SAMPLES}/Vintage Marketplace/Client RR/Vintage Marketplace Rent Roll - 1.26.26- Client RR.xlsx`,
  },
]

async function toB64(p) {
  const buf = await fs.readFile(p)
  return buf.toString('base64')
}

async function run(pair) {
  console.log(`\n═══ ${pair.name} ═══`)
  const argus  = { name: path.basename(pair.argus),  base64: await toB64(pair.argus)  }
  const client = { name: path.basename(pair.client), base64: await toB64(pair.client) }

  // 1) detect
  const det = await fetch(`${BASE}/api/detect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileA: argus, fileB: client }),
  }).then(r => r.json())
  console.log('detect:', { argus: det.argus, aScore: det.detection?.A?.score, bScore: det.detection?.B?.score })

  // 2) compare (SSE)
  const resp = await fetch(`${BASE}/api/compare`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ argus, client, useOpus: false }),
  })
  const reader = resp.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let result = null
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      let ev = 'message', data = ''
      for (const ln of raw.split('\n')) {
        if (ln.startsWith('event:')) ev = ln.slice(6).trim()
        else if (ln.startsWith('data:')) data += ln.slice(5).trim()
      }
      if (!data) continue
      const p = JSON.parse(data)
      if (ev === 'pc-progress') process.stdout.write(`  [${p.percent}%] ${p.stage}: ${p.message}\n`)
      else if (ev === 'pc-complete') { result = p; console.log('  ✓ complete') }
      else if (ev === 'pc-error') { console.error('  ✗ error:', p.error); return null }
    }
  }

  const r = result?.result
  if (!r) return null
  console.log(`  property:            ${r.property || '(none)'}`)
  console.log(`  argus tenants:       ${r.argusTenantsTotal}`)
  console.log(`  client tenants:      ${r.clientTenantsTotal}`)
  console.log(`  matched:             ${r.summary.matched}`)
  console.log(`  clean:               ${r.summary.cleanMatch}`)
  console.log(`  with diffs:          ${r.summary.withDifferences}`)
  console.log(`  argus-only:          ${r.summary.argusOnly}`)
  console.log(`  client-only:         ${r.summary.clientOnly}`)

  // Show top 5 differences
  const withDiffs = (r.tenantGroups || []).filter(g => !g.allMatch && !g.argusOnly && !g.clientOnly).slice(0, 5)
  for (const g of withDiffs) {
    console.log(`    ▸ Suite ${g.suite} — ${g.argus?.name} ↔ ${g.client?.name}`)
    for (const d of (g.differences || []).slice(0, 3)) {
      console.log(`        · ${d.label}: argus "${d.argusValue}" | client "${d.clientValue}" [${d.severity}]`)
    }
  }

  // Save excel
  const outDir = '/tmp/pizza-chef-smoke'
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, result.excelFilename || `${pair.name}.xlsx`)
  await fs.writeFile(outPath, Buffer.from(result.excelBase64, 'base64'))
  console.log(`  → wrote ${outPath}`)
  return r
}

for (const pair of PAIRS) {
  try { await run(pair) } catch (e) { console.error('  ✗ FAILED:', e.message) }
}
