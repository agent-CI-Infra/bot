import { useMemo } from 'react'
import { IconGithub } from '@/assets/brand-icons'
import { useContributors, useRepos } from '@/lib/monitor/data'
import type { ContributorRecord, RepoSummary } from '@/lib/monitor/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { EmptyState, ErrorState, LoadingState } from './components/states'
import { TrendChart } from './components/trend-chart'

/** star-history.com external embed URLs for one repository. */
function starHistory(repo: string) {
  return {
    link: `https://www.star-history.com/?repos=${encodeURIComponent(
      repo
    )}&type=date&legend=top-right`,
    light: `https://api.star-history.com/chart?repos=${repo}&type=date&legend=top-right`,
    dark: `https://api.star-history.com/chart?repos=${repo}&type=date&theme=dark&legend=top-right`,
  }
}

/**
 * Daily cumulative contributor counts, counted from each non-bot account's
 * first contribution date up to today. Two series: every contributor and the
 * external subset.
 */
function contributorGrowth(items: ContributorRecord[]) {
  const humans = items.filter((c) => !c.isBot)
  const dayOf = (c: ContributorRecord) => c.firstContributionAt?.slice(0, 10)
  const pickDates = (records: ContributorRecord[]) =>
    records
      .map(dayOf)
      .filter((d): d is string => Boolean(d))
      .sort((a, b) => a.localeCompare(b))

  const allDates = pickDates(humans)
  if (allDates.length === 0) return []
  const externalDates = pickDates(
    humans.filter((c) => c.contributionType === 'external')
  )

  const startDay = allDates[0]
  const endDay = new Date().toISOString().slice(0, 10)
  const points: { date: string; all: number; external: number }[] = []
  let all = 0
  let external = 0
  const cursor = new Date(`${startDay}T00:00:00.000Z`)
  while (cursor.toISOString().slice(0, 10) <= endDay) {
    const date = cursor.toISOString().slice(0, 10)
    while (all < allDates.length && allDates[all] <= date) all += 1
    while (external < externalDates.length && externalDates[external] <= date)
      external += 1
    points.push({ date: date.slice(5), all, external })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return points
}

function RepoGrowthRow({ repo }: { repo: RepoSummary }) {
  const contributors = useContributors(repo.fullName)
  const items = contributors.data?.items ?? []
  const growth = useMemo(() => contributorGrowth(items), [items])
  const urls = starHistory(repo.fullName)

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-base'>
          <a
            href={repo.htmlUrl}
            target='_blank'
            rel='noreferrer'
            className='inline-flex items-center gap-2 hover:underline'
          >
            <IconGithub className='size-4' />
            {repo.fullName}
          </a>
        </CardTitle>
      </CardHeader>
      <CardContent className='grid gap-6 lg:grid-cols-2'>
        <div className='flex h-full flex-col gap-3'>
          <p className='text-sm font-medium text-muted-foreground'>
            贡献者增长
          </p>
          {contributors.isError ? (
            <EmptyState
              title='无法加载贡献者数据'
              description='数据文件无法读取，可能尚未发布。'
            />
          ) : contributors.isLoading ? (
            <LoadingState />
          ) : growth.length === 0 ? (
            <EmptyState title='暂无贡献者数据' />
          ) : (
            <div className='min-h-[220px] flex-1'>
              <TrendChart
                data={growth}
                xKey='date'
                height='100%'
                series={[
                  {
                    key: 'all',
                    label: '全部贡献者',
                    color: 'var(--chart-1)',
                    type: 'line',
                  },
                  {
                    key: 'external',
                    label: '外部贡献者',
                    color: 'var(--chart-2)',
                    type: 'line',
                  },
                ]}
                yDomain={['auto', 'auto']}
              />
            </div>
          )}
        </div>

        <div className='space-y-3'>
          <p className='text-sm font-medium text-muted-foreground'>
            Star History
          </p>
          <a href={urls.link} target='_blank' rel='noreferrer'>
            <picture>
              <source media='(prefers-color-scheme: dark)' srcSet={urls.dark} />
              <source
                media='(prefers-color-scheme: light)'
                srcSet={urls.light}
              />
              <img
                alt={`${repo.fullName} Star History Chart`}
                src={urls.light}
                className='w-full rounded-lg border'
              />
            </picture>
          </a>
        </div>
      </CardContent>
    </Card>
  )
}

export function GrowthTrends() {
  const reposQuery = useRepos()
  const repos = reposQuery.data?.repos ?? []

  if (reposQuery.isError) {
    return (
      <>
        <Header>
          <div className='me-auto' />
          <LanguageSwitch />
          <ThemeSwitch />
        </Header>
        <Main>
          <ErrorState onRetry={() => reposQuery.refetch()} />
        </Main>
      </>
    )
  }

  if (reposQuery.isLoading) {
    return (
      <>
        <Header>
          <div className='me-auto' />
          <LanguageSwitch />
          <ThemeSwitch />
        </Header>
        <Main>
          <LoadingState />
        </Main>
      </>
    )
  }

  return (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>社区成长</h1>
          <p className='text-sm text-muted-foreground'>
            各社区的贡献者增长与 Star 增长历史。
          </p>
        </div>

        <div className='flex flex-col gap-6'>
          {repos.map((repo) => (
            <RepoGrowthRow key={repo.fullName} repo={repo} />
          ))}
        </div>
      </Main>
    </>
  )
}
