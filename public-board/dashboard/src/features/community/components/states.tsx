import { AlertTriangle, Inbox, Loader2, RefreshCw } from 'lucide-react'
import { useLang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

type StateProps = {
  className?: string
  title?: string
  description?: string
}

export function LoadingState({ className, title }: StateProps) {
  const { t } = useLang()
  title ??= t('state.loading')
  return (
    <div
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-3 text-muted-foreground',
        className
      )}
    >
      <Loader2 className='size-6 animate-spin' />
      <p className='text-sm'>{title}</p>
    </div>
  )
}

export function EmptyState({ className, title, description }: StateProps) {
  const { t } = useLang()
  title ??= t('state.empty.title')
  description ??= t('state.empty.desc')
  return (
    <div
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-3 text-center text-muted-foreground',
        className
      )}
    >
      <Inbox className='size-6' />
      <div className='space-y-1'>
        <p className='text-sm font-medium text-foreground'>{title}</p>
        <p className='max-w-sm text-xs'>{description}</p>
      </div>
    </div>
  )
}

export function ErrorState({
  className,
  title,
  description,
  onRetry,
}: StateProps & { onRetry?: () => void }) {
  const { t } = useLang()
  title ??= t('state.error.title')
  description ??= t('state.error.desc')
  return (
    <Card className={cn('border-destructive/40', className)}>
      <CardContent className='flex min-h-40 flex-col items-center justify-center gap-3 text-center'>
        <AlertTriangle className='size-6 text-destructive' />
        <div className='space-y-1'>
          <p className='text-sm font-medium'>{title}</p>
          <p className='max-w-md text-xs text-muted-foreground'>
            {description}
          </p>
        </div>
        {onRetry ? (
          <Button variant='outline' size='sm' onClick={onRetry}>
            <RefreshCw className='me-2 size-4' />
            {t('state.retry')}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
