// Field-by-field diff. Pure JS where we can; Claude only for evidence prose.

const PSF_EPS = 0.02
const RENT_EPS_PCT = 0.01
const SF_EPS_PCT = 0.01
const DATE_EPS_DAYS = 1

export async function diffTenants({ matched, argusOnly, clientOnly }, { model } = {}) {
  const groups = []

  for (const pair of matched) {
    const { argus, client, matchedBy } = pair
    const diffs = compareFields(argus, client)
    groups.push({
      suite: client.suite || argus.suite || null,
      suiteNormalized: argus.suiteNormalized || client.suiteNormalized || null,
      matchedBy,
      argus, client,
      argusOnly: false, clientOnly: false,
      differences: diffs,
      allMatch: diffs.length === 0,
      evidence: diffs.length ? buildEvidence(argus, client, diffs) : null,
    })
  }
  for (const pair of argusOnly) {
    groups.push({
      suite: pair.argus.suite,
      suiteNormalized: pair.argus.suiteNormalized,
      matchedBy: 'argus-only',
      argus: pair.argus, client: null,
      argusOnly: true, clientOnly: false,
      differences: [],
      allMatch: false,
      evidence: `Tenant "${pair.argus.name}" (Suite ${pair.argus.suite || '?'}, ${fmtSF(pair.argus.sqft)} SF) is in the Argus rent roll but has no match in the client rent roll.`,
    })
  }
  for (const pair of clientOnly) {
    groups.push({
      suite: pair.client.suite,
      suiteNormalized: pair.client.suiteNormalized,
      matchedBy: 'client-only',
      argus: null, client: pair.client,
      argusOnly: false, clientOnly: true,
      differences: [],
      allMatch: false,
      evidence: `Tenant "${pair.client.name}" (Suite ${pair.client.suite || '?'}, ${fmtSF(pair.client.sqft)} SF) is in the client rent roll but has no match in Argus.`,
    })
  }

  groups.sort((a, b) => naturalCompare(a.suite, b.suite))

  const summary = {
    totalTenants: groups.length,
    matched: matched.length,
    cleanMatch: groups.filter(g => g.allMatch).length,
    withDifferences: groups.filter(g => !g.argusOnly && !g.clientOnly && !g.allMatch).length,
    argusOnly: argusOnly.length,
    clientOnly: clientOnly.length,
  }

  return { groups, summary }
}

