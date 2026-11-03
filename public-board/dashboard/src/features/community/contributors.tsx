import { useMemo, useState, type ReactNode } from 'react'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import { getRouteApi } from '@tanstack/react-router'
import { Check, ChevronDown } from 'lucide-react'
import {
  contributorsQuery,
  issuesQuery,
  pullsQuery,
  repoKey,
  useRepos,
} from '@/lib/monitor/data'
import { resolveRange, type TimeRangeSearch } from '@/lib/monitor/ranges'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { LanguageSwitch } from '@/components/language-switch'
import { Header } from '@/components/layout/header'
import { Main } from '@/components/layout/main'
import { ThemeSwitch } from '@/components/theme-switch'
import { ChartCard } from './components/chart-card'
import { MonitorTable } from './components/monitor-table'
import { EmptyState, ErrorState, LoadingState } from './components/states'
import { TimeRangeFilter } from './components/time-range-filter'
import { TrendChart } from './components/trend-chart'
import { issuesColumns } from './issues-columns'
import { pullsColumns } from './pulls-columns'

const route = getRouteApi('/_authenticated/contributors')

type ContributorOption = { login: string; pulls: number; issues: number }

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

function ContributorPicker({
  contributors,
  value,
  onChange,
}: {
  contributors: ContributorOption[]
  value?: string
  onChange: (login: string) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = contributors.find((c) => c.login === value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-full max-w-sm justify-between'
        >
          <span className='truncate'>
            {selected ? selected.login : '选择贡献者…'}
          </span>
          <ChevronDown className='ms-2 size-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[min(24rem,90vw)] p-0'>
        <Command>
          <CommandInput placeholder='输入贡献者名称或关键词…' />
          <CommandList>
            <CommandEmpty>未找到匹配的贡献者。</CommandEmpty>
            {contributors.map((c) => (
              <CommandItem
                key={c.login}
                value={c.login}
                onSelect={() => {
                  onChange(c.login)
                  setOpen(false)
                }}
              >
                <span className='truncate'>{c.login}</span>
                <span className='ms-auto text-xs text-muted-foreground'>
                  PR {c.pulls} · Issue {c.issues}
                </span>
                <Check
                  className={cn(
                    'ms-1 size-4',
                    c.login === selected?.login ? 'opacity-100' : 'opacity-0'
                  )}
                />
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export function ContributorsAnalysis() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const queryClient = useQueryClient()
  const reposQuery = useRepos()
  const repos = reposQuery.data?.repos ?? []

  // `combine` memoizes the merged data structurally, so the values below are
  // stable between renders and safe to put in dependency arrays.
  const pulls = useQueries({
    queries: repos.map((repo) => pullsQuery(repoKey(repo))),
    combine: (results) => ({
      items: results.flatMap((result) => result.data ?? []),
      isLoading: results.some((result) => result.isLoading),
      isError: results.some((result) => result.isError),
    }),
  })
  const issues = useQueries({
    queries: repos.map((repo) => issuesQuery(repoKey(repo))),
    combine: (results) => ({
      items: results.flatMap((result) => result.data ?? []),
      isLoading: results.some((result) => result.isLoading),
      isError: results.some((result) => result.isError),
    }),
  })
  const contributors = useQueries({
    queries: repos.map((repo) => contributorsQuery(repoKey(repo))),
    combine: (results) => ({
      items: results.flatMap((result) => result.data?.items ?? []),
      isLoading: results.some((result) => result.isLoading),
      isError: results.some((result) => result.isError),
    }),
  })

  const isLoading =
    reposQuery.isLoading ||
    pulls.isLoading ||
    issues.isLoading ||
    contributors.isLoading
  const isError =
    reposQuery.isError ||
    pulls.isError ||
    issues.isError ||
    contributors.isError

  const all = useMemo(() => {
    const logins = new Set<string>()
    for (const c of contributors.items) {
      if (!c.isBot) logins.add(c.login)
    }
    const byLogin = new Map<string, ContributorOption>()
    for (const login of logins)
      byLogin.set(login, { login, pulls: 0, issues: 0 })
    for (const p of pulls.items) {
      const c = byLogin.get(p.author)
      if (c) c.pulls += 1
    }
    for (const item of issues.items) {
      const c = byLogin.get(item.author)
      if (c) c.issues += 1
    }
    const ranked = [...byLogin.values()].sort(
      (a, b) => b.pulls + b.issues - (a.pulls + a.issues)
    )
    return { pulls: pulls.items, issues: issues.items, contributors: ranked }
  }, [pulls.items, issues.items, contributors.items])

  const selectedLogin = useMemo(() => {
    if (all.contributors.length === 0) return undefined
    if (
      search.contributor &&
      all.contributors.some((c) => c.login === search.contributor)
    ) {
      return search.contributor
    }
    return all.contributors[0].login
  }, [all.contributors, search.contributor])

  const selectedPulls = useMemo(() => {
    if (!selectedLogin) return []
    return all.pulls.filter((p) => p.author === selectedLogin)
  }, [all.pulls, selectedLogin])

  const selectedIssues = useMemo(() => {
    if (!selectedLogin) return []
    return all.issues.filter((i) => i.author === selectedLogin)
  }, [all.issues, selectedLogin])

  const now = toDate(reposQuery.data?.generatedAt) ?? new Date()

  const boundStart = useMemo(() => {
    let min: string | null = null
    for (const r of all.pulls) if (!min || r.createdAt < min) min = r.createdAt
    for (const r of all.issues) if (!min || r.createdAt < min) min = r.createdAt
    return min ? new Date(`${min.slice(0, 10)}T00:00:00.000Z`) : null
  }, [all.pulls, all.issues])

  const range = useMemo(
    () => resolveRange(search, now, boundStart),
    [search, now, boundStart]
  )

  const cumulative = useMemo(() => {
    const { from, to, key } = range
    const prs = [...selectedPulls].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    const iss = [...selectedIssues].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt)
    )
    const startDay =
      key === 'all'
        ? (prs[0]?.createdAt ?? iss[0]?.createdAt)?.slice(0, 10)
        : from?.toISOString().slice(0, 10)
    const endDay = to.toISOString().slice(0, 10)
    if (!startDay || startDay > endDay) return []
    const points: { date: string; pr: number; issue: number }[] = []
    let p = 0
    let i = 0
    const cursor = new Date(`${startDay}T00:00:00.000Z`)
    while (cursor.toISOString().slice(0, 10) <= endDay) {
      const day = cursor.toISOString().slice(0, 10)
      while (p < prs.length && prs[p].createdAt.slice(0, 10) <= day) p += 1
      while (i < iss.length && iss[i].createdAt.slice(0, 10) <= day) i += 1
      points.push({ date: day.slice(5), pr: p, issue: i })
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return points
  }, [range, selectedPulls, selectedIssues])

  const onRangeChange = (next: TimeRangeSearch) =>
    navigate({ search: (prev) => ({ ...prev, range: next.range }) })

  const onContributorChange = (login: string) =>
    navigate({ search: (prev) => ({ ...prev, contributor: login }) })

  const retryAll = () => {
    reposQuery.refetch()
    void queryClient.refetchQueries({ queryKey: ['monitor'], type: 'active' })
  }

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

  if (isLoading) return shell(<LoadingState />)
  if (isError) return shell(<ErrorState onRetry={retryAll} />)

  return shell(
    <>
      <div className='space-y-1'>
        <h1 className='text-2xl font-bold tracking-tight'>贡献者贡献分析</h1>
        <p className='text-sm text-muted-foreground'>
          查看每位贡献者的 PR 与 Issue 累计趋势和明细。
        </p>
      </div>

      <ContributorPicker
        contributors={all.contributors}
        value={selectedLogin}
        onChange={onContributorChange}
      />

      {selectedLogin ? (
        <>
          <ChartCard
            title={`${selectedLogin} · PR / Issue 累计趋势`}
            description='左侧为 PR 累计，右侧为 Issue 累计。'
            action={
              <TimeRangeFilter
                value={{ range: search.range }}
                onChange={onRangeChange}
              />
            }
            empty={cumulative.length === 0}
            emptyMessage='该贡献者暂无 PR 或 Issue 数据。'
          >
            <TrendChart
              data={cumulative}
              xKey='date'
              series={[
                {
                  key: 'pr',
                  label: 'PR 累计',
                  color: 'var(--chart-1)',
                  type: 'line',
                },
                {
                  key: 'issue',
                  label: 'Issue 累计',
                  color: 'var(--chart-2)',
                  type: 'line',
                  yAxis: 'right',
                },
              ]}
              yDomain={['auto', 'auto']}
              y2Domain={['auto', 'auto']}
            />
          </ChartCard>

          <Card>
            <CardHeader>
              <CardTitle className='text-base'>Pull Request 清单</CardTitle>
            </CardHeader>
            <CardContent>
              <MonitorTable
                data={selectedPulls}
                columns={pullsColumns}
                searchPlaceholder='按标题、作者或编号搜索 PR…'
                emptyMessage='该贡献者暂无 Pull Request。'
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='text-base'>Issue 清单</CardTitle>
            </CardHeader>
            <CardContent>
              <MonitorTable
                data={selectedIssues}
                columns={issuesColumns}
                searchPlaceholder='按标题、作者或编号搜索 Issue…'
                emptyMessage='该贡献者暂无 Issue。'
              />
            </CardContent>
          </Card>
        </>
      ) : (
        <EmptyState
          title='暂无贡献者数据'
          description='尚未采集到贡献者数据。'
        />
      )}
    </>
  )
}
