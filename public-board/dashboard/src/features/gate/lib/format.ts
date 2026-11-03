/** Percent formatters for gate data (spec: Geist Mono figures). */

/** 96.2 → "96.2%" · 100 → "100%" */
export function formatPercent(value: number): string {
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(1)}%`
}
