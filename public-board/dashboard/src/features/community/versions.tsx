import { getRouteApi } from '@tanstack/react-router'
import {
  useMonitorMeta,
  useReleases,
  useSelectedRepo,
} from '@/lib/monitor/data'
import { formatDate } from '@/lib/monitor/format'
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
import { MonitorHeader } from './components/monitor-header'
import { RepoFilter } from './components/repo-filter'
import { EmptyState, ErrorState, LoadingState } from './components/states'

const route = getRouteApi('/_authenticated/versions')

function LinkCell({ href, label }: { href: string | null; label?: string }) {
  if (!href) return <span className='text-muted-foreground'>—</span>
  return (
    <a
      href={href}
      target='_blank'
      rel='noreferrer'
      className='font-medium text-blue-600 underline hover:text-blue-700 dark:text-blue-400'
    >
      {label ?? href}
    </a>
  )
}

export function VersionsAnalysis() {
  const search = route.useSearch()
  const navigate = route.useNavigate()
  const repoList = useSelectedRepo(search)
  const selectedKey = repoList.key

  const meta = useMonitorMeta(selectedKey)
  const releases = useReleases(selectedKey)

  const items = releases.data ?? []

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

  if (repoList.isLoading || (selectedKey && meta.isLoading)) {
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

  if (selectedKey && meta.isError) {
    return (
      <>
        <Header>
          <div className='me-auto' />
          <LanguageSwitch />
          <ThemeSwitch />
        </Header>
        <Main>
          <ErrorState onRetry={() => meta.refetch()} />
        </Main>
      </>
    )
  }

  const repoUrl = meta.data?.repo.htmlUrl ?? ''
  const homepage = items[0]?.homepage ?? null

  return (
    <>
      <Header>
        <div className='me-auto' />
        <LanguageSwitch />
        <ThemeSwitch />
      </Header>

      <Main className='flex flex-1 flex-col gap-6'>
        <MonitorHeader
          title='版本管理'
          description='各社区的版本发布与相关信息。'
          meta={meta.data}
          search={search}
          onSearchChange={onSearchChange}
          showRange={false}
        />

        <RepoFilter
          repos={repoList.repos}
          value={selectedKey}
          onChange={(key) => onSearchChange({ repo: key })}
        />

        <Card>
          <CardHeader className='flex flex-row items-center justify-between gap-2 space-y-0'>
            <CardTitle className='text-base'>版本清单</CardTitle>
            {homepage ? (
              <a
                href={homepage}
                target='_blank'
                rel='noreferrer'
                className='font-medium text-blue-600 underline hover:text-blue-700 dark:text-blue-400'
              >
                点击进入官网
              </a>
            ) : null}
          </CardHeader>
          <CardContent>
            {releases.isLoading ? (
              <LoadingState />
            ) : items.length === 0 ? (
              <EmptyState
                title='暂无版本数据'
                description='尚未采集到该社区的版本发布信息。'
              />
            ) : (
              <div className='overflow-x-auto'>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>版本</TableHead>
                      <TableHead>发布时间</TableHead>
                      <TableHead>README</TableHead>
                      <TableHead>Release Note</TableHead>
                      <TableHead>宣传视频</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((r) => (
                      <TableRow key={r.tag}>
                        <TableCell>
                          <div className='flex flex-col gap-0.5'>
                            <LinkCell
                              href={`${repoUrl}/tree/${r.tag}`}
                              label={r.tag}
                            />
                            {r.name && r.name !== r.tag ? (
                              <span className='text-xs text-muted-foreground'>
                                {r.name}
                              </span>
                            ) : null}
                            {r.prerelease ? (
                              <span className='text-xs text-muted-foreground'>
                                预发布
                              </span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className='whitespace-nowrap'>
                          {formatDate(r.publishedAt)}
                        </TableCell>
                        <TableCell>
                          <LinkCell href={r.readmeUrl} label='README' />
                        </TableCell>
                        <TableCell>
                          <LinkCell
                            href={r.releaseNoteUrl}
                            label='Release Note'
                          />
                        </TableCell>
                        <TableCell>
                          <LinkCell href={r.videoUrl} label='点击进入' />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </Main>
    </>
  )
}