function compareFields(a, c) {
  const diffs = []

  // Tenant name
  if (a.name && c.name) {
    const aN = normName(a.name), cN = normName(c.name)
    if (aN !== cN) {
      diffs.push({
        field: 'tenant_name',
        label: 'Tenant Name',
        argusValue: a.name, clientValue: c.name,
        severity: similar(aN, cN) ? 'LOW' : 'MEDIUM',
      })
    }
  }

  // SF
  if (a.sqft && c.sqft && Math.abs(a.sqft - c.sqft) / a.sqft > SF_EPS_PCT) {
    diffs.push({
      field: 'sqft', label: 'Square Footage',
      argusValue: fmtSF(a.sqft), clientValue: fmtSF(c.sqft),
      severity: Math.abs(a.sqft - c.sqft) / a.sqft > 0.02 ? 'HIGH' : 'MEDIUM',
    })
  }

  // Dates
  if (a.leaseStart && c.leaseStart) {
    const days = daysBetween(a.leaseStart, c.leaseStart)
    if (days == null) {
      if (a.leaseStart !== c.leaseStart) diffs.push({ field: 'lease_start', label: 'Lease Start', argusValue: a.leaseStart, clientValue: c.leaseStart, severity: 'MEDIUM' })
    } else if (days > DATE_EPS_DAYS) {
      diffs.push({
        field: 'lease_start', label: 'Lease Start',
        argusValue: a.leaseStart, clientValue: c.leaseStart,
        severity: days > 30 ? 'HIGH' : 'MEDIUM',
      })
    }
  }
  if (a.leaseEnd && c.leaseEnd) {
    const days = daysBetween(a.leaseEnd, c.leaseEnd)
    if (days == null) {
      if (a.leaseEnd !== c.leaseEnd) diffs.push({ field: 'lease_end', label: 'Lease End', argusValue: a.leaseEnd, clientValue: c.leaseEnd, severity: 'MEDIUM' })
    } else if (days > DATE_EPS_DAYS) {
      diffs.push({
        field: 'lease_end', label: 'Lease End',
        argusValue: a.leaseEnd, clientValue: c.leaseEnd,
        severity: days > 30 ? 'HIGH' : 'MEDIUM',
      })
    }
  }

  // Rent — compare monthly if we have it, else annual.
  const aMo = a.monthlyRent ?? (a.annualRent ? a.annualRent / 12 : null)
  const cMo = c.monthlyRent ?? (c.annualRent ? c.annualRent / 12 : null)
  if (aMo && cMo && Math.abs(aMo - cMo) / aMo > RENT_EPS_PCT) {
    diffs.push({
      field: 'monthly_rent', label: 'Monthly Rent',
      argusValue: fmtMoney(aMo), clientValue: fmtMoney(cMo),
      severity: 'HIGH',
    })
  }

  // PSF monthly
  const aPsf = a.psfMonthly ?? (a.psfAnnual ? a.psfAnnual / 12 : null)
  const cPsf = c.psfMonthly ?? (c.psfAnnual ? c.psfAnnual / 12 : null)
  if (aPsf && cPsf && Math.abs(aPsf - cPsf) > PSF_EPS) {
    diffs.push({
      field: 'psf_monthly', label: 'Rent $/SF/Mo',
      argusValue: fmtPSF(aPsf), clientValue: fmtPSF(cPsf),
      severity: 'MEDIUM',
    })
  }

  // Rent steps — count + alignment
  const aSteps = a.rentSteps || []
  const cSteps = c.rentSteps || []
  if (aSteps.length !== cSteps.length) {
    diffs.push({
      field: 'rent_steps_count', label: 'Rent Steps Count',
      argusValue: String(aSteps.length), clientValue: String(cSteps.length),
      severity: 'HIGH',
    })
  }

  return diffs
}

function buildEvidence(a, c, diffs) {
  const lines = []
  lines.push(`Matched by ${a.suite && c.suite ? 'suite' : 'SF/name'}: Argus "${a.name}" (Suite ${a.suite || '?'}) ↔ Client "${c.name}" (Suite ${c.suite || '?'}).`)
  for (const d of diffs) {
    lines.push(`• ${d.label}: Argus = ${d.argusValue} | Client = ${d.clientValue} [${d.severity}]`)
  }
  return lines.join('\n')
}

function normName(s) {
  return String(s).toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|the|#\d+)\b/g, '')
    .replace(/[^a-z0-9]/g, '')
}
function similar(a, b) {
  const short = a.length < b.length ? a : b
  const long  = a.length < b.length ? b : a
  return long.includes(short)
}

function fmtMoney(n) { return n == null ? '—' : `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}` }
function fmtSF(n)    { return n == null ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }) }
function fmtPSF(n)   { return n == null ? '—' : `$${Number(n).toFixed(2)}/SF` }

function daysBetween(a, b) {
  const da = parseDate(a), db = parseDate(b)
  if (!da || !db) return null
  return Math.abs((da - db) / (1000 * 60 * 60 * 24))
}
function parseDate(s) {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/)
  if (!m) return null
  let [_, mo, d, y] = m
  y = +y; if (y < 100) y += 2000
  const dt = new Date(y, +mo - 1, +d)
  return isNaN(dt) ? null : dt
}

function naturalCompare(a, b) {
  const sa = String(a ?? ''), sb = String(b ?? '')
  return sa.localeCompare(sb, undefined, { numeric: true, sensitivity: 'base' })
}
