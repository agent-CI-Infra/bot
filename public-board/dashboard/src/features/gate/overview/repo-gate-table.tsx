import { useMemo, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ExternalLink,
  GitBranch,
  SearchX,
} from 'lucide-react'
import { useLang, type I18nKey } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  STAGE_LABEL,
  STAGE_TONE,
  type StageTone,
} from '@/features/gate/components/gate-stage-meta'
import { TONE_BG, TONE_TEXT } from '@/features/gate/components/gate-styles'
import {
  COVERAGE_THRESHOLD,
  GATE_CATEGORIES,
  countReposByStatus,
  type GateCaseSummary,
  type GateLevel,
  type GateRepo,
  type GateStage,
  type RepoBranchStat,
  type RepoCategoryStat,
} from '@/features/gate/data/gate'
import { formatPercent } from '@/features/gate/lib/format'

/**
 * Flat gate overview table (spec v1.9): repository (with branch picker) ·
 * build / ready / merge / daily / release pass-rate pills · coverage.
 * Rows sort by clicking a column header (first click: desc for metrics,
 * asc for repository names); branches without a category always sink.
 */
type SortKey =
  'repo' | 'build' | 'ready' | 'merge' | 'daily' | 'release' | 'coverage'
type SortDir = 'asc' | 'desc'

const ROW_COLS =
  'grid grid-cols-[minmax(280px,1fr)_repeat(5,104px)_104px] items-center gap-x-2.5'

const COL_LABEL: Record<string, I18nKey> = {
  repo: 'gate.col.repo',
  build: 'gate.col.build',
  ready: 'gate.col.ready',
  merge: 'gate.col.merge',
  daily: 'gate.col.daily',
  release: 'gate.col.release',
  coverage: 'gate.col.coverage',
}

/** Sort value per column; null sinks to the bottom in both directions. */
function sortValue(
  repo: GateRepo,
  branch: RepoBranchStat,
  key: SortKey
): number | string | null {
  switch (key) {
    case 'repo':
      return repo.name
    case 'coverage':
      return branch.coverage
    default:
      return branch.stats.find((s) => s.category === key)?.passRate ?? null
  }
}

/** Per-layer tooltip for a gate cell (SD-board format). */
function casesTooltip(
  stat: RepoCategoryStat,
  plannedLabel: string
): string | null {
  const cases = stat.cases
  if (!cases) return null
  const layers = cases.layers ?? []
  if (layers.length === 0) return null
  const parts = layers.map((layer) =>
    layer.planOnly
      ? `${layer.name} ${plannedLabel} ${layer.planned}`
      : `${layer.name} ${layer.passed}/${layer.planned}`
  )
  const when = cases.runAt ? cases.runAt.slice(0, 16).replace('T', ' ') : ''
  return `${parts.join(' · ')}${when ? ` — ${when}` : ''}`
}

/** Empty slot with the same footprint as a chip, so columns stay aligned. */
function EmptyCell() {
  return (
    <span className='flex h-7 w-full items-center justify-center text-[13px] text-gate-faint'>
      –
    </span>
  )
}

const TONE_CHIP: Record<StageTone, string> = {
  pass: cn(TONE_BG.pass, TONE_TEXT.pass),
  warn: cn(TONE_BG.warn, TONE_TEXT.warn),
  fail: cn(TONE_BG.fail, TONE_TEXT.fail),
  neutral: 'bg-gate-track text-gate-dim',
}

/** Compliance level badge (C0–C4) next to the owner. */
function LevelBadge({ level }: { level: GateLevel }) {
  const { t } = useLang()
  return (
    <span
      title={t('gate.levelHint')}
      className='inline-flex h-4 shrink-0 items-center rounded border border-gate-line bg-gate-track px-1 font-mono text-[10px] leading-none text-gate-dim'
    >
      {level}
    </span>
  )
}

/**
 * Onboarding stage chip. Pending cases and unexecuted cases take precedence
 * over the generic stage label so "not green" is always explicit.
 */
