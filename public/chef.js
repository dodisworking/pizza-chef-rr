// Pizza Chef — front-end driver.
// Stages: upload → confirm → bake (SSE) → result.

const $ = s => document.querySelector(s)
const state = {
  fileA: null, fileB: null,
  argusSlot: null, clientSlot: null, // 'A' | 'B'
  argusFile: null, clientFile: null,
  detection: null,
  result: null, excelBase64: null, excelFilename: null,
  useOpus: false,
}

// ── Stage helpers ────────────────────────────────────────
function showStage(id) {
  document.querySelectorAll('.stage').forEach(s => s.classList.remove('active'))
  $('#' + id).classList.add('active')
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// ── File upload wiring ───────────────────────────────────
function wireDropSlot(slotId, inputId, nameId, key) {
  const slot = $(slotId), input = $(inputId), name = $(nameId)

  input.addEventListener('change', (e) => handleFile(e.target.files[0], key, slot, name))
  slot.addEventListener('dragover', e => { e.preventDefault(); slot.classList.add('dragover') })
  slot.addEventListener('dragleave', () => slot.classList.remove('dragover'))
  slot.addEventListener('drop', e => {
    e.preventDefault(); slot.classList.remove('dragover')
    const f = e.dataTransfer.files[0]; if (f) handleFile(f, key, slot, name)
  })
}

function handleFile(file, key, slot, nameEl) {
  if (!file) return
  const lower = file.name.toLowerCase()
  if (!/\.(pdf|xlsx|xls)$/i.test(lower)) {
    alert('Only PDF or XLSX please — kosher pizzeria, strict menu.')
    return
  }
  state[key] = file
  slot.classList.add('filled')
  nameEl.textContent = file.name
  $('#detectBtn').disabled = !(state.fileA && state.fileB)
}

wireDropSlot('#slotA', '#inputA', '#nameA', 'fileA')
wireDropSlot('#slotB', '#inputB', '#nameB', 'fileB')

// ── Detect ───────────────────────────────────────────────
$('#detectBtn').addEventListener('click', async () => {
  $('#detectBtn').disabled = true
  $('#detectBtn').textContent = 'Sniffing…'
  try {
    const [a, b] = await Promise.all([toBase64(state.fileA), toBase64(state.fileB)])
    const resp = await fetch('/api/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileA: { name: state.fileA.name, base64: a },
        fileB: { name: state.fileB.name, base64: b },
      }),
    })
    if (!resp.ok) throw new Error(await resp.text())
    const data = await resp.json()
    state.argusSlot  = data.argus
    state.clientSlot = data.client
    state.detection  = data.detection
    state.argusFile  = state.argusSlot  === 'A' ? state.fileA : state.fileB
    state.clientFile = state.clientSlot === 'A' ? state.fileA : state.fileB
    renderConfirm()
    showStage('confirmStage')
  } catch (e) {
    alert('Detection failed: ' + e.message)
  } finally {
    $('#detectBtn').disabled = false
    $('#detectBtn').textContent = 'Identify the dough →'
  }
})

function renderConfirm() {
  const det = state.detection || {}
  const argusKey = state.argusSlot, clientKey = state.clientSlot
  $('#argusFilename').textContent  = det[argusKey]?.filename || '—'
  $('#clientFilename').textContent = det[clientKey]?.filename || '—'
  $('#argusHits').innerHTML  = hitsHtml(det[argusKey])
  $('#clientHits').innerHTML = hitsHtml(det[clientKey])
}

function hitsHtml(d) {
  if (!d) return ''
  const a = (d.argusHits  || []).slice(0, 3).map(h => `✓ ${h}`).join('<br>')
  const c = (d.clientHits || []).slice(0, 3).map(h => `○ ${h}`).join('<br>')
  const sc = `<div style="margin-top:6px;color:#9ca3af">score: ${d.score}</div>`
  return [a, c].filter(Boolean).join('<br>') + sc
}

$('#swapBtn').addEventListener('click', () => {
  [state.argusSlot, state.clientSlot] = [state.clientSlot, state.argusSlot]
  ;[state.argusFile, state.clientFile] = [state.clientFile, state.argusFile]
  renderConfirm()
})

