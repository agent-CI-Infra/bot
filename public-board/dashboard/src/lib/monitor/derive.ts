import type { ResolvedRange } from './ranges'
import type {
  HistoryPoint,
  IssueRecord,
  PullRecord,
  ContributionType,
  ContributorRecord,
} from './types'

const DAY_MS = 24 * 60 * 60 * 1000

/** Window the community activity score is measured over. */
export const ACTIVITY_WINDOW_DAYS = 30

/**
 * Indicators of the community activity score: the reference threshold each
 * value is measured against, and its weight in the weighted sum.
 */
export const ACTIVITY_INDICATORS = [
  { label: '贡献者数量', threshold: 3000, weight: 0.4 },
  { label: '新增 Issue 数量', threshold: 3000, weight: 0.15 },
  { label: '新增 PR 数量', threshold: 5000, weight: 0.15 },
  { label: 'Issue 平均评论数', threshold: 5, weight: 0.15 },
  { label: 'PR 平均评论数', threshold: 8, weight: 0.15 },
] as const

/**
 * Community activity score over the last `ACTIVITY_WINDOW_DAYS` days. Each
 * indicator's achievement grows logarithmically towards its threshold and the
 * results are combined by weight:
 *
 *   C = (1 / Σαᵢ) · Σ αᵢ · ln(1 + Sᵢ) / ln(1 + max(Sᵢ, Tᵢ))
 *
 * where Sᵢ is the indicator's observed value and Tᵢ its threshold.
 */
export function activityScore(
  pulls: PullRecord[],
  issues: IssueRecord[],
  contributors: ContributorRecord[],
  now = new Date()
): number {
  const windowStart = new Date(
    now.getTime() - ACTIVITY_WINDOW_DAYS * DAY_MS
  ).toISOString()

  const newPulls = pulls.filter((p) => p.createdAt >= windowStart)
  const newIssues = issues.filter((i) => i.createdAt >= windowStart)
  const mean = (records: { comments: number }[]) =>
    records.length === 0
      ? 0
      : records.reduce((sum, r) => sum + r.comments, 0) / records.length

  const values = [
    contributors.filter(
      (c) => !c.isBot && (c.lastContributionAt ?? '') >= windowStart
    ).length,
    newIssues.length,
    newPulls.length,
    mean(newIssues),
    mean(newPulls),
  ]

  const totalWeight = ACTIVITY_INDICATORS.reduce(
    (sum, indicator) => sum + indicator.weight,
    0
  )
  const weighted = ACTIVITY_INDICATORS.reduce((sum, indicator, index) => {
    const value = values[index]
    const ratio =
      Math.log(1 + value) / Math.log(1 + Math.max(value, indicator.threshold))
    return sum + indicator.weight * ratio
  }, 0)

  return weighted / totalWeight
}

export function toDayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function isInRange(iso: string | null, range: ResolvedRange): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return false
  if (range.from && t < range.from.getTime()) return false
  if (t >= range.to.getTime() + DAY_MS) return false
  return true
}

export function sliceHistory(
  history: HistoryPoint[],
  range: ResolvedRange
): HistoryPoint[] {
  return history.filter((p) => {
    const t = new Date(`${p.date}T00:00:00.000Z`).getTime()
    if (range.from && t < range.from.getTime()) return false
    if (t > range.to.getTime()) return false
    return true
  })
}

type CumulativeKey = 'stars' | 'forks' | 'watchers' | 'openPulls' | 'openIssues'
type ActivityKey =
  | 'newPulls'
  | 'mergedPulls'
  | 'closedUnmergedPulls'
  | 'newIssues'
  | 'closedIssues'

/**
 * Delta of a cumulative counter over the range, using the last snapshot
 * *before* the range as the baseline so partial days are not double counted.
 */
export function cumulativeDelta(
  history: HistoryPoint[],
  range: ResolvedRange,
  key: CumulativeKey
): { value: number | null; fullBaseline: boolean } {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date))
  const fromTime = range.from ? range.from.getTime() : null

  let baselineIdx = -1
  let lastIdx = -1
  for (let i = 0; i < sorted.length; i++) {
    const t = new Date(`${sorted[i].date}T00:00:00.000Z`).getTime()
    if (fromTime !== null && t < fromTime) baselineIdx = i
    if (t <= range.to.getTime()) lastIdx = i
  }

  if (lastIdx === -1) return { value: null, fullBaseline: false }
  const last = sorted[lastIdx][key]
  if (range.from === null) {
    // All history: compare against the very first snapshot.
    return { value: null, fullBaseline: false }
  }
  const hasBaseline = baselineIdx !== -1
  const baseline = hasBaseline ? sorted[baselineIdx][key] : sorted[lastIdx][key]
  return { value: last - baseline, fullBaseline: hasBaseline }
}

