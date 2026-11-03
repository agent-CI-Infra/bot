/**
 * AgentGate · gate domain types, category metadata and demo data.
 * Numbers are design-mock placeholders until CI pipelines publish real
 * per-branch gate results.
 */

export type GateCategory = 'build' | 'ready' | 'merge' | 'daily' | 'release'
export type GateRunStatus = 'passed' | 'failed' | 'running'
/** Per-category health derived from pass rate thresholds. */
export type GateHealth = 'pass' | 'warn' | 'fail'

/** ci-gates compliance level. */
export type GateLevel = 'C0' | 'C1' | 'C2' | 'C3' | 'C4'

/** Onboarding stage derived from the latest trusted reports. */
export type GateStage =
  | 'discovered'
  | 'gates-running'
  | 'cases-pending'
  | 'observing'
  | 'enforced'
  | 'failing'

/** Whether a report comes from a trusted lane event or a PR (provisional). */
export type GateTrust = 'trusted' | 'provisional' | 'unknown'

/**
 * Case catalog + execution counters (ci-gates `case-catalog@1`).
 * `todo` / `notRun` are onboarding signals, never "pass".
 */
export interface GateCaseSummary {
  total: number
  ready: number
  todo: number
  skipped: number
  executed: number
  passed: number
  notRun: number
}

/** Latest lane verdict / run metadata (from a board summary). */
export interface GateLatest {
  verdict: string
  trust?: GateTrust
  event?: string
  runId?: number
  runAt?: string
  runUrl?: string
  sha?: string
  observe?: unknown[]
  waivers?: unknown[]
  results?: unknown[]
}

/** One test layer inside the latest run of a gate category. */
export interface GateCaseLayer {
  name: string
  planned: number
  executed: number
  passed: number
  /** True when only the plan (case list) is published, not per-case results. */
  planOnly?: boolean
}

/** Case counts of the latest run of a gate category (SD-board aligned). */
export interface GateCaseCounts {
  passed: number
  planned: number
  executed: number
  planOnlyPlanned: number
  totalPlanned: number
  runUrl?: string
  runAt?: string
  layers: GateCaseLayer[]
  /** Catalog/onboarding counters when the source is ci-gates. */
  todo?: number
  notRun?: number
  ready?: number
  total?: number
}

export interface RepoCategoryStat {
  category: GateCategory
  /** Latest lane verdict / run metadata when a board summary is available. */
  latest?: GateLatest
  /**
   * Pass rate over the selected window (success / decided runs);
   * null when every run in the window is undecided (skipped/cancelled).
   */
  passRate: number | null
  avgDurationSec: number | null
  /** Canary-style runs still in progress → renders "2h 51m+". */
  ongoing?: boolean
  /** All matched runs in the selected window. */
  runs: number
  health: GateHealth
  /** Deep link to where this metric is presented on the source dashboard. */
  link?: string
  /** Test-case counts of the newest run of this category. */
  cases?: GateCaseCounts
}

/** Gate metrics for one branch of a repository. */
export interface RepoBranchStat {
  name: string
  gateStatus: GateRunStatus
  /** UT coverage %, red below the 75% threshold; null when unavailable. */
  coverage: number | null
  /** Deep link to the coverage view of the source dashboard. */
  coverageLink?: string
  /** Repository-level case counters for this branch. */
  caseSummary?: GateCaseSummary
  stats: RepoCategoryStat[]
}

export interface GateRepo {
  id: string
  name: string
  owner: string
  /** Branch shown by default (first entry of branchData). */
  defaultBranch: string
  branchData: RepoBranchStat[]
  /** Optional external dashboard opened when the repo name is clicked. */
  url?: string
  /** True for repositories whose numbers are still design placeholders. */
  demo?: boolean
  /** ci-gates compliance level (C0–C4). */
  level?: GateLevel
  /** Onboarding stage derived from the latest trusted reports. */
  stage?: GateStage
  /** Per-repository board (deep view), when the repo publishes one. */
  boardUrl?: string
  /** Repository-level case counters (merged across lanes). */
  caseSummary?: GateCaseSummary
}

