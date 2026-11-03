import {
  TIME_RANGES,
  TIME_RANGE_LABELS,
  type TimeRangeKey,
  type TimeRangeSearch,
} from '@/lib/monitor/ranges'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

type TimeRangeFilterProps = {
  value: TimeRangeSearch
  onChange: (next: TimeRangeSearch) => void
  className?: string
  /** Larger, wider control for placement in page headers. */
  size?: 'sm' | 'lg'
}

export function TimeRangeFilter({
  value,
  onChange,
  className,
  size = 'sm',
}: TimeRangeFilterProps) {
  const range: TimeRangeKey = value.range ?? '30d'
  const lg = size === 'lg'

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-lg border',
        lg ? 'h-9 gap-1.5 p-1' : 'gap-1 p-1',
        className
      )}
    >
      {TIME_RANGES.map((key) => (
        <Button
          key={key}
          type='button'
          size='sm'
          variant={range === key ? 'secondary' : 'ghost'}
          className={lg ? 'h-full px-5 text-sm' : 'h-7 px-2.5 text-xs'}
          onClick={() => onChange({ ...value, range: key })}
        >
          {TIME_RANGE_LABELS[key]}
        </Button>
      ))}
    </div>
  )
}
