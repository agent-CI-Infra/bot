import type { Store } from '../storage/database.js';
import { type Actor, repository } from '../app/auth.js';
import { fail, fields, HttpError, type Json } from '../core/security.js';
import type { RuleService } from '../rules/service.js';
import { defaultManagerPrompt, effectiveManagerPrompt, eventFilters, managerPrompt, saveManager } from './settings.js';
import { retryEvent } from './worker.js';
import { projectCeiling } from '../projects/ceiling.js';
import { activateActions } from '../actions/storage.js';
import { standingRules } from './rules.js';
import { taskDispatch } from './store.js';
import { dispatchList, dispatchDetail } from './view.js';
import { mentionNames } from '../projects/capabilities.js';

const json = (text: unknown, fallback: any) => { try { return JSON.parse(String(text)) ?? fallback; } catch { return fallback; } };

/**
 * The unified Manager configuration of one project (#1122): the single Manager prompt, project capability ceiling,
 * event filters, standing rules, and repository skill metadata. Fixed work types and per-task-type model overrides
 * are retired.
 */
export async function managerView(store: Store, rules: RuleService, repositoryId: string) {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId)!;
  const prompt = managerPrompt(store, repositoryId);
  const content = effectiveManagerPrompt(store, repositoryId);
  const ceiling = projectCeiling(store, repositoryId, policy);
  const view = await rules.view(repositoryId);
  const migration = store.get('SELECT migrated_at,report FROM manager_migrations WHERE repository_id=?', repositoryId);
  return {
    capability_ceiling: ceiling,
    prompt: {
      revision: prompt.revision,
      content,
      effective: content,
      default_content: defaultManagerPrompt,
      customized: prompt.revision > 0 && content.trim() !== defaultManagerPrompt.trim(),
      updated_at: prompt.updated_at,
      updated_by: prompt.actor,
      source: prompt.source,
    },
    standing_rules: standingRules(store, repositoryId),
    events: eventFilters(store, repositoryId, policy),
    rules: { sha: view.sha, updated_at: view.updated_at, needs_refresh: view.needs_refresh, development_label: view.development_label, review_label: view.review_label },
    migration: migration ? { migrated_at: migration.migrated_at, report: json(migration.report, {}) } : null,
    mention_names: mentionNames(),
  };
}

/** A Manager save through the management command service; `args` are the command arguments. */
export function applyManagerChange(store: Store, repositoryId: string, args: Json, actor: string) {
  fields(args, ['expected_revision', 'content', 'prompt', 'events', 'standing_rules']);
  const expected = args.expected_revision === undefined ? managerPrompt(store, repositoryId).revision : Number(args.expected_revision);
  return saveManager(
    store,
    repositoryId,
    {
      expected_revision: expected,
      content: args.content as string | undefined,
      prompt: args.prompt as string | undefined,
      events: args.events,
      standing_rules: args.standing_rules,
    },
    actor,
    'console',
    () => activateActions(store, repositoryId),
  );
}

/** GET of the Manager configuration and the dispatch records; PUT goes through the management service (see ManagementApi). */
export async function managerApi(store: Store, rules: RuleService, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  const dispatchEventId = (segment: string): string => { try { return decodeURIComponent(segment); } catch { return fail(400, 'invalid_dispatch_event'); } };
  const removed = /^\/api\/repositories\/([^/]+)\/workflows(?:\/.*)?$/.exec(url.pathname);
  if (removed) {
    repository(store, user, removed[1]!);
    throw Object.assign(new HttpError(410, 'workflows_removed'), { detail: `工作流已由项目 Manager 取代：GET/PUT /api/repositories/${removed[1]}/manager` });
  }
  const manager = /^\/api\/repositories\/([^/]+)\/manager$/.exec(url.pathname);
  if (manager && method === 'GET') { repository(store, user, manager[1]!); return { manager: await managerView(store, rules, manager[1]!) }; }
  const events = /^\/api\/repositories\/([^/]+)\/dispatch(?:\/([^/]+)(\/retry)?)?$/.exec(url.pathname);
  if (events) {
    const repositoryId = events[1]!; repository(store, user, repositoryId);
    if (!events[2] && method === 'GET') return dispatchList(store, repositoryId, url.searchParams);
    if (events[2] && !events[3] && method === 'GET') return dispatchDetail(store, repositoryId, dispatchEventId(events[2]), url.searchParams);
    if (events[2] && events[3] && method === 'POST') {
      fields(input, []);
      const eventId = dispatchEventId(events[2]);
      if (!retryEvent(store, repositoryId, eventId)) fail(409, 'dispatch_event_not_failed');
      store.audit(user.id, 'dispatch.retry', eventId, repositoryId);
      return { ok: true };
    }
    return fail(405, 'method_not_allowed');
  }
  const task = /^\/api\/tasks\/([^/]+)\/dispatch$/.exec(url.pathname);
  if (task && method === 'GET') {
    const row = store.get('SELECT repository_id FROM tasks WHERE id=?', task[1]!); if (!row) return fail(404, 'task_not_found');
    repository(store, user, String(row.repository_id));
    return { dispatch: taskDispatch(store, task[1]!) };
  }
  return undefined;
}
