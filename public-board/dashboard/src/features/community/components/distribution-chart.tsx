import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

type DistributionChartProps = {
  data: { bucket: string; count: number }[]
  height?: number
  color?: string
}

export function DistributionChart({
  data,
  height = 240,
  color = 'var(--chart-2)',
}: DistributionChartProps) {
  return (
    <ResponsiveContainer width='100%' height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid
          vertical={false}
          stroke='var(--border)'
          strokeDasharray='3 3'
        />
        <XAxis
          dataKey='bucket'
          stroke='var(--muted-foreground)'
          fontSize={12}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
        />
        <YAxis
          stroke='var(--muted-foreground)'
          fontSize={12}
          tickLine={false}
          axisLine={false}
          width={32}
          allowDecimals={false}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--popover)',
            border: '1px solid var(--border)',
            borderRadius: '0.5rem',
            fontSize: '12px',
            color: 'var(--popover-foreground)',
          }}
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
        />
        <Bar
          dataKey='count'
          name='数量'
          fill={color}
          radius={[3, 3, 0, 0]}
          maxBarSize={40}
        />
      </BarChart>
    </ResponsiveContainer>
  )
}
