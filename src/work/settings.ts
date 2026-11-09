import type { Store, Row } from '../storage/database.js';
import { fail, HttpError } from '../core/security.js';
import { workTypes, workType, sections, section, savedWrites, workAccess, validateWrites, type WorkPermissions } from './catalog.js';
import { resolveRules } from '../rules/service.js';

/**
 * Project configuration of the Manager: its prompt (the project's only flow definition), and per work type the switch and
 * the writes the control plane performs. Models stay in policies.task_models, keyed by work type ('manager' is the model
 * of the dispatch call). Event filters decide which events reach the Manager at all.
 *
 * The prompt is Markdown. A level-2 heading that ends with a known section id in backticks, such as
 * "## 检视 Issue `review.issue`", starts that section; text before the first one is a preamble the Manager reads with the
 * dispatch section. A section the project has not written uses its built-in text. The sections of the .bot rule files
 * (review, development, labels, guide) are their console layer: policies.rule_overrides is kept equal to them, so rule
 * resolution and task snapshots read the same text, and a repository file still replaces them.
 *
 * Every save is a new immutable revision in manager_revisions, with the prompt, work settings and event filters it set;
 * revision 1 of an upgraded project is the migration from workflows (see migration.ts).
 */
export function workStorage(store: Store) {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS manager_revisions(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,
      work_settings TEXT NOT NULL,event_filters TEXT NOT NULL,source TEXT NOT NULL,actor TEXT,created_at TEXT NOT NULL,PRIMARY KEY(repository_id,revision));
    CREATE TABLE IF NOT EXISTS manager_migrations(repository_id TEXT PRIMARY KEY,migrated_at TEXT NOT NULL,archive TEXT NOT NULL,report TEXT NOT NULL);
  `);
  store.db.exec(`CREATE TABLE IF NOT EXISTS manager_dispatch_prompts(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,content TEXT NOT NULL,PRIMARY KEY(repository_id,revision))`);
  const columns = new Set(store.all('PRAGMA table_info(policies)').map(row => String(row.name)));
  if (!columns.has('work_settings')) store.db.exec("ALTER TABLE policies ADD COLUMN work_settings TEXT NOT NULL DEFAULT '{}'");
  if (!columns.has('event_filters')) store.db.exec("ALTER TABLE policies ADD COLUMN event_filters TEXT NOT NULL DEFAULT '{}'");
  // Tasks of former custom workflows keep naming them; new reply tasks leave it empty.
  if (!store.all('PRAGMA table_info(tasks)').some(row => row.name === 'workflow_id')) store.db.exec('ALTER TABLE tasks ADD COLUMN workflow_id TEXT');
}

const json = (text: unknown, fallback: any) => { try { const value = JSON.parse(String(text)); return value ?? fallback; } catch { return fallback; } };
const policyOf = (store: Store, repositoryId: string) => store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);

// ---- The prompt and its sections ----

export interface ManagerPrompt { revision: number; content: string; updated_at: string | null; actor: string | null; source: string | null }
export function managerPrompt(store: Store, repositoryId: string): ManagerPrompt {
  const row = store.get('SELECT * FROM manager_revisions WHERE repository_id=? ORDER BY revision DESC LIMIT 1', repositoryId);
  return row ? { revision: Number(row.revision), content: String(row.content), updated_at: String(row.created_at), actor: row.actor ?? null, source: String(row.source) }
    : { revision: 0, content: '', updated_at: null, actor: null, source: null };
}
const heading = /^##[ \t]+(.*?)[ \t]*`([a-z][a-z0-9._-]*)`[ \t]*$/;
/** The preamble and the sections of a prompt. Unknown or repeated section ids are configuration errors. */
export function parseSections(content: string): { preamble: string; sections: Map<string, { title: string; body: string }> } {
  const found = new Map<string, { title: string; body: string }>(), lines = content.replace(/\r\n/g, '\n').split('\n'), preamble: string[] = [];
  let current = null as { id: string; title: string; lines: string[] } | null, fence = false;
  const close = () => { if (current) found.set(current.id, { title: current.title, body: current.lines.join('\n').replace(/^\n+|\s+$/g, '') }); };
  for (const line of lines) {
    // A heading inside a fenced block (for example a quoted prompt) is text, not a section.
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && heading.exec(line);
    if (match) {
      const id = match[2]!;
      if (!section(id)) throw Object.assign(new HttpError(400, 'unknown_manager_section', 'content'), { detail: `没有章节 ${id}；可用：${sections.map(s => s.id).join('、')}` });
      if (found.has(id) || current?.id === id) throw Object.assign(new HttpError(400, 'duplicate_manager_section', 'content'), { detail: `章节 ${id} 出现了两次` });
      close(); current = { id, title: match[1] || section(id)!.title, lines: [] }; continue;
    }
    (current ? current.lines : preamble).push(line);
  }
  close();
  return { preamble: preamble.join('\n').trim(), sections: found };
}
/** The project's own text of one section, or undefined when it uses the built-in text. */
export function managerSection(store: Store, repositoryId: string, id: string): string | undefined {
  return parseSections(managerPrompt(store, repositoryId).content).sections.get(id)?.body;
}
/** The text a section takes effect with: the project's, else the built-in one. */
export const sectionText = (store: Store, repositoryId: string, id: string) => managerSection(store, repositoryId, id) ?? section(id)?.builtin() ?? '';
/** The rule_overrides that the rule sections of a prompt stand for. Paths without a section have no console layer. */
export function ruleOverrides(content: string, previous: Record<string, unknown> = {}) {
  const parsed = parseSections(content).sections, overrides: Record<string, unknown> = { ...previous };
  for (const entry of sections) if (entry.rule) { if (parsed.has(entry.id)) overrides[entry.rule] = parsed.get(entry.id)!.body; else delete overrides[entry.rule]; }
  return overrides;
}
// A line of text that would read as a section heading. Text the control plane writes into a section (a migrated prompt, a
// rule file saved through the rules API) is escaped so it stays inside its section and can never fail to parse.
const headingLike = /^##[ \t]+.*`[a-z][a-z0-9._-]*`[ \t]*$/;
export function escapeSectionBody(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n').map(line => headingLike.test(line) ? '\\' + line : line);
  // An unclosed fence would turn every later heading into text; close it at the end of the section.
  return (lines.filter(line => /^\s*(```|~~~)/.test(line)).length % 2 ? [...lines, '```'] : lines).join('\n');
}
/** A prompt whose rule sections are given text: used by the rules API and the migration to write one section. */
export function withSection(content: string, id: string, raw: string | null): string {
  const parsed = parseSections(content), entry = section(id)!, body = raw === null ? null : escapeSectionBody(raw);
  const lines = content.replace(/\r\n/g, '\n').split('\n'), out: string[] = [];
  let skipping = false, written = false, fence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const match = !fence && heading.exec(line);
    if (match) { skipping = match[2] === id; if (skipping && body !== null) { out.push(line, '', body, ''); written = true; } if (skipping) continue; }
    if (!skipping) out.push(line);
  }
  if (!written && body !== null) { while (out.length && !out.at(-1)!.trim()) out.pop(); out.push(...(out.length ? [''] : []), `## ${parsed.sections.get(id)?.title ?? entry.title} \`${id}\``, '', body); }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s*$/, '\n');
}

