import type { Store } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import type { Decision, DispatchContext } from './store.js';

/**
 * Standing rules (#815, #1122). Routine events need no model call: the Manager (or a person in 角色 → Manager) registers
 * rules, each naming an event type, optional object conditions and what to do: create a generic task assigned to a role,
 * continue the running task on the object, or ignore the event. The dispatcher applies the first rule that matches and
 * records its id and revision on the event; an event no rule settles goes to the persistent Object Manager thread.
 *
 * A rule never widens anything: the task it creates is checked against the project's capability ceiling and role authority,
 * and a rule never starts development (which requires a verified basis).
 */
export interface StandingRule {
  id: string;
  event: string;
  action: RuleAction;
  role?: string;
  writes?: string[];
  reason: string;
  enabled?: boolean;
  when?: { labels_any?: string[]; labels_none?: string[] };
}

export const ruleActions = ['create', 'continue', 'continue_active', 'continue_or_create', 'ignore'] as const;
export type RuleAction = typeof ruleActions[number];
export const allowedRuleWrites = ['review', 'github', 'actions_rerun'] as const;

export const builtinRules: StandingRule[] = [
  { id: 'issue-opened', event: 'issue.opened', action: 'create', role: 'reviewer', writes: ['review'], reason: '常设规则：新 Issue 直派 reviewer 角色检视。' },
  { id: 'pull-request-opened', event: 'pull_request.opened', action: 'create', role: 'reviewer', writes: ['review'], reason: '常设规则：新 PR 直派 reviewer 角色检视。' },
  { id: 'pull-request-push', event: 'pull_request.synchronize', action: 'continue_or_create', role: 'reviewer', writes: ['review'], reason: '常设规则：新提交并入进行中的 PR 检视，否则直派 reviewer 检视当前 head。' },
  { id: 'issue-update', event: 'issue.updated', action: 'continue_active', reason: '常设规则：更新并入还在进行的 Issue 任务。' },
  { id: 'pull-request-update', event: 'pull_request.updated', action: 'continue_active', reason: '常设规则：更新并入还在进行的 PR 任务。' },
];

export function rulesStorage(store: Store) {
  store.db.exec('CREATE TABLE IF NOT EXISTS manager_rules(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,rules TEXT NOT NULL,PRIMARY KEY(repository_id,revision))');
}

/** Normalizes legacy work-based rule records saved before #1122 into role + writes. */
export function normalizeSavedRule(raw: any): StandingRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const creates = raw.action === 'create' || raw.action === 'continue_or_create';
  let role: string | undefined = typeof raw.role === 'string' && raw.role.trim() ? raw.role.trim() : undefined;
  let writes: string[] | undefined = Array.isArray(raw.writes) ? raw.writes.filter((w: unknown) => typeof w === 'string') : undefined;
  if (creates && !role && typeof raw.work === 'string') {
    if (raw.work.startsWith('review.')) { role = 'reviewer'; writes ??= ['review']; }
    else if (raw.work === 'reply') { role = 'reviewer'; writes ??= ['github']; }
    else if (raw.work === 'actions.failures') { role = 'dev'; writes ??= ['actions_rerun', 'github']; }
    else if (raw.work.startsWith('release.')) { role = 'reviewer'; writes ??= []; }
    else { role = 'reviewer'; writes ??= []; }
  }
  return {
    id: String(raw.id ?? ''),
    event: String(raw.event ?? ''),
    action: raw.action as RuleAction,
    ...(creates && role ? { role } : {}),
    ...(creates && writes ? { writes } : {}),
    reason: String(raw.reason ?? ''),
    ...(raw.enabled !== undefined ? { enabled: !!raw.enabled } : {}),
    ...(raw.when ? { when: raw.when } : {}),
  };
}

