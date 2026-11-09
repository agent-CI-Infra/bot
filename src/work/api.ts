import type { Store, Row } from '../storage/database.js';
import { type Actor, repository } from '../app/auth.js';
import { fail, fields, HttpError, type Json } from '../core/security.js';
import type { RuleService } from '../rules/service.js';
import { workTypes, workType, sections, section, writeOptions } from './catalog.js';
import { managerPrompt, parseSections, workEnabled, workActive, workPermissions, workSettings, eventFilters, saveManager, sectionText, withSection } from './settings.js';
import { retryEvent } from '../dispatch/worker.js';
import { activateActions } from '../actions/storage.js';
import { taskDispatch } from '../dispatch/store.js';

const json = (text: unknown, fallback: any) => { try { return JSON.parse(String(text)) ?? fallback; } catch { return fallback; } };
/** The model a work type uses: its own entry in task_models, else the project default. */
function model(policy: Row, id: string) {
  const overrides = json(policy.task_models || '{}', {}), configured = !!overrides && typeof overrides === 'object' && Object.hasOwn(overrides, id);
  return { id: configured ? overrides[id] : null, inherited: !configured, default_id: policy.model_id ?? null };
}

/**
 * The Manager configuration of one project: the prompt with its sections (each with the built-in text it replaces, and
 * whether a repository file replaces it in turn), the work types with their switch, writes and model, the event filters,
 * the migration record of an upgraded project and the latest dispatch decisions.
 */
export async function managerView(store: Store, rules: RuleService, repositoryId: string) {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId)!, prompt = managerPrompt(store, repositoryId);
  const parsed = parseSections(prompt.content), view = await rules.view(repositoryId), settings = workSettings(store, repositoryId, policy);
  const files = new Map<string, any>(view.files.map((file: any) => [file.path, file]));
  const migration = store.get('SELECT migrated_at,report FROM manager_migrations WHERE repository_id=?', repositoryId);
  return {
    prompt: { revision: prompt.revision, content: prompt.content, updated_at: prompt.updated_at, updated_by: prompt.actor, source: prompt.source },
    sections: sections.map(entry => {
      const file = entry.rule ? files.get(entry.rule) : entry.repository ? files.get(entry.repository) : undefined;
      // A repository file replaces both the project's section and the built-in text, as rule files always did.
      const repositoryFile = file?.layers?.some((layer: any) => layer.source === 'repository') ?? false;
      const content = parsed.sections.get(entry.id)?.body ?? null;
      return { id: entry.id, title: entry.title, path: entry.rule ?? entry.repository ?? null, written: content !== null, content, builtin: entry.builtin(),
        effective_source: repositoryFile ? 'repository' : content !== null ? 'console' : 'builtin', effective: repositoryFile ? String(file.effective) : content ?? entry.builtin() };
    }),
    work: workTypes.map(type => ({ id: type.id, name: type.name, description: type.description, kinds: type.kinds, section: type.section,
      enabled: workEnabled(store, repositoryId, type.id, policy), active: workActive(store, repositoryId, type.id, policy),
      project_switch: type.family === 'review' ? { key: 'review_enabled', title: '项目的检视开关', on: !!policy.review_enabled }
        : type.family === 'development' ? { key: 'development_enabled', title: '项目的开发开关', on: !!policy.development_enabled } : null,
      writes: workPermissions(store, repositoryId, type.id, policy).writes, write_options: writeOptions(type.id), model: model(policy, type.id),
      version: Number(settings[type.id]?.version ?? 0) })),
    dispatch_model: model(policy, 'manager'),
    events: eventFilters(store, repositoryId, policy),
    rules: { sha: view.sha, updated_at: view.updated_at, needs_refresh: view.needs_refresh, development_label: view.development_label, review_label: view.review_label },
    migration: migration ? { migrated_at: migration.migrated_at, report: json(migration.report, {}) } : null,
    mention_names: (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').trim().toLowerCase() === 'off' ? [] : (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').split(',').map(name => name.trim()).filter(Boolean)
  };
}
/**
 * The work types in the shape the workflow list used to have, for readers of get_effective_config written before #207
 * (the management chat). Prompts are the effective Manager sections with their layers.
 */