// ---- Work types: switch and writes ----

/** `events`, when set, lists the event types a work type is offered on (written by the migration from old trigger lists). */
export interface WorkSetting { enabled?: boolean; writes?: string[]; events?: string[]; version?: number }
export const workSettings = (store: Store, repositoryId: string, policy = policyOf(store, repositoryId)): Record<string, WorkSetting> => {
  const value = json(policy?.work_settings ?? '{}', {}); return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
/** The work type's own switch. Actions failure handling keeps its policy switch, which also starts its scan. */
export function workEnabled(store: Store, repositoryId: string, id: string, policy = policyOf(store, repositoryId)): boolean {
  if (id === 'actions.failures') return !!policy?.actions_failures_enabled;
  const work = workType(id); if (!work) return false;
  const saved = workSettings(store, repositoryId, policy)[id]?.enabled;
  return typeof saved === 'boolean' ? saved : work.defaultEnabled;
}
/** Runs now: the project is on, its review or development switch for those types, and the work type itself. */
export function workActive(store: Store, repositoryId: string, id: string, policy = policyOf(store, repositoryId)): boolean {
  const work = workType(id);
  if (!work || !policy?.enabled || !workEnabled(store, repositoryId, id, policy)) return false;
  if (work.family === 'review') return !!policy.review_enabled;
  if (work.family === 'development') return !!policy.development_enabled;
  return true;
}
/** Whether the Manager may be offered this work type for an event of this type: active, and the event is one it runs on. */
export function workOffered(store: Store, repositoryId: string, id: string, eventType: string, policy = policyOf(store, repositoryId)): boolean {
  if (!workActive(store, repositoryId, id, policy)) return false;
  const events = workSettings(store, repositoryId, policy)[id]?.events;
  return !Array.isArray(events) || events.includes(eventType);
}
/** What a task of this work type may do, read from trusted storage: reading is open, writing is the saved writes. */
export function workPermissions(store: Store, repositoryId: string, id: string, policy = policyOf(store, repositoryId)): WorkPermissions {
  return workAccess(id, savedWrites(workSettings(store, repositoryId, policy)[id]?.writes, id));
}
/** How often a work type's settings or Manager section changed since the upgrade; a stage gate reads it (see roles/schedule.ts). */
export const workVersion = (store: Store, repositoryId: string, id: string) => Number(workSettings(store, repositoryId)[id]?.version ?? 0);

// ---- Event filters ----

/**
 * Which events reach the Manager. The five review switches of the policy keep their columns (and the policy API) and now
 * mean "dispatch this kind of event", with their old dependencies: updates and mentions of an Issue (a PR) follow its
 * opening switch, as review triggers did. event_filters holds the rest and explicit values that replace those defaults
 * (written by the migration where trigger lists differed, and by the Manager page, which saves each switch on its own).
 * Label lists name labels whose addition by a person is dispatched; the development label while issue.development_label is on.
 */
export interface EventFilters {
  'issue.opened': boolean; 'issue.updated': boolean; 'issue.mention': boolean; 'issue.labels': string[]; 'issue.development_label': boolean;
  'pull_request.opened': boolean; 'pull_request.synchronize': boolean; 'pull_request.updated': boolean; 'pull_request.mention': boolean; 'pull_request.labels': string[];
  'review.published.issue': boolean; 'review.published.pr': boolean; 'actions.run_failed': boolean;
}
export const dispatchEventTypes = ['issue.opened', 'issue.updated', 'issue.mention', 'issue.labeled', 'pull_request.opened', 'pull_request.synchronize', 'pull_request.updated',
  'pull_request.mention', 'pull_request.labeled', 'review.published', 'release.manual', 'actions.run_failed', 'gate.manual', 'schedule.due'];
export const filterColumns: Record<string, string> = { 'issue.opened': 'review_issues', 'issue.updated': 'review_issue_updates', 'pull_request.opened': 'review_pull_requests',
  'pull_request.synchronize': 'review_pr_updates', 'pull_request.updated': 'review_pr_discussion', 'actions.run_failed': 'actions_failures_enabled' };
const filterFlags = ['issue.mention', 'issue.development_label', 'pull_request.mention', 'review.published.issue', 'review.published.pr'];
/** The policy API's review switches keep moving an explicit update switch with them, as they kept a saved trigger list in step. */
export function syncEventFilters(store: Store, repositoryId: string, changes: Record<string, unknown>) {
  const policy = policyOf(store, repositoryId); if (!policy) return;
  const saved = json(policy.event_filters || '{}', {});
  for (const [column, key] of [['review_issue_updates', 'issue.updated'], ['review_pr_discussion', 'pull_request.updated']] as const)
    if (changes[column] !== undefined && typeof saved[key] === 'boolean') saved[key] = !!changes[column];
  store.run('UPDATE policies SET event_filters=? WHERE repository_id=?', JSON.stringify(saved), repositoryId);
}
export function eventFilters(store: Store, repositoryId: string, policy = policyOf(store, repositoryId)): EventFilters {
  const saved = json(policy?.event_filters ?? '{}', {}), flag = (key: string, fallback = true) => typeof saved[key] === 'boolean' ? saved[key] : fallback;
  const labels = (key: string) => Array.isArray(saved[key]) ? saved[key].filter((label: unknown) => typeof label === 'string' && label.trim()).map((label: string) => label.trim()) : [];
  const issues = !!policy?.review_issues, pulls = !!policy?.review_pull_requests;
  return { 'issue.opened': issues, 'issue.updated': flag('issue.updated', issues && !!policy?.review_issue_updates), 'issue.mention': flag('issue.mention', issues), 'issue.labels': labels('issue.labels'),
    'issue.development_label': flag('issue.development_label'), 'pull_request.opened': pulls, 'pull_request.synchronize': !!policy?.review_pr_updates,
    'pull_request.updated': flag('pull_request.updated', pulls && !!policy?.review_pr_discussion), 'pull_request.mention': flag('pull_request.mention', pulls), 'pull_request.labels': labels('pull_request.labels'),
    'review.published.issue': flag('review.published.issue'), 'review.published.pr': flag('review.published.pr'), 'actions.run_failed': !!policy?.actions_failures_enabled };
}
/** A label a person added that this project dispatches (compared without case). */
export const labelDispatched = (filters: EventFilters, object: 'issue' | 'pull_request', label: string) =>
  filters[`${object}.labels`].some(name => name.toLowerCase() === label.toLowerCase());

// ---- Saving ----

function checkFilters(value: unknown): Partial<EventFilters> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_event_filters', 'events');
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key.endsWith('.labels')) {
      if (!['issue.labels', 'pull_request.labels'].includes(key) || !Array.isArray(entry) || entry.length > 30 || entry.some(label => typeof label !== 'string' || !label.trim() || label.length > 50 || /\p{Cc}/u.test(label)))
        fail(400, 'invalid_event_filters', 'events.' + key);
      out[key] = [...new Set((entry as string[]).map(label => label.trim()))];
    } else if ((Object.hasOwn(filterColumns, key) || filterFlags.includes(key)) && typeof entry === 'boolean') out[key] = entry;
    else fail(400, 'invalid_event_filters', 'events.' + key);
  }
  return out as Partial<EventFilters>;
}
function checkWork(value: unknown, current: Record<string, WorkSetting>) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail(400, 'invalid_work_settings', 'work');
  const next: Record<string, WorkSetting> = JSON.parse(JSON.stringify(current)), changed = new Set<string>();
  let actions: boolean | undefined;
  for (const [id, entry] of Object.entries(value as Record<string, any>)) {
    if (!workType(id)) fail(400, 'unknown_work_type', 'work.' + id);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['enabled', 'writes', 'events'].includes(key))) fail(400, 'invalid_work_settings', 'work.' + id);
    const setting = { ...(next[id] ?? {}) };
    if (entry.enabled !== undefined) {
      if (typeof entry.enabled !== 'boolean') fail(400, 'invalid_work_settings', `work.${id}.enabled`);
      if (id === 'actions.failures') actions = entry.enabled; else if (setting.enabled !== entry.enabled) { setting.enabled = entry.enabled; changed.add(id); }
    }
    // The events a work type is offered on; null offers it on every event again.
    if (entry.events !== undefined) {
      if (entry.events !== null && (!Array.isArray(entry.events) || entry.events.some((event: unknown) => typeof event !== 'string' || !dispatchEventTypes.includes(event)))) fail(400, 'invalid_work_settings', `work.${id}.events`);
      if (JSON.stringify(setting.events ?? null) !== JSON.stringify(entry.events)) changed.add(id);
      if (entry.events === null) delete setting.events; else setting.events = [...new Set(entry.events as string[])];
    }
    if (entry.writes !== undefined) {
      const writes = validateWrites(entry.writes, id, `work.${id}.writes`);
      if (JSON.stringify(savedWrites(setting.writes, id)) !== JSON.stringify(writes)) changed.add(id);
      setting.writes = writes;
    }
    next[id] = setting;
  }
  return { next, changed, actions };
}
export interface ManagerChange { expected_revision: number; content?: string; prompt?: string; work?: unknown; events?: unknown }
/**
 * Saves one revision atomically. `prompt` is the complete dispatch text; legacy `content` still edits task rule sections.
 * Neither text grants writes. Existing task rules remain validated and switches/writes come only from `work`.
 */
