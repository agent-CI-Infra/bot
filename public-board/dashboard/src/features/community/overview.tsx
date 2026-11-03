import { useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import {
  AlertCircle,
  CircleDot,
  Flag,
  GitFork,
  GitPullRequest,
  Star,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import { IconGithub } from '@/assets/brand-icons'
import { useLang, type I18nKey } from '@/lib/i18n'
import {
  repoKey,
  useActivityScores,
  useIssues,
  usePulls,
  useRepos,
} from '@/lib/monitor/data'
import {
  ACTIVITY_INDICATORS,
  ACTIVITY_WINDOW_DAYS,
  activeContributorsSplit,
} from '@/lib/monitor/derive'
import {
  formatDateTime,
  formatExact,
  formatNumber,
  formatPercent,
} from '@/lib/monitor/format'
import { fetchLiveRepoStats, type LiveRepoStats } from '@/lib/monitor/live'
import type { TimeRangeSearch } from '@/lib/monitor/ranges'
import type { Composition, RepoSummary } from '@/lib/monitor/types'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { MetricCard } from './components/metric-card'
import { MonitorHeader } from './components/monitor-header'
import { ErrorState, LoadingState } from './components/states'
import { useMonitorBase } from './use-monitor'

const route = getRouteApi('/_authenticated/')

/**
 * The overview always reflects the current state, so it uses one fixed window
 * (the platform's 30-day convention) instead of a user-selectable range.
 */
const FIXED_RANGE: TimeRangeSearch = { range: '30d' }

/** Click-to-open explanation for the "活跃贡献者" metric. */
function ActiveContributorsInfo() {
  const { t } = useLang()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='活跃贡献者说明'
          className='shrink-0 text-muted-foreground transition-colors hover:text-foreground'
        >
          <AlertCircle className='size-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-72 text-xs leading-relaxed'>
        {t('community.contributorsInfo')}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Click-to-open explanation of the community activity score: the formula and
 * its indicator weights, without the per-repository calculation.
 */
function ActivityScoreInfo() {
  const { t } = useLang()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          aria-label='活跃度计算公式'
          className='inline-flex shrink-0 items-center align-middle text-muted-foreground transition-colors hover:text-foreground'
        >
          <AlertCircle className='size-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='start'
        className='w-80 space-y-3 text-xs leading-relaxed'
      >
        <p className='font-medium'>{t('community.score.title')}</p>
        <p className='font-mono text-[11px] break-words'>
          C = (1 / Σαᵢ) · Σ αᵢ · ln(1 + Sᵢ) / ln(1 + max(Sᵢ, Tᵢ))
        </p>
        <table className='w-full'>
          <thead>
            <tr className='text-muted-foreground'>
              <th className='text-left font-normal'>
                {t('community.score.metric')}
              </th>
              <th className='text-right font-normal'>
                {t('community.score.threshold')} Tᵢ
              </th>
              <th className='text-right font-normal'>
                {t('community.score.weight')} αᵢ
              </th>
            </tr>
          </thead>
          <tbody>
            {ACTIVITY_INDICATORS.map((indicator) => (
              <tr key={indicator.label}>
                <td>{indicator.label}</td>
                <td className='text-right tabular-nums'>
                  {indicator.threshold}
                </td>
                <td className='text-right tabular-nums'>{indicator.weight}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className='text-muted-foreground'>
          {t('community.score.window', { days: ACTIVITY_WINDOW_DAYS })}
        </p>
      </PopoverContent>
    </Popover>
  )
}

function StatRow({ labelKey, value }: { labelKey: I18nKey; value: string }) {
  const { t } = useLang()
  return (
    <div className='flex items-center justify-between gap-3 py-1 text-sm'>
      <span className='text-muted-foreground'>{t(labelKey)}</span>
      <span className='font-medium tabular-nums'>{value}</span>
    </div>
  )
}

/**
 * Internal / external split as plain numbers. Bots ("unknown") are neither, so
 * they are excluded from both sides — matching the config-driven split used by
 * every other page. Only the external value keeps its share of the total (the
 * internal share is usually ~100% and adds noise), rendered as the percentage
 * (parenthesised) followed by the bare count.
 */
function compositionParts(composition?: Composition) {
  const internal = composition?.internal ?? 0
  const external = composition?.external ?? 0
  const total = internal + external
  return {
    internal: formatExact(internal),
    external:
      total > 0
        ? `（${formatPercent(external / total, 0)}）${formatExact(external)}`
        : formatExact(external),
  }
}

/**
 * Comment totals for a record set, plus the per-record average. Bots are
 * counted (GitHub reports a single unfiltered comment count per item).
 */
function commentStats(records: { comments?: number }[]) {
  if (records.length === 0) return { total: '—', average: '—' }
  const total = records.reduce((sum, r) => sum + (r.comments ?? 0), 0)
  return {
    total: formatExact(total),
    average: (total / records.length).toFixed(2),
  }
}

/**
 * One repository rendered as a self-contained box: status, scale metrics,
 * PR/Issue overview and alerts — the same content the overview used to show,
 * now scoped per repository.
 */
function RepoOverviewBox({
  repo,
  live,
  activity,
  isTop,
}: {
  repo: RepoSummary
  /** Live GitHub counts for this repo, set by the page-level refresh. */
  live?: LiveRepoStats
  /** Community activity score; null while its data is still loading. */
  activity: number | null
  /** Marks the highest-scoring community on the page. */
  isTop?: boolean
}) {
  const { t } = useLang()
  const key = repoKey(repo)
  const base = useMonitorBase(key, FIXED_RANGE)
  const pulls = usePulls(key)
  const issues = useIssues(key)

  if (base.isLoading) {
    return (
      <section className='rounded-xl border bg-card p-4 sm:p-6'>
        <LoadingState />
      </section>
    )
  }

  if (base.isError) {
    return (
      <section className='rounded-xl border bg-card p-4 sm:p-6'>
        <ErrorState onRetry={() => base.meta.refetch()} />
      </section>
    )
  }

  const meta = base.meta.data
  const latest = base.latest.data

  const pullRecords = pulls.data ?? []
  const issueRecords = issues.data ?? []
  const active = activeContributorsSplit(pullRecords, issueRecords, base.range)

  const pullsData = latest?.pulls
  const issuesData = latest?.issues
  const pullComp = compositionParts(pullsData?.composition)
  const issueComp = compositionParts(issuesData?.composition)
  const pullComments = commentStats(pullRecords)
  const issueComments = commentStats(issueRecords)

  const repoRef = meta?.repo
  const fullName = repoRef?.fullName ?? repo.fullName
  const htmlUrl = repoRef?.htmlUrl ?? repo.htmlUrl
  const defaultBranch = repoRef?.defaultBranch ?? repo.defaultBranch

  return (
    <section className='space-y-4 rounded-xl border bg-card p-4'>
      <header className='flex flex-wrap items-center gap-3'>
        <a
          href={htmlUrl}
          target='_blank'
          rel='noreferrer'
          className='inline-flex items-center gap-2 text-lg font-semibold tracking-tight hover:underline'
        >
          <IconGithub className='size-5' />
          {fullName}
          <Badge variant='outline' className='font-normal'>
            {defaultBranch}
          </Badge>
        </a>
        <div className='ms-auto flex items-center gap-1 text-sm'>
          {isTop ? (
            <Flag
              role='img'
              aria-label='活跃度最高'
              className='size-3.5 fill-red-500 text-red-500'
            />
          ) : null}
          <span className='text-muted-foreground'>
            {t('community.activity')}:
          </span>
          <span className='font-semibold tabular-nums'>
            {activity === null ? '—' : activity.toFixed(2)}
          </span>
        </div>
      </header>

      <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
        <MetricCard
          inline
          compact
          title='Stars'
          value={formatNumber(live?.stars ?? latest?.repo.stars)}
          icon={Star}
        />
        <MetricCard
          inline
          compact
          title='Forks'
          value={formatNumber(live?.forks ?? latest?.repo.forks)}
          icon={GitFork}
        />
        <MetricCard
          inline
          compact
          title={t('community.metric.contributors')}
          value={formatNumber(latest?.contributors.total)}
          icon={Users}
          suffix={t('community.extSuffix', {
            n: latest?.contributors.composition.external ?? 0,
          })}
        />
        <MetricCard
          inline
          compact
          title={t('community.metric.activeContributors')}
          value={formatExact(active.total)}
          icon={Users}
          suffix={t('community.extSuffix', { n: active.external })}
          info={<ActiveContributorsInfo />}
        />
      </div>

      <div className='grid gap-3 lg:grid-cols-2'>
        <Card className='gap-2 py-4'>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <GitPullRequest className='size-4' />
              Pull Request
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-1'>
            <div className='grid grid-cols-3 gap-x-6'>
              <StatRow
                labelKey='community.pr.total'
                value={formatNumber(pullsData?.total)}
              />
              <StatRow
                labelKey='community.internal'
                value={pullComp.internal}
              />
              <StatRow
                labelKey='community.comments.total'
                value={pullComments.total}
              />
            </div>
            <div className='grid grid-cols-3 gap-x-6'>
              <StatRow
                labelKey='community.pr.open'
                value={formatExact(live?.openPulls ?? pullsData?.open)}
              />
              <StatRow
                labelKey='community.external'
                value={pullComp.external}
              />
              <StatRow
                labelKey='community.comments.avg'
                value={pullComments.average}
              />
            </div>
          </CardContent>
        </Card>

        <Card className='gap-2 py-4'>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-base'>
              <CircleDot className='size-4' />
              Issue
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-1'>
            <div className='grid grid-cols-3 gap-x-6'>
              <StatRow
                labelKey='community.issue.total'
                value={formatNumber(issuesData?.total)}
              />
              <StatRow
                labelKey='community.internal'
                value={issueComp.internal}
              />
              <StatRow
                labelKey='community.comments.total'
                value={issueComments.total}
              />
            </div>
            <div className='grid grid-cols-3 gap-x-6'>
              <StatRow
                labelKey='community.pr.open'
                value={formatExact(live?.openIssues ?? issuesData?.open)}
              />
              <StatRow
                labelKey='community.external'
                value={issueComp.external}
              />
              <StatRow
                labelKey='community.comments.avg'
                value={issueComments.average}
              />
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  )
}

export function CommunityOverview() {
  const { t } = useLang()
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const reposQuery = useRepos()
  const repos = reposQuery.data?.repos ?? []
  const queryClient = useQueryClient()
  const scores = useActivityScores(repos)
  // Highest activity first; repositories whose score is not loaded yet sink.
  const ordered = [...repos].sort(
    (a, b) => (scores.get(repoKey(b)) ?? -1) - (scores.get(repoKey(a)) ?? -1)
  )
  // Flag the leader, but only once its score is known: while nothing is loaded
  // every score is null, so `ordered` is just the unsorted list.
  const topKey =
    ordered.length > 0 && scores.get(repoKey(ordered[0])) != null
      ? repoKey(ordered[0])
      : null

  const [liveByRepo, setLiveByRepo] = useState<Record<string, LiveRepoStats>>(
    {}
  )
  const [, setUpdating] = useState(false)

  // All repositories share a single "data updated at" label: the newest live
  // fetch after a manual refresh, otherwise the published snapshot's build time.
  const liveFetchedAt = Object.values(liveByRepo).reduce<string | null>(
    (latest, stats) =>
      !latest || stats.fetchedAt > latest ? stats.fetchedAt : latest,
    null
  )
  const sharedUpdatedAt = liveFetchedAt ?? reposQuery.data?.generatedAt ?? null

  const onSearchChange = (next: typeof search) =>
    navigate({ search: (prev) => ({ ...prev, ...next }) })

  /**
   * Refresh every monitored repository at once: fetch live counts from GitHub
   * for all of them; if GitHub is unreachable, fall back to re-fetching the
   * published snapshots so the button still updates the page.
   *
   * Retained on purpose while the "更新数据" button is hidden from the page.
   */
  const handleUpdateAll = async () => {
    if (repos.length === 0) return
    setUpdating(true)
    try {
      const results = await Promise.allSettled(
        repos.map((repo) => fetchLiveRepoStats(repo))
      )
      const next = { ...liveByRepo }
      let ok = 0
      let firstReason: unknown
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          next[repoKey(repos[index])] = result.value
          ok += 1
        } else if (firstReason === undefined) {
          firstReason = result.reason
        }
      })
      setLiveByRepo(next)

      if (ok === repos.length) {
        toast.success(`已更新全部 ${repos.length} 个仓库的 GitHub 实时数据`)
      } else if (ok > 0) {
        toast.success(`已更新 ${ok}/${repos.length} 个仓库的实时数据，其余失败`)
      } else {
        // GitHub reachable but refused (e.g. rate limit) or unreachable:
        // surface the real reason and still refresh the published snapshots.
        await queryClient.refetchQueries({ queryKey: ['monitor'] })
        const reason =
          firstReason instanceof Error ? firstReason.message : '更新数据失败'
        toast.warning(`${reason}，已刷新为平台已发布的最新快照。`)
      }
    } finally {
      setUpdating(false)
    }
  }

  // Re-attach this to a button to re-enable the live refresh; kept meanwhile so
  // the implementation is not lost.
  void handleUpdateAll

  const dataUpdatedAt = (
    <span className='text-xs text-muted-foreground'>
      {`${t('community.dataUpdatedAt')} ${formatDateTime(sharedUpdatedAt)}`}
    </span>
  )

  const shell = (children: ReactNode) => (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>
      <Main className='flex flex-1 flex-col gap-6'>{children}</Main>
    </>
  )

  if (reposQuery.isLoading) {
    return shell(<LoadingState />)
  }

  if (reposQuery.isError) {
    return shell(<ErrorState onRetry={() => reposQuery.refetch()} />)
  }

  return shell(
    <>
      <MonitorHeader
        title={t('community.title')}
        description={
          <>
            {t('community.description').slice(0, -1)}
            <ActivityScoreInfo />
            {t('community.description').slice(-1)}
          </>
        }
        meta={undefined}
        search={search}
        onSearchChange={onSearchChange}
        showRange={false}
        actions={dataUpdatedAt}
      />

      {repos.length === 0 ? (
        <ErrorState onRetry={() => reposQuery.refetch()} />
      ) : (
        ordered.map((repo) => (
          <RepoOverviewBox
            key={repoKey(repo)}
            repo={repo}
            live={liveByRepo[repoKey(repo)]}
            activity={scores.get(repoKey(repo)) ?? null}
            isTop={repoKey(repo) === topKey}
          />
        ))
      )}
    </>
  )
}