$('#backToUpload').addEventListener('click', () => showStage('uploadStage'))

// ── Bake ─────────────────────────────────────────────────
let bakeAbort = null
let bakeStartedAt = 0
let lastProgressAt = 0
let elapsedTimer = null
let stallTimer = null
const STALL_TIMEOUT_MS = 180000  // if no new progress event in 3min, assume stuck

$('#rollBtn').addEventListener('click', async () => {
  state.mode = document.querySelector('input[name=mode]:checked')?.value || 'regular'
  showStage('bakingStage')
  setKitchenStage('dough')
  updateProgress({ stage: 'dough', percent: 3, message: 'Warming the stone…' })
  startBakeTimers()

  bakeAbort = new AbortController()
  try {
    const [argusB64, clientB64] = await Promise.all([toBase64(state.argusFile), toBase64(state.clientFile)])
    const resp = await fetch('/api/compare', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argus:  { name: state.argusFile.name,  base64: argusB64  },
        client: { name: state.clientFile.name, base64: clientB64 },
        mode: state.mode,
      }),
      signal: bakeAbort.signal,
    })
    if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
    await consumeSSE(resp.body)
  } catch (e) {
    if (e.name === 'AbortError') {
      // User cancelled or stall-timeout fired — already handled
    } else {
      alert('Baking failed: ' + e.message)
      resetBake()
      showStage('uploadStage')
    }
  } finally {
    stopBakeTimers()
  }
})

$('#cancelBtn').addEventListener('click', () => {
  if (!bakeAbort) return
  const elapsed = Math.round((Date.now() - bakeStartedAt) / 1000)
  if (elapsed > 60 && !confirm(`The pizza has been in the oven for ${elapsed}s. Stop anyway?`)) return
  bakeAbort.abort()
  stopBakeTimers()
  resetBake()
  showStage('uploadStage')
})

function startBakeTimers() {
  bakeStartedAt = lastProgressAt = Date.now()
  elapsedTimer = setInterval(() => {
    const s = Math.round((Date.now() - bakeStartedAt) / 1000)
    const el = $('#progressElapsed')
    if (el) el.textContent = `${s}s elapsed${s > 120 ? ' · dense files take up to 2 min' : ''}`
  }, 1000)
  stallTimer = setInterval(() => {
    if (Date.now() - lastProgressAt > STALL_TIMEOUT_MS) {
      bakeAbort?.abort()
      stopBakeTimers()
      alert('The kitchen stalled — no progress in 3 minutes. Try again or use a smaller file.')
      resetBake()
      showStage('uploadStage')
    }
  }, 5000)
}
function stopBakeTimers() {
  if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null }
  if (stallTimer) { clearInterval(stallTimer); stallTimer = null }
}
function resetBake() {
  bakeAbort = null
  bakeStartedAt = lastProgressAt = 0
}

async function consumeSSE(stream) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2)
      const lines = raw.split('\n')
      let event = 'message', data = ''
      for (const ln of lines) {
        if (ln.startsWith('event:')) event = ln.slice(6).trim()
        else if (ln.startsWith('data:')) data += ln.slice(5).trim()
      }
      if (!data) continue
      let payload; try { payload = JSON.parse(data) } catch { continue }
      if (event === 'pc-progress') { lastProgressAt = Date.now(); updateProgress(payload) }
      else if (event === 'pc-complete') { lastProgressAt = Date.now(); onComplete(payload) }
      else if (event === 'pc-error') { alert('Kitchen error: ' + payload.error); stopBakeTimers(); resetBake(); showStage('uploadStage'); return }
    }
  }
}

const STAGE_MAP = {
  dough: { pizza: 'dough',    label: 'Kneading dough' },
  roll:  { pizza: 'roll',     label: 'Rolling dough' },
  sauce: { pizza: 'sauce',    label: 'Spreading sauce' },
  toppings: { pizza: 'toppings', label: 'Adding toppings' },
  oven:  { pizza: 'oven',     label: 'Baking' },
  ding:  { pizza: 'ding',     label: 'DING!' },
}

const STAGE_LABELS = {
  dough:    'KNEADING DOUGH',
  roll:     'TOSSING DOUGH',
  sauce:    'SPREADING SAUCE',
  toppings: 'SPRINKLING VEGGIES',
  oven:     'BAKING IN THE OVEN',
  ding:     'DING!',
}