export function saveManager(store: Store, repositoryId: string, change: ManagerChange, actor: string | null, source = 'console', onActions?: (enabled: boolean) => void) {
  return store.transaction(() => {
    const policy = policyOf(store, repositoryId); if (!policy) return fail(404, 'repository_not_found');
    const current = managerPrompt(store, repositoryId);
    if (!Number.isSafeInteger(change.expected_revision) || change.expected_revision !== current.revision) fail(409, 'manager_revision_conflict', 'expected_revision');
    if (change.prompt !== undefined && (typeof change.prompt !== 'string' || !change.prompt.trim() || change.prompt.includes('\0') || Buffer.byteLength(change.prompt) > 512 * 1024)) fail(400, 'invalid_manager_prompt', 'prompt');
    let content = current.content;
    if (change.content !== undefined) {
      if (typeof change.content !== 'string' || change.content.includes('\0') || Buffer.byteLength(change.content) > 512 * 1024) fail(400, 'invalid_manager_prompt', 'content');
      content = change.content;
    }
    const before = parseSections(current.content).sections, after = parseSections(content).sections;
    const overrides = ruleOverrides(content, json(policy.rule_overrides || '{}', {}));
    // The same checks as saving a rule file: the label lines stay valid; the development label cannot be switched off.
    resolveRules({ ...policy, rule_overrides: JSON.stringify(overrides) }, {});
    const work = change.work === undefined ? { next: workSettings(store, repositoryId, policy), changed: new Set<string>(), actions: undefined } : checkWork(change.work, workSettings(store, repositoryId, policy));
    // A work type whose section text changed counts as changed, like a workflow whose prompt was edited.
    for (const type of workTypes) if ((before.get(type.section)?.body ?? null) !== (after.get(type.section)?.body ?? null)) work.changed.add(type.id);
    for (const id of work.changed) work.next[id] = { ...(work.next[id] ?? {}), version: Number(work.next[id]?.version ?? 0) + 1 };
    const filters = change.events === undefined ? undefined : checkFilters(change.events);
    if (filters?.['actions.run_failed'] !== undefined) {
      if (work.actions !== undefined && work.actions !== filters['actions.run_failed']) fail(400, 'invalid_event_filters', 'events.actions.run_failed');
      work.actions = filters['actions.run_failed'];
    }
    const saved = json(policy.event_filters || '{}', {});
    // A switch saved here stands on its own: updates keep their own value instead of following the opening switch.
    if (filters) for (const [key, value] of Object.entries(filters)) {
      if (Object.hasOwn(filterColumns, key)) store.run(`UPDATE policies SET ${filterColumns[key]}=? WHERE repository_id=?`, Number(value), repositoryId);
      if (!Object.hasOwn(filterColumns, key) || ['issue.updated', 'pull_request.updated'].includes(key)) saved[key] = value;
    }
    store.run('UPDATE policies SET rule_overrides=?,work_settings=?,event_filters=? WHERE repository_id=?', JSON.stringify(overrides), JSON.stringify(work.next), JSON.stringify(saved), repositoryId);
    if (work.actions !== undefined) { store.run('UPDATE policies SET actions_failures_enabled=? WHERE repository_id=?', Number(work.actions), repositoryId); if (work.actions && !policy.actions_failures_enabled) onActions?.(true); }
    const revision = current.revision + 1, now = new Date().toISOString();
    store.run('INSERT INTO manager_revisions VALUES(?,?,?,?,?,?,?,?)', repositoryId, revision, content, JSON.stringify(work.next),
      JSON.stringify(eventFilters(store, repositoryId)), source, actor, now);
    if (change.prompt !== undefined) store.run('INSERT INTO manager_dispatch_prompts VALUES(?,?,?)', repositoryId, revision, change.prompt);
    return managerPrompt(store, repositoryId);
  });
}
/** The archived workflows row of a work type from the migration, kept so stage gates of older tasks keep their hash. */
export function legacyWorkflowRow(store: Store, repositoryId: string, id: string): Row | undefined {
  const row = store.get('SELECT archive FROM manager_migrations WHERE repository_id=?', repositoryId); if (!row) return undefined;
  return (json(row.archive, {}).workflows ?? []).find((entry: Row) => entry.id === id);
}
