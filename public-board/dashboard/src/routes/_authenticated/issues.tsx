import { createFileRoute } from '@tanstack/react-router'
import { timeRangeSearchSchema } from '@/lib/monitor/ranges'
import { IssuesAnalysis } from '@/features/community/issues'

export const Route = createFileRoute('/_authenticated/issues')({
  validateSearch: timeRangeSearchSchema,
  component: IssuesAnalysis,
})