function updateProgress({ stage, percent, message }) {
  const m = STAGE_MAP[stage] || STAGE_MAP.dough
  const label = STAGE_LABELS[m.pizza] || m.label.toUpperCase()
  $('#progressStage').textContent = label
  $('#progressMessage').textContent = message || ''
  $('#progressFill').style.width = Math.min(100, Math.max(0, percent || 0)) + '%'
  $('#bakingHeadline').textContent = label + '…'
  setKitchenStage(m.pizza)
}

function setKitchenStage(stage) {
  const k = document.getElementById('kitchen')
  if (!k) return
  k.className = 'kitchen stage-' + stage
  if (stage === 'toppings') rainVeggies()
}

const VEG_EMOJI = ['🫑','🥦','🫒','🧅','🍅','🌶️','🥬','🌿']
function rainVeggies() {
  const host = document.getElementById('veggieRain')
  if (!host) return
  host.innerHTML = ''
  for (let i = 0; i < 14; i++) {
    const s = document.createElement('span')
    s.className = 'v'
    s.textContent = VEG_EMOJI[Math.floor(Math.random() * VEG_EMOJI.length)]
    s.style.left = (10 + Math.random() * 80) + '%'
    s.style.animationDelay = (Math.random() * 0.6) + 's'
    host.appendChild(s)
  }
}

function onComplete(payload) {
  state.result = payload.result
  state.excelBase64 = payload.excelBase64
  state.excelFilename = payload.excelFilename
  renderResults()
  showStage('resultStage')
  try {
    // Audible ding (tiny beep via WebAudio)
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = 1320; g.gain.value = 0.1
    o.connect(g); g.connect(ctx.destination); o.start()
    setTimeout(() => { g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4); setTimeout(() => o.stop(), 450) }, 5)
  } catch {}
}

// ── Results / Reviewer ───────────────────────────────────
//
// state.reviews[key] = { verdict: 'good' | 'bad' | null, note: string }
// key = tenant group index in result.tenantGroups
state.reviews = {}
state.currentFilter = 'all'
state.activeGroupIdx = -1

function renderResults() {
  const r = state.result || {}
  const s = r.summary || {}
  $('#resultSub').textContent = `Property: ${r.property || 'Unknown'} · ${r.argusTenantsTotal || 0} Argus tenants · ${r.clientTenantsTotal || 0} client tenants`

  const stats = [
    { n: s.matched || 0,         l: 'Matched pairs' },
    { n: s.cleanMatch || 0,      l: 'Clean matches', cls: 'hl-green' },
    { n: s.withDifferences || 0, l: 'With differences', cls: (s.withDifferences||0) ? 'hl-red' : '' },
    { n: s.argusOnly || 0,       l: 'Argus only', cls: (s.argusOnly||0) ? 'hl-orange' : '' },
    { n: s.clientOnly || 0,      l: 'Client only', cls: (s.clientOnly||0) ? 'hl-orange' : '' },
  ]
  $('#statsGrid').innerHTML = stats.map(x =>
    `<div class="stat-card ${x.cls || ''}"><div class="n">${x.n}</div><div class="l">${x.l}</div></div>`
  ).join('')

  renderPanels()
  wireReviewer()
}

function renderPanels() {
  const r = state.result || {}
  renderApplePanel(r.argus || [])
  renderPearPanel(r.client || [])
  renderA2APanel(r.tenantGroups || [])
}

function renderApplePanel(argusList) {
  const host = $('#applePanel')
  const q = ($('#appleSearch').value || '').toLowerCase()
  host.innerHTML = argusList
    .filter(t => !q || (t.name || '').toLowerCase().includes(q) || String(t.suite || '').toLowerCase().includes(q))
    .map(t => `
      <div class="tenant-row" data-side="apple" data-suite="${escape(t.suiteNormalized || t.suite || '')}">
        <div class="suite">${escape(t.suite || '—')}</div>
        <div class="name" title="${escape(t.name || '')}">${escape(t.name || '—')}</div>
        <div class="sf">${t.sqft != null ? Number(t.sqft).toLocaleString() : '—'}</div>
      </div>`).join('') || '<div style="padding:14px;color:#9ca3af;font-size:12px">(no tenants)</div>'
}

