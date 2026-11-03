import { cn } from '@/lib/utils'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { EmptyState, LoadingState } from './states'

type ChartCardProps = {
  title: string
  description?: string
  action?: React.ReactNode
  loading?: boolean
  empty?: boolean
  emptyMessage?: string
  className?: string
  contentClassName?: string
  children: React.ReactNode
}

export function ChartCard({
  title,
  description,
  action,
  loading,
  empty,
  emptyMessage,
  className,
  contentClassName,
  children,
}: ChartCardProps) {
  return (
    <Card className={cn('flex flex-col', className)}>
      <CardHeader className='flex flex-row items-start justify-between gap-2 space-y-0'>
        <div className='space-y-1'>
          <CardTitle className='text-base'>{title}</CardTitle>
          {description ? (
            <CardDescription>{description}</CardDescription>
          ) : null}
        </div>
        {action}
      </CardHeader>
      <CardContent className={cn('flex-1', contentClassName)}>
        {loading ? (
          <LoadingState />
        ) : empty ? (
          <EmptyState description={emptyMessage} />
        ) : (
          children
        )}
      </CardContent>
    </Card>
  )
}
