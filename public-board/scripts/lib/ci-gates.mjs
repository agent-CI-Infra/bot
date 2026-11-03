/**
 * ci-gates contract adapter for the public dashboard.
 *
 * Inputs:
 *  - `board-summary.json` published by a per-repository board (preferred), or
 *  - `gate-report.json` artifacts pulled directly from a public repository.
 *
 * The output is the existing `public/data/gate/<owner>/<name>.json` shape so the
 * Gate page needs no new data source, plus optional v1.1 fields (level, stage,
 * caseSummary, latest). Everything here is dependency-free and read-only.
 */

export const REPORT_SCHEMA = 'ci-gates/gate-report@1'
export const SUMMARY_SCHEMA = 'ci-gates/board-summary@1'
export const SUMMARY_MAX_BYTES = 100 * 1024
export const CATALOG_SCHEMA = 'ci-gates/case-catalog@1'
export const REPORT_MAX_BYTES = 2 * 1024 * 1024

export const LANES = Object.freeze([
  'build',
  'pr-ready',
  'pr-merge',
  'daily',
  'release',
])

export const LANE_TO_CATEGORY = Object.freeze({
  build: 'build',
  'pr-ready': 'ready',
  'pr-merge': 'merge',
  daily: 'daily',
  release: 'release',
})

export const STAGES = Object.freeze([
  'discovered',
  'gates-running',
  'cases-pending',
  'observing',
  'enforced',
  'failing',
])

export const VERDICTS = Object.freeze([
  'pass',
  'fail',
  'not_run',
  'not_applicable',
  'waived',
  'observe_fail',
  'error',
])

export const LEVELS = Object.freeze(['C0', 'C1', 'C2', 'C3', 'C4'])

const TRUSTED_EVENTS = new Set([
  'merge_group',
  'push',
  'schedule',
  'release',
])

const CASE_KEYS = [
  'total',
  'ready',
  'todo',
  'skipped',
  'executed',
  'passed',
  'notRun',
]

/**
 * Same-repository boards publish under the repository's Pages site. This is
 * the default when a source omits `summaryUrl`; custom domains and subpaths
 * override it explicitly.
 */
export function defaultSummaryUrl(owner, name) {
  if (!owner || !name) return null
  const userSite = String(name).toLowerCase() === `${String(owner).toLowerCase()}.github.io`
  return userSite
    ? `https://${owner}.github.io/data/summary.json`
    : `https://${owner}.github.io/${name}/data/summary.json`
}

/** `pr_ready` / `PR-READY` → `pr-ready`; unknown values → null. */
export function normalizeLane(value) {
  const lane = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-')
  return LANES.includes(lane) ? lane : null
}

export function isGateLevel(value) {
  return LEVELS.includes(value)
}

export function isGateStage(value) {
  return STAGES.includes(value)
}

export function isTrustedEvent(event) {
  return TRUSTED_EVENTS.has(event)
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function toInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, Math.round(value))
}

function toNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return value
}

/** Flat catalog/execution counters used by the dashboard chips. */
export function normalizeCaseSummary(input) {
  if (!isObject(input)) return null
  const out = {}
  let found = false
  for (const key of CASE_KEYS) {
    if (input[key] !== undefined) {
      out[key] = toInt(input[key])
      found = true
    }
  }
  return found ? out : null
}

/** Day buckets, merged by date and sorted ascending (UTC dates). */
export function normalizeHistory(input) {
  if (!Array.isArray(input)) return []
  const byDate = new Map()
  for (const bucket of input) {
    if (!isObject(bucket) || typeof bucket.date !== 'string') continue
    const date = bucket.date.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const current = byDate.get(date) ?? {
      date,
      pass: 0,
      fail: 0,
      ignored: 0,
      retries: 0,
      durations: [],
    }
    current.pass += toInt(bucket.pass)
    current.fail += toInt(bucket.fail)
    current.ignored += toInt(bucket.ignored)
    current.retries += toInt(bucket.retries)
    if (Array.isArray(bucket.durations)) {
      current.durations.push(
        ...bucket.durations.filter(
          (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0
        )
      )
    }
    byDate.set(date, current)
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1))
}

/**
 * Fallback when a board publishes pass rate but no daily buckets: spread the
 * rate over a single bucket dated at generation time. The UI window selector
 * then shows the same value for every window, which is honest enough for a
 * board that only keeps the latest aggregate.
 */