function renderPearPanel(clientList) {
  const host = $('#pearPanel')
  const q = ($('#pearSearch').value || '').toLowerCase()
  host.innerHTML = clientList
    .filter(t => !q || (t.name || '').toLowerCase().includes(q) || String(t.suite || '').toLowerCase().includes(q))
    .map(t => `
      <div class="tenant-row" data-side="pear" data-suite="${escape(t.suiteNormalized || t.suite || '')}">
        <div class="suite">${escape(t.suite || '—')}</div>
        <div class="name" title="${escape(t.name || '')}">${escape(t.name || '—')}</div>
        <div class="sf">${t.sqft != null ? Number(t.sqft).toLocaleString() : '—'}</div>
      </div>`).join('') || '<div style="padding:14px;color:#9ca3af;font-size:12px">(no tenants)</div>'
}

function a2aStatus(g) {
  if (g.argusOnly) return 'argusOnly'
  if (g.clientOnly) return 'clientOnly'
  if (g.allMatch)   return 'match'
  return 'diffs'
}

function renderA2APanel(groups) {
  const host = $('#a2aPanel')
  const filter = state.currentFilter
  const rows = groups.map((g, idx) => ({ g, idx }))
    .filter(({ g, idx }) => {
      const st = a2aStatus(g)
      if (filter === 'all') return true
      if (filter === 'diffs')      return st === 'diffs'
      if (filter === 'argusOnly')  return st === 'argusOnly'
      if (filter === 'clientOnly') return st === 'clientOnly'
      if (filter === 'unreviewed') return (st !== 'match') && !state.reviews[idx]?.verdict
      return true
    })
    .map(({ g, idx }) => {
      const st = a2aStatus(g)
      const tenant = g.argus?.name || g.client?.name || '—'
      const statusIcon = st === 'match' ? '✓' : st === 'diffs' ? '✗' : '!'
      const v = state.reviews[idx]?.verdict
      const verdictIcon = v === 'good' ? '👍' : v === 'bad' ? '👎' : (st === 'match' ? '' : '•')
      return `
        <div class="a2a-row status-${st} ${state.activeGroupIdx === idx ? 'selected' : ''}"
             data-idx="${idx}" data-suite="${escape(g.suiteNormalized || g.suite || '')}">
          <div class="a2a-suite">${escape(g.suite || '—')}</div>
          <div class="a2a-tenant" title="${escape(tenant)}">${escape(tenant)}</div>
          <div class="a2a-status">${statusIcon}</div>
          <div class="a2a-verdict">${verdictIcon}</div>
        </div>`
    }).join('')
  host.innerHTML = rows || '<div style="padding:14px;color:#9ca3af;font-size:12px">(no rows for this filter)</div>'
}

// ═══ SOURCE PREVIEW (PDF render + red rectangle overlay) ════
// Uses pdf.js loaded via CDN. Caches one pdf.js document per file.
const pdfCache = new Map()     // key: 'argus' | 'client' → { pdfDoc, tenantIndex: Map<suiteNorm, {page, rect}> }

async function loadPdfDoc(side) {
  if (pdfCache.has(side)) return pdfCache.get(side)
  const file = side === 'argus' ? state.argusFile : state.clientFile
  if (!file) return null
  if (!/\.pdf$/i.test(file.name)) {
    pdfCache.set(side, { type: 'xlsx', file })
    return pdfCache.get(side)
  }
  if (typeof pdfjsLib === 'undefined') return null
  const buf = await file.arrayBuffer()
  const pdfDoc = await pdfjsLib.getDocument({ data: buf }).promise
  const entry = { type: 'pdf', pdfDoc, tenantIndex: new Map() }
  pdfCache.set(side, entry)
  return entry
}

