import type { ReactNode } from 'react'
import {
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  type LucideIcon,
} from 'lucide-react'
import { formatDelta } from '@/lib/monitor/format'
import { cn } from '@/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

type MetricCardProps = {
  title: string
  value: string
  icon?: LucideIcon
  /** Small inline text rendered right after the value, e.g. "(外部5)". */
  suffix?: string
  /** Optional control rendered right after the title (e.g. an info popover). */
  info?: ReactNode
  /** Signed change within the selected period (null = no baseline). */
  delta?: number | null
  /** Signed change within the previous period, for comparison. */
  previousDelta?: number | null
  /** Short context line, e.g. "Open now". */
  hint?: string
  description?: string
  /** Tighter padding/value size, for high-density grids. */
  compact?: boolean
  /** Render icon, title and value on a single compact line. */
  inline?: boolean
  className?: string
}

function DeltaBadge({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined) {
    return (
      <span className='inline-flex items-center gap-1 text-muted-foreground'>
        <Minus className='size-3.5' />
        <span>无基线</span>
      </span>
    )
  }
  if (delta === 0) {
    return (
      <span className='inline-flex items-center gap-1 text-muted-foreground'>
        <Minus className='size-3.5' />
        <span>0</span>
      </span>
    )
  }
  const positive = delta > 0
  const Icon = positive ? ArrowUpRight : ArrowDownRight
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-medium',
        positive
          ? 'text-emerald-600 dark:text-emerald-400'
          : 'text-red-600 dark:text-red-400'
      )}
    >
      <Icon className='size-3.5' />
      <span>{formatDelta(delta)}</span>
    </span>
  )
}

export function MetricCard({
  title,
  value,
  icon: Icon,
  suffix,
  info,
  delta,
  previousDelta,
  hint,
  description,
  compact,
  inline,
  className,
}: MetricCardProps) {
  const hasInfo =
    delta !== undefined ||
    (previousDelta !== undefined && previousDelta !== null) ||
    Boolean(hint)

  if (inline) {
    return (
      <Card className={cn('gap-0 px-2.5 py-1.5', className)}>
        <CardContent className='flex items-center gap-1 px-0'>
          {Icon ? (
            <Icon className='size-4 shrink-0 text-muted-foreground' />
          ) : null}
          <span className='truncate text-sm text-muted-foreground'>
            {title}
          </span>
          {info ? <span className='shrink-0'>{info}</span> : null}
          <span className='ml-auto text-base font-bold tabular-nums'>
            {value}
          </span>
          {suffix ? (
            <span className='shrink-0 text-base font-bold tabular-nums'>
              {suffix}
            </span>
          ) : null}
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={cn(compact ? 'gap-1 py-3' : 'gap-4', className)}>
      <CardHeader className='flex flex-row items-center justify-between space-y-0 pb-0'>
        <div className='flex items-center gap-1.5'>
          <CardTitle className='text-sm font-medium'>{title}</CardTitle>
          {info}
        </div>
        {Icon ? <Icon className='size-4 text-muted-foreground' /> : null}
      </CardHeader>
      <CardContent className='space-y-2'>
        <div className='flex items-baseline gap-2'>
          <span
            className={cn(
              'font-bold tabular-nums',
              compact ? 'text-xl' : 'text-2xl'
            )}
          >
            {value}
          </span>
          {suffix ? (
            <span className='text-sm text-muted-foreground tabular-nums'>
              {suffix}
            </span>
          ) : null}
        </div>
        {hasInfo ? (
          <div className='flex flex-wrap items-center gap-x-2 gap-y-1 text-xs'>
            {delta !== undefined ? <DeltaBadge delta={delta} /> : null}
            {previousDelta !== undefined && previousDelta !== null ? (
              <span className='text-muted-foreground'>
                环比：{formatDelta(previousDelta)}
              </span>
            ) : null}
            {hint ? (
              <span className='text-muted-foreground'>{hint}</span>
            ) : null}
          </div>
        ) : null}
        {description ? (
          <CardDescription className='text-xs'>{description}</CardDescription>
        ) : null}
      </CardContent>
    </Card>
  )
}