function StageChip({
  stage,
  cases,
}: {
  stage?: GateStage
  cases?: GateCaseSummary
}) {
  const { t } = useLang()
  if (!stage) return null

  const notRun = cases?.notRun ?? 0
  const todo = cases?.todo ?? 0
  let label = t(STAGE_LABEL[stage])
  let tone = STAGE_TONE[stage]

  if (notRun > 0) {
    label = t('gate.cases.notRun', { n: notRun })
    tone = 'fail'
  } else if (stage === 'cases-pending' && todo > 0) {
    label = t('gate.cases.todo', { n: todo })
    tone = 'warn'
  } else if (stage === 'enforced' && cases && cases.ready > 0) {
    label = t('gate.cases.ready', { ready: cases.ready, total: cases.total })
  }

  const details = [
    t(STAGE_LABEL[stage]),
    todo > 0 ? t('gate.cases.todo', { n: todo }) : null,
    notRun > 0 ? t('gate.cases.notRun', { n: notRun }) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <span
      title={details}
      className={cn(
        'inline-flex h-4 shrink-0 items-center rounded px-1 text-[10px] leading-none font-medium',
        TONE_CHIP[tone]
      )}
    >
      {label}
    </span>
  )
}

/**
 * Pass rate as a soft status chip tinted by health tier (single line, same
 * look for every repository). When the latest run's case count is known it is
 * pinned to the cell's bottom-right corner without shifting the chip.
 */
function RateCell({ stat }: { stat?: RepoCategoryStat }) {
  const { t } = useLang()
  if (!stat || stat.passRate == null) {
    return <EmptyCell />
  }
  const pillClass = cn(
    'flex h-7 w-full items-center justify-center rounded-md text-[13px] font-medium tabular-nums',
    TONE_BG[stat.health],
    TONE_TEXT[stat.health]
  )
  const value = formatPercent(stat.passRate)
  const cases = stat.cases
  const tooltip = casesTooltip(stat, t('gate.casesPlanned'))

  const pill = stat.link ? (
    <a
      href={stat.link}
      target='_blank'
      rel='noreferrer'
      title={tooltip ?? t('gate.openSource')}
      className={cn(
        pillClass,
        'transition-shadow hover:ring-2 hover:ring-gate-accent/40'
      )}
    >
      {value}
    </a>
  ) : (
    <span className={cn(pillClass, 'shrink-0')}>{value}</span>
  )

  if (!cases) return pill
  return (
    <div
      className='relative flex h-full w-full items-center'
      title={tooltip ?? undefined}
    >
      {pill}
      <span className='pointer-events-none absolute right-0 bottom-0.5 font-mono text-[10px] leading-none text-gate-faint tabular-nums'>
        {cases.totalPlanned}
      </span>
    </div>
  )
}

function CoverageCell({
  coverage,
  link,
}: {
  coverage: number | null
  link?: string
}) {
  const { t } = useLang()
  if (coverage == null) {
    return <EmptyCell />
  }
  const low = coverage < COVERAGE_THRESHOLD
  const pillClass = cn(
    'flex h-7 w-full items-center justify-center rounded-md text-[13px] font-medium tabular-nums',
    low
      ? 'bg-gate-fail-soft text-gate-fail'
      : 'bg-gate-accent-soft text-gate-accent'
  )
  const value = formatPercent(coverage)
  if (!link) {
    return <span className={cn(pillClass, 'shrink-0')}>{value}</span>
  }
  return (
    <a
      href={link}
      target='_blank'
      rel='noreferrer'
      title={t('gate.openSource')}
      className={cn(
        pillClass,
        'transition-shadow hover:ring-2 hover:ring-gate-accent/40'
      )}
    >
      {value}
    </a>
  )
}

