import type { Store, Row } from '../storage/database.js';
import { type Actor, repository as allowRepository } from '../app/auth.js';
import { fail, fields, HttpError, randomId, type Json } from '../core/security.js';
import { type RuleService, resolveRules } from '../rules/service.js';
import { runAgent } from '../agent/runtime.js';
import { Redactor, TaskError, stop } from '../agent/common.js';
import { ReadTokens } from '../agent/read-token.js';
import { RepositoryExplorer, repositoryTools } from '../agent/exploration.js';
import { builtinRule } from '../releases/preflight.js';
import { builtinWorkflows, builtinWorkflow, triggers, githubScopes, hasFlowchart, writeOptions, validateWrites, defaultWrites, triggerOptions as catalogOptions, type BuiltinWorkflow } from './catalog.js';
import { savedWorkflow, workflowPermissions, customWorkflow, workflowTriggers, workflowEnabled, workflowActive, policyColumns, type Trigger } from './resolve.js';
import { activateActions } from '../actions/storage.js';

// A trigger as the console offers it to one workflow: the same catalog entries for built-in and custom workflows. The
// development label trigger names the label from issue-development.md, so it takes no label of its own.
function triggerOptions(id: string, developmentLabel: string | null) {
  return catalogOptions(id).map(trigger => {
    const entry = triggers.find(item => item.id === trigger)!, fixed = id.startsWith('development.') && trigger === 'issue.labeled';
    return { id: trigger, title: entry.title, short: entry.short, label: !!entry.label && !fixed, ...(fixed ? { fixed_label: developmentLabel } : {}),
      ...(trigger === 'comment.mention' ? { note: '名字来自部署设置 BOT_MENTION_NAMES' } : entry.note ? { note: entry.note } : {}) };
  });
}
const layerSource = (layers: { source: string }[]) => layers.at(-1)!.source;
const jsonOf = (text: unknown, fallback: any) => { try { return JSON.parse(String(text)); } catch { return fallback; } };

