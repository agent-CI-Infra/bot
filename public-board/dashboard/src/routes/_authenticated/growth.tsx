import { createFileRoute } from '@tanstack/react-router'
import { timeRangeSearchSchema } from '@/lib/monitor/ranges'
import { GrowthTrends } from '@/features/community/growth'

export const Route = createFileRoute('/_authenticated/growth')({
  validateSearch: timeRangeSearchSchema,
  component: GrowthTrends,
})
