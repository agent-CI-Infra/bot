import type { Store, Row } from '../storage/database.js';
import { type Actor, repository as allowRepository } from '../app/auth.js';
import { fail, fields, HttpError, randomId, type Json } from '../core/security.js';
import { type RuleService, resolveRules } from '../rules/service.js';
import { runAgent } from '../agent/runtime.js';
import { Redactor, TaskError } from '../agent/common.js';
import { builtinRule } from '../releases/preflight.js';
import { builtinWorkflows, builtinWorkflow, triggers, customCeiling, defaultPermissions, validatePermissions, clampPermissions, githubScopes,
  hasFlowchart, type BuiltinWorkflow, type WorkflowPermissions } from './catalog.js';
import { savedWorkflow, workflowPermissions, customWorkflow } from './resolve.js';

// A trigger as the console shows it: configurable switches, and fixed conditions with the reason they are fixed.
interface TriggerState { id: string; title: string; enabled: boolean; configurable: boolean; label?: string | null; note?: string }
const policyTriggers: Record<string, { id: string; column?: string; note?: string }[]> = {
  'review.issue': [{ id: 'issue.opened', column: 'review_issues' }, { id: 'issue.updated', column: 'review_issue_updates', note: '同时需要打开「Issue 打开」' },
    { id: 'comment.mention', note: '名字来自部署设置 BOT_MENTION_NAMES；同时需要打开「Issue 打开」' }],
  'review.pr': [{ id: 'pull_request.opened', column: 'review_pull_requests', note: '草稿 PR 不检视' },
    { id: 'pull_request.synchronize', column: 'review_pr_updates', note: 'bot PR 的自动跟进也依赖它' },
    { id: 'pull_request.updated', column: 'review_pr_discussion', note: '同时需要打开「PR 打开或 Ready for review」' },
    { id: 'comment.mention', note: '名字来自部署设置 BOT_MENTION_NAMES；同时需要打开「PR 打开或 Ready for review」' }]
};
const title = (id: string) => triggers.find(trigger => trigger.id === id)?.title ?? id;
function builtinTriggers(workflow: BuiltinWorkflow, policy: Row, developmentLabel: string | null): TriggerState[] {
  if (policyTriggers[workflow.id]) return policyTriggers[workflow.id]!.map(({ id, column, note }) =>
    ({ id, title: title(id), enabled: column ? !!policy[column] : true, configurable: !!column, ...(note ? { note } : {}) }));
  if (workflow.id === 'development.issue') return [
    { id: 'review.issue.published', title: 'Issue 检视发布，结论要求改代码', enabled: true, configurable: false, note: '控制面核对检视结论里的原文依据' },
    { id: 'issue.labeled', title: '有人（不是 App）给 Issue 加上开发标签', enabled: true, configurable: false, label: developmentLabel,
      note: '开发标签和「Issue 没有指派人」由控制面检查，发布 PR 前再查一次；提示词关不掉' }];
  if (workflow.id === 'development.pr') return [{ id: 'review.pr.published', title: 'bot PR 的检视发布了可执行意见', enabled: true, configurable: false, note: '在修订轮数内；依赖「检视 PR」的 PR head 更新触发' }];
  return [{ id: 'release.manual', title: workflow.id === 'release.notes' ? '「发版本」页起草发行说明' : '「发版本」页查看 Release 工作流运行', enabled: true, configurable: false }];
}
const layerSource = (layers: { source: string }[]) => layers.at(-1)!.source;
const jsonOf = (text: unknown, fallback: any) => { try { return JSON.parse(String(text)); } catch { return fallback; } };

