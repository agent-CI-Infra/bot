import { type ReactNode } from 'react'
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { GripVertical } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ChartCard } from './chart-card'

export type ChartLayout = 'vertical' | 'horizontal'

type ChartItem = {
  id: string
  title: string
  empty: boolean
  emptyMessage: string
  chart: ReactNode
}

type ChartLayoutGridProps = {
  layout: ChartLayout
  onLayoutChange: (layout: ChartLayout) => void
  items: ChartItem[]
}

function DraggableChart({ item }: { item: ChartItem }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: item.id })

  return (
    <div
      ref={setNodeRef}
      style={
        transform
          ? {
              transform: `translate3d(${transform.x}px, ${transform.y}px, 0)`,
            }
          : undefined
      }
      className={cn(isDragging ? 'relative z-10 opacity-90' : 'opacity-100')}
    >
      <ChartCard
        title={item.title}
        action={
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='size-8 cursor-grab touch-none active:cursor-grabbing'
            aria-label='拖拽调整图表排列'
            {...attributes}
            {...listeners}
          >
            <GripVertical className='size-4' />
          </Button>
        }
        empty={item.empty}
        emptyMessage={item.emptyMessage}
      >
        {item.chart}
      </ChartCard>
    </div>
  )
}

/**
 * Renders the two monitor charts as draggable cards. Dragging a card upward
 * switches to side-by-side layout, dragging downward switches back to stacked.
 */
export function ChartLayoutGrid({
  layout,
  onLayoutChange,
  items,
}: ChartLayoutGridProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const deltaY = event.delta.y
    if (deltaY < -48) onLayoutChange('horizontal')
    else if (deltaY > 48) onLayoutChange('vertical')
  }

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <div
        className={
          layout === 'horizontal'
            ? 'grid gap-3 lg:grid-cols-2'
            : 'flex flex-col gap-6'
        }
      >
        {items.map((item) => (
          <DraggableChart key={item.id} item={item} />
        ))}
      </div>
    </DndContext>
  )
}