export function activitySum(
  history: HistoryPoint[],
  range: ResolvedRange,
  key: ActivityKey
): number {
  return sliceHistory(history, range).reduce((acc, p) => acc + (p[key] ?? 0), 0)
}

export type PeriodMetrics = {
  starsDelta: number | null
  forksDelta: number | null
  openPullsDelta: number | null
  openIssuesDelta: number | null
  newPulls: number
  mergedPulls: number
  closedUnmergedPulls: number
  newIssues: number
  closedIssues: number
  points: number
  baselineComplete: boolean
}

export function computePeriodMetrics(
  history: HistoryPoint[],
  range: ResolvedRange
): PeriodMetrics {
  const stars = cumulativeDelta(history, range, 'stars')
  const forks = cumulativeDelta(history, range, 'forks')
  const openPulls = cumulativeDelta(history, range, 'openPulls')
  const openIssues = cumulativeDelta(history, range, 'openIssues')
  const points = sliceHistory(history, range).length

  return {
    starsDelta: stars.value,
    forksDelta: forks.value,
    openPullsDelta: openPulls.value,
    openIssuesDelta: openIssues.value,
    newPulls: activitySum(history, range, 'newPulls'),
    mergedPulls: activitySum(history, range, 'mergedPulls'),
    closedUnmergedPulls: activitySum(history, range, 'closedUnmergedPulls'),
    newIssues: activitySum(history, range, 'newIssues'),
    closedIssues: activitySum(history, range, 'closedIssues'),
    points,
    baselineComplete: stars.fullBaseline,
  }
}

/** The equally sized window immediately before `range`, if bounded. */
export function previousRange(range: ResolvedRange): ResolvedRange | null {
  if (!range.from || !range.days) return null
  const to = new Date(range.from.getTime() - DAY_MS)
  const from = new Date(to.getTime() - (range.days - 1) * DAY_MS)
  return {
    key: 'previous',
    from,
    to,
    days: range.days,
    label: '上一周期',
  }
}

/**
 * Unique authors with a PR or Issue created inside the window, split into the
 * overall count and how many of them are external contributors (based on each
 * record's `contributionType`). Bots ("unknown") are neither internal nor
 * external, so they are excluded — the same split used everywhere else.
 */
export function activeContributorsSplit(
  pulls: PullRecord[],
  issues: IssueRecord[],
  range: ResolvedRange
): { total: number; external: number } {
  const all = new Set<string>()
  const external = new Set<string>()
  const add = (author: string, type: ContributionType) => {
    if (type === 'unknown') return
    all.add(author)
    if (type === 'external') external.add(author)
  }
  for (const p of pulls) {
    if (!isInRange(p.createdAt, range)) continue
    add(p.author, p.contributionType)
  }
  for (const i of issues) {
    if (!isInRange(i.createdAt, range)) continue
    add(i.author, i.contributionType)
  }
  return { total: all.size, external: external.size }
}

export function compositionOf(
  records: { contributionType: ContributionType }[]
): Record<ContributionType, number> {
  const out: Record<ContributionType, number> = {
    internal: 0,
    external: 0,
    unknown: 0,
  }
  for (const r of records) out[r.contributionType] += 1
  return out
}

/** Bucket numeric values into labeled ranges for distribution charts. */
export function bucketValues(
  values: number[],
  edges: number[],
  labels: string[]
): { bucket: string; count: number }[] {
  const counts = labels.map(() => 0)
  for (const v of values) {
    let placed = false
    for (let i = 0; i < edges.length; i++) {
      if (v <= edges[i]) {
        counts[i] += 1
        placed = true
        break
      }
    }
    if (!placed) counts[labels.length - 1] += 1
  }
  return labels.map((bucket, i) => ({ bucket, count: counts[i] }))
}

/** Age distribution (in days) for currently open issues. */
export function issueAgeBuckets(
  issues: IssueRecord[],
  now: Date
): { bucket: string; count: number }[] {
  const labels = ['<7d', '7-30d', '30-90d', '90-180d', '>180d']
  const edges = [7, 30, 90, 180]
  const ages = issues
    .filter((i) => i.state === 'open')
    .map((i) => (now.getTime() - new Date(i.createdAt).getTime()) / DAY_MS)
  return bucketValues(ages, edges, labels)
}

/**
 * The `p`-th percentile (0–1) of numeric values, using the nearest-rank
 * method. Returns `null` for an empty list.
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(p * sorted.length) - 1)
  )
  return sorted[rank]
}
