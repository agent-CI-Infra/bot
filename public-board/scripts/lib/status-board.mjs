/**
 * Status-board snapshot adapters.
 *
 * `status-board-lanes` sources already publish the per-day lane buckets the
 * gate overview consumes. The board may also publish a `gates` block (latest
 * ci-gates verdict, compliance level, onboarding stage, case counters) and a
 * resolved coverage value; both are repo-level and must only be attached to
 * the branch the board measured. Everything here is pure so the collector
 * stays easy to test without network access.
 */

import { isGateLevel, isGateStage } from './ci-gates.mjs'

/**
 * The board's gate lanes use ci-gates lane ids (`pr-ready`, `pr-merge`…),
 * while the overview columns use shorter ids.
 */
const GATE_LANE_TO_COLUMN = Object.freeze({
  build: 'build',
  'pr-ready': 'ready',
  'pr-merge': 'merge',
  daily: 'daily',
  release: 'release',
})

function count(value) {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.round(value))
    : 0
}

/** Repo-level case counters published by the board (`gates.cases`). */
export function boardCaseSummary(gates) {
  const cases = gates?.cases
  if (!cases || typeof cases !== 'object') return null
  return {
    total: count(cases.total),
    ready: count(cases.ready),
    todo: count(cases.todo),
    skipped: count(cases.skipped),
    executed: count(cases.executed),
    passed: count(cases.passed),
    notRun: count(cases.notRun),
  }
}

/**
 * Latest board verdict per overview column, plus the level/stage/case summary.
 * The board's gate block belongs to one run/branch, so it is ignored for other
 * branch lines. When the snapshot omits the run branch, the source's default
 * branch is assumed.
 */
export function boardGateMeta(snapshot, branchName, defaultBranch) {
  const gates = snapshot?.sections?.ci?.data?.gates
  if (!gates || typeof gates !== 'object') return null
  const runBranch = gates.run?.branch ?? defaultBranch
  if (runBranch && branchName && runBranch !== branchName) return null

  const lanes = Array.isArray(gates.lanes) ? gates.lanes : []
  const level = lanes.map((lane) => lane?.level).find(isGateLevel)
  const latestByCategory = new Map()
  for (const lane of lanes) {
    const category = GATE_LANE_TO_COLUMN[lane?.lane]
    if (!category || !lane?.verdict) continue
    latestByCategory.set(category, {
      verdict: lane.verdict,
      ...(lane.event ? { event: lane.event } : {}),
      ...(gates.run?.id ? { runId: gates.run.id } : {}),
      ...(gates.run?.created_at ? { runAt: gates.run.created_at } : {}),
      ...(gates.run?.url ? { runUrl: gates.run.url } : {}),
      ...(lane.sha ?? gates.run?.sha
        ? { sha: lane.sha ?? gates.run.sha }
        : {}),
      ...(Array.isArray(lane.results) && lane.results.length > 0
        ? { results: lane.results }
        : {}),
    })
  }

  return {
    ...(level ? { level } : {}),
    ...(isGateStage(gates.stage) ? { stage: gates.stage } : {}),
    caseSummary: boardCaseSummary(gates),
    latestByCategory,
  }
}

/** Coverage the board already resolved (line coverage wins). */
export function snapshotCoverage(snapshot) {
  const coverage = snapshot?.sections?.tests?.data?.coverage
  const value = coverage?.value
  const lines = value?.lines_pct
  if (typeof lines !== 'number' || !Number.isFinite(lines)) return null
  const detail = {}
  for (const metric of ['lines', 'branches', 'functions']) {
    const pct = value?.[`${metric}_pct`]
    if (typeof pct === 'number' && Number.isFinite(pct)) detail[metric] = pct
  }
  return {
    coverage: Math.round(lines * 10) / 10,
    coverageDetail: detail,
    coverageSource: coverage?.source ?? 'snapshot',
  }
}

/**
 * Default board lane → dashboard gate column. A source can override this with
 * `laneMap` when its board does not publish every lane the default mapping
 * assumes (for example DigitalMate only exposes PR and Daily gates).
 */
const DEFAULT_LANE_MAP = Object.freeze({
  pr: 'ready',
  // SD's 主干 lane (main push / manual) is the post-merge gate.
  main: 'merge',
  daily: 'daily',
  release: 'release',
})

/** Source lane map, falling back to the SD-compatible default. */
export function laneMapOf(source) {
  const map = source?.laneMap
  return map && typeof map === 'object' && !Array.isArray(map)
    ? map
    : DEFAULT_LANE_MAP
}

/**
 * One status-board lane block → the dashboard branch shape. Lanes absent from
 * the source's map are ignored, so a board that only gates PR and Daily does
 * not fabricate merge/release cells from unrelated CI lanes.
 */
export function lanesToBranch(laneData, source) {
  const days = laneData?.days ?? []
  const laneMap = laneMapOf(source)
  const stats = []
  for (const lane of laneData?.lanes ?? []) {
    const category = laneMap[lane.key]
    if (!category) continue
    const byDay = new Map()
    lane.days?.forEach((cells, index) => {
      const date = days[index]
      if (!date || !Array.isArray(cells) || cells.length === 0) return
      const bucket = {
        date,
        pass: 0,
        fail: 0,
        ignored: 0,
        retries: 0,
        durations: [],
      }
      for (const run of cells) {
        const outcome = run?.outcome ?? run?.conclusion
        if (outcome === 'success') bucket.pass += 1
        else if (outcome === 'failure') bucket.fail += 1
        else bucket.ignored += 1
        if ((run?.attempt ?? 1) > 1) bucket.retries += 1
        if (typeof run?.duration_s === 'number' && run.duration_s > 0) {
          bucket.durations.push(run.duration_s)
        }
      }
      byDay.set(date, bucket)
    })
    if (byDay.size === 0) continue
    stats.push({
      category,
      daily: [...byDay.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
      ...(source.boardBaseUrl ? { link: `${source.boardBaseUrl}#ci` } : {}),
    })
  }
  if (stats.length === 0) return null
  // Keep the order declared by the source's lane map.
  const order = new Map(
    Object.keys(laneMap).map((key, index) => [laneMap[key], index])
  )
  stats.sort(
    (a, b) =>
      (order.get(a.category) ?? Infinity) - (order.get(b.category) ?? Infinity)
  )
  const latest =
    laneData?.lanes?.find((lane) => lane.key === 'main') ??
    laneData?.lanes?.find((lane) => lane.summary?.total)
  const rate = latest?.summary?.success_rate
  return {
    name: laneData?.branch ?? source.defaultBranch,
    gateStatus: rate == null ? 'passed' : rate >= 50 ? 'passed' : 'failed',
    coverage: null,
    stats,
  }
}