// Scan every page once, build suite → (page, bbox) index.
// The bbox is the union of every text run matching the suite number or tenant name.
async function buildTenantIndex(entry, tenants) {
  if (entry.type !== 'pdf' || entry.tenantIndex.size) return
  const pdfDoc = entry.pdfDoc
  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p)
    const viewport = page.getViewport({ scale: 1.0 })
    const tc = await page.getTextContent()
    for (const t of tenants) {
      const suiteKey = t.suiteNormalized || t.suite
      if (!suiteKey) continue
      const suiteRe = new RegExp(`(^|\\s|#)0*${escapeRegex(String(t.suite || '').replace(/^0+/, '').replace(/[^a-z0-9]/gi, ''))}\\b`, 'i')
      const nameToken = t.name ? t.name.split(/[\s,]/).filter(w => w.length > 3)[0] : null
      const nameRe = nameToken ? new RegExp(escapeRegex(nameToken), 'i') : null

      const hits = []
      for (const item of tc.items) {
        const str = item.str
        const hit = (suiteRe.test(str) || (nameRe && nameRe.test(str)))
        if (!hit) continue
        // Item transform: [a, b, c, d, x, y] where (x,y) is PDF point origin (bottom-left of the item baseline).
        const tr = pdfjsLib.Util.transform(viewport.transform, item.transform)
        const x = tr[4]
        const y = tr[5] - item.height  // pdf.js y is baseline; subtract height to get top
        const w = item.width
        const h = item.height
        hits.push({ x, y, w, h })
      }
      if (!hits.length) continue
      const existing = entry.tenantIndex.get(suiteKey)
      if (existing) continue  // first-page hit wins
      const bbox = unionBoxes(hits)
      // Pad a bit
      bbox.x -= 6; bbox.y -= 4; bbox.w += 12; bbox.h += 8
      entry.tenantIndex.set(suiteKey, { page: p, rect: bbox, viewportScale: 1 })
    }
  }
}

function unionBoxes(boxes) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const b of boxes) {
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w)
    y2 = Math.max(y2, b.y + b.h)
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function renderSourcePreviews(g) {
  await Promise.all([
    renderOneSide('argus', $('#previewArgus'), g, state.result.argus),
    renderOneSide('client', $('#previewClient'), g, state.result.client),
  ])
}

async function renderOneSide(side, host, group, tenants) {
  host.innerHTML = '<div class="preview-placeholder">Loading…</div>'
  const suiteKey = group.suiteNormalized || group.suite
  const tenant = side === 'argus' ? group.argus : group.client

  // If this side doesn't have the tenant at all, show a note
  if (!tenant && ((side === 'argus' && group.clientOnly) || (side === 'client' && group.argusOnly))) {
    host.innerHTML = '<div class="preview-placeholder">Not present in this rent roll.</div>'
    return
  }

  let entry
  try { entry = await loadPdfDoc(side) } catch (e) { entry = null }
  if (!entry) {
    host.innerHTML = '<div class="preview-placeholder">Source file no longer loaded. Re-upload to see the visual preview.</div>'
    return
  }

  if (entry.type === 'xlsx') {
    renderXlsxRow(host, tenant)
    return
  }

  // PDF — build index lazily
  try { await buildTenantIndex(entry, tenants || []) } catch (e) { console.warn('index failed', e) }
  const loc = entry.tenantIndex.get(suiteKey)
  if (!loc) {
    host.innerHTML = `<div class="preview-placeholder">Couldn't find Suite ${escape(group.suite || '')} in the PDF (might be a scanned image or atypical layout).</div>`
    return
  }

  // Render that page
  const page = await entry.pdfDoc.getPage(loc.page)
  const scale = 1.3
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = viewport.width
  canvas.height = viewport.height
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise

  host.innerHTML = ''
  host.style.position = 'relative'
  host.appendChild(canvas)

  // Overlay red rectangle. loc.rect was computed at scale=1; rescale now.
  const rect = document.createElement('div')
  rect.className = 'hl-rect'
  const canvasOffset = canvas.getBoundingClientRect()
  const hostOffset = host.getBoundingClientRect()
  const offsetX = canvas.offsetLeft
  const offsetY = canvas.offsetTop
  rect.style.left = (offsetX + loc.rect.x * scale) + 'px'
  rect.style.top  = (offsetY + loc.rect.y * scale) + 'px'
  rect.style.width  = (loc.rect.w * scale) + 'px'
  rect.style.height = (loc.rect.h * scale) + 'px'
  host.appendChild(rect)

  // Scroll the rectangle into view inside the preview-canvas-wrap
  host.scrollTop = Math.max(0, (offsetY + loc.rect.y * scale) - 40)
}

