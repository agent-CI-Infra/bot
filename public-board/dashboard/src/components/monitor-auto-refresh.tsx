import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'

/** How often an open page re-reads the published monitor data. */
const REFRESH_INTERVAL_MS = 60 * 60 * 1000

/**
 * Re-reads the published monitor data once an hour so a page left open keeps
 * showing the latest snapshot without a manual refresh.
 */
export function MonitorAutoRefresh() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const timer = setInterval(() => {
      void queryClient.refetchQueries({ queryKey: ['monitor'] })
    }, REFRESH_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [queryClient])

  return null
}
