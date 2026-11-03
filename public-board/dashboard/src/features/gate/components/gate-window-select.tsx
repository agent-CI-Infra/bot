import { Check, ChevronDown } from 'lucide-react'
import { useLang } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  useGateWindow,
  WINDOW_OPTIONS,
} from '@/features/gate/stores/gate-window'

/**
 * Compact time-window selector rendered inline with the page subtitle, so the
 * "last N days" in the heading is an actual control instead of static text.
 */
export function GateWindowSelect() {
  const { t } = useLang()
  const windowDays = useGateWindow((s) => s.windowDays)
  const setWindowDays = useGateWindow((s) => s.setWindowDays)
  const current = WINDOW_OPTIONS.find((o) => o.days === windowDays)

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        aria-label={t('gate.windowSelect')}
        title={t('gate.windowSelect')}
        className='inline-flex h-6 items-center gap-1 rounded-md border border-gate-line bg-gate-card px-2 text-sm text-gate-dim outline-none hover:text-gate-ink focus-visible:ring-2 focus-visible:ring-gate-accent/30'
      >
        {current ? t(current.labelKey) : `${windowDays}d`}
        <ChevronDown className='size-3.5 text-gate-faint' />
      </DropdownMenuTrigger>
      <DropdownMenuContent align='start' className='min-w-32'>
        {WINDOW_OPTIONS.map((option) => (
          <DropdownMenuItem
            key={option.days}
            onClick={() => setWindowDays(option.days)}
            className='text-[12px] font-medium'
          >
            {t(option.labelKey)}
            <Check
              size={14}
              className={cn('ms-auto', option.days !== windowDays && 'hidden')}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
