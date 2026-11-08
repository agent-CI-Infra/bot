import { fail } from '../core/security.js';
import type { Plan } from './types.js';

const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(at: number, timezone: string): number[] {
  let f = formatters.get(timezone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); }
    catch { return fail(400, 'invalid_schedule_timezone'); }
    formatters.set(timezone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map(v => [v.type, v.value]));
  return [Number(p.year), Number(p.month), Number(p.day), Number(p.hour), Number(p.minute)];
}
const wall = (p: number[]) => Date.UTC(p[0]!, p[1]! - 1, p[2]!, p[3]!, p[4]!);
function field(value: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of value.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return fail(400, 'invalid_schedule_cron');
    const step = Number(m[2] ?? 1), bounds = m[1] === '*' ? [min, max] : m[1]!.split('-').map(Number);
    const [start, end] = [bounds[0]!, bounds[1] ?? (m[2] ? max : bounds[0]!)];
    if (start < min || end > max || start > end || step < 1 || step > max + 1) fail(400, 'invalid_schedule_cron');
    for (let i = start; i <= end; i += step) values.add(i);
  }
  return values;
}
export function parseCron(cron: string): Set<number>[] {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return fail(400, 'invalid_schedule_cron');
  return parts.map((v, i) => field(v, [0, 0, 1, 1, 0][i]!, [59, 23, 31, 12, 6][i]!));
}
/** Enumerate wall-clock candidates, then validate UTC conversions. Gaps have no candidate;
 * folds choose the earliest UTC candidate, independently of the worker's polling frequency. */
export function nextTime(plan: Pick<Plan, 'timezone' | 'cron' | 'interval_ms' | 'start_at' | 'end_at'>, after: number): number | null {
  localParts(after, plan.timezone);
  if (plan.interval_ms) {
    const next = plan.start_at + Math.max(0, Math.floor((after - plan.start_at) / plan.interval_ms) + 1) * plan.interval_ms;
    return plan.end_at !== undefined && next >= plan.end_at ? null : next;
  }
  const sets = parseCron(plan.cron!), raw = plan.cron!.trim().split(/\s+/), p = localParts(Math.max(after, plan.start_at - 1), plan.timezone);
  const firstDay = Date.UTC(p[0]!, p[1]! - 1, p[2]!);
  // A finite search also rejects impossible dates; leap-day plans can look ahead to the next leap year.
  for (let day = 0; day < 366 * 5; day++) {
    const date = new Date(firstDay + day * 86400000), y = date.getUTCFullYear(), m = date.getUTCMonth() + 1, d = date.getUTCDate();
    if (!sets[3]!.has(m)) continue;
    const dom = sets[2]!.has(d), dow = sets[4]!.has(date.getUTCDay());
    if (!(raw[2] === '*' ? dow : raw[4] === '*' ? dom : dom || dow)) continue;
    const midnight = date.getTime(), offsets = new Set<number>();
    for (const delta of [-36, -12, 0, 12, 36]) {
      const at = midnight + delta * 3600000;
      offsets.add(wall(localParts(at, plan.timezone)) - at);
    }
    let best = Infinity;
    for (const h of sets[1]!) for (const minute of sets[0]!) {
      const local = Date.UTC(y, m - 1, d, h, minute);
      const candidates = [...offsets].map(offset => local - offset).filter(at => wall(localParts(at, plan.timezone)) === local);
      const at = Math.min(...candidates);
      if (at > after && at >= plan.start_at) best = Math.min(best, at);
    }
    if (best !== Infinity) return plan.end_at !== undefined && best >= plan.end_at ? null : best;
  }
  return null;
}
export function previewTimes(plan: Parameters<typeof nextTime>[0], after: number, count = 5): number[] {
  const result: number[] = [];
  for (let i = 0; i < count; i++) { const at = nextTime(plan, after); if (at === null) break; result.push(at); after = at; }
  return result;
}
export function quietUntil(spec: { timezone: string; quiet_start?: string; quiet_end?: string }, now: number): number {
  if (!spec.quiet_start || !spec.quiet_end) return now;
  const minutes = (v: string) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const start = minutes(spec.quiet_start), end = minutes(spec.quiet_end);
  const quiet = (at: number) => { const p = localParts(at, spec.timezone), current = p[3]! * 60 + p[4]!; return start < end ? current >= start && current < end : current >= start || current < end; };
  if (!quiet(now)) return now;
  // UTC minute stepping handles midnight, DST gaps and folds without an ambiguous local conversion.
  for (let at = Math.floor(now / 60000) * 60000 + 60000; at <= now + 27 * 3600000; at += 60000) if (!quiet(at)) return at;
  return now + 27 * 3600000;
}
