import { useMemo } from 'react'
import { useMonitorCore } from '@/lib/monitor/data'
import { computePeriodMetrics, previousRange } from '@/lib/monitor/derive'
import { resolveRange, type TimeRangeSearch } from '@/lib/monitor/ranges'

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Shared derivation for every monitor page: resolves the URL time range
 * against the dataset and computes current + previous period metrics.
 */
export function useMonitorBase(repo: string, search: TimeRangeSearch) {
  const core = useMonitorCore(repo)
  const history = useMemo(() => core.history.data ?? [], [core.history.data])

  const now = useMemo(() => {
    return (
      toDate(core.latest.data?.generatedAt) ??
      toDate(core.meta.data?.lastSuccessAt) ??
      new Date()
    )
  }, [core.latest.data, core.meta.data])

  const boundStart = useMemo(() => {
    if (history.length > 0) return toDate(`${history[0].date}T00:00:00.000Z`)
    return toDate(core.meta.data?.monitoringStart)
  }, [history, core.meta.data])

  const range = useMemo(
    () => resolveRange(search, now, boundStart),
    [search, now, boundStart]
  )

  const current = useMemo(
    () => computePeriodMetrics(history, range),
    [history, range]
  )

  const prevRange = useMemo(() => previousRange(range), [range])
  const previous = useMemo(
    () => (prevRange ? computePeriodMetrics(history, prevRange) : null),
    [history, prevRange]
  )

  return {
    ...core,
    history,
    now,
    boundStart,
    range,
    prevRange,
    current,
    previous,
  }
}
