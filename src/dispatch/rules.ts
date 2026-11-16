import type { Store } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import type { Decision, DispatchContext } from './store.js';

/**
 * Standing rules (#815). Routine events need no model call: the Manager (or a person in 角色 → Manager) registers rules,
 * each naming an event type, optional object conditions and what to do: create one work type, continue the running task,
 * or ignore the event. The dispatcher applies the first rule that matches and records its id and revision on the event;
 * an event no rule settles goes to the Manager. Rules are kept with the Manager's revisions; a project that never saved any
 * uses the built-in ones below.
 *
 * A rule never widens anything: the work it creates is checked like the Manager's create_task, and a rule whose work is
 * refused, or that would start development (which needs a basis), does not apply.
 */
export interface StandingRule {
  id: string; event: string; action: RuleAction; work?: string; reason: string; enabled?: boolean;
  when?: { labels_any?: string[]; labels_none?: string[] };
}
// continue: the object's running, waiting or last finished task; continue_active: only one that is queued, running or
// waiting; continue_or_create: continue, else create the work.
export const ruleActions = ['create', 'continue', 'continue_active', 'continue_or_create', 'ignore'] as const;
export type RuleAction = typeof ruleActions[number];

/**
 * What the Manager decided by itself for these events before #815, as rules: a review of every new Issue and pull request,
 * a push to the pull request's review (or a new review of the head), and an update to the review still working on the
 * object. Mentions, labels, published reviews and everything else still go to the Manager.
 */
export const builtinRules: StandingRule[] = [
  { id: 'issue-opened', event: 'issue.opened', action: 'create', work: 'review.issue', reason: '常设规则：新 Issue 交给 Issue 检视。' },
  { id: 'pull-request-opened', event: 'pull_request.opened', action: 'create', work: 'review.pr', reason: '常设规则：新 PR 交给 PR 检视。' },
  { id: 'pull-request-push', event: 'pull_request.synchronize', action: 'continue_or_create', work: 'review.pr', reason: '常设规则：新提交交给这个 PR 的检视，没有就检视这个 head。' },
  { id: 'issue-update', event: 'issue.updated', action: 'continue_active', reason: '常设规则：更新并入还在进行的 Issue 检视。' },
  { id: 'pull-request-update', event: 'pull_request.updated', action: 'continue_active', reason: '常设规则：更新并入还在进行的 PR 检视。' },
];

export function rulesStorage(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS manager_rules(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,rules TEXT NOT NULL,PRIMARY KEY(repository_id,revision))');
}
/** The rules in force: the ones saved with the latest Manager revision that had rules, else the built-in ones (revision 0). */
export function standingRules(store: Store, repositoryId: string): { revision: number; source: 'builtin' | 'saved'; rules: StandingRule[] } {
  const row = store.hasTable('manager_rules') ? store.get('SELECT revision,rules FROM manager_rules WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId) : undefined;
  if (!row) return { revision: 0, source: 'builtin', rules: builtinRules };
  try { return { revision: Number(row.revision), source: 'saved', rules: JSON.parse(String(row.rules)) as StandingRule[] }; } catch { return { revision: Number(row.revision), source: 'saved', rules: [] }; }
}

const string = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max;
/** Checks a list of rules as saved from the console or registered by the Manager. */
export function checkRules(value: unknown, eventTypes: string[], workIds: string[]): StandingRule[] {
  if (!Array.isArray(value) || value.length > 50) return fail(400, 'invalid_standing_rules', 'standing_rules');
  const ids = new Set<string>();
  return value.map((rule: any, index) => {
    const field = `standing_rules.${index}`;
    if (!rule || typeof rule !== 'object' || Object.keys(rule).some(key => !['id', 'event', 'action', 'work', 'reason', 'enabled', 'when'].includes(key))) fail(400, 'invalid_standing_rules', field);
    if (!string(rule.id, 80) || !/^[a-z0-9][a-z0-9._-]*$/.test(rule.id) || ids.has(rule.id)) fail(400, 'invalid_standing_rules', field + '.id');
    ids.add(rule.id);
    if (!eventTypes.includes(rule.event)) fail(400, 'invalid_standing_rules', field + '.event');
    if (!ruleActions.includes(rule.action)) fail(400, 'invalid_standing_rules', field + '.action');
    const creates = rule.action === 'create' || rule.action === 'continue_or_create';
    if (creates ? !workIds.includes(rule.work) : rule.work !== undefined) fail(400, 'invalid_standing_rules', field + '.work');
    // Development needs a basis the Manager states for the Issue at hand; a standing rule cannot give one.
    if (creates && String(rule.work).startsWith('development.')) fail(400, 'standing_rule_development', field + '.work');
    if (!string(rule.reason, 500)) fail(400, 'invalid_standing_rules', field + '.reason');
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') fail(400, 'invalid_standing_rules', field + '.enabled');
    const when = rule.when;
    if (when !== undefined && (!when || typeof when !== 'object' || Object.keys(when).some(key => !['labels_any', 'labels_none'].includes(key))
      || Object.values(when).some(list => !Array.isArray(list) || list.length > 20 || list.some(label => !string(label, 50))))) fail(400, 'invalid_standing_rules', field + '.when');
    return { id: rule.id, event: rule.event, action: rule.action, ...(rule.work !== undefined ? { work: rule.work } : {}), reason: rule.reason.trim(),
      ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}), ...(when ? { when } : {}) };
  });
}

const labelsOf = (facts: any): string[] => (Array.isArray(facts?.object?.labels) ? facts.object.labels : []).map((label: unknown) => String(label).toLowerCase());
/**
 * The decision the first matching rule makes for this event, or null when no rule settles it (the Manager decides).
 * `refused` tells whether creating an offered work would be refused now.
 */
export function ruleDecision(store: Store, context: DispatchContext, refused: (id: string) => boolean): (Decision & { rule: { id: string; revision: number } }) | null {
  const { revision, rules } = standingRules(store, String(context.event.repository_id)), labels = labelsOf(context.facts);
  for (const rule of rules) {
    if (rule.enabled === false || rule.event !== context.event.type) continue;
    if (rule.when?.labels_any && !rule.when.labels_any.some(label => labels.includes(label.toLowerCase()))) continue;
    if (rule.when?.labels_none && rule.when.labels_none.some(label => labels.includes(label.toLowerCase()))) continue;
    const decided = (decision: Omit<Decision, 'reason'>) => ({ ...decision, reason: rule.reason, model: null, rule: { id: rule.id, revision } });
    const create = () => { const option = context.options.find(entry => entry.work === rule.work); return option && !refused(option.id) ? decided({ decision: 'create', option_ids: [option.id] }) : null; };
    const continued = (active: boolean) => { const target = context.continuations.find(task => !active || task.status !== 'succeeded'); return target ? decided({ decision: 'continue', option_ids: [target.id] }) : null; };
    const decision = rule.action === 'ignore' ? decided({ decision: 'ignore', option_ids: [] }) : rule.action === 'create' ? create()
      : rule.action === 'continue' ? continued(false) : rule.action === 'continue_active' ? continued(true) : continued(false) ?? create();
    // A rule that cannot do its part here leaves the event to the next rule, or to the Manager.
    if (decision) return decision;
  }
  return null;
}
export type RuleRef = { id: string; revision: number };
export const ruleJson = (rule: RuleRef | null | undefined): Json | null => rule ? { id: rule.id, revision: rule.revision } : null;
