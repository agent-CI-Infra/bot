import { createFileRoute } from '@tanstack/react-router'
import { timeRangeSearchSchema } from '@/lib/monitor/ranges'
import { VersionsAnalysis } from '@/features/community/versions'

export const Route = createFileRoute('/_authenticated/versions')({
  validateSearch: timeRangeSearchSchema,
  component: VersionsAnalysis,
})