function renderXlsxRow(host, tenant) {
  if (!tenant) {
    host.innerHTML = '<div class="preview-placeholder">Not present in this rent roll.</div>'
    return
  }
  const rows = [
    ['Suite', tenant.suite],
    ['Tenant', tenant.name],
    ['SF', tenant.sqft != null ? Number(tenant.sqft).toLocaleString() : '—'],
    ['Lease Start', tenant.leaseStart],
    ['Lease End', tenant.leaseEnd],
    ['Annual Rent', tenant.annualRent != null ? '$' + Number(tenant.annualRent).toLocaleString() : '—'],
    ['Monthly Rent', tenant.monthlyRent != null ? '$' + Number(tenant.monthlyRent).toLocaleString() : '—'],
    ['$/SF Annual', tenant.psfAnnual != null ? '$' + tenant.psfAnnual.toFixed(2) : '—'],
  ]
  host.innerHTML = `
    <div class="preview-xlsx-row">
      <table>
        ${rows.map(([k,v]) => `<tr class="highlighted"><th>${escape(k)}</th><td>${escape(v ?? '—')}</td></tr>`).join('')}
      </table>
    </div>
    <div class="preview-placeholder" style="margin:0">XLSX source — row data shown in place of page render.</div>`
}

function wireReviewer() {
  // Filter chips
  document.querySelectorAll('#filterChips .chip').forEach(c => {
    c.onclick = () => {
      document.querySelectorAll('#filterChips .chip').forEach(x => x.classList.remove('active'))
      c.classList.add('active')
      state.currentFilter = c.dataset.filter
      renderA2APanel(state.result.tenantGroups || [])
    }
  })

  // Search boxes
  $('#appleSearch').oninput = () => renderApplePanel(state.result.argus || [])
  $('#pearSearch').oninput  = () => renderPearPanel(state.result.client || [])

  // Click on any a2a row → open drawer + highlight panels
  $('#a2aPanel').onclick = (e) => {
    const row = e.target.closest('.a2a-row')
    if (!row) return
    const idx = parseInt(row.dataset.idx, 10)
    openDrawer(idx)
  }

  // Click tenant in apple/pear → open drawer if there's a matching a2a row
  $('#applePanel').onclick = $('#pearPanel').onclick = (e) => {
    const row = e.target.closest('.tenant-row')
    if (!row) return
    const suite = row.dataset.suite
    const groups = state.result.tenantGroups || []
    const idx = groups.findIndex(g => (g.suiteNormalized || g.suite) === suite)
    if (idx >= 0) openDrawer(idx)
  }

  // Source preview toggle
  $('#togglePreview').onclick = () => {
    const grid = $('#previewGrid')
    const shown = !grid.hidden
    if (shown) { grid.hidden = true; $('#togglePreview').textContent = '📄 Show sources' }
    else       { grid.hidden = false; $('#togglePreview').textContent = '🫣 Hide sources' }
  }

  // Drawer controls
  $('#drawerScrim').onclick = $('#drawerClose').onclick = closeDrawer
  $('#drawerPrev').onclick = () => navDrawer(-1)
  $('#drawerNext').onclick = () => navDrawer(+1)
  document.querySelectorAll('.btn-review').forEach(b => {
    b.onclick = () => setVerdict(b.dataset.verdict === 'none' ? null : b.dataset.verdict)
  })
  $('#reviewNote').oninput = (e) => {
    if (state.activeGroupIdx < 0) return
    const r = state.reviews[state.activeGroupIdx] || { verdict: null, note: '' }
    r.note = e.target.value
    state.reviews[state.activeGroupIdx] = r
  }
  document.addEventListener('keydown', handleDrawerKey)
}

function handleDrawerKey(e) {
  if ($('#reviewDrawer').getAttribute('aria-hidden') !== 'false') return
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return
  if (e.key === 'Escape')      closeDrawer()
  else if (e.key === 'j' || e.key === 'ArrowDown') navDrawer(+1)
  else if (e.key === 'k' || e.key === 'ArrowUp')   navDrawer(-1)
  else if (e.key === 'g') setVerdict('good')
  else if (e.key === 'b') setVerdict('bad')
}

