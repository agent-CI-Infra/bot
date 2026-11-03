import { Fragment, type ReactNode } from 'react'
import { ExternalLink } from 'lucide-react'
import { useLang } from '@/lib/i18n'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ABOUT_COPY, ADD_SNIPPET, GATE_SNIPPET } from './about-copy'

const REPO_URL = 'https://github.com/agent-CI-Infra/bot'
const SITE_URL = '/dashboard/'
const CONFIG_URL = `${REPO_URL}/blob/main/public-board/config/internal-contributors.json`
const GATE_CONFIG_URL = `${REPO_URL}/blob/main/docs/onboarding-guide.md`
const COLLECT_URL = `${REPO_URL}/blob/main/public-board/scripts/collect.mjs`
const GATE_COLLECT_URL = `${REPO_URL}/blob/main/public-board/collect.mjs`
const DEPLOY_URL = `${REPO_URL}/blob/main/Dockerfile`
const ISSUES_URL = `${REPO_URL}/issues`

/** Inline code token, e.g. a file path or a login name. */
function Code({ children }: { children: ReactNode }) {
  return (
    <code className='rounded bg-muted px-1.5 py-0.5 font-mono text-xs'>
      {children}
    </code>
  )
}

/** Inline code token that links out to its source file on GitHub. */
function CodeLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer'
      className='inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-primary hover:underline'
    >
      {children}
      <ExternalLink className='size-3' />
    </a>
  )
}

/** Multi-line code / data snippet. */
function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <pre className='overflow-x-auto rounded-lg border bg-muted/50 p-3 font-mono text-xs leading-relaxed'>
      {children}
    </pre>
  )
}

function StepList({ children }: { children: ReactNode }) {
  return (
    <ol className='list-decimal space-y-4 ps-5 text-sm leading-relaxed marker:text-muted-foreground'>
      {children}
    </ol>
  )
}

function BulletList({ children }: { children: ReactNode }) {
  return (
    <ul className='list-disc space-y-1.5 ps-5 text-sm leading-relaxed marker:text-muted-foreground'>
      {children}
    </ul>
  )
}

function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer'
      className='inline font-medium break-all text-primary hover:underline'
    >
      {children}
      <ExternalLink className='ms-1 hidden size-3.5 align-[-2px] sm:inline' />
    </a>
  )
}

function Section({
  title,
  description,
  children,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>{title}</CardTitle>
        {description ? (
          <p className='text-sm text-muted-foreground'>{description}</p>
        ) : null}
      </CardHeader>
      <CardContent className='space-y-3 text-sm leading-relaxed'>
        {children}
      </CardContent>
    </Card>
  )
}

/** Required / optional marker used by the onboarding checklist. */
function Need({ children }: { children: ReactNode }) {
  return (
    <Badge variant='secondary' className='font-normal'>
      {children}
    </Badge>
  )
}

const TOKENS: Record<string, ReactNode> = {
  config: (
    <CodeLink href={CONFIG_URL}>public-board/config/internal-contributors.json</CodeLink>
  ),
  gateConfig: (
    <CodeLink href={GATE_CONFIG_URL}>docs/onboarding-guide.md</CodeLink>
  ),
  collect: <CodeLink href={COLLECT_URL}>public-board/scripts/collect.mjs</CodeLink>,
  deploy: <CodeLink href={DEPLOY_URL}>Dockerfile</CodeLink>,
  gateCollect: (
    <CodeLink href={GATE_COLLECT_URL}>public-board/collect.mjs</CodeLink>
  ),
  issues: <ExtLink href={ISSUES_URL}>GitHub Issues</ExtLink>,
}