export class WorkflowService {
  constructor(readonly store: Store, readonly rules: RuleService) {}
  // Prompt layers of a built-in workflow: built-in text, console layer, repository file; the last one present is used.
  private builtinPrompt(workflow: BuiltinWorkflow, view: any, row: Row | undefined) {
    if (workflow.prompt.rule) {
      const file = view.files.find((entry: any) => entry.path === workflow.prompt.rule);
      return { path: workflow.prompt.rule, layers: file.layers, source: file.source, effective: file.effective,
        shared_with: builtinWorkflows.filter(other => other.id !== workflow.id && other.prompt.rule === workflow.prompt.rule).map(other => other.id) };
    }
    const layers: { source: string; content: string }[] = [{ source: 'builtin', content: workflow.id === 'release.notes' ? builtinRule : workflow.prompt.builtin }];
    if (row?.prompt != null) layers.push({ source: 'console', content: String(row.prompt) });
    const repository = workflow.prompt.repository && view.files.find((entry: any) => entry.path === workflow.prompt.repository);
    if (repository) layers.push({ source: 'repository', content: repository.effective });
    return { path: workflow.prompt.repository ?? null, layers, source: layerSource(layers), effective: layers.at(-1)!.content, shared_with: [] };
  }
  private model(policy: Row, id: string, row?: Row) {
    if (row && id.startsWith('custom.')) return { id: row.model_id ?? null, inherited: !row.model_id, default_id: policy.model_id ?? null };
    const overrides = jsonOf(policy.task_models || '{}', {});
    const configured = !!overrides && typeof overrides === 'object' && Object.hasOwn(overrides, id);
    return { id: configured ? overrides[id] : null, inherited: !configured, default_id: policy.model_id ?? null };
  }
  async list(repositoryId: string) {
    const policy = this.store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId)!, view = await this.rules.view(repositoryId);
    const rows = new Map(this.store.all('SELECT * FROM workflows WHERE repository_id=?', repositoryId).map(row => [String(row.id), row]));
    const builtins = builtinWorkflows.map(workflow => {
      const row = rows.get(workflow.id), review = workflow.base === 'review', development = workflow.base === 'development';
      return { id: workflow.id, builtin: true, base: workflow.base, object: workflow.object, name: workflow.name, description: workflow.description,
        enabled: review ? !!policy.review_enabled : development ? !!policy.development_enabled : true,
        enabled_note: review ? '两条检视工作流共用这个开关' : development ? '两条开发工作流共用项目的开发开关' : '在「发版本」页按需执行',
        enabled_editable: review || development, active: !!policy.enabled && (review ? !!policy.review_enabled : development ? !!policy.development_enabled : true),
        triggers: builtinTriggers(workflow, policy, development ? view.development_label : null), prompt: this.builtinPrompt(workflow, view, row),
        permissions: workflowPermissions(this.store, repositoryId, workflow.id), ceiling: workflow.ceiling, model: this.model(policy, workflow.id),
        settings: review ? { review_language: policy.review_language || 'auto' } : development ? { test_command: policy.test_command || '', max_revisions: policy.max_revisions } : {},
        version: Number(row?.version ?? 0) };
    });
    const customs = [...rows.values()].filter(row => String(row.id).startsWith('custom.')).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(row => {
      const custom = customWorkflow(row);
      return { id: custom.id, builtin: false, base: 'reply', object: 'any', name: custom.name, description: String(row.description || ''), enabled: custom.enabled,
        enabled_editable: true, active: !!policy.enabled && custom.enabled,
        triggers: custom.triggers.map(trigger => ({ id: trigger.id, title: title(trigger.id), enabled: true, configurable: true, ...(trigger.label ? { label: trigger.label } : {}) })),
        prompt: { path: null, layers: [{ source: 'console', content: custom.prompt }], source: 'console', effective: custom.prompt, shared_with: [] },
        permissions: workflowPermissions(this.store, repositoryId, custom.id), ceiling: customCeiling, model: this.model(policy, custom.id, row), settings: {},
        version: Number(row.version), updated_at: row.updated_at };
    });
    return { workflows: [...builtins, ...customs], triggers, github_scopes: githubScopes, rules: { sha: view.sha, updated_at: view.updated_at, needs_refresh: view.needs_refresh },
      mention_names: (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').trim().toLowerCase() === 'off' ? [] : (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').split(',').map(name => name.trim()).filter(Boolean) };
  }
  // A model a project may use: its own, or a deployment-shared one granted to it (a super administrator grants it here).
  private modelChoice(user: Actor, repositoryId: string, value: unknown): { id: string | null; grant: boolean } {
    if (value === null) return { id: null, grant: false };
    if (typeof value !== 'string' || !value.trim()) return fail(400, 'invalid_workflow_model');
    const shared = user.role === 'super_admin' && !!this.store.get('SELECT id FROM models WHERE id=? AND repository_id IS NULL', value);
    if (!shared && !this.store.get(`SELECT id FROM models WHERE id=? AND (repository_id=? OR (repository_id IS NULL AND EXISTS
      (SELECT 1 FROM model_projects WHERE model_id=models.id AND repository_id=?)))`, value, repositoryId, repositoryId)) fail(400, 'model_not_available');
    return { id: value, grant: shared };
  }
  private checkVersion(row: Row | undefined, version: unknown) {
    if (version !== undefined && Number(version) !== Number(row?.version ?? 0)) fail(409, 'workflow_version_conflict');
  }
  private savePermissions(repositoryId: string, id: string, permissions: WorkflowPermissions | undefined, prompt: string | null | undefined, now: string) {
    const row = savedWorkflow(this.store, repositoryId, id);
    if (!row) this.store.run('INSERT INTO workflows(repository_id,id,created_at,updated_at,version) VALUES(?,?,?,?,0)', repositoryId, id, now, now);
    if (permissions) this.store.run('UPDATE workflows SET permissions=? WHERE repository_id=? AND id=?', JSON.stringify(permissions), repositoryId, id);
    if (prompt !== undefined) this.store.run('UPDATE workflows SET prompt=? WHERE repository_id=? AND id=?', prompt, repositoryId, id);
    this.store.run('UPDATE workflows SET version=version+1,updated_at=? WHERE repository_id=? AND id=?', now, repositoryId, id);
  }
  // A built-in workflow writes each part where it has always lived; the whole save is one transaction.
  private updateBuiltin(user: Actor, repositoryId: string, workflow: BuiltinWorkflow, body: Json) {
    fields(body, ['enabled', 'triggers', 'prompt', 'permissions', 'model_id', 'settings', 'version']);
    const policy = this.store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId)!, row = savedWorkflow(this.store, repositoryId, workflow.id);
    this.checkVersion(row, body.version);
    const review = workflow.base === 'review', development = workflow.base === 'development', updates: Record<string, unknown> = {};
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean' || !review && !development) fail(400, 'invalid_workflow_enabled');
      updates[review ? 'review_enabled' : 'development_enabled'] = Number(body.enabled);
    }
    if (body.triggers !== undefined) {
      const switches = policyTriggers[workflow.id] ?? [], value = body.triggers as Json;
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_workflow_triggers');
      for (const [id, on] of Object.entries(value)) {
        const column = switches.find(trigger => trigger.id === id)?.column;
        if (!column || typeof on !== 'boolean') fail(400, 'invalid_workflow_triggers');
        updates[column!] = Number(on);
      }
    }
    const settings = (body.settings ?? {}) as Json;
    if (typeof settings !== 'object' || Array.isArray(settings)) fail(400, 'invalid_workflow_settings');
    fields(settings, review ? ['review_language'] : development ? ['test_command', 'max_revisions'] : []);
    if (settings.review_language !== undefined && !['auto', 'zh', 'en'].includes(String(settings.review_language))) fail(400, 'invalid_review_language');
    if (settings.test_command !== undefined && (typeof settings.test_command !== 'string' || settings.test_command.length > 2048)) fail(400, 'invalid_test_command');
    if (settings.max_revisions !== undefined && (!Number.isSafeInteger(settings.max_revisions) || Number(settings.max_revisions) < 0 || Number(settings.max_revisions) > 10)) fail(400, 'invalid_revision_budget');
    Object.assign(updates, settings);
    let overrides: Json | undefined, consolePrompt: string | null | undefined;
    if (body.prompt !== undefined) {
      if (body.prompt !== null && (typeof body.prompt !== 'string' || body.prompt.includes('\0'))) fail(400, 'invalid_rule_content');
      if (workflow.prompt.rule) {
        overrides = jsonOf(policy.rule_overrides || '{}', {});
        if (body.prompt === null) delete overrides![workflow.prompt.rule]; else overrides![workflow.prompt.rule] = body.prompt;
        // The same checks as saving the rule file: the development label line stays valid and cannot be switched off.
        resolveRules({ ...policy, rule_overrides: JSON.stringify(overrides) }, {});
      } else consolePrompt = body.prompt as string | null;
    }
    const permissions = body.permissions === undefined ? undefined : validatePermissions(body.permissions, workflow.ceiling);
    const model = body.model_id === undefined ? undefined : this.modelChoice(user, repositoryId, body.model_id);
    const now = new Date().toISOString();
    this.store.transaction(() => {
      for (const [column, value] of Object.entries(updates)) this.store.run(`UPDATE policies SET ${column}=? WHERE repository_id=?`, value as any, repositoryId);
      if (overrides) this.store.run('UPDATE policies SET rule_overrides=? WHERE repository_id=?', JSON.stringify(overrides), repositoryId);
      if (model) {
        const taskModels = jsonOf(this.store.get('SELECT task_models FROM policies WHERE repository_id=?', repositoryId)!.task_models || '{}', {});
        if (model.id) taskModels[workflow.id] = model.id; else delete taskModels[workflow.id];
        if (model.grant) this.store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model.id, repositoryId);
        this.store.run('UPDATE policies SET task_models=? WHERE repository_id=?', JSON.stringify(taskModels), repositoryId);
      }
      this.savePermissions(repositoryId, workflow.id, permissions, consolePrompt, now);
      this.store.audit(user.id, 'workflow.updated', workflow.id, repositoryId);
    });
  }
  // A custom workflow: free name, description and prompt; triggers from the catalog; permissions within the reply ceiling.
  private customValues(body: Json, existing?: Row) {
    fields(body, ['name', 'description', 'enabled', 'triggers', 'prompt', 'permissions', 'model_id', 'version']);
    const string = (value: unknown, code: string, required: boolean) => {
      if (value === undefined && !required) return undefined;
      if (typeof value !== 'string' || value.includes('\0') || required && !value.trim()) return fail(400, code);
      return value;
    };
    const name = string(body.name, 'invalid_workflow_name', !existing), prompt = string(body.prompt, 'invalid_workflow_prompt', !existing);
    if (existing && name !== undefined && !name.trim()) fail(400, 'invalid_workflow_name');
    if (existing && prompt !== undefined && !prompt.trim()) fail(400, 'invalid_workflow_prompt');
    const description = string(body.description, 'invalid_workflow_description', false);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'invalid_workflow_enabled');
    let saved: { id: string; label?: string }[] | undefined;
    if (body.triggers !== undefined) {
      if (!Array.isArray(body.triggers)) fail(400, 'invalid_workflow_triggers');
      saved = (body.triggers as any[]).map(trigger => {
        const definition = triggers.find(entry => entry.id === trigger?.id);
        if (!definition || typeof trigger !== 'object' || Object.keys(trigger).some(key => !['id', 'label'].includes(key))) return fail(400, 'invalid_workflow_triggers');
        if (definition.label && (typeof trigger.label !== 'string' || !trigger.label.trim() || trigger.label.includes('\0'))) return fail(400, 'invalid_workflow_trigger_label');
        if (!definition.label && trigger.label !== undefined) return fail(400, 'invalid_workflow_triggers');
        return { id: definition.id, ...(definition.label ? { label: String(trigger.label).trim() } : {}) };
      });
      if (new Set(saved!.map(trigger => trigger.id + ':' + (trigger.label ?? '').toLowerCase())).size !== saved!.length) fail(400, 'duplicate_workflow_trigger');
    }
    const permissions = body.permissions === undefined ? (existing ? undefined : defaultPermissions('custom')) : validatePermissions(body.permissions, customCeiling);
    return { name, description, prompt, triggers: saved, permissions, enabled: body.enabled as boolean | undefined };
  }
  private saveCustom(user: Actor, repositoryId: string, id: string, body: Json, existing?: Row) {
    if (existing) this.checkVersion(existing, body.version);
    const values = this.customValues(body, existing), model = body.model_id === undefined ? undefined : this.modelChoice(user, repositoryId, body.model_id);
    const now = new Date().toISOString();
    this.store.transaction(() => {
      if (!existing) this.store.run(`INSERT INTO workflows(repository_id,id,name,description,enabled,triggers,prompt,permissions,model_id,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`, repositoryId, id, values.name!, values.description ?? '', Number(values.enabled ?? true), JSON.stringify(values.triggers ?? []),
        values.prompt!, JSON.stringify(values.permissions), model?.id ?? null, now, now);
      else {
        const set: Record<string, unknown> = { name: values.name, description: values.description, prompt: values.prompt,
          enabled: values.enabled === undefined ? undefined : Number(values.enabled), triggers: values.triggers && JSON.stringify(values.triggers),
          permissions: values.permissions && JSON.stringify(values.permissions), model_id: model ? model.id : undefined };
        for (const [column, value] of Object.entries(set)) if (value !== undefined) this.store.run(`UPDATE workflows SET ${column}=? WHERE repository_id=? AND id=?`, value as any, repositoryId, id);
        this.store.run('UPDATE workflows SET version=version+1,updated_at=? WHERE repository_id=? AND id=?', now, repositoryId, id);
      }
      if (model?.grant) this.store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model.id, repositoryId);
      this.store.audit(user.id, existing ? 'workflow.updated' : 'workflow.created', id, repositoryId);
    });
  }
  // Chat drafts a prompt (with its flowchart) and permissions. Nothing is saved: the administrator reviews the draft in
  // the editor and saves it there, so a draft never becomes the effective configuration by itself.
  async assistant(repositoryId: string, body: Json) {
    fields(body, ['workflow_id', 'draft', 'messages']);
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.some((m: any) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()))
      fail(400, 'invalid_assistant_messages');
    const id = body.workflow_id === undefined || body.workflow_id === null ? null : String(body.workflow_id);
    const builtin = id ? builtinWorkflow(id) : undefined;
    if (id && !builtin && !savedWorkflow(this.store, repositoryId, id)) fail(404, 'workflow_not_found');
    const current = id ? (await this.list(repositoryId)).workflows.find(workflow => workflow.id === id) : null;
    const ceiling = builtin?.ceiling ?? customCeiling;
    const catalog = builtin ? (current?.triggers || []).filter(trigger => trigger.configurable).map(({ id, title }) => ({ id, title }))
      : triggers.map(({ id, title, label }) => ({ id, title, ...(label ? { needs_label: true } : {}) }));
    const system = [
      'You help a project administrator write one workflow of a GitHub repository maintenance bot. Reply in Simplified Chinese.',
      'A workflow has triggers, a prompt for the agent, permissions and a model. The prompt is Markdown. It must contain exactly one flowchart as a fenced ```mermaid block starting with "flowchart LR"; nodes are id[label] with short Chinese labels, edges are -->, and a labeled edge -->|label| may lead back to an earlier step (for example when a review or a test finds a problem). After the flowchart, describe each step for the agent.',
      'To use several agents, the prompt says in which step to call start_agent: it starts an independent agent with its own session that does not see the main conversation and gets at most the workflow permissions (it can only narrow them) and cannot publish. Only mention start_agent when permissions.agents is true.',
      'Hard limits you cannot change through the prompt: publication is done by the control plane (' + ceiling.publication + '); the agent never pushes, merges, approves, labels or comments through the shell; drafts, closed objects and the bot\'s own writing never trigger; development needs the project development switch, a development label added by a person and an Issue nobody is assigned to; tests must pass before a pull request; release notes are checked by the control plane.',
      'Permissions: {"workspace":{"read","write","notes","shell" booleans},"github":[read scopes],"agents":boolean}. They can never exceed this ceiling: ' + JSON.stringify(ceiling) + '. Choose the least the workflow needs.',
      'Return only JSON: {"reply":"what you changed and why, in a few sentences","draft":{' + (builtin ? '"triggers":{"<id>":true|false},' : '"name":"...","description":"...","triggers":[{"id":"...","label":"... only when needs_label"}],') + '"prompt":"full Markdown prompt","permissions":{...}}}. Keep fields the administrator did not ask to change.'
    ].join('\n');
    const prompt = JSON.stringify({ workflow: current ? { id: current.id, builtin: current.builtin, name: current.name, description: current.description,
      triggers: current.triggers, prompt: current.prompt.effective, permissions: current.permissions } : null,
      draft: body.draft ?? null, available_triggers: catalog, github_scopes: ceiling.github, conversation: messages });
    const redactor = new Redactor();
    let content: string;
    try {
      content = await runAgent({ store: this.store, task: { id: 'workflow-assistant:' + randomId(), repository_id: repositoryId, kind: 'workflow.assistant' }, redactor,
        guard: async () => {}, system, prompt, tools: [], maxTurns: 1, maxOutputChars: 2 * 1024 * 1024 });
    } catch (error) {
      if (error instanceof TaskError) throw Object.assign(new HttpError(error.state === 'waiting_configuration' ? 409 : 502, error.code), { detail: error.detail });
      throw error;
    }
    const value = jsonOf(content.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''), null);
    if (!value || typeof value.reply !== 'string' || !value.draft || typeof value.draft !== 'object') fail(502, 'assistant_reply_invalid');
    const draft = value.draft, warnings: string[] = [];
    // A draft outside what the workflow may do is narrowed here and said so; saving validates again.
    const permissions = clampPermissions(draft.permissions ?? current?.permissions ?? defaultPermissions('custom'), ceiling);
    if (JSON.stringify(permissions) !== JSON.stringify({ ...draft.permissions, publication: ceiling.publication }) && draft.permissions)
      warnings.push('草稿里的权限超出了这条工作流的上限或格式不对，已收窄到允许的范围。');
    const result: Json = { prompt: typeof draft.prompt === 'string' ? draft.prompt : current?.prompt.effective ?? '', permissions };
    if (builtin) {
      const allowed = new Set(catalog.map(trigger => trigger.id));
      result.triggers = Object.fromEntries(Object.entries(draft.triggers && typeof draft.triggers === 'object' && !Array.isArray(draft.triggers) ? draft.triggers : {})
        .filter(([trigger, on]) => allowed.has(trigger) && typeof on === 'boolean'));
    } else {
      result.name = typeof draft.name === 'string' && draft.name.trim() ? draft.name : current?.name ?? '新工作流';
      result.description = typeof draft.description === 'string' ? draft.description : current?.description ?? '';
      result.triggers = (Array.isArray(draft.triggers) ? draft.triggers : []).filter((trigger: any) => {
        const definition = triggers.find(entry => entry.id === trigger?.id);
        return definition && (!definition.label || typeof trigger.label === 'string' && trigger.label.trim());
      }).map((trigger: any) => ({ id: trigger.id, ...(triggers.find(entry => entry.id === trigger.id)!.label ? { label: String(trigger.label).trim() } : {}) }));
    }
    if (!hasFlowchart(String(result.prompt))) warnings.push('草稿提示词里没有 mermaid 流程图。');
    return { reply: value.reply, draft: result, warnings };
  }
  async api(user: Actor, method: string, url: URL, body: Json): Promise<Json | undefined> {
    const match = /^\/api\/repositories\/([^/]+)\/workflows(?:\/([^/]+))?$/.exec(url.pathname); if (!match) return undefined;
    const repositoryId = match[1]!, target = match[2] ? decodeURIComponent(match[2]) : null; allowRepository(this.store, user, repositoryId);
    if (!target && method === 'GET') return this.list(repositoryId);
    if (target === 'assistant' && method === 'POST') return this.assistant(repositoryId, body);
    if (!target && method === 'POST') {
      const id = 'custom.' + randomId().slice(0, 12);
      this.saveCustom(user, repositoryId, id, body);
      return { workflow: (await this.list(repositoryId)).workflows.find(workflow => workflow.id === id)! };
    }
    if (!target) return fail(405, 'method_not_allowed');
    const builtin = builtinWorkflow(target), row = savedWorkflow(this.store, repositoryId, target);
    if (!builtin && !(row && target.startsWith('custom.'))) return fail(404, 'workflow_not_found');
    if (method === 'GET') return { workflow: (await this.list(repositoryId)).workflows.find(workflow => workflow.id === target)! };
    if (method === 'PUT') {
      if (builtin) this.updateBuiltin(user, repositoryId, builtin, body); else this.saveCustom(user, repositoryId, target, body, row);
      return { workflow: (await this.list(repositoryId)).workflows.find(workflow => workflow.id === target)! };
    }
    if (method === 'DELETE') {
      if (builtin) return fail(409, 'builtin_workflow_required');
      fields(body, []);
      this.store.transaction(() => {
        // Work that has not finished stops with the workflow; finished tasks and their logs stay.
        this.store.run(`UPDATE tasks SET status='cancelled',error_code='workflow_deleted' WHERE repository_id=? AND workflow_id=?
          AND status NOT IN ('succeeded','pr_opened','completed','cancelled','superseded','failed')`, repositoryId, target);
        this.store.run('DELETE FROM workflows WHERE repository_id=? AND id=?', repositoryId, target);
        this.store.audit(user.id, 'workflow.deleted', target, repositoryId);
      });
      return { ok: true };
    }
    return fail(405, 'method_not_allowed');
  }
}
