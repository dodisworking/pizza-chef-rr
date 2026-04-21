// Deterministic tenant matcher.
//
// Priority: suite (normalized) → square footage → fuzzy name.
// We skip option rows (renewal assumptions) because they're Argus-internal
// and never appear on a client rent roll.

export function matchTenants(argusTenants, clientTenants) {
  const argus  = argusTenants .filter(t => !t.isOption && !isArgusMeta(t))
  const client = clientTenants.filter(t => !t.isOption)

  const argusByKey  = new Map(argus .filter(t => t.suiteNormalized).map(t => [t.suiteNormalized, t]))
  const clientByKey = new Map(client.filter(t => t.suiteNormalized).map(t => [t.suiteNormalized, t]))
  const usedClient = new Set()
  const usedArgus  = new Set()

  const matched = []

  // 1) Suite match
  for (const a of argus) {
    if (!a.suiteNormalized) continue
    const c = clientByKey.get(a.suiteNormalized)
    if (c && !usedClient.has(c)) {
      matched.push({ argus: a, client: c, matchedBy: 'suite' })
      usedClient.add(c); usedArgus.add(a)
    }
  }

  // 2) SF match (within 1%)
  for (const a of argus) {
    if (usedArgus.has(a)) continue
    if (!a.sqft) continue
    const c = client.find(cc =>
      !usedClient.has(cc) &&
      cc.sqft &&
      Math.abs(cc.sqft - a.sqft) / a.sqft < 0.01
    )
    if (c) {
      matched.push({ argus: a, client: c, matchedBy: 'sqft' })
      usedClient.add(c); usedArgus.add(a)
    }
  }

  // 3) Fuzzy name match
  for (const a of argus) {
    if (usedArgus.has(a)) continue
    if (!a.name) continue
    const aTok = tokenize(a.name)
    let best = null
    let bestScore = 0
    for (const c of client) {
      if (usedClient.has(c) || !c.name) continue
      const score = jaccard(aTok, tokenize(c.name))
      if (score > bestScore) { best = c; bestScore = score }
    }
    if (best && bestScore >= 0.5) {
      matched.push({ argus: a, client: best, matchedBy: 'name' })
      usedClient.add(best); usedArgus.add(a)
    }
  }

  const argusOnly  = argus .filter(t => !usedArgus.has(t)) .map(t => ({ argus: t, client: null, matchedBy: 'argus-only' }))
  const clientOnly = client.filter(t => !usedClient.has(t)).map(t => ({ argus: null, client: t, matchedBy: 'client-only' }))

  return { matched, argusOnly, clientOnly, all: [...matched, ...argusOnly, ...clientOnly] }
}

function isArgusMeta(t) {
  if (!t.name) return false
  return /^zz\s+vacant\b/i.test(t.name) && !t.suite   // summary rollups
}

function tokenize(s) {
  return new Set(
    String(s).toLowerCase()
      .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the)\b/g, ' ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1)
  )
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}
