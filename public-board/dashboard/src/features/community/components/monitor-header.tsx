import type { ReactNode } from 'react'
import { IconGithub } from '@/assets/brand-icons'
import type { TimeRangeSearch } from '@/lib/monitor/ranges'
import type { MonitorMeta } from '@/lib/monitor/types'
import { Badge } from '@/components/ui/badge'
import { TimeRangeFilter } from './time-range-filter'

type MonitorHeaderProps = {
  title: string
  description?: ReactNode
  meta: MonitorMeta | undefined
  search: TimeRangeSearch
  onSearchChange: (next: TimeRangeSearch) => void
  /** Render the time-range filter (default true). */
  showRange?: boolean
  /** Optional right-aligned actions (e.g. a refresh button). */
  actions?: ReactNode
}

export function MonitorHeader({
  title,
  description,
  meta,
  search,
  onSearchChange,
  showRange = true,
  actions,
}: MonitorHeaderProps) {
  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        <div className='space-y-1'>
          <h1 className='text-2xl font-bold tracking-tight'>{title}</h1>
          {description ? (
            <p className='text-sm text-muted-foreground'>{description}</p>
          ) : null}
        </div>
        <div className='flex flex-wrap items-center gap-3'>
          {showRange ? (
            <TimeRangeFilter
              value={search}
              onChange={onSearchChange}
              size='lg'
            />
          ) : null}
          {meta?.repo ? (
            <a
              href={meta.repo.htmlUrl}
              target='_blank'
              rel='noreferrer'
              className='inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm transition-colors hover:bg-muted'
            >
              <IconGithub className='size-4' />
              <span className='font-medium'>{meta.repo.fullName}</span>
              <Badge variant='outline' className='font-normal'>
                {meta.repo.defaultBranch}
              </Badge>
            </a>
          ) : null}
          {actions}
        </div>
      </div>
    </div>
  )
}
