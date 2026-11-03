import { createFileRoute } from '@tanstack/react-router'
import { timeRangeSearchSchema } from '@/lib/monitor/ranges'
import { CommunityOverview } from '@/features/community/overview'

export const Route = createFileRoute('/_authenticated/')({
  validateSearch: timeRangeSearchSchema,
  component: CommunityOverview,
})