export function synthesizeHistory(lane, generatedAt) {
  const runs = toInt(lane?.runs)
  if (runs === 0) return []
  const rate = toNumber(lane?.passRate)
  if (rate == null) return []
  const pass = Math.max(0, Math.min(runs, Math.round((rate / 100) * runs)))
  const date = String(generatedAt ?? new Date().toISOString()).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  const avg = toNumber(lane?.avgDurationSec)
  return [
    {
      date,
      pass,
      fail: runs - pass,
      ignored: 0,
      retries: 0,
      durations: avg == null ? [] : [Math.round(avg)],
    },
  ]
}

/**
 * Onboarding stage. An explicit stage from the board wins; otherwise derive it.
 * `not_run` with pending catalog entries is "cases-pending" (onboarding), while
 * a real gate failure is "failing".
 */
export function deriveStage(summary, now = new Date()) {
  if (isGateStage(summary?.stage)) return summary.stage
  const lanes = Array.isArray(summary?.lanes) ? summary.lanes : []
  if (lanes.length === 0) return 'discovered'
  const trusted = lanes.filter((lane) => laneTrust(lane) !== 'provisional')
  const hardFail = trusted.some(
    (lane) => lane.verdict === 'fail' || lane.verdict === 'error'
  )
  if (hardFail) return 'failing'
  const cases = normalizeCaseSummary(summary?.caseSummary)
  if (cases && (cases.todo > 0 || cases.notRun > 0)) return 'cases-pending'
  if (trusted.some((lane) => lane.verdict === 'not_run')) return 'failing'
  const applicable = trusted.filter((lane) => lane.verdict !== 'not_applicable')
  if (applicable.length === 0) return 'gates-running'
  if (summary?.observeUntil) {
    const until = new Date(summary.observeUntil)
    if (!Number.isNaN(until.valueOf()) && until >= now) return 'observing'
  }
  return 'enforced'
}

/**
 * Validate a `gate-report.json` v1.1 artifact before it influences the board or
 * the public dataset. `run` is optional; when supplied, the report must belong
 * to the same commit.
 */
export function validateReport(report, source, run) {
  if (!isObject(report)) throw new Error('report is not an object')
  if (report.schema !== REPORT_SCHEMA) {
    throw new Error(`unsupported report schema: ${report.schema ?? '(none)'}`)
  }
  const expectedRepo =
    source?.id ?? (source?.owner && source?.name ? `${source.owner}/${source.name}` : null)
  if (!expectedRepo) throw new Error('source needs id or owner/name')
  if (report.repo !== expectedRepo) {
    throw new Error(`report repo mismatch: expected ${expectedRepo}, got ${report.repo}`)
  }
  if (!LANES.includes(report.lane)) throw new Error(`unknown report lane: ${report.lane}`)
  if (!isGateLevel(report.level)) throw new Error(`unknown report level: ${report.level}`)
  if (
    !['pass', 'fail', 'not_applicable', 'waived', 'observe_fail', 'error'].includes(
      report.verdict
    )
  ) {
    throw new Error(`unknown report verdict: ${report.verdict}`)
  }
  if (!Array.isArray(report.results)) throw new Error('report.results must be an array')
  if (run?.head_sha && report.sha !== run.head_sha) {
    throw new Error(`report sha mismatch: run ${run.head_sha}, report ${report.sha}`)
  }
  const bytes = Buffer.byteLength(JSON.stringify(report), 'utf8')
  if (bytes > REPORT_MAX_BYTES) {
    throw new Error(`report too large: ${bytes} bytes > ${REPORT_MAX_BYTES}`)
  }
  return true
}

/**
 * Validate a parsed `case-catalog.yaml`. Ready cases must point at a file and
 * an owner; skipped cases must carry an expiry and a reason.
 */
export function validateCatalog(catalog) {
  if (!isObject(catalog)) throw new Error('catalog is not an object')
  if (catalog.schema !== CATALOG_SCHEMA) {
    throw new Error(`unsupported catalog schema: ${catalog.schema ?? '(none)'}`)
  }
  if (catalog.version !== 1) throw new Error(`unsupported catalog version: ${catalog.version}`)
  if (!Array.isArray(catalog.cases)) throw new Error('catalog.cases must be an array')
  const ids = new Set()
  for (const entry of catalog.cases) {
    if (!isObject(entry)) throw new Error('catalog case is not an object')
    if (typeof entry.id !== 'string' || !entry.id) throw new Error('catalog case id is required')
    if (ids.has(entry.id)) throw new Error(`duplicate catalog case id: ${entry.id}`)
    ids.add(entry.id)
    if (!LANES.includes(entry.lane)) {
      throw new Error(`unknown catalog lane for ${entry.id}: ${entry.lane}`)
    }
    if (!/^L[0-5](-L[0-5])?$/.test(String(entry.layer ?? ''))) {
      throw new Error(`unknown catalog layer for ${entry.id}: ${entry.layer}`)
    }
    if (!['ready', 'todo', 'skipped'].includes(entry.status)) {
      throw new Error(`unknown catalog status for ${entry.id}: ${entry.status}`)
    }
    if (entry.status === 'ready' && (!entry.file || !entry.owner)) {
      throw new Error(`ready case ${entry.id} needs file and owner`)
    }
    if (entry.status === 'skipped') {
      if (!entry.until || !entry.reason) {
        throw new Error(`skipped case ${entry.id} needs until and reason`)
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.until)) {
        throw new Error(`skipped case ${entry.id} has an invalid until date`)
      }
    }
  }
  return true
}

