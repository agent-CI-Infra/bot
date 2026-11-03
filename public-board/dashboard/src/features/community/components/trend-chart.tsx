import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

export type ChartDatum = Record<string, string | number | null>

export type ChartSeries = {
  key: string
  label: string
  color: string
  type?: 'line' | 'area' | 'bar'
  /** Which y-axis the series is plotted against. Defaults to `'left'`. */
  yAxis?: 'left' | 'right'
}

type TrendChartProps = {
  data: ChartDatum[]
  xKey: string
  series: ChartSeries[]
  height?: number | `${number}%`
  yFormatter?: (value: number) => string
  /** Formatter for the right y-axis, used when a series sets `yAxis: 'right'`. */
  y2Formatter?: (value: number) => string
  xFormatter?: (value: string) => string
  /** Override the left y-axis domain, e.g. `['auto', 'auto']` to zoom into the data. */
  yDomain?: [number | string, number | string]
  /** Override the right y-axis domain. */
  y2Domain?: [number | string, number | string]
  stacked?: boolean
}

const TOOLTIP_STYLE: React.CSSProperties = {
  backgroundColor: 'var(--popover)',
  border: '1px solid var(--border)',
  borderRadius: '0.5rem',
  fontSize: '12px',
  color: 'var(--popover-foreground)',
}

export function TrendChart({
  data,
  xKey,
  series,
  height = 280,
  yFormatter,
  y2Formatter,
  xFormatter,
  yDomain,
  y2Domain,
  stacked,
}: TrendChartProps) {
  const leftSeries = series.find((s) => (s.yAxis ?? 'left') === 'left')
  const rightSeries = series.find((s) => s.yAxis === 'right')
  const hasRightAxis = Boolean(rightSeries)
  // In dual-axis mode, tint each side's numbers with its line colour so the two
  // scales are easy to tell apart.
  const leftColor = hasRightAxis ? leftSeries?.color : undefined
  const rightColor = rightSeries?.color
  // Bold the axis numbers only for the dual-axis chart; other charts keep the
  // default weight.
  const tickStyle = hasRightAxis ? { fontWeight: 'bold' } : undefined
  return (
    <ResponsiveContainer width='100%' height={height}>
      <ComposedChart
        data={data}
        margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
      >
        <CartesianGrid
          vertical={false}
          yAxisId='left'
          stroke='var(--border)'
          strokeDasharray='3 3'
        />
        <XAxis
          dataKey={xKey}
          stroke='var(--muted-foreground)'
          fontSize={12}
          tickLine={false}
          axisLine={false}
          tickMargin={8}
          minTickGap={16}
          tickFormatter={xFormatter}
        />
        <YAxis
          yAxisId='left'
          stroke={leftColor ?? 'var(--muted-foreground)'}
          fontSize={12}
          tickLine={false}
          axisLine={false}
          width={44}
          domain={yDomain}
          tickFormatter={yFormatter}
          tick={tickStyle}
        />
        {hasRightAxis && (
          <YAxis
            yAxisId='right'
            orientation='right'
            stroke={rightColor ?? 'var(--muted-foreground)'}
            fontSize={12}
            tickLine={false}
            axisLine={false}
            width={44}
            domain={y2Domain}
            tickFormatter={y2Formatter}
            tick={tickStyle}
          />
        )}
        <Tooltip contentStyle={TOOLTIP_STYLE} />
        <Legend wrapperStyle={{ fontSize: '12px' }} />
        {series.map((s) => {
          const yAxisId = s.yAxis ?? 'left'
          if (s.type === 'bar') {
            return (
              <Bar
                key={s.key}
                yAxisId={yAxisId}
                dataKey={s.key}
                name={s.label}
                fill={s.color}
                radius={[3, 3, 0, 0]}
                stackId={stacked ? 'stack' : undefined}
                maxBarSize={28}
              />
            )
          }
          if (s.type === 'area') {
            return (
              <Area
                key={s.key}
                yAxisId={yAxisId}
                dataKey={s.key}
                name={s.label}
                stroke={s.color}
                fill={s.color}
                type='monotone'
                stackId={stacked ? 'stack' : undefined}
                strokeWidth={2}
                fillOpacity={0.18}
              />
            )
          }
          return (
            <Line
              key={s.key}
              yAxisId={yAxisId}
              type='monotone'
              dataKey={s.key}
              name={s.label}
              stroke={s.color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          )
        })}
      </ComposedChart>
    </ResponsiveContainer>
  )
}