function openDrawer(idx) {
  state.activeGroupIdx = idx
  const g = (state.result.tenantGroups || [])[idx]
  if (!g) return
  const review = state.reviews[idx] || { verdict: null, note: '' }

  // Highlight panels
  highlightPanels(g.suiteNormalized || g.suite)
  document.querySelectorAll('.a2a-row').forEach(r => r.classList.toggle('selected', parseInt(r.dataset.idx,10) === idx))

  $('#drawerTitle').innerHTML = `Suite <b>${escape(g.suite || '—')}</b> · ${escape(g.argus?.name || g.client?.name || '—')}`
  $('#drawerBody').innerHTML = renderDrawerBody(g)

  // Verdict buttons state
  document.querySelectorAll('.btn-review').forEach(b => {
    b.classList.toggle('active', b.dataset.verdict === review.verdict)
  })
  $('#reviewNote').value = review.note || ''

  $('#reviewDrawer').setAttribute('aria-hidden', 'false')

  // Reset source preview (hidden until user clicks toggle)
  $('#previewGrid').hidden = true
  $('#togglePreview').textContent = '📄 Show sources'

  // Pre-render sources in background so they're ready on click
  requestAnimationFrame(() => renderSourcePreviews(g))
}

function closeDrawer() {
  $('#reviewDrawer').setAttribute('aria-hidden', 'true')
  // Re-render a2a so verdict icons update
  renderA2APanel(state.result.tenantGroups || [])
}

function navDrawer(delta) {
  const groups = state.result.tenantGroups || []
  let idx = state.activeGroupIdx
  for (let i = 0; i < groups.length; i++) {
    idx = (idx + delta + groups.length) % groups.length
    // Skip clean matches by default if nav-ing
    if (!groups[idx].allMatch) break
  }
  openDrawer(idx)
}

function setVerdict(verdict) {
  if (state.activeGroupIdx < 0) return
  const r = state.reviews[state.activeGroupIdx] || { verdict: null, note: '' }
  r.verdict = verdict
  state.reviews[state.activeGroupIdx] = r
  document.querySelectorAll('.btn-review').forEach(b => {
    b.classList.toggle('active', b.dataset.verdict === verdict)
  })
}