/** Catalog counters used by the board and by report `cases.catalog`. */
export function summarizeCatalog(catalog) {
  const stats = { total: 0, ready: 0, todo: 0, skipped: 0 }
  for (const entry of catalog?.cases ?? []) {
    stats.total += 1
    if (entry.status === 'ready') stats.ready += 1
    else if (entry.status === 'todo') stats.todo += 1
    else if (entry.status === 'skipped') stats.skipped += 1
  }
  return stats
}

/** Branch-level status shown in the repository table. */
export function deriveGateStatus(lanes) {
  const failing = lanes.some((lane) =>
    ['fail', 'error', 'not_run'].includes(lane?.verdict)
  )
  return failing ? 'failed' : 'passed'
}

/**
 * Reject anything that could poison the public dataset: wrong contract, wrong
 * repository identity, unknown lanes/verdicts, duplicate lanes, oversized JSON.
 */
export function validateSummary(summary, source) {
  if (!isObject(summary)) throw new Error('summary is not an object')
  if (summary.schema !== SUMMARY_SCHEMA) {
    throw new Error(`unsupported summary schema: ${summary.schema ?? '(none)'}`)
  }
  if (!isObject(source)) throw new Error('source is required')
  const expectedRepo =
    source.id ?? (source.owner && source.name ? `${source.owner}/${source.name}` : null)
  if (!expectedRepo) throw new Error('source needs id or owner/name')
  if (summary.repo !== expectedRepo) {
    throw new Error(`summary repo mismatch: expected ${expectedRepo}, got ${summary.repo}`)
  }
  if (source.owner && summary.owner !== source.owner) {
    throw new Error(`summary owner mismatch: expected ${source.owner}, got ${summary.owner}`)
  }
  if (source.name && summary.name !== source.name) {
    throw new Error(`summary name mismatch: expected ${source.name}, got ${summary.name}`)
  }
  if (!Array.isArray(summary.lanes)) throw new Error('summary.lanes must be an array')
  const seen = new Set()
  for (const lane of summary.lanes) {
    if (!isObject(lane)) throw new Error('summary lane is not an object')
    const id = normalizeLane(lane.id)
    if (!id) throw new Error(`unknown lane: ${lane.id}`)
    if (seen.has(id)) throw new Error(`duplicate lane: ${id}`)
    seen.add(id)
    if (!VERDICTS.includes(lane.verdict)) {
      throw new Error(`unknown verdict for ${id}: ${lane.verdict}`)
    }
    if (lane.trust !== undefined && !['trusted', 'provisional'].includes(lane.trust)) {
      throw new Error(`unknown trust for ${id}: ${lane.trust}`)
    }
  }
  if (summary.level !== undefined && !isGateLevel(summary.level)) {
    throw new Error(`unknown level: ${summary.level}`)
  }
  if (summary.stage !== undefined && !isGateStage(summary.stage)) {
    throw new Error(`unknown stage: ${summary.stage}`)
  }
  const bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
  if (bytes > SUMMARY_MAX_BYTES) {
    throw new Error(`summary too large: ${bytes} bytes > ${SUMMARY_MAX_BYTES}`)
  }
  return true
}

/**
 * The table's case cell predates ci-gates and expects the SD-board shape
 * (`layers`, `totalPlanned`). Keep that shape so the existing UI keeps
 * working, and carry the catalog counters as optional fields for tooltips.
 */
function toGateCaseCounts(summary) {
  if (!summary) return null
  const total = summary.total ?? summary.ready ?? 0
  return {
    passed: summary.passed ?? 0,
    planned: summary.ready ?? total,
    executed: summary.executed ?? 0,
    planOnlyPlanned: 0,
    totalPlanned: total,
    layers: [],
    todo: summary.todo ?? 0,
    notRun: summary.notRun ?? 0,
    ready: summary.ready ?? 0,
    total,
  }
}

