import { useQuery } from '@tanstack/react-query'
import {
  isGateLevel,
  isGateStage,
  passRateHealth,
  type GateCaseCounts,
  type GateCaseSummary,
  type GateCategory,
  type GateHealth,
  type GateLatest,
  type GateRepo,
  type GateRunStatus,
  type RepoCategoryStat,
} from '@/features/gate/data/gate'

/**
 * Real gate datasets collected by `scripts/collect-gate.mjs` into
 * `public/data/gate/` (same static-snapshot pattern as the community data).
 * Repositories without a published dataset keep their demo entry, which the
 * overview merges in as a fallback.
 */
const DATA_DIR = `${import.meta.env.BASE_URL}data/gate`

async function fetchJson<T>(file: string): Promise<T> {
  const res = await fetch(`${DATA_DIR}/${file}`, { cache: 'no-cache' })
  if (!res.ok) throw new Error(`Failed to load ${file} (HTTP ${res.status})`)
  return (await res.json()) as T
}

type GateIndex = {
  generatedAt: string
  windowDays: number
  sources: {
    id: string
    owner: string
    name: string
    file: string
    level?: string
    stage?: string
    boardUrl?: string
  }[]
}

/** One UTC day of runs for a category (what the collector publishes). */
type DayBucket = {
  date: string
  pass: number
  fail: number
  ignored: number
  retries: number
  durations: number[]
}

type RawStat = {
  category: GateCategory
  daily: DayBucket[]
  link?: string | null
  cases?: GateCaseCounts | null
  latest?: GateLatest | null
}

type RawBranch = {
  name: string
  gateStatus: GateRunStatus
  coverage: number | null
  coverageLink?: string | null
  caseSummary?: GateCaseSummary | null
  stats: RawStat[]
  recentRuns?: unknown[]
}

type RawRepo = {
  id: string
  name: string
  owner: string
  defaultBranch: string
  url?: string | null
  generatedAt?: string
  sourceUrl?: string
  sourceType?: string
  windowDays?: number
  level?: string | null
  stage?: string | null
  boardUrl?: string | null
  caseSummary?: GateCaseSummary | null
  branchData: RawBranch[]
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid]
}

/** First UTC day included in a `windowDays`-long window ending today. */
function windowCutoff(windowDays: number): string {
  const cutoff = new Date(Date.now() - (windowDays - 1) * 24 * 60 * 60 * 1000)
  return cutoff.toISOString().slice(0, 10)
}

/** Latest verdict overrides the pass-rate tier for non-green states. */
function latestHealth(verdict: string | undefined): GateHealth | null {
  if (verdict === 'fail' || verdict === 'error' || verdict === 'not_run') {
    return 'fail'
  }
  if (verdict === 'waived' || verdict === 'observe_fail') return 'warn'
  return null
}

/** Aggregate the published daily buckets over the selected window. */
function toStat(stat: RawStat, cutoff: string): RepoCategoryStat {
  const days = stat.daily.filter((day) => day.date >= cutoff)
  let pass = 0
  let fail = 0
  let runs = 0
  const durations: number[] = []
  for (const day of days) {
    pass += day.pass
    fail += day.fail
    runs += day.pass + day.fail + day.ignored
    durations.push(...day.durations)
  }
  const decided = pass + fail
  const passRate = decided > 0 ? Math.round((pass / decided) * 1000) / 10 : null
  const health: GateHealth =
    latestHealth(stat.latest?.verdict) ??
    (passRate == null ? 'warn' : passRateHealth(stat.category, passRate))
  return {
    category: stat.category,
    passRate,
    avgDurationSec: median(durations),
    runs,
    health,
    link: stat.link ?? undefined,
    cases: stat.cases ?? undefined,
    latest: stat.latest ?? undefined,
  }
}

/** Raw datasets → dashboard shape, aggregated for the selected window. */
export function deriveGateRepos(
  datasets: RawRepo[],
  windowDays: number
): GateRepo[] {
  const cutoff = windowCutoff(windowDays)
  return datasets.map((raw) => ({
    id: raw.id,
    name: raw.name,
    owner: raw.owner,
    defaultBranch: raw.defaultBranch,
    url: raw.url ?? undefined,
    level: isGateLevel(raw.level) ? raw.level : undefined,
    stage: isGateStage(raw.stage) ? raw.stage : undefined,
    boardUrl: raw.boardUrl ?? undefined,
    caseSummary: raw.caseSummary ?? undefined,
    branchData: raw.branchData.map((branch) => ({
      name: branch.name,
      gateStatus: branch.gateStatus,
      coverage: branch.coverage ?? null,
      coverageLink: branch.coverageLink ?? undefined,
      caseSummary: branch.caseSummary ?? raw.caseSummary ?? undefined,
      stats: branch.stats.map((stat) => toStat(stat, cutoff)),
    })),
  }))
}

/** Raw published datasets (aggregation happens per selected window). */
export function useGateDatasets() {
  return useQuery({
    queryKey: ['gate', 'datasets'],
    queryFn: async (): Promise<RawRepo[]> => {
      const index = await fetchJson<GateIndex>('index.json')
      return Promise.all(
        (index.sources ?? []).map((source) => fetchJson<RawRepo>(source.file))
      )
    },
    staleTime: 5 * 60 * 1000,
    retry: 1,
  })
}