export class WorkflowService {
  constructor(readonly store: Store, readonly rules: RuleService, readonly githubUrl?: string) {}
  save(user: Actor, repositoryId: string, target: string, body: Json): void {
    allowRepository(this.store,user,repositoryId);
    const builtin=builtinWorkflow(target),row=savedWorkflow(this.store,repositoryId,target);
    if(!builtin&&!(row&&target.startsWith('custom.')))fail(404,'workflow_not_found');
    if(builtin)this.updateBuiltin(user,repositoryId,builtin,body);else this.saveCustom(user,repositoryId,target,body,row);
  }
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
    const shared = (id: string) => ({ enabled: workflowEnabled(this.store, repositoryId, id), active: workflowActive(this.store, repositoryId, id),
      triggers: workflowTriggers(this.store, repositoryId, id), trigger_options: triggerOptions(id, view.development_label),
      permissions: workflowPermissions(this.store, repositoryId, id), write_options: writeOptions(id), version: Number(rows.get(id)?.version ?? 0) });
    const builtins = builtinWorkflows.map(workflow => {
      const row = rows.get(workflow.id), review = workflow.base === 'review', development = workflow.base === 'development';
      return { id: workflow.id, builtin: true, base: workflow.base, object: workflow.object,
        name: row?.name || workflow.name, description: row?.description || workflow.description, default_name: workflow.name, default_description: workflow.description,
        ...shared(workflow.id),
        // The project-wide switches on the project list still apply to every review or development workflow.
        project_switch: review ? { key: 'review_enabled', title: '项目的检视开关', on: !!policy.review_enabled } : development ? { key: 'development_enabled', title: '项目的开发开关', on: !!policy.development_enabled } : null,
        prompt: this.builtinPrompt(workflow, view, row), model: this.model(policy, workflow.id),
        settings: review ? { review_language: policy.review_language || 'auto' } : development ? { test_command: policy.test_command || '', max_revisions: policy.max_revisions } : {},
        ...(workflow.id === 'actions.failures' ? { status: this.store.get('SELECT enabled_at,next_scan,error FROM actions_failure_scans WHERE repository_id=?', repositoryId) || null } : {}) };
    });
    const customs = [...rows.values()].filter(row => String(row.id).startsWith('custom.')).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(row => {
      const custom = customWorkflow(row);
      return { id: custom.id, builtin: false, base: 'reply', object: 'any', name: custom.name, description: String(row.description || ''),
        ...shared(custom.id), project_switch: null,
        prompt: { path: null, layers: [{ source: 'console', content: custom.prompt }], source: 'console', effective: custom.prompt, shared_with: [] },
        model: this.model(policy, custom.id, row), settings: {}, updated_at: row.updated_at };
    });
    return { workflows: [...builtins, ...customs], triggers, custom_write_options: writeOptions('custom'), custom_writes: defaultWrites('custom'), rules: { sha: view.sha, updated_at: view.updated_at, needs_refresh: view.needs_refresh },
      mention_names: (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').trim().toLowerCase() === 'off' ? [] : (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').split(',').map(name => name.trim()).filter(Boolean) };
  }
  // A trigger list from the editor: catalog entries this workflow may have, each once, label triggers with their label.
  // The older form {id: on} switches entries of the current list.
  private triggerList(repositoryId: string, id: string, value: unknown): Trigger[] {
    const options = new Map(triggerOptions(id, null).map(option => [option.id, option]));
    let list: any[] = value as any[];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      list = workflowTriggers(this.store, repositoryId, id).filter(trigger => (value as Json)[trigger.id] !== false);
      for (const [trigger, on] of Object.entries(value)) {
        if (typeof on !== 'boolean' || !options.has(trigger)) fail(400, 'invalid_workflow_triggers');
        if (on && !list.some(entry => entry.id === trigger)) list.push({ id: trigger });
      }
    }
    if (!Array.isArray(list)) return fail(400, 'invalid_workflow_triggers');
    const result = list.map(trigger => {
      const option = options.get(trigger?.id);
      if (!option || typeof trigger !== 'object' || Object.keys(trigger).some(key => !['id', 'label'].includes(key))) return fail(400, 'invalid_workflow_triggers');
      if (option.label && (typeof trigger.label !== 'string' || !trigger.label.trim() || trigger.label.includes('\0'))) return fail(400, 'invalid_workflow_trigger_label');
      if (!option.label && trigger.label !== undefined) return fail(400, 'invalid_workflow_triggers');
      return { id: option.id, ...(option.label ? { label: String(trigger.label).trim() } : {}) };
    });
    if (new Set(result.map(trigger => trigger.id + ':' + (trigger.label ?? '').toLowerCase())).size !== result.length) fail(400, 'duplicate_workflow_trigger');
    return result;
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
  // The workflows row of a built-in workflow is created on its first save; only the parts given are written.
  private saveRow(repositoryId: string, id: string, values: Record<string, unknown>, now: string) {
    if (!savedWorkflow(this.store, repositoryId, id)) this.store.run('INSERT INTO workflows(repository_id,id,created_at,updated_at,version) VALUES(?,?,?,?,0)', repositoryId, id, now, now);
    for (const [column, value] of Object.entries(values)) if (value !== undefined) this.store.run(`UPDATE workflows SET ${column}=? WHERE repository_id=? AND id=?`, value as any, repositoryId, id);
    this.store.run('UPDATE workflows SET version=version+1,updated_at=? WHERE repository_id=? AND id=?', now, repositoryId, id);
  }
  private text(value: unknown, code: string) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.includes('\0')) return fail(400, code);
    return value;
  }
  // A built-in workflow takes the same fields as a custom one. Prompts, models and settings keep living where they always
  // did; its name, description, switch and trigger list are on its own row. Fixed-rule workflows have no prompt or model.
  private updateBuiltin(user: Actor, repositoryId: string, workflow: BuiltinWorkflow, body: Json) {
    fields(body, ['name', 'description', 'enabled', 'triggers', 'prompt', 'writes', 'model_id', 'settings', 'version']);
    const policy = this.store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId)!, row = savedWorkflow(this.store, repositoryId, workflow.id);
    this.checkVersion(row, body.version);
    const review = workflow.base === 'review', development = workflow.base === 'development', updates: Record<string, unknown> = {};
    const name = this.text(body.name, 'invalid_workflow_name'), description = this.text(body.description, 'invalid_workflow_description');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') fail(400, 'invalid_workflow_enabled');
    const list = body.triggers === undefined ? undefined : this.triggerList(repositoryId, workflow.id, body.triggers);
    // The policy switches of the review triggers follow the list, so the policy API keeps reporting what runs.
    if (list && policyColumns[workflow.id]) for (const [trigger, column] of Object.entries(policyColumns[workflow.id]!)) updates[column] = Number(list.some(entry => entry.id === trigger));
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
    const writes = body.writes === undefined ? undefined : validateWrites(body.writes, workflow.id);
    const model = body.model_id === undefined ? undefined : this.modelChoice(user, repositoryId, body.model_id);
    const now = new Date().toISOString(), actions = workflow.id === 'actions.failures';
    this.store.transaction(() => {
      for (const [column, value] of Object.entries(updates)) this.store.run(`UPDATE policies SET ${column}=? WHERE repository_id=?`, value as any, repositoryId);
      if (overrides) this.store.run('UPDATE policies SET rule_overrides=? WHERE repository_id=?', JSON.stringify(overrides), repositoryId);
      if (model) {
        const taskModels = jsonOf(this.store.get('SELECT task_models FROM policies WHERE repository_id=?', repositoryId)!.task_models || '{}', {});
        if (model.id) taskModels[workflow.id] = model.id; else delete taskModels[workflow.id];
        if (model.grant) this.store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model.id, repositoryId);
        this.store.run('UPDATE policies SET task_models=? WHERE repository_id=?', JSON.stringify(taskModels), repositoryId);
      }
      // Actions failure handling keeps its policy switch (and its scan start time) as the workflow's switch.
      if (actions && body.enabled !== undefined) {
        this.store.run('UPDATE policies SET actions_failures_enabled=? WHERE repository_id=?', Number(body.enabled), repositoryId);
        if (body.enabled && !policy.actions_failures_enabled) activateActions(this.store, repositoryId);
      }
      this.saveRow(repositoryId, workflow.id, { name: name === undefined ? undefined : name.trim(), description: description === undefined ? undefined : description.trim(),
        enabled: body.enabled === undefined || actions ? undefined : Number(body.enabled), trigger_list: list && JSON.stringify(list), prompt: consolePrompt,
        permissions: writes && JSON.stringify({ writes }) }, now);
      this.store.audit(user.id, 'workflow.updated', workflow.id, repositoryId);
    });
  }
  // A custom workflow: free name, description and prompt; triggers from the catalog; the writes it may ask for.
  private customValues(repositoryId: string, id: string, body: Json, existing?: Row) {
    fields(body, ['name', 'description', 'enabled', 'triggers', 'prompt', 'writes', 'model_id', 'version']);
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
    const saved = body.triggers === undefined ? undefined : this.triggerList(repositoryId, id, body.triggers);
    const writes = body.writes === undefined ? (existing ? undefined : defaultWrites(id)) : validateWrites(body.writes, id);
    return { name, description, prompt, triggers: saved, writes, enabled: body.enabled as boolean | undefined };
  }
  private saveCustom(user: Actor, repositoryId: string, id: string, body: Json, existing?: Row) {
    if (existing) this.checkVersion(existing, body.version);
    const values = this.customValues(repositoryId, id, body, existing), model = body.model_id === undefined ? undefined : this.modelChoice(user, repositoryId, body.model_id);
    const now = new Date().toISOString();
    this.store.transaction(() => {
      if (!existing) this.store.run(`INSERT INTO workflows(repository_id,id,name,description,enabled,triggers,prompt,permissions,model_id,version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,?,?)`, repositoryId, id, values.name!, values.description ?? '', Number(values.enabled ?? true), JSON.stringify(values.triggers ?? []),
        values.prompt!, JSON.stringify({ writes: values.writes }), model?.id ?? null, now, now);
      else {
        const set: Record<string, unknown> = { name: values.name, description: values.description, prompt: values.prompt,
          enabled: values.enabled === undefined ? undefined : Number(values.enabled), triggers: values.triggers && JSON.stringify(values.triggers),
          permissions: values.writes && JSON.stringify({ writes: values.writes }), model_id: model ? model.id : undefined };
        for (const [column, value] of Object.entries(set)) if (value !== undefined) this.store.run(`UPDATE workflows SET ${column}=? WHERE repository_id=? AND id=?`, value as any, repositoryId, id);
        this.store.run('UPDATE workflows SET version=version+1,updated_at=? WHERE repository_id=? AND id=?', now, repositoryId, id);
      }
      if (model?.grant) this.store.run('INSERT INTO model_projects VALUES(?,?) ON CONFLICT DO NOTHING', model.id, repositoryId);
      this.store.audit(user.id, existing ? 'workflow.updated' : 'workflow.created', id, repositoryId);
    });
  }
  // Chat drafts a workflow with an agent: it reads the project's workflows and, when the account allows, the repository,
  // and proposes a draft through update_draft. Nothing is saved: the administrator reviews the draft in the editor and saves
  // it there, so a draft never becomes the effective configuration by itself. `emit` receives the run as it happens.
  async assistant(repositoryId: string, body: Json, emit: (event: Json) => void = () => {}, signal?: AbortSignal) {
    const prepared = await this.assistantInput(repositoryId, body);
    return this.assistantRun(repositoryId, prepared, emit, signal);
  }
  private async assistantInput(repositoryId: string, body: Json) {
    fields(body, ['workflow_id', 'draft', 'proposed', 'messages']);
    const messages = body.messages;
    if (!Array.isArray(messages) || !messages.length || messages.some((m: any) => !m || !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || !m.content.trim()))
      fail(400, 'invalid_assistant_messages');
    const id = body.workflow_id === undefined || body.workflow_id === null ? null : String(body.workflow_id);
    const builtin = id ? builtinWorkflow(id) : undefined;
    if (id && !builtin && !savedWorkflow(this.store, repositoryId, id)) fail(404, 'workflow_not_found');
    const list = await this.list(repositoryId), current = id ? list.workflows.find(workflow => workflow.id === id) ?? null : null;
    const object = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : null;
    return { id, builtin, current, list, messages: messages as { role: 'user' | 'assistant'; content: string }[], draft: object(body.draft), proposed: object(body.proposed) };
  }
  private async assistantRun(repositoryId: string, input: Awaited<ReturnType<WorkflowService['assistantInput']>>, emit: (event: Json) => void, signal?: AbortSignal) {
    const { id, current, list, messages } = input, options = writeOptions(id ?? 'custom');
    // The same trigger catalog the editor offers this workflow.
    const catalog = triggerOptions(id ?? 'custom', null).map(({ id, title, label }) => ({ id, title, ...(label ? { needs_label: true } : {}) }));
    // Only what the editor edits goes into a draft; a field an older editor kept (such as permissions) is dropped.
    const editable = (value: Json | null) => Object.fromEntries(Object.entries(value ?? {}).filter(([key]) => ['name', 'description', 'enabled', 'triggers', 'prompt', 'writes', 'model_id'].includes(key)));
    let draft: Json = { name: current?.name ?? '新工作流', description: current?.description ?? '', triggers: current?.triggers ?? [], prompt: current?.prompt.effective ?? '',
      writes: current?.permissions.writes ?? defaultWrites(id ?? 'custom'), ...editable(input.draft) }, warnings: string[] = [], updated = false;
    // update_draft: the agent's proposal, checked as the editor would check it; what does not fit is dropped and said so.
    const updateDraft = (args: any) => {
      if (!args || typeof args !== 'object') return { error: 'update_draft_invalid' };
      const next: Json = { ...draft }, notes: string[] = [];
      for (const key of ['name', 'description', 'prompt']) if (typeof args[key] === 'string') next[key] = args[key];
      if (Array.isArray(args.triggers)) {
        next.triggers = args.triggers.filter((trigger: any) => { const option = catalog.find(entry => entry.id === trigger?.id); return option && (!option.needs_label || typeof trigger.label === 'string' && trigger.label.trim()); })
          .map((trigger: any) => ({ id: trigger.id, ...(catalog.find(entry => entry.id === trigger.id)!.needs_label ? { label: String(trigger.label).trim() } : {}) }));
        if ((next.triggers as any[]).length !== args.triggers.length) notes.push('有触发源不在这条工作流的目录里，或按标签触发时缺少标签名，已去掉。');
      }
      if (Array.isArray(args.writes)) {
        // Writes outside this workflow's options are dropped, locked ones kept, and a PR brings the code write with it.
        const wanted = new Set<string>([...args.writes.filter((write: unknown) => typeof write === 'string' && options.some(option => option.id === write)), ...options.filter(option => option.locked).map(option => option.id)]);
        if (wanted.has('pull_request')) wanted.add('code');
        next.writes = options.map(option => option.id).filter(write => wanted.has(write));
        if (args.writes.some((write: unknown) => !options.some(option => option.id === write))) notes.push('有写入能力不在这条工作流可选的范围里，已去掉。');
      }
      if (typeof next.prompt === 'string' && next.prompt && !hasFlowchart(next.prompt)) notes.push('提示词里没有 mermaid 流程图。');
      draft = next; warnings = notes; updated = true;
      emit({ type: 'draft', draft, warnings });
      return { ok: true, draft, warnings };
    };
    const repository = this.store.get('SELECT * FROM repositories WHERE id=?', repositoryId)!;
    const app = this.store.get('SELECT type FROM accounts WHERE id=?', repository.account_id)?.type === 'github_app';
    const redactor = new Redactor(), guard = async () => { if (signal?.aborted) stop('assistant_cancelled', 'cancelled'); };
    const tokens = new ReadTokens(this.store, repository, redactor, guard, this.githubUrl, githubScopes), explorer = new RepositoryExplorer(tokens, redactor, guard);
    const fn = (name: string, description: string, properties: Json = {}) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required: [], additionalProperties: false } } });
    const tools = [
      fn('update_draft', 'Propose the workflow draft shown to the administrator. Give the full prompt (with its mermaid flowchart) and any fields you change; omitted fields keep their draft value. Returns the checked draft and warnings to fix.', {
        name: { type: 'string' }, description: { type: 'string' }, prompt: { type: 'string' },
        triggers: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id'], additionalProperties: false } },
        writes: { type: 'array', items: { type: 'string' }, description: 'The writes the workflow may ask the platform for, from the available writes' } }),
      fn('list_workflows', 'List this project\'s workflows: id, name, switch, triggers, writes and flowchart steps.'),
      ...(app ? [fn('github_read_token', 'Establish read-only access to this repository before reading it.'), ...repositoryTools] : [])
    ];
    const system = [
      'You are the workflow assistant of a GitHub repository maintenance bot. You help a project administrator write one workflow. Reply in Simplified Chinese, briefly.',
      'A workflow has triggers, a prompt for its agent and a model. The prompt is Markdown with exactly one flowchart as a fenced ```mermaid block starting with "flowchart LR": nodes are id[label] with short Chinese labels, edges are -->, and a labeled edge -->|label| may lead back to an earlier step (for example when a review or a test finds a problem). After the flowchart, describe each step for the agent.',
      'Reading is never restricted and needs no configuration: every workflow runs in the project computer, where its agent may read its workspace, run commands, write project notes, start independent agents and read everything on GitHub with a read-only token.',
      'To use several agents, the prompt says in which step to call start_agent: it starts an independent agent with its own session that does not see the main conversation, gets at most the workflow\'s own permissions and cannot publish.',
      'Writing is configured as writes: each is a platform tool the agent calls when it needs to, and the control plane performs it with its own checks. Available writes (id, tool, what the control plane does, locked ones cannot be removed): ' + JSON.stringify(options.map(({ id, tool, detail, locked }) => ({ id, tool, detail, locked }))) + '. Choose only the writes the workflow needs and say in the prompt when to call each tool; the agent never pushes, merges, approves, labels or comments through the shell. Drafts, closed objects and the bot\'s own writing never trigger; a pull request needs the project development switch and passing tests (the development workflows also a development label added by a person and an unassigned Issue); release notes are checked by the control plane.',
      'Available triggers: ' + JSON.stringify(catalog) + '.',
      'Work like an agent: read what you need (list_workflows; the repository through github_read and github_search when available), then call update_draft with the draft, fix any warnings it returns, and finish with a short message saying what you drafted and what the administrator should check. The administrator saves the draft; you cannot save or change anything yourself.'
    ].join('\n');
    const context = { workflow: current ? { id: current.id, builtin: current.builtin, name: current.name, description: current.description, triggers: current.triggers, writes: current.permissions.writes, prompt: current.prompt.effective } : null,
      editor_draft: input.draft && editable(input.draft), your_last_draft: input.proposed && editable(input.proposed), repository: repository.full_name };
    let reply = '';
    try {
      await runAgent({ store: this.store, task: { id: 'workflow-assistant:' + randomId(), repository_id: repositoryId, kind: 'workflow.assistant' }, redactor, guard, system, prompt: '', tools,
        adapter: async ({ request }) => {
          const conversation: any[] = [{ role: 'system', content: system }, { role: 'user', content: 'Current workflow and editor contents:\n' + JSON.stringify(context) }, ...messages.map(m => ({ role: m.role, content: m.content }))];
          for (let turn = 0; turn < 32; turn++) {
            let streamed = '';
            const { value } = await request({ messages: conversation, tools, tool_choice: 'auto' }, 'turn:' + turn, async delta => {
              if (delta?.content) { streamed += delta.content; emit({ type: 'text', delta: redactor.text(delta.content) }); }
              if (delta?.reasoning) emit({ type: 'reasoning', delta: redactor.text(delta.reasoning) });
            });
            const message = value?.choices?.[0]?.message;
            if (!message) return stop('agent_output_invalid', undefined, '助手没有返回有效结果。');
            const text = typeof message.content === 'string' ? message.content : '';
            if (text && !streamed) emit({ type: 'text', delta: redactor.text(text) });
            const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
            if (!calls.length) { reply = redactor.text(text); return; }
            conversation.push(redactor.clean({ role: 'assistant', content: text || null, tool_calls: calls }));
            emit({ type: 'turn' });
            for (const call of calls.slice(0, 8)) {
              await guard();
              let args: any = null; try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = null; }
              const name = String(call.function?.name || '');
              emit({ type: 'tool_call', id: call.id, name, arguments: redactor.clean(args) });
              const result = name === 'update_draft' ? updateDraft(args)
                : name === 'list_workflows' ? list.workflows.map(workflow => ({ id: workflow.id, name: workflow.name, builtin: workflow.builtin, enabled: workflow.enabled, triggers: workflow.triggers,
                  writes: workflow.permissions.writes, flow: workflow.prompt.effective.match(/```mermaid[\s\S]*?```/)?.[0] ?? null }))
                : tools.some(tool => tool.function.name === name) ? await explorer.execute(name, args) : { error: 'tool_not_allowed' };
              const content = JSON.stringify(redactor.clean(result));
              emit({ type: 'tool_result', id: call.id, name, result: content.length > 4000 ? content.slice(0, 4000) + '…' : content });
              conversation.push({ role: 'tool', tool_call_id: call.id, content });
            }
          }
          return stop('agent_turn_limit', 'failed', '助手达到 32 轮上限。');
        } });
    } catch (error) {
      if (error instanceof TaskError) throw Object.assign(new HttpError(error.state === 'waiting_configuration' ? 409 : error.code === 'assistant_cancelled' ? 499 : 502, error.code), { detail: error.detail });
      throw error;
    } finally { await tokens.revoke(); }
    return { reply, draft: updated ? draft : null, warnings };
  }
  // The streamed assistant: one JSON line per event (text, reasoning, tool call and result, draft), then done or error.
  async assistantStream(user: Actor, url: URL, body: Json, res: import('node:http').ServerResponse, closed: AbortSignal) {
    const match = /^\/api\/repositories\/([^/]+)\/workflows\/assistant$/.exec(url.pathname)!, repositoryId = match[1]!;
    allowRepository(this.store, user, repositoryId);
    const input = await this.assistantInput(repositoryId, body);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    const emit = (event: Json) => { if (!res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
    try { emit({ type: 'done', ...await this.assistantRun(repositoryId, input, emit, closed) }); }
    catch (error) { emit({ type: 'error', error: error instanceof HttpError ? error.code : 'service_unavailable', ...((error as any)?.detail ? { detail: String((error as any).detail) } : {}) }); }
    finally { res.end(); }
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
      this.save(user,repositoryId,target,body);
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
