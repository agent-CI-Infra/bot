import z from 'zod'

export const TIME_RANGES = ['7d', '30d', 'all'] as const
export type TimeRangeKey = (typeof TIME_RANGES)[number]

export type ResolvedRange = {
  /** `previous` marks the comparison window emitted by `previousRange`. */
  key: TimeRangeKey | 'previous'
  /** Inclusive start (UTC). null = unbounded (all history). */
  from: Date | null
  /** Exclusive end (UTC). */
  to: Date
  /** Number of whole days covered, or null when unbounded. */
  days: number | null
  label: string
}

export const TIME_RANGE_LABELS: Record<TimeRangeKey, string> = {
  '7d': '最近 7 天',
  '30d': '最近 30 天',
  all: '全部历史',
}

/** Shared `validateSearch` schema used by every monitor page. */
export const timeRangeSearchSchema = z.object({
  /** Selected repository key (`owner/name`). Absent = first monitored repo. */
  repo: z.string().optional().catch(undefined),
  range: z.enum(TIME_RANGES).optional().catch('30d'),
})

export type TimeRangeSearch = z.infer<typeof timeRangeSearchSchema>

const DAY_MS = 24 * 60 * 60 * 1000

function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  )
}

/**
 * Resolve the URL search state into a concrete UTC window.
 *
 * `now` should be the latest collection timestamp so that ranges are stable
 * for a given dataset instead of drifting with wall-clock time.
 */
export function resolveRange(
  search: TimeRangeSearch,
  now: Date,
  boundStart: Date | null
): ResolvedRange {
  const key = search.range ?? '30d'
  const to = startOfUtcDay(now)

  if (key === 'all') {
    return {
      key,
      from: boundStart,
      to,
      days: boundStart
        ? Math.max(
            1,
            Math.round((to.getTime() - boundStart.getTime()) / DAY_MS) + 1
          )
        : null,
      label: TIME_RANGE_LABELS.all,
    }
  }

  const days = key === '7d' ? 7 : 30
  const from = new Date(to.getTime() - (days - 1) * DAY_MS)
  return { key, from, to, days, label: TIME_RANGE_LABELS[key] }
}