/** The rules in force: the ones saved with the latest Manager revision that had rules, else the built-in ones (revision 0). */
export function standingRules(store: Store, repositoryId: string): { revision: number; source: 'builtin' | 'saved'; rules: StandingRule[] } {
  const row = store.hasTable('manager_rules') ? store.get('SELECT revision,rules FROM manager_rules WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId) : undefined;
  if (!row) return { revision: 0, source: 'builtin', rules: builtinRules };
  try {
    const parsed = JSON.parse(String(row.rules));
    const rules = Array.isArray(parsed) ? parsed.map(normalizeSavedRule).filter((r): r is StandingRule => !!r) : [];
    return { revision: Number(row.revision), source: 'saved', rules };
  } catch {
    return { revision: Number(row.revision), source: 'saved', rules: [] };
  }
}

const string = (value: unknown, max: number) => typeof value === 'string' && !!value.trim() && value.length <= max;

/** Checks a list of rules as saved from the console or registered by the Manager. */
export function checkRules(value: unknown, eventTypes: string[], roleIds: string[]): StandingRule[] {
  if (!Array.isArray(value) || value.length > 50) return fail(400, 'invalid_standing_rules', 'standing_rules');
  const ids = new Set<string>();
  return value.map((rawRule: any, index) => {
    const field = `standing_rules.${index}`;
    if (!rawRule || typeof rawRule !== 'object' || Object.keys(rawRule).some(key => !['id', 'event', 'action', 'role', 'writes', 'work', 'reason', 'enabled', 'when'].includes(key)))
      fail(400, 'invalid_standing_rules', field);
    if (typeof rawRule.work === 'string' && (rawRule.work.startsWith('development.') || rawRule.work === 'development'))
      fail(400, 'standing_rule_development', field + '.work');
    if (rawRule.work !== undefined && typeof rawRule.work !== 'string')
      fail(400, 'invalid_standing_rules', field + '.work');
    const rule = rawRule.work !== undefined && rawRule.role === undefined
      ? (() => {
          const w = String(rawRule.work);
          if (w === 'review.issue' || w === 'review.pr' || w === 'review') return { ...rawRule, role: 'reviewer', writes: rawRule.writes ?? ['review'] };
          if (w === 'reply') return { ...rawRule, role: 'reviewer', writes: rawRule.writes ?? ['github'] };
          if (w === 'actions.failures') return { ...rawRule, role: 'dev', writes: rawRule.writes ?? ['actions_rerun', 'github'] };
          if (w === 'release.observe' || w === 'release.notes') return { ...rawRule, role: 'reviewer', writes: rawRule.writes ?? [] };
          return fail(400, 'invalid_standing_rules', field + '.work');
        })()
      : rawRule;
    if (!string(rule.id, 80) || !/^[a-z0-9][a-z0-9._-]*$/.test(rule.id) || ids.has(rule.id)) fail(400, 'invalid_standing_rules', field + '.id');
    ids.add(rule.id);
    if (!eventTypes.includes(rule.event)) fail(400, 'invalid_standing_rules', field + '.event');
    if (!ruleActions.includes(rule.action)) fail(400, 'invalid_standing_rules', field + '.action');
    const creates = rule.action === 'create' || rule.action === 'continue_or_create';
    if (creates && Array.isArray(rule.writes) && rule.writes.includes('pull_request')) fail(400, 'standing_rule_development', field + '.writes');
    if (creates ? (!string(rule.role, 32) || !roleIds.includes(rule.role) || rule.role === 'qa') : (rule.role !== undefined || rule.writes !== undefined))
      fail(400, 'invalid_standing_rules', field + '.role');
    let writes: string[] | undefined;
    if (creates && rule.writes !== undefined) {
      if (!Array.isArray(rule.writes) || rule.writes.some((w: unknown) => typeof w !== 'string' || !(allowedRuleWrites as readonly string[]).includes(w)))
        fail(400, 'invalid_standing_rules', field + '.writes');
      writes = [...new Set(rule.writes as string[])];
    } else if (creates && rule.role === 'reviewer') {
      writes = ['review'];
    }
    if (!string(rule.reason, 500)) fail(400, 'invalid_standing_rules', field + '.reason');
    if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') fail(400, 'invalid_standing_rules', field + '.enabled');
    const when = rule.when;
    if (when !== undefined && (!when || typeof when !== 'object' || Object.keys(when).some(key => !['labels_any', 'labels_none'].includes(key))
      || Object.values(when).some(list => !Array.isArray(list) || list.length > 20 || list.some(label => !string(label, 50)))))
      fail(400, 'invalid_standing_rules', field + '.when');
    return {
      id: rule.id,
      event: rule.event,
      action: rule.action,
      ...(creates ? { role: rule.role, ...(writes !== undefined ? { writes } : {}) } : {}),
      reason: rule.reason.trim(),
      ...(rule.enabled !== undefined ? { enabled: rule.enabled } : {}),
      ...(when ? { when } : {}),
    };
  });
}

const labelsOf = (facts: any): string[] => (Array.isArray(facts?.object?.labels) ? facts.object.labels : []).map((label: unknown) => String(label).toLowerCase());

/**
 * The decision the first matching rule makes for this event, or null when no rule settles it (the Object Manager decides).
 * `canCreate` checks whether creating the rule's generic task is allowed under the current capability ceiling and object state.
 */
export function ruleDecision(
  store: Store,
  context: DispatchContext,
  canCreate: (role: string, writes: string[]) => boolean,
): (Decision & { rule: { id: string; revision: number } }) | null {
  const { revision, rules } = standingRules(store, String(context.event.repository_id)), labels = labelsOf(context.facts);
  for (const rule of rules) {
    if (rule.enabled === false || rule.event !== context.event.type) continue;
    if (rule.when?.labels_any && !rule.when.labels_any.some(label => labels.includes(label.toLowerCase()))) continue;
    if (rule.when?.labels_none && rule.when.labels_none.some(label => labels.includes(label.toLowerCase()))) continue;
    const decided = (decision: Omit<Decision, 'reason'>) => ({ ...decision, reason: rule.reason, model: null, rule: { id: rule.id, revision } });
    const create = () => {
      const role = rule.role ?? 'reviewer', writes = rule.writes ?? (role === 'reviewer' ? ['review'] : []);
      if (!canCreate(role, writes)) return null;
      return decided({ decision: 'create', option_ids: [], role, writes });
    };
    const continued = (active: boolean) => {
      const target = context.continuations.find(task => !active || !['succeeded', 'completed', 'pr_opened'].includes(task.status));
      return target ? decided({ decision: 'continue', option_ids: [target.id] }) : null;
    };
    const decision = rule.action === 'ignore' ? decided({ decision: 'ignore', option_ids: [] }) : rule.action === 'create' ? create()
      : rule.action === 'continue' ? continued(false) : rule.action === 'continue_active' ? continued(true) : continued(false) ?? create();
    if (decision) return decision;
  }
  return null;
}

export type RuleRef = { id: string; revision: number };
export const ruleJson = (rule: RuleRef | null | undefined): Json | null => rule ? { id: rule.id, revision: rule.revision } : null;
