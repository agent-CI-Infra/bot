import { type ColumnDef } from '@tanstack/react-table'
import { ExternalLink } from 'lucide-react'
import { formatDate, formatDurationHours } from '@/lib/monitor/format'
import type { IssueRecord } from '@/lib/monitor/types'
import { cn } from '@/lib/utils'
import { Badge } from '@/components/ui/badge'
import { DataTableColumnHeader } from '@/components/data-table'
import { LongText } from '@/components/long-text'

const STATE_STYLE: Record<IssueRecord['state'], string> = {
  open: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  closed: 'border-muted-foreground/40 text-muted-foreground',
}

const TYPE_STYLE = {
  internal: 'border-blue-500/40 text-blue-600 dark:text-blue-400',
  external: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  unknown: 'border-muted-foreground/40 text-muted-foreground',
} as const

export const issuesColumns: ColumnDef<IssueRecord, unknown>[] = [
  {
    accessorKey: 'number',
    header: ({ column }) => <DataTableColumnHeader column={column} title='#' />,
    cell: ({ row }) => (
      <a
        href={row.original.url}
        target='_blank'
        rel='noreferrer'
        className='font-mono text-xs hover:underline'
      >
        #{row.original.number}
      </a>
    ),
    meta: { className: 'w-20' },
  },
  {
    accessorKey: 'title',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='标题' />
    ),
    cell: ({ row }) => (
      <LongText className='max-w-md ps-1'>{row.original.title}</LongText>
    ),
  },
  {
    accessorKey: 'author',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='作者' />
    ),
    cell: ({ row }) => (
      <span className='text-sm text-nowrap'>{row.original.author}</span>
    ),
    meta: { className: 'w-40' },
  },
  {
    accessorKey: 'contributionType',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='类型' />
    ),
    cell: ({ row }) => (
      <Badge
        variant='outline'
        className={cn('capitalize', TYPE_STYLE[row.original.contributionType])}
      >
        {row.original.contributionType}
      </Badge>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
    enableSorting: false,
    meta: { className: 'w-28' },
  },
  {
    accessorKey: 'state',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='状态' />
    ),
    cell: ({ row }) => (
      <Badge
        variant='outline'
        className={cn('capitalize', STATE_STYLE[row.original.state])}
      >
        {row.original.state}
      </Badge>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
    enableSorting: false,
    meta: { className: 'w-28' },
  },
  {
    accessorKey: 'createdAt',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='创建时间' />
    ),
    cell: ({ row }) => (
      <span className='text-xs text-nowrap text-muted-foreground'>
        {formatDate(row.original.createdAt)}
      </span>
    ),
    meta: { className: 'w-28' },
  },
  {
    id: 'duration',
    accessorFn: (row) => row.waitingHours ?? undefined,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='滞留时长' />
    ),
    cell: ({ row }) => (
      <span className='text-xs text-nowrap tabular-nums'>
        {formatDurationHours(row.original.waitingHours)}
      </span>
    ),
    sortUndefined: 'last',
    meta: { className: 'w-32' },
  },
  {
    accessorKey: 'comments',
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title='评论数' />
    ),
    cell: ({ row }) => (
      <span className='text-xs tabular-nums'>{row.original.comments}</span>
    ),
    meta: { className: 'w-24' },
  },
  {
    id: 'link',
    header: () => <span className='sr-only'>链接</span>,
    cell: ({ row }) => (
      <a
        href={row.original.url}
        target='_blank'
        rel='noreferrer'
        className='inline-flex text-muted-foreground hover:text-foreground'
        aria-label={`在 GitHub 上打开 Issue #${row.original.number}`}
      >
        <ExternalLink className='size-4' />
      </a>
    ),
    enableSorting: false,
    enableHiding: false,
    meta: { className: 'w-12' },
  },
]