function highlightPanels(suiteKey) {
  for (const side of ['apple', 'pear']) {
    const host = $('#' + side + 'Panel')
    const rows = host.querySelectorAll('.tenant-row')
    let hit = null
    rows.forEach(r => {
      const match = r.dataset.suite === suiteKey
      r.classList.toggle('highlighted', match)
      r.classList.toggle('dim', !match && !!suiteKey)
      if (match) hit = r
    })
    if (hit) hit.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
}

function renderDrawerBody(g) {
  const a = g.argus, c = g.client
  const diffs = g.differences || []
  const flagged = new Set(diffs.map(d => d.field))

  const field = (label, key, v, isFlagged) => `
    <div class="field-row ${isFlagged ? 'flagged' : ''}">
      <div class="label">${label}</div>
      <div class="value">${escape(v ?? '—')}</div>
    </div>`

  const sideCard = (who, t) => {
    if (!t) return `<div class="evidence-card ${who}"><div class="side-label">${who === 'apple' ? '🍎 Apple · Argus' : '🍐 Pear · Client'}</div><div style="color:#9ca3af;font-size:12px">Not present in this rent roll</div></div>`
    const monthly = t.monthlyRent ?? (t.annualRent ? t.annualRent / 12 : null)
    const psf = t.psfMonthly ?? (t.psfAnnual ? t.psfAnnual / 12 : null)
    return `
      <div class="evidence-card ${who}">
        <div class="side-label">${who === 'apple' ? '🍎 Apple · Argus' : '🍐 Pear · Client'}</div>
        ${field('Tenant', 'tenant_name', t.name, flagged.has('tenant_name'))}
        ${field('Suite', 'suite', t.suite, false)}
        ${field('SF', 'sqft', t.sqft != null ? Number(t.sqft).toLocaleString() : null, flagged.has('sqft'))}
        ${field('Lease Start', 'lease_start', t.leaseStart, flagged.has('lease_start'))}
        ${field('Lease End', 'lease_end', t.leaseEnd, flagged.has('lease_end'))}
        ${field('Monthly Rent', 'monthly_rent', monthly != null ? '$' + Number(monthly).toLocaleString(undefined,{maximumFractionDigits:0}) : null, flagged.has('monthly_rent'))}
        ${field('$/SF/Mo', 'psf_monthly', psf != null ? '$' + Number(psf).toFixed(2) : null, flagged.has('psf_monthly'))}
        ${field('Steps', 'rent_steps', (t.rentSteps || []).length + ' step(s)', flagged.has('rent_steps_count') || flagged.has('rent_step_date') || flagged.has('rent_step_amount'))}
      </div>`
  }

  const diffList = diffs.length ? `
    <ul class="diff-list">
      ${diffs.map(d => `
        <li class="sev-${d.severity || 'LOW'}">
          <span class="diff-sev">${d.severity || 'LOW'}</span>
          <div class="diff-label">${escape(d.label || d.field)}</div>
          <div class="diff-values">Argus: <b>${escape(d.argusValue)}</b> · Client: <b>${escape(d.clientValue)}</b></div>
        </li>`).join('')}
    </ul>` : `<div style="color:#6b7280;font-size:13px;margin-bottom:16px">No field-level differences — Todd thinks this is a clean match.</div>`

  const status = g.argusOnly ? '<div style="padding:10px;background:#fff7ed;border-left:3px solid #f97316;border-radius:6px;margin-bottom:14px;font-size:13px;color:#9a3412">This tenant is in Argus but <b>not found</b> in the client rent roll.</div>'
               : g.clientOnly ? '<div style="padding:10px;background:#fff7ed;border-left:3px solid #f97316;border-radius:6px;margin-bottom:14px;font-size:13px;color:#9a3412">This tenant is in the client rent roll but <b>not found</b> in Argus.</div>'
               : ''

  return `
    ${status}
    ${diffList}
    <div class="evidence-grid">
      ${sideCard('apple', a)}
      ${sideCard('pear', c)}
    </div>
  `
}

$('#downloadBtn').addEventListener('click', async () => {
  const btn = $('#downloadBtn')
  const originalText = btn.textContent
  const hasReviews = Object.values(state.reviews || {}).some(r => r?.verdict || r?.note)

  try {
    // If user has left reviews, ask server to regenerate Excel with them embedded.
    // Otherwise download the pre-generated Excel that came with the bake.
    if (hasReviews) {
      btn.disabled = true; btn.textContent = '📝 Adding your reviews…'
      const resp = await fetch('/api/download-with-reviews', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: state.result, reviews: state.reviews }),
      })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`)
      const data = await resp.json()
      saveXlsxFromBase64(data.excelBase64, data.excelFilename || state.excelFilename)
    } else {
      if (!state.excelBase64) return
      saveXlsxFromBase64(state.excelBase64, state.excelFilename)
    }
  } catch (e) {
    alert('Download failed: ' + e.message)
  } finally {
    btn.disabled = false; btn.textContent = originalText
  }
})

function saveXlsxFromBase64(b64, filename) {
  const blob = base64ToBlob(b64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename || 'rent-roll-reconciliation.xlsx'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

$('#restartBtn').addEventListener('click', () => {
  for (const key of ['fileA','fileB','argusFile','clientFile']) state[key] = null
  state.argusSlot = state.clientSlot = state.detection = state.result = state.excelBase64 = null
  $('#slotA').classList.remove('filled'); $('#slotB').classList.remove('filled')
  $('#nameA').textContent = ''; $('#nameB').textContent = ''
  $('#inputA').value = ''; $('#inputB').value = ''
  $('#detectBtn').disabled = true
  showStage('uploadStage')
})

// ── Utils ────────────────────────────────────────────────
function toBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result).split(',')[1])
    fr.onerror = reject
    fr.readAsDataURL(file)
  })
}
function base64ToBlob(b64, mime) {
  const bin = atob(b64); const len = bin.length; const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}
function escape(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]) }

// health ping
fetch('/api/health').then(r => r.json()).then(() => $('#health').textContent = '🟢 kitchen online').catch(() => $('#health').textContent = '🔴 offline')
