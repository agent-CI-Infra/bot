import { createFileRoute } from '@tanstack/react-router'
import { AboutSite } from '@/features/community/about'

export const Route = createFileRoute('/_authenticated/about')({
  component: AboutSite,
})
