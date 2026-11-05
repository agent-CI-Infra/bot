import { appEvents, appPermissions, missingEvents, missingPermissions } from '../github/client.js';

// What each console feature needs from a repository's GitHub account. Review and development make up the baseline that
// onboarding asks for (appPermissions/appEvents). Gate onboarding commits .github/workflows/ (workflows) and Actions
// failure analysis needs workflow_run; both, like releases, run only through a GitHub App installation. Tokens still
// request only what each use needs; this table only says which features a missing grant stops.
export const features = ['review', 'review_threads', 'development', 'ci_reads', 'board', 'release', 'gate', 'actions_failures'] as const;
export type Feature = typeof features[number];
interface Needs { permissions: Record<string, string>; events?: string[]; app?: boolean }
export const featureNeeds: Record<Feature, Needs> = {
  review: { permissions: { metadata: 'read', contents: 'read', issues: 'write', pull_requests: 'write' }, events: appEvents },
  // Re-reviews close the bot's inline threads that later commits fixed; GitHub lets an App resolve a thread only with
  // contents: write. Without it reviews are still published and the threads stay open.
  review_threads: { permissions: { metadata: 'read', contents: 'write', pull_requests: 'write' } },
  development: { permissions: { metadata: 'read', contents: 'write', issues: 'write', pull_requests: 'write' }, events: appEvents },
  // Task agents read CI results with their own read-only token; a missing grant only hides those results.
  ci_reads: { permissions: { actions: 'read', checks: 'read', statuses: 'read' } },
  board: { permissions: { metadata: 'read', contents: 'read', issues: 'read', pull_requests: 'read', actions: 'read' } },
  release: { app: true, permissions: { metadata: 'read', contents: 'write', actions: 'write', pull_requests: 'read' } },
  gate: { app: true, permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', workflows: 'write' } },
  actions_failures: { app: true, permissions: { metadata: 'read', contents: 'read', actions: 'write', issues: 'write' }, events: ['workflow_run'] },
};
const rank: Record<string, number> = { read: 1, write: 2, admin: 3 };
// The baseline raised to what any feature needs, and every event any feature listens to.
export const allPermissions: Record<string, string> = { ...appPermissions };
for (const needs of Object.values(featureNeeds)) for (const [name, level] of Object.entries(needs.permissions))
  if (rank[level]! > (rank[allPermissions[name]!] || 0)) allPermissions[name] = level;
export const allEvents = [...new Set([...appEvents, ...features.flatMap(feature => featureNeeds[feature].events || [])])];

// `features` lists the features the gap stops; an empty list means only the onboarding baseline asks for more.
export interface AccessGap { kind: 'permission' | 'event' | 'role' | 'account'; name: string; required?: string; current?: string | null; features: Feature[] }
const appOnly = features.filter(feature => featureNeeds[feature].app);

/** App permissions and events against every feature; used for installations and the App definition alike. */
export function appGaps(permissions: unknown, events: unknown): AccessGap[] {
  const stopped = (name: string, current: string | null) => features.filter(feature => {
    const need = featureNeeds[feature].permissions[name]; return !!need && rank[need]! > (rank[current || ''] || 0);
  });
  return [...missingPermissions(permissions, allPermissions).map(item => ({ kind: 'permission' as const, name: item.permission, required: item.required,
    current: item.current, features: stopped(item.permission, item.current) })),
  ...missingEvents(events, allEvents).map(name => ({ kind: 'event' as const, name, features: features.filter(feature => featureNeeds[feature].events?.includes(name)) }))];
}
/** Every gap of one repository; null while the grant (or an App installation's events) has not been read. */
export function accessGaps(accountType: string, grant: string | null, events: string | null): AccessGap[] | null {
  let value: unknown; try { value = grant ? JSON.parse(grant) : null; } catch { return null; }
  if (!value || typeof value !== 'object') return null;
  if (accountType === 'github_app') {
    let subscribed: unknown; try { subscribed = events ? JSON.parse(events) : null; } catch { return null; }
    return Array.isArray(subscribed) ? appGaps(value, subscribed) : null;
  }
  // A bot account works through its own repository role and cannot run the App-only features at all.
  const role = value as Record<string, unknown>, gaps: AccessGap[] = [];
  if (!(role.admin === true || role.maintain === true || role.push === true)) {
    const current = role.triage === true ? 'triage' : role.pull === true ? 'read' : null;
    gaps.push({ kind: 'role', name: 'repository_role', required: 'write', current, features: current ? ['review', 'review_threads', 'development'] : features.filter(feature => !featureNeeds[feature].app) });
  }
  gaps.push({ kind: 'account', name: 'github_app', features: appOnly });
  return gaps;
}
