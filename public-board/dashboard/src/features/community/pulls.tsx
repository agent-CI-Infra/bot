import { useMemo, useState } from 'react'
import { getRouteApi } from '@tanstack/react-router'
import {
  repoKey,
  useActivityScores,
  usePulls,
  useSelectedRepo,
} from '@/lib/monitor/data'
import { percentile } from '@/lib/monitor/derive'
import { formatDurationHours, formatNumber } from '@/lib/monitor/format'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ChartLayoutGrid, type ChartLayout } from './components/chart-layout'
import { MonitorHeader } from './components/monitor-header'
import { MonitorTable } from './components/monitor-table'
import { RepoFilter } from './components/repo-filter'
import { ErrorState, LoadingState } from './components/states'
import { TrendChart } from './components/trend-chart'
import { pullsColumns } from './pulls-columns'
import { useMonitorBase } from './use-monitor'

const route = getRouteApi('/_authenticated/pulls')

export function PullsAnalysis() {
  const [layout, setLayout] = useState<ChartLayout>('horizontal')
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const repoList = useSelectedRepo(search)
  const scores = useActivityScores(repoList.repos)

  // Repositories ranked by community activity, highest first.
  const orderedRepos = [...repoList.repos].sort(
    (a, b) => (scores.get(repoKey(b)) ?? -1) - (scores.get(repoKey(a)) ?? -1)
  )

  // Default to the highest-activity repository when the URL does not pin one.
  const selectedKey = search.repo
    ? repoList.key
    : orderedRepos[0]
      ? repoKey(orderedRepos[0])
      : repoList.key

  const base = useMonitorBase(selectedKey, search)
  const pulls = usePulls(selectedKey)

  // Activity scores are `null` until every repository's data has loaded.
  const scoresReady = [...scores.values()].every((value) => value !== null)

  const records = pulls.data ?? []

  // Records restricted to the selected time window, used by the stats and the
  // detail table. The trend charts keep using the full set and slice internally.
  const rangeRecords = useMemo(() => {
    const { from, to } = base.range
    if (!from) return records
    const fromMs = from.getTime()
    const toMs = to.getTime()
    return records.filter((r) => {
      const t = new Date(r.createdAt).getTime()
      return t >= fromMs && t <= toMs
    })
  }, [records, base.range])

  // Cumulative PR count and cumulative comment count as of each day, counted
  // from the full record set (not the young daily history). Comments are summed
  // over the PRs opened up to that day. Fixed ranges keep their window; "全部历史"
  // spans from the first PR to today.
  const cumulative = useMemo(() => {
    const { from, to, key } = base.range
    const opened = [...records].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    const startDay =
      key === 'all'
        ? opened[0]?.createdAt.slice(0, 10)
        : from?.toISOString().slice(0, 10)
    const endDay = to.toISOString().slice(0, 10)
    if (!startDay || startDay > endDay) return []
    const points: { date: string; total: number; comments: number }[] = []
    let seen = 0
    let comments = 0
    const cursor = new Date(`${startDay}T00:00:00.000Z`)
    while (cursor.toISOString().slice(0, 10) <= endDay) {
      const day = cursor.toISOString().slice(0, 10)
      while (
        seen < opened.length &&
        opened[seen].createdAt.slice(0, 10) <= day
      ) {
        comments += opened[seen].comments
        seen += 1
      }
      points.push({ date: day.slice(5), total: seen, comments })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return points
  }, [records, base.range])

  // Daily new PR count within the same window, for the bar chart below.
  const daily = useMemo(() => {
    const { from, to, key } = base.range
    const opened = [...records].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    const startDay =
      key === 'all'
        ? opened[0]?.createdAt.slice(0, 10)
        : from?.toISOString().slice(0, 10)
    const endDay = to.toISOString().slice(0, 10)
    if (!startDay || startDay > endDay) return []
    const counts = new Map<string, number>()
    for (const r of records) {
      const day = r.createdAt.slice(0, 10)
      if (day < startDay || day > endDay) continue
      counts.set(day, (counts.get(day) ?? 0) + 1)
    }
    const points: { date: string; count: number }[] = []
    const cursor = new Date(`${startDay}T00:00:00.000Z`)
    while (cursor.toISOString().slice(0, 10) <= endDay) {
      const day = cursor.toISOString().slice(0, 10)
      points.push({ date: day.slice(5), count: counts.get(day) ?? 0 })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return points
  }, [records, base.range])

  // Summary stats shown between the trend chart and the detail table.
  const stats = useMemo(() => {
    const total = rangeRecords.length
    const commentTotal = rangeRecords.reduce(
      (sum, r) => sum + (r.comments ?? 0),
      0
    )
    const waiting = rangeRecords
      .filter((r) => r.state === 'open')
      .map((r) => r.waitingHours)
      .filter((h): h is number => h !== null)
    return {
      total,
      commentTotal,
      p50: percentile(waiting, 0.5),
      p90: percentile(waiting, 0.9),
    }
  }, [rangeRecords])

  const onSearchChange = (next: typeof search) =>
    navigate({ search: (prev) => ({ ...prev, ...next }) })

  if (repoList.isError) {
    return (
      <>
        <Header>
          <div className='me-auto' />
          <LanguageSwitch />
          <ThemeSwitch />
        </Header>
        <Main>
          <ErrorState onRetry={() => repoList.refetch()} />
        </Main>
      </>
    )
  }

  if (base.isLoading || (!search.repo && !scoresReady)) {
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

  if (base.isError) {
    return (
      <>
        <Header>
          <div className='me-auto' />
          <LanguageSwitch />
          <ThemeSwitch />
        </Header>
        <Main>
          <ErrorState onRetry={() => base.meta.refetch()} />
        </Main>
      </>
    )
  }

  const latest = base.latest.data
  const pullsData = latest?.pulls

  return (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <MonitorHeader
          title='Pull Request 分析'
          description=''
          meta={base.meta.data}
          search={search}
          onSearchChange={onSearchChange}
        />

        <RepoFilter
          repos={orderedRepos}
          value={selectedKey}
          onChange={(key) => onSearchChange({ repo: key })}
        />

        <ChartLayoutGrid
          layout={layout}
          onLayoutChange={setLayout}
          items={[
            {
              id: 'cumulative',
              title: 'PR 累计总数与评论累计数增长趋势',
              empty: cumulative.length === 0,
              emptyMessage: '暂无历史数据。',
              chart: (
                <TrendChart
                  data={cumulative}
                  xKey='date'
                  series={[
                    {
                      key: 'total',
                      label: 'PR 累计',
                      color: 'var(--chart-1)',
                      type: 'line',
                    },
                    {
                      key: 'comments',
                      label: '评论累计',
                      color: 'var(--chart-2)',
                      type: 'line',
                      yAxis: 'right',
                    },
                  ]}
                  yDomain={['auto', 'auto']}
                  y2Domain={['auto', 'auto']}
                />
              ),
            },
            {
              id: 'daily',
              title: 'PR 每日新增数量',
              empty: daily.length === 0,
              emptyMessage: '暂无历史数据。',
              chart: (
                <TrendChart
                  data={daily}
                  xKey='date'
                  series={[
                    {
                      key: 'count',
                      label: '每日数量',
                      color: 'var(--chart-1)',
                      type: 'bar',
                    },
                  ]}
                  yDomain={['auto', 'auto']}
                />
              ),
            },
          ]}
        />

        <div className='grid gap-3 sm:grid-cols-2 lg:grid-cols-4'>
          {[
            { label: 'PR 累计数量', value: formatNumber(stats.total) },
            {
              label: 'PR 评论累计数量',
              value: formatNumber(stats.commentTotal),
            },
            {
              label: 'PR 滞留时长 P90',
              value:
                stats.p90 === null ? '—' : `≤${formatDurationHours(stats.p90)}`,
            },
            {
              label: 'PR 滞留时长 P50',
              value:
                stats.p50 === null ? '—' : `≤${formatDurationHours(stats.p50)}`,
            },
          ].map((item) => (
            <Card key={item.label} className='py-1.5'>
              <CardContent className='flex items-center justify-between gap-2 px-4'>
                <span className='text-xs text-muted-foreground'>
                  {item.label}
                </span>
                <span className='text-base font-semibold tabular-nums'>
                  {item.value}
                </span>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <CardTitle className='text-base'>Pull Request 明细</CardTitle>
          </CardHeader>
          <CardContent>
            <MonitorTable
              data={rangeRecords}
              columns={pullsColumns}
              searchPlaceholder='按标题、作者或编号搜索 PR…'
              filters={[
                {
                  columnId: 'state',
                  title: '状态',
                  options: [
                    { label: '开启中', value: 'open' },
                    { label: '已合并', value: 'merged' },
                    { label: '已关闭', value: 'closed' },
                  ],
                },
                {
                  columnId: 'contributionType',
                  title: '类型',
                  options: [
                    { label: '内部', value: 'internal' },
                    { label: '外部', value: 'external' },
                    { label: '未知', value: 'unknown' },
                  ],
                },
              ]}
              emptyMessage='尚未采集到 Pull Request。'
            />
          </CardContent>
        </Card>

        <p className='text-xs text-muted-foreground'>
          数据集中的 PR 总数：{formatNumber(pullsData?.total)}。
        </p>
      </Main>
    </>
  )
}
