import z from 'zod'
import { createFileRoute } from '@tanstack/react-router'
import { TIME_RANGES } from '@/lib/monitor/ranges'
import { ContributorsAnalysis } from '@/features/community/contributors'

const contributorSearchSchema = z.object({
  contributor: z.string().optional().catch(undefined),
  range: z.enum(TIME_RANGES).optional().catch('30d'),
})

export const Route = createFileRoute('/_authenticated/contributors')({
  validateSearch: contributorSearchSchema,
  component: ContributorsAnalysis,
})