const RICH_TEXT_RE = /(\*\*[^*]+\*\*|`[^`]+`|\{[a-zA-Z0-9_]+\})/g

/**
 * Renders copy strings with lightweight inline markup:
 * `code`, **emphasis**, and {tokens} for links / components.
 */
function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split(RICH_TEXT_RE).map((part, index) => {
        if (part.startsWith('**') && part.endsWith('**')) {
          return (
            <strong key={index} className='font-semibold'>
              {part.slice(2, -2)}
            </strong>
          )
        }
        if (part.startsWith('`') && part.endsWith('`')) {
          return <Code key={index}>{part.slice(1, -1)}</Code>
        }
        if (part.startsWith('{') && part.endsWith('}')) {
          const token = TOKENS[part.slice(1, -1)]
          return <Fragment key={index}>{token ?? part}</Fragment>
        }
        return <Fragment key={index}>{part}</Fragment>
      })}
    </>
  )
}

export function AboutSite() {
  const { lang } = useLang()
  const c = ABOUT_COPY[lang]

  return (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>{c.hero.title}</h1>
          <p className='text-sm text-muted-foreground'>{c.hero.subtitle}</p>
        </div>

        <Section title={c.site.title} description={c.site.description}>
          <p className='flex flex-wrap items-center gap-2'>
            <span className='text-muted-foreground'>{c.site.repoLabel}</span>
            <ExtLink href={REPO_URL}>{REPO_URL}</ExtLink>
          </p>
          <p className='flex flex-wrap items-center gap-2'>
            <span className='text-muted-foreground'>{c.site.siteLabel}</span>
            <ExtLink href={SITE_URL}>{SITE_URL}</ExtLink>
          </p>
          <p className='text-muted-foreground'>
            <RichText text={c.site.p1} />
          </p>
          <p className='text-muted-foreground'>
            <RichText text={c.site.p2} />
          </p>
        </Section>

        <Section title={c.add.title} description={c.add.description}>
          <StepList>
            <li>
              <RichText text={c.add.step1.text} />
              <div className='mt-2'>
                <CodeBlock>{ADD_SNIPPET}</CodeBlock>
              </div>
              <p className='mt-2'>{c.add.step1.rulesTitle}</p>
              <ul className='mt-1 list-disc space-y-1 ps-5'>
                {c.add.step1.rules.map((rule) => (
                  <li key={rule}>
                    <RichText text={rule} />
                  </li>
                ))}
              </ul>
              <p className='mt-2 text-muted-foreground'>{c.add.step1.note}</p>
            </li>
            <li>
              <RichText text={c.add.step2.text} />
              <div className='mt-2'>
                <CodeBlock>{`/dashboard/\n/boards/<owner>/<repo>/`}</CodeBlock>
              </div>
              <p className='mt-2 text-muted-foreground'>{c.add.step2.note}</p>
            </li>
            <li>
              <RichText text={c.add.step3.text} />
            </li>
          </StepList>
          <p className='text-muted-foreground'>
            <RichText text={c.add.footer} />
          </p>
        </Section>

        <Section title={c.info.title} description={c.info.description}>
          <Table className='min-w-[640px]'>
            <TableHeader>
              <TableRow>
                <TableHead className='w-[150px]'>
                  {c.info.columns.name}
                </TableHead>
                <TableHead className='w-[110px]'>
                  {c.info.columns.required}
                </TableHead>
                <TableHead>{c.info.columns.detail}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.info.rows.map((row) => (
                <TableRow key={row.label}>
                  <TableCell className='align-top font-medium whitespace-normal'>
                    {row.label}
                  </TableCell>
                  <TableCell className='align-top'>
                    <Need>{c.info.needLabels[row.need]}</Need>
                  </TableCell>
                  <TableCell className='align-top whitespace-normal'>
                    <RichText text={row.detail} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>

        <Section title={c.gate.title} description={c.gate.description}>
          <p>
            <RichText text={c.gate.intro} />
          </p>
          <p>
            <RichText text={c.gate.configIntro} />
          </p>
          <CodeBlock>{GATE_SNIPPET}</CodeBlock>
          <BulletList>
            {c.gate.bullets.map((bullet) => (
              <li key={bullet}>
                <RichText text={bullet} />
              </li>
            ))}
          </BulletList>
          <p className='text-muted-foreground'>
            <RichText text={c.gate.footer} />
          </p>
        </Section>

        <Section title={c.data.title} description={c.data.description}>
          <div className='grid gap-x-8 gap-y-2 sm:grid-cols-2'>
            {c.data.files.map((file) => (
              <p key={file.codes.join('|')}>
                {file.codes.map((code, index) => (
                  <Fragment key={code}>
                    {index > 0 ? ' / ' : null}
                    <Code>{code}</Code>
                  </Fragment>
                ))}{' '}
                <span className='text-muted-foreground'>— {file.note}</span>
              </p>
            ))}
          </div>
          <BulletList>
            {c.data.bullets.map((bullet) => (
              <li key={bullet}>
                <RichText text={bullet} />
              </li>
            ))}
          </BulletList>
        </Section>

        <Section title={c.metrics.title}>
          <BulletList>
            {c.metrics.bullets.map((bullet) => (
              <li key={bullet}>
                <RichText text={bullet} />
              </li>
            ))}
          </BulletList>
        </Section>

        <Section title={c.notes.title}>
          <BulletList>
            {c.notes.bullets.map((bullet) => (
              <li key={bullet}>
                <RichText text={bullet} />
              </li>
            ))}
          </BulletList>
        </Section>

        <Card>
          <CardHeader>
            <CardTitle className='text-base'>{c.feedback.title}</CardTitle>
          </CardHeader>
          <CardContent className='space-y-2 text-sm leading-relaxed'>
            <p>
              <RichText text={c.feedback.p1} />
            </p>
            <p className='text-muted-foreground'>
              <RichText text={c.feedback.p2} />
            </p>
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