/** Branch selector chip shown next to the repository name. */
function BranchPicker({
  repo,
  selected,
  onSelect,
}: {
  repo: GateRepo
  selected: RepoBranchStat
  onSelect: (branchName: string) => void
}) {
  const { t } = useLang()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t('gate.switchBranch')}
        title={t('gate.switchBranch')}
        className='inline-flex h-5 max-w-32 shrink-0 items-center gap-1 rounded-md border border-gate-line bg-gate-track px-1.5 text-[11px] font-medium text-gate-dim outline-none hover:text-gate-ink focus-visible:ring-2 focus-visible:ring-gate-accent/30'
      >
        <GitBranch className='size-3 shrink-0' />
        <span className='truncate'>{selected.name}</span>
        <ChevronDown className='size-3 shrink-0' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='min-w-44'>
        <DropdownMenuLabel className='text-xs text-muted-foreground'>
          {t('gate.branches')}
        </DropdownMenuLabel>
        {repo.branchData.map((b) => (
          <DropdownMenuItem
            key={b.name}
            onClick={() => onSelect(b.name)}
            className='gap-2 text-[12px] font-medium'
          >
            <GitBranch className='size-3.5 text-gate-faint' />
            <span className='truncate'>{b.name}</span>
            <Check
              size={14}
              className={cn('ms-auto', b.name !== selected.name && 'hidden')}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function SortHeader({
  labelKey,
  active,
  dir,
  onClick,
  centered,
  accent,
}: {
  labelKey: I18nKey
  active: boolean
  dir: SortDir
  onClick: () => void
  centered?: boolean
  /** Coverage is a separate metric — its header carries the accent hue. */
  accent?: boolean
}) {
  const { t } = useLang()
  const label = t(labelKey)
  return (
    <button
      type='button'
      onClick={onClick}
      className={cn(
        'group flex items-center gap-1 text-[11px] font-semibold tracking-[0.06em] uppercase outline-none focus-visible:ring-2 focus-visible:ring-gate-accent/30',
        centered ? 'justify-center text-center' : 'text-left',
        active
          ? 'text-gate-ink'
          : accent
            ? 'text-gate-accent hover:text-gate-accent/80'
            : 'text-gate-faint hover:text-gate-dim'
      )}
    >
      {label}
      {active ? (
        dir === 'asc' ? (
          <ArrowUp className='size-3' />
        ) : (
          <ArrowDown className='size-3' />
        )
      ) : (
        <ArrowDown className='size-3 opacity-0 transition-opacity group-hover:opacity-40' />
      )}
    </button>
  )
}

export function RepoGateTable({ repos }: { repos: GateRepo[] }) {
  const { t } = useLang()
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  /** Selected branch name per repo id; falls back to the default branch. */
  const [branchByRepo, setBranchByRepo] = useState<Record<string, string>>({})

  const branchOf = (repo: GateRepo): RepoBranchStat =>
    repo.branchData.find((b) => b.name === branchByRepo[repo.id]) ??
    repo.branchData[0]

  /** Repo paired with its currently selected branch. */
  const views = useMemo(
    () => repos.map((repo) => ({ repo, branch: branchOf(repo) })),
    // branchOf closes over branchByRepo; listing it keeps the view in sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [repos, branchByRepo]
  )

  const sortedViews = useMemo(() => {
    if (!sortKey) return views
    return [...views].sort((a, b) => {
      const va = sortValue(a.repo, a.branch, sortKey)
      const vb = sortValue(b.repo, b.branch, sortKey)
      if (va == null && vb == null) return 0
      if (va == null) return 1
      if (vb == null) return -1
      if (typeof va === 'string' || typeof vb === 'string') {
        return String(va).localeCompare(String(vb))
      }
      return sortDir === 'asc' ? va - vb : vb - va
    })
  }, [views, sortKey, sortDir])

  const statusCounts = useMemo(
    () =>
      countReposByStatus(
        sortedViews.map((v) => ({ gateStatus: v.branch.gateStatus }))
      ),
    [sortedViews]
  )

  const onSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'repo' ? 'asc' : 'desc')
    }
  }

  return (
    <div className='overflow-hidden rounded-xl border border-gate-line bg-gate-card'>
      {/* Header */}
      <div className={cn(ROW_COLS, 'h-11 border-b border-gate-grid px-4')}>
        <SortHeader
          labelKey='gate.col.repo'
          active={sortKey === 'repo'}
          dir={sortDir}
          onClick={() => onSort('repo')}
        />
        {GATE_CATEGORIES.map((c) => (
          <SortHeader
            key={c.id}
            labelKey={COL_LABEL[c.id]}
            active={sortKey === c.id}
            dir={sortDir}
            onClick={() => onSort(c.id)}
            centered
          />
        ))}
        <div className='flex h-full items-center self-stretch border-l border-gate-grid pl-2.5'>
          <SortHeader
            labelKey='gate.col.coverage'
            active={sortKey === 'coverage'}
            dir={sortDir}
            onClick={() => onSort('coverage')}
            centered
            accent
          />
        </div>
      </div>

      {/* Rows */}
      {sortedViews.map(({ repo, branch }) => (
        <div
          key={repo.id}
          className={cn(
            ROW_COLS,
            'h-12 border-b border-gate-grid px-4 transition-colors last:border-b-0 hover:bg-gate-subtle'
          )}
        >
          <div className='min-w-0'>
            <div className='flex min-w-0 items-center gap-1.5'>
              {repo.url ? (
                <a
                  href={repo.url}
                  target='_blank'
                  rel='noreferrer'
                  title={repo.url}
                  className='truncate text-sm leading-5 font-semibold text-gate-ink hover:text-gate-accent hover:underline'
                >
                  {repo.name}
                </a>
              ) : (
                <span className='truncate text-sm leading-5 font-semibold text-gate-ink'>
                  {repo.name}
                </span>
              )}
              {repo.demo ? (
                <span
                  title={t('gate.demoHint')}
                  className='inline-flex h-5 shrink-0 items-center rounded-md border border-gate-line bg-gate-track px-1.5 text-[11px] font-medium text-gate-faint'
                >
                  {t('gate.demo')}
                </span>
              ) : null}
              <BranchPicker
                repo={repo}
                selected={branch}
                onSelect={(name) =>
                  setBranchByRepo((cur) => ({ ...cur, [repo.id]: name }))
                }
              />
            </div>
            <div className='flex min-w-0 items-center gap-1.5 text-xs leading-4 text-gate-dim'>
              <span className='truncate'>{repo.owner}</span>
              {repo.level ? <LevelBadge level={repo.level} /> : null}
              <StageChip
                stage={repo.stage}
                cases={branch.caseSummary ?? repo.caseSummary}
              />
              {repo.boardUrl ? (
                <a
                  href={repo.boardUrl}
                  target='_blank'
                  rel='noreferrer'
                  title={t('gate.openBoard')}
                  className='inline-flex shrink-0 items-center text-gate-faint hover:text-gate-accent'
                >
                  <ExternalLink className='size-3' />
                </a>
              ) : null}
            </div>
          </div>

          {GATE_CATEGORIES.map((c) => (
            <RateCell
              key={c.id}
              stat={branch.stats.find((s) => s.category === c.id)}
            />
          ))}

          <div className='flex h-full items-center self-stretch border-l border-gate-grid pl-2.5'>
            <CoverageCell
              coverage={branch.coverage}
              link={branch.coverageLink}
            />
          </div>
        </div>
      ))}

      {/* Empty state */}
      {repos.length === 0 && (
        <div className='flex flex-col items-center gap-2 py-16'>
          <SearchX className='size-8 text-gate-faint' />
          <p className='text-sm text-gate-dim'>{t('gate.empty')}</p>
        </div>
      )}

      {/* Footer sync bar */}
      <div className='flex h-10 items-center justify-between border-t border-gate-grid px-4 text-xs text-gate-faint'>
        <span className='flex items-center gap-4'>
          <span className='flex items-center gap-1.5 text-gate-dim'>
            <span className='size-1.5 animate-pulse rounded-full bg-gate-pass' />
            {t('gate.live')}
          </span>
          <span>{t('gate.synced')}</span>
        </span>
        <span>
          {t('gate.summary', {
            total: repos.length,
            passed: statusCounts.passed,
            failed: statusCounts.failed,
            running: statusCounts.running,
          })}
        </span>
      </div>
    </div>
  )
}
