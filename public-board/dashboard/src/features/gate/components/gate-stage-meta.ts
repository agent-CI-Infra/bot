import type { I18nKey } from '@/lib/i18n'
import type { GateStage } from '@/features/gate/data/gate'

/** Label + tone for each onboarding stage (shared by table and funnel). */
export const STAGE_LABEL: Record<GateStage, I18nKey> = {
  discovered: 'gate.stage.discovered',
  'gates-running': 'gate.stage.gatesRunning',
  'cases-pending': 'gate.stage.casesPending',
  observing: 'gate.stage.observing',
  enforced: 'gate.stage.enforced',
  failing: 'gate.stage.failing',
}

export type StageTone = 'pass' | 'warn' | 'fail' | 'neutral'

export const STAGE_TONE: Record<GateStage, StageTone> = {
  discovered: 'neutral',
  'gates-running': 'neutral',
  'cases-pending': 'warn',
  observing: 'warn',
  enforced: 'pass',
  failing: 'fail',
}
