import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  ExternalLink,
  FileText,
  ShieldCheck,
} from 'lucide-react'
import { useLang } from '@/lib/i18n'
import { Button } from '@/components/ui/button'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'

const GITHUB_REPO = 'https://github.com/agent-CI-Infra/bot'
const CI_WORKFLOW_REPO = 'https://github.com/agent-CI-Infra/CI-workflow'
const TEMPLATE_GUIDE = `${CI_WORKFLOW_REPO}/blob/main/README.md`
const BOARD_INDEX = '/boards/'
const CREATE_BOARD = BOARD_INDEX
const ONBOARDING_ISSUE = `${GITHUB_REPO}/issues/new`

const COPY_BLOCK = `git clone --depth 1 https://github.com/agent-CI-Infra/CI-workflow.git /tmp/ci-workflow
mkdir -p .github scripts/gate test/cases
cp -R /tmp/ci-workflow/template/.github/. .github/
cp /tmp/ci-workflow/scripts/gate/gate.mjs scripts/gate/
cp -R /tmp/ci-workflow/template/test/. ./test/`

const CONFIG_BLOCK = `{
  "version": 1,
  "level": "C1",
  "caseCatalog": "test/cases/case-catalog.yaml",
  "caseRoot": "test",
  "lanes": {
    "build": { "commands": ["npm run build"] },
    "pr-ready": {
      "commands": [
        "npm run lint",
        "node \\"$CI_GATES_CLI\\" verify-cases"
      ]
    }
  }
}`

const CASE_BLOCK = `- id: auth.login.success
  lane: pr-ready
  layer: L1
  title: 正确凭证可以登录
  status: ready
  file: test/auth.test.ts
  owner: '@your-team'`

const MARKER_BLOCK = `// @case auth.login.success
it('正确凭证可以登录', async () => {
  // ...
})`

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className='mt-3 max-w-full min-w-0 overflow-x-auto rounded-md border border-gate-line bg-gate-track p-3 text-[12px] leading-relaxed text-gate-ink'>
      <code>{children}</code>
    </pre>
  )
}

function StepCard({
  step,
  title,
  children,
}: {
  step: number
  title: string
  children: ReactNode
}) {
  return (
    <section className='min-w-0 rounded-xl border border-gate-line bg-gate-card p-5'>
      <div className='flex items-center gap-3'>
        <span className='flex size-7 shrink-0 items-center justify-center rounded-full bg-gate-pass-soft font-mono text-xs font-semibold text-gate-pass'>
          {step}
        </span>
        <h2 className='text-sm font-semibold text-gate-ink'>{title}</h2>
      </div>
      <div className='mt-3 text-sm leading-relaxed text-gate-dim'>
        {children}
      </div>
    </section>
  )
}

export function GateOnboardingPage() {
  const { t } = useLang()

  return (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>
      <Main className='flex flex-1 flex-col gap-6'>
        <div>
          <Button asChild variant='ghost' size='sm' className='-ms-2 mb-2'>
            <Link to='/gate'>
              <ArrowLeft className='size-4' />
              {t('gate.onboarding.back')}
            </Link>
          </Button>
          <h1 className='text-2xl font-bold tracking-tight'>
            {t('gate.onboarding.title')}
          </h1>
          <p className='mt-1 max-w-3xl text-sm text-muted-foreground'>
            {t('gate.onboarding.subtitle')}
          </p>
        </div>

        <section className='min-w-0 rounded-xl border border-gate-line bg-gate-card p-5 sm:p-6'>
          <div className='flex flex-col gap-4 sm:flex-row sm:items-start'>
            <div className='flex size-10 shrink-0 items-center justify-center rounded-lg bg-gate-pass-soft text-gate-pass'>
              <ShieldCheck className='size-5' />
            </div>
            <div className='space-y-1.5'>
              <h2 className='text-base font-semibold text-gate-ink'>
                {t('gate.onboarding.hero.title')}
              </h2>
              <p className='max-w-3xl text-sm leading-relaxed text-gate-dim'>
                {t('gate.onboarding.hero.desc')}
              </p>
              <p className='max-w-3xl text-sm leading-relaxed text-gate-dim'>
                {t('gate.onboarding.issueHint')}
              </p>
            </div>
          </div>
        </section>

        <div className='grid min-w-0 gap-4 lg:grid-cols-2'>
          <StepCard step={1} title={t('gate.onboarding.step1.title')}>
            <p>{t('gate.onboarding.step1.body')}</p>
            <CodeBlock>{COPY_BLOCK}</CodeBlock>
          </StepCard>

          <StepCard step={2} title={t('gate.onboarding.step2.title')}>
            <p>{t('gate.onboarding.step2.body')}</p>
            <CodeBlock>{CONFIG_BLOCK}</CodeBlock>
          </StepCard>

          <StepCard step={3} title={t('gate.onboarding.step3.title')}>
            <p>{t('gate.onboarding.step3.body')}</p>
            <CodeBlock>{CASE_BLOCK}</CodeBlock>
            <CodeBlock>{MARKER_BLOCK}</CodeBlock>
          </StepCard>

          <StepCard step={4} title={t('gate.onboarding.step4.title')}>
            <p>{t('gate.onboarding.step4.body')}</p>
            <p className='mt-3'>
              <code className='rounded border border-gate-line bg-gate-track px-1.5 py-0.5 font-mono text-[12px] text-gate-ink'>
                CI Gates / gate
              </code>
            </p>
            <p className='mt-3'>{t('gate.onboarding.step4.mergeQueue')}</p>
          </StepCard>
        </div>

        <section className='rounded-xl border border-dashed border-gate-line bg-gate-track p-5'>
          <h2 className='text-sm font-semibold text-gate-ink'>
            {t('gate.onboarding.board.title')}
          </h2>
          <p className='mt-2 max-w-3xl text-sm leading-relaxed text-gate-dim'>
            {t('gate.onboarding.boardNote')}
          </p>
          <div className='mt-3 flex flex-wrap items-center gap-4'>
            <a
              href={BOARD_INDEX}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-1.5 text-sm font-medium text-gate-accent hover:underline'
            >
              {t('gate.onboarding.boardTemplate')}
              <ExternalLink className='size-3.5 opacity-70' />
            </a>
            <a
              href={CREATE_BOARD}
              target='_blank'
              rel='noreferrer'
              className='inline-flex items-center gap-1.5 text-sm font-medium text-gate-accent hover:underline'
            >
              {t('gate.onboarding.boardCreate')}
              <ExternalLink className='size-3.5 opacity-70' />
            </a>
            <Link
              to='/gate'
              className='inline-flex items-center gap-1.5 text-sm font-medium text-gate-accent hover:underline'
            >
              {t('gate.onboarding.boardLink')}
              <ArrowRight className='size-4' />
            </Link>
          </div>
        </section>

        <div className='flex flex-wrap items-center gap-2'>
          <Button asChild>
            <a href={TEMPLATE_GUIDE} target='_blank' rel='noreferrer'>
              <BookOpen className='size-4' />
              {t('gate.onboarding.tutorial')}
              <ExternalLink className='size-3.5 opacity-70' />
            </a>
          </Button>
          <Button asChild variant='outline'>
            <a href={ONBOARDING_ISSUE} target='_blank' rel='noreferrer'>
              <FileText className='size-4' />
              {t('gate.onboarding.request')}
            </a>
          </Button>
        </div>
      </Main>
    </>
  )
}