export async function workCompatibility(store: Store, rules: RuleService, repositoryId: string) {
  const view = await rules.view(repositoryId), policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId)!;
  const files = new Map<string, any>(view.files.map((file: any) => [file.path, file])), written = parseSections(managerPrompt(store, repositoryId).content).sections;
  return workTypes.map(type => {
    const entry = section(type.section)!, file = entry.rule ? files.get(entry.rule) : undefined;
    const layers = file ? file.layers : [{ source: 'builtin', content: entry.builtin() }, ...(written.has(entry.id) ? [{ source: 'console', content: written.get(entry.id)!.body }] : [])];
    return { id: type.id, name: type.name, builtin: true, enabled: workEnabled(store, repositoryId, type.id, policy), active: workActive(store, repositoryId, type.id, policy),
      prompt: { path: entry.rule ?? entry.repository ?? null, section: entry.id, layers, source: file ? file.source : layers.at(-1)!.source, effective: file ? file.effective : sectionText(store, repositoryId, entry.id) },
      permissions: workPermissions(store, repositoryId, type.id, policy), model: model(policy, type.id) };
  });
}
/** A Manager save through the management command service; `args` are the command arguments. */
export function applyManagerChange(store: Store, repositoryId: string, args: Json, actor: string) {
  fields(args, ['expected_revision', 'content', 'work', 'events']);
  const expected = args.expected_revision === undefined ? managerPrompt(store, repositoryId).revision : Number(args.expected_revision);
  return saveManager(store, repositoryId, { expected_revision: expected, content: args.content as string | undefined, work: args.work, events: args.events }, actor, 'console',
    () => activateActions(store, repositoryId));
}
/**
 * The former workflow.update command, kept for clients written before #207: a prompt edits the work type's Manager section,
 * enabled and writes edit its project settings. Triggers, names and per-workflow settings no longer exist; models and
 * review/development settings are project settings (project.update), so those fields are refused with where they went.
 */
export function workflowUpdate(store: Store, repositoryId: string, workflowId: string, args: Json, actor: string) {
  const type = workType(workflowId);
  if (!type) fail(404, 'work_type_not_found');
  const gone = Object.keys(args).find(key => !['prompt', 'enabled', 'writes'].includes(key));
  if (gone) throw Object.assign(new HttpError(410, 'workflow_field_removed', gone), { detail: gone === 'triggers' ? '事件由 Manager 分派：在 Manager 提示词和事件过滤里配置。'
    : ['model_id', 'settings'].includes(gone) ? '模型和检视、开发设置是项目设置：用 project.update。' : '工作类型的名称固定，不能修改。' });
  const work: Json = {};
  if (args.enabled !== undefined || args.writes !== undefined) work[type!.id] = { ...(args.enabled !== undefined ? { enabled: args.enabled } : {}), ...(args.writes !== undefined ? { writes: args.writes } : {}) };
  let content: string | undefined;
  if (args.prompt !== undefined) {
    if (args.prompt !== null && (typeof args.prompt !== 'string' || args.prompt.includes('\0'))) fail(400, 'invalid_rule_content');
    content = withSection(managerPrompt(store, repositoryId).content, type!.section, args.prompt as string | null);
  }
  const saved = saveManager(store, repositoryId, { expected_revision: managerPrompt(store, repositoryId).revision, ...(content !== undefined ? { content } : {}), ...(Object.keys(work).length ? { work } : {}) },
    actor, 'console', () => activateActions(store, repositoryId));
  return saved;
}

/** GET of the Manager configuration and the dispatch records; PUT goes through the management service (see ManagementApi). */
export async function managerApi(store: Store, rules: RuleService, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  const removed = /^\/api\/repositories\/([^/]+)\/workflows(?:\/.*)?$/.exec(url.pathname);
  // The workflow API is gone; its replacement is named so older clients can follow it.
  if (removed) { repository(store, user, removed[1]!); throw Object.assign(new HttpError(410, 'workflows_removed'), { detail: `工作流已由项目 Manager 取代：GET/PUT /api/repositories/${removed[1]}/manager` }); }
  const manager = /^\/api\/repositories\/([^/]+)\/manager$/.exec(url.pathname);
  if (manager && method === 'GET') { repository(store, user, manager[1]!); return { manager: await managerView(store, rules, manager[1]!) }; }
  const events = /^\/api\/repositories\/([^/]+)\/dispatch(?:\/([^/]+)\/retry)?$/.exec(url.pathname);
  if (events) {
    const repositoryId = events[1]!; repository(store, user, repositoryId);
    if (!events[2] && method === 'GET') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 50)), offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const state = url.searchParams.get('state');
      const rows = store.all(`SELECT id,type,source,object_type,object_number,summary,state,decision,reason,brief,result,model,attempts,error,created_at,decided_at FROM dispatch_events
        WHERE repository_id=? ${state ? 'AND state=?' : ''} ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?`, ...[repositoryId, ...(state ? [state] : []), limit + 1, offset]);
      return { events: rows.slice(0, limit).map(row => ({ ...row, brief: json(row.brief, null), result: json(row.result, null), error: json(row.error, null) })), has_more: rows.length > limit, offset, limit };
    }
    if (events[2] && method === 'POST') {
      fields(input, []);
      if (!retryEvent(store, repositoryId, decodeURIComponent(events[2]))) fail(409, 'dispatch_event_not_failed');
      store.audit(user.id, 'dispatch.retry', events[2], repositoryId); return { ok: true };
    }
    return fail(405, 'method_not_allowed');
  }
  const task = /^\/api\/tasks\/([^/]+)\/dispatch$/.exec(url.pathname);
  if (task && method === 'GET') {
    const row = store.get('SELECT repository_id FROM tasks WHERE id=?', task[1]!); if (!row) return fail(404, 'task_not_found');
    repository(store, user, String(row.repository_id)); return { dispatch: taskDispatch(store, task[1]!) };
  }
  return undefined;
}
