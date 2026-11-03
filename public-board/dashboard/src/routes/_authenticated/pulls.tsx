import { createFileRoute } from '@tanstack/react-router'
import { timeRangeSearchSchema } from '@/lib/monitor/ranges'
import { PullsAnalysis } from '@/features/community/pulls'

export const Route = createFileRoute('/_authenticated/pulls')({
  validateSearch: timeRangeSearchSchema,
  component: PullsAnalysis,
})
