import { createFileRoute } from '@tanstack/react-router'
import { GateOnboardingPage } from '@/features/gate/onboarding/gate-onboarding-page'

export const Route = createFileRoute('/_authenticated/gate-onboarding')({
  component: GateOnboardingPage,
})