/**
 * A lane is trusted unless it explicitly says otherwise. For older summaries
 * without `trust`, fall back to the event: a PR-tagged lane is provisional.
 */
function laneTrust(lane) {
  if (lane.trust) return lane.trust
  if (lane.lastEvent && !isTrustedEvent(lane.lastEvent)) return 'provisional'
  return 'trusted'
}

function laneToStat(lane, summary, source, generatedAt) {
  const history = normalizeHistory(lane.history)
  const daily =
    history.length > 0
      ? history
      : synthesizeHistory(lane, summary.generatedAt ?? generatedAt)
  const cases = toGateCaseCounts(normalizeCaseSummary(lane.cases))
  return {
    category: LANE_TO_CATEGORY[lane.id],
    daily,
    link:
      lane.lastRunUrl ??
      summary.boardUrl ??
      source.summaryUrl ??
      null,
    ...(cases ? { cases } : {}),
    latest: {
      verdict: lane.verdict,
      trust: laneTrust(lane),
      event: lane.lastEvent,
      runId: lane.lastRunId,
      runAt: lane.lastRunAt,
      runUrl: lane.lastRunUrl,
      sha: lane.lastSha,
      observe: summary.observeUntil ? [{ until: summary.observeUntil }] : [],
      waivers: [],
      results: [],
    },
  }
}

/**
 * Normalize a board summary into the dashboard dataset. The public dataset
 * carries only whitelisted fields; PR-provisional lanes are dropped so they
 * cannot drive the table or the onboarding funnel.
 */
export function buildDatasetFromSummary(source, summary, options = {}) {
  validateSummary(summary, source)
  const now = options.now instanceof Date ? options.now : new Date()
  const windowDays = Number(options.windowDays ?? summary.windowDays ?? 30)
  const generatedAt = now.toISOString()
  const owner = summary.owner
  const name = summary.name
  const branchName = source.defaultBranch ?? summary.defaultBranch ?? 'main'
  const boardUrl = summary.boardUrl ?? source.boardUrl

  const trustedLanes = summary.lanes.filter(
    (lane) => laneTrust(lane) !== 'provisional'
  )
  const stats = trustedLanes.map((lane) =>
    laneToStat({ ...lane, id: normalizeLane(lane.id) }, summary, source, generatedAt)
  )
  const caseSummary =
    normalizeCaseSummary(summary.caseSummary) ??
    normalizeCaseSummary(trustedLanes.find((lane) => lane.id === 'build')?.cases) ??
    undefined

  return {
    schema: 'ci-gates/dashboard-repo@1',
    id: source.id ?? `${owner}/${name}`,
    name,
    owner,
    defaultBranch: branchName,
    url: source.url ?? `https://github.com/${owner}/${name}`,
    generatedAt,
    sourceUrl:
      source.summaryUrl ?? defaultSummaryUrl(source.owner, source.name) ?? null,
    sourceType: 'board-summary',
    windowDays,
    ...(isGateLevel(summary.level) ? { level: summary.level } : {}),
    ...(summary.preset ? { preset: summary.preset } : {}),
    ...(summary.gatesVersion ? { gatesVersion: summary.gatesVersion } : {}),
    stage: deriveStage(summary, now),
    ...(boardUrl ? { boardUrl } : {}),
    ...(caseSummary ? { caseSummary } : {}),
    branchData: [
      {
        name: branchName,
        gateStatus: deriveGateStatus(trustedLanes),
        coverage: toNumber(summary.coverage),
        ...(boardUrl ? { coverageLink: `${boardUrl}#coverage` } : {}),
        ...(caseSummary ? { caseSummary } : {}),
        stats,
      },
    ],
  }
}

/** Lightweight index entry so the overview funnel does not refetch datasets. */
export function summaryIndexEntry(source, dataset) {
  return {
    id: dataset.id,
    name: dataset.name,
    owner: dataset.owner,
    file: `${dataset.owner}/${dataset.name}.json`,
    ...(dataset.sourceUrl ? { sourceUrl: dataset.sourceUrl } : {}),
    sourceType: 'board-summary',
    ...(dataset.level ? { level: dataset.level } : {}),
    ...(dataset.stage ? { stage: dataset.stage } : {}),
    ...(dataset.boardUrl ? { boardUrl: dataset.boardUrl } : {}),
    windowDays: dataset.windowDays,
  }
}
