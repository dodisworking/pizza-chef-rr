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

// ── Results ──────────────────────────────────────────────
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

  const groups = (r.tenantGroups || []).filter(g => !g.allMatch).slice(0, 10)
  const rows = [`<div class="preview-row hdr"><div>Suite</div><div>Tenant</div><div>Argus</div><div>Client</div><div>Severity</div></div>`]
  for (const g of groups) {
    const d = (g.differences || [])[0]
    const sev = d?.severity || (g.argusOnly || g.clientOnly ? 'HIGH' : 'LOW')
    const tenant = g.argus?.name || g.client?.name || '—'
    const argusV = g.argusOnly ? '— (missing)' : (d ? d.argusValue : 'match')
    const clientV = g.clientOnly ? '— (missing)' : (d ? d.clientValue : 'match')
    rows.push(`<div class="preview-row ${sev}"><div>${escape(g.suite || '—')}</div><div>${escape(tenant)}</div><div>${escape(argusV)}</div><div>${escape(clientV)}</div><div class="sev">${sev}</div></div>`)
  }
  if (groups.length === 0) rows.push(`<div class="preview-row"><div>🎉</div><div>Every tenant matched. The oven is clean.</div><div></div><div></div><div></div></div>`)
  $('#previewTable').innerHTML = rows.join('')
}

$('#downloadBtn').addEventListener('click', () => {
  if (!state.excelBase64) return
  const blob = base64ToBlob(state.excelBase64, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = state.excelFilename || 'rent-roll-reconciliation.xlsx'
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
})

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