export interface GateCategoryMeta {
  id: GateCategory
  description: string
  /** Pass-rate colorization thresholds, per the approved design. */
  warnBelow: number
  failBelow: number
}

export const GATE_LEVELS: GateLevel[] = ['C0', 'C1', 'C2', 'C3', 'C4']

export function isGateLevel(value: unknown): value is GateLevel {
  return GATE_LEVELS.includes(value as GateLevel)
}

export function isGateStage(value: unknown): value is GateStage {
  return GATE_STAGES.includes(value as GateStage)
}

/** Funnel order: onboarding first, failure last. */
export const GATE_STAGES: GateStage[] = [
  'discovered',
  'gates-running',
  'cases-pending',
  'observing',
  'enforced',
  'failing',
]

export const GATE_CATEGORIES: GateCategoryMeta[] = [
  {
    id: 'build',
    // The SD board publishes no commit/build lane, so this column renders
    // empty until one exists upstream.
    description: 'Commit & PR base gate (not published by the SD board)',
    warnBelow: 90,
    failBelow: 80,
  },
  { id: 'ready', description: 'PR gate', warnBelow: 90, failBelow: 80 },
  {
    id: 'merge',
    description: 'Merge gate',
    warnBelow: 90,
    failBelow: 80,
  },
  { id: 'daily', description: 'Nightly (L4)', warnBelow: 90, failBelow: 80 },
  {
    id: 'release',
    description: 'Release (L5)',
    warnBelow: 95,
    failBelow: 80,
  },
]

const CATEGORY_MAP = new Map(GATE_CATEGORIES.map((c) => [c.id, c]))

export function getCategoryMeta(category: GateCategory): GateCategoryMeta {
  const meta = CATEGORY_MAP.get(category)
  if (!meta) throw new Error(`Unknown gate category: ${category}`)
  return meta
}

export function passRateHealth(
  category: GateCategory,
  passRate: number
): GateHealth {
  const { warnBelow, failBelow } = getCategoryMeta(category)
  if (passRate < failBelow) return 'fail'
  if (passRate < warnBelow) return 'warn'
  return 'pass'
}

/** Count repos below the coverage gate threshold (75%). */
export const COVERAGE_THRESHOLD = 75

function stat(
  category: GateCategory,
  passRate7d: number,
  avgDurationSec: number | null,
  runs7d: number,
  ongoing?: boolean
): RepoCategoryStat {
  return {
    category,
    passRate: passRate7d,
    avgDurationSec,
    runs: runs7d,
    ongoing,
    health: passRateHealth(category, passRate7d),
  }
}

function branch(
  name: string,
  gateStatus: GateRunStatus,
  coverage: number,
  stats: RepoCategoryStat[]
): RepoBranchStat {
  return { name, gateStatus, coverage, stats }
}

export const GATE_REPOS: GateRepo[] = [
  {
    id: 'sciencediscovery',
    name: 'sciencediscovery',
    owner: 'openJiuwen-ai',
    defaultBranch: 'main',
    url: '/boards/openjiuwen-ai/sciencediscovery/#overview',
    branchData: [
      branch('main', 'failed', 71.2, [
        stat('ready', 93.8, 1300, 298),
        stat('daily', 85.1, 10260, 32, true),
        stat('release', 100, 18720, 4),
      ]),
      branch('release/v1.4', 'passed', 78.6, [
        stat('ready', 96.1, 1265, 96),
        stat('daily', 88.9, 9980, 12),
        stat('release', 96.7, 17600, 2),
      ]),
      branch('feat/mcp-tools', 'running', 69.8, [
        stat('ready', 84.5, 1420, 41),
      ]),
    ],
  },
]

export function countReposByStatus(repos: { gateStatus: GateRunStatus }[]) {
  const counts = { passed: 0, failed: 0, running: 0 }
  for (const repo of repos) counts[repo.gateStatus] += 1
  return counts
}
