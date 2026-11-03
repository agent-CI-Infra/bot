import { createFileRoute } from '@tanstack/react-router'
import { timeRangeSearchSchema } from '@/lib/monitor/ranges'
import { EcosystemInfluence } from '@/features/community/ecosystem'

export const Route = createFileRoute('/_authenticated/ecosystem')({
  validateSearch: timeRangeSearchSchema,
  component: EcosystemInfluence,
})
