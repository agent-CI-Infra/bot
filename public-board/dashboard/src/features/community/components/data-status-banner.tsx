import {
  AlertTriangle,
  CheckCircle2,
  Database,
  Info,
  XCircle,
} from 'lucide-react'
import { formatDateTime, formatRelative } from '@/lib/monitor/format'
import type { MonitorMeta } from '@/lib/monitor/types'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'

type DataStatusBannerProps = {
  meta: MonitorMeta | undefined
}

export function DataStatusBanner({ meta }: DataStatusBannerProps) {
  if (!meta) return null

  const status = meta.status
  const relative = formatRelative(meta.lastSuccessAt)

  const config = {
    ok: {
      Icon: CheckCircle2,
      variant: 'default' as const,
      title: '数据已是最新',
      className: 'border-emerald-500/30',
    },
    partial: {
      Icon: AlertTriangle,
      variant: 'default' as const,
      title: '数据仅部分采集',
      className: 'border-amber-500/40',
    },
    failed: {
      Icon: XCircle,
      variant: 'destructive' as const,
      title: '最近一次采集失败 — 正在显示上一次有效数据',
      className: '',
    },
    empty: {
      Icon: Database,
      variant: 'default' as const,
      title: '尚未采集到数据',
      className: '',
    },
  }[status]

  const { Icon } = config

  return (
    <Alert variant={config.variant} className={config.className}>
      <Icon className='size-4' />
      <AlertTitle className='flex flex-wrap items-center gap-2'>
        {config.title}
        {meta.historyComplete === false && status !== 'empty' ? (
          <Badge variant='outline' className='font-normal'>
            历史自监控开始
          </Badge>
        ) : null}
      </AlertTitle>
      <AlertDescription>
        <div className='space-y-1 text-xs'>
          <p>
            最近一次成功更新：{' '}
            <span className='font-medium'>
              {meta.lastSuccessAt ? formatDateTime(meta.lastSuccessAt) : '—'}
            </span>
            {relative ? ` (${relative})` : null}
          </p>
          {meta.monitoringStart ? (
            <p>
              监控起始时间{' '}
              <span className='font-medium'>
                {formatDateTime(meta.monitoringStart)}
              </span>
            </p>
          ) : null}
          {meta.errors.length > 0 ? (
            <p className='text-destructive'>
              {meta.errors.length} 个采集错误：{meta.errors[0].scope} —{' '}
              {meta.errors[0].message}
            </p>
          ) : null}
          {meta.notes.map((note, idx) => (
            <p
              key={idx}
              className='flex items-start gap-1 text-muted-foreground'
            >
              <Info className='mt-0.5 size-3 shrink-0' />
              <span>{note}</span>
            </p>
          ))}
        </div>
      </AlertDescription>
    </Alert>
  )
}
