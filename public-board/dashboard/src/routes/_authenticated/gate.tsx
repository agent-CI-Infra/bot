import { useMemo } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { BookOpen, LayoutGrid } from 'lucide-react'
import { useLang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import {
  STAGE_LABEL,
  STAGE_TONE,
  type StageTone,
} from '@/features/gate/components/gate-stage-meta'
import { GateWindowSelect } from '@/features/gate/components/gate-window-select'
import {
  GATE_STAGES,
  type GateStage,
} from '@/features/gate/data/gate'
import { deriveGateRepos, useGateDatasets } from '@/features/gate/data/gate-api'
import { RepoGateTable } from '@/features/gate/overview/repo-gate-table'
import { useGateWindow } from '@/features/gate/stores/gate-window'

export const Route = createFileRoute('/_authenticated/gate')({
  component: GatePage,
})

const FUNNEL_TONE: Record<StageTone, string> = {
  pass: 'bg-gate-pass-soft text-gate-pass',
  warn: 'bg-gate-warn-soft text-gate-warn',
  fail: 'bg-gate-fail-soft text-gate-fail',
  neutral: 'border border-gate-line bg-gate-track text-gate-dim',
}

/**
 * Quality gate monitor: per-branch gate performance for the monitored
 * repositories, rendered inside the existing platform shell.
 */
function GatePage() {
  const { t } = useLang()
  const { data: datasets } = useGateDatasets()
  const windowDays = useGateWindow((s) => s.windowDays)

  // Public hosting lists only collected repositories authorized by this bot installation.
  const repos = useMemo(() => deriveGateRepos(datasets ?? [], windowDays), [datasets, windowDays])

  /** Repositories per onboarding stage; demo entries carry no stage. */
  const stageCounts = useMemo(() => {
    const counts = new Map<GateStage, number>()
    for (const repo of repos) {
      if (!repo.stage) continue
      counts.set(repo.stage, (counts.get(repo.stage) ?? 0) + 1)
    }
    return counts
  }, [repos])

  return (
    <>
      <Header>
        <div className='me-auto' />
        <Button asChild variant='outline' size='sm' className='me-1'>
          <a href='/boards/' aria-label={t('gate.boards.entry')}>
            <LayoutGrid className='size-4' />
            <span className='hidden sm:inline'>{t('gate.boards.entry')}</span>
          </a>
        </Button>
        <Button asChild variant='outline' size='sm' className='me-1'>
          <Link to='/gate-onboarding' aria-label={t('gate.onboarding.entry')}>
            <BookOpen className='size-4' />
            <span className='hidden sm:inline'>
              {t('gate.onboarding.entry')}
            </span>
          </Link>
        </Button>
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>
      <Main className='flex flex-1 flex-col gap-6'>
        <div className='flex flex-wrap items-center gap-x-2 gap-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('gate.title')}
          </h1>
          <p className='text-sm text-muted-foreground'>{t('gate.subtitle')}</p>
          <GateWindowSelect />
        </div>

        {stageCounts.size > 0 ? (
          <div className='flex flex-wrap items-center gap-2 text-xs'>
            <span className='text-gate-faint'>{t('gate.funnel.title')}</span>
            {GATE_STAGES.map((stage) => {
              const count = stageCounts.get(stage) ?? 0
              if (count === 0) return null
              return (
                <span
                  key={stage}
                  className={cn(
                    'inline-flex items-center gap-1 rounded-md px-2 py-1 font-medium',
                    FUNNEL_TONE[STAGE_TONE[stage]]
                  )}
                >
                  {t(STAGE_LABEL[stage])}
                  <b className='tabular-nums'>{count}</b>
                </span>
              )
            })}
          </div>
        ) : null}

        <RepoGateTable repos={repos} />
      </Main>
    </>
  )
}
