import { randomId, fail, type Json } from '../core/security.js';
import type { Store, Row } from '../storage/database.js';
import { appJwt, missingPermissions, revokeInstallationToken } from '../github/client.js';
import { installationExecutionDenied } from '../installations/archive.js';
import { selectedModel } from '../agent/model.js';
import { stop, TaskError } from '../agent/common.js';
import { registerEventWork, eventTaskActive } from '../work/events.js';
import { sectionText, workActive } from '../work/settings.js';
import { recordEvent, registerDispatchHook } from '../dispatch/store.js';
import { collectFacts, baselinePlan, type GateFacts } from './gate-facts.js';
import { gateFiles, gateEvents, normalizePlan, PlanError, gateLanes, laneTimes, laneEvents, releasePath, tokenPattern, type GateFile, type GatePlan, type GateTarget } from './gate-plan.js';
import { unifiedDiff } from './text-diff.js';

/**
 * Gate onboarding as a conversation with the gate onboarding work type. Every message is an event the Manager decides on,
 * and every turn it starts is a task in the project's queue: it runs in the project computer on a checkout of the default
 * branch, like every other task, reads
 * the code and runs its commands there, and hands back a reply and a plan with submit_gate_plan. Nothing is written to the
 * repository until a person confirms a plan revision after seeing the files; only then does the control plane open the PR.
 */
// States: thinking (a turn is queued or running), ready, creating (the confirmed PR), done, blocked, failed; `collecting`
// and `connected` only appear on conversations from earlier versions.
const workflowId = 'gate.onboarding';
type Permissions = Record<string, string>;
export interface GateMessage { role: 'agent' | 'user' | 'system'; content: string; at: string }
/** One step's GitHub App credentials; every installation token it mints is revoked when the step ends. */
interface AppSession { appId: string; privateKey: string; issued: string[]; guard: () => void }

// The confirmed gate PR mints its own installation token, limited to what it writes and to what the installation granted.
// Workflow tasks never ask for workflows, so only the confirmed gate PR can change `.github/workflows/`.
export const gatePermissions = {
  // The confirmed gate PR commits `.github/workflows/` to the source repository.
  source: { contents: 'write', pull_requests: 'write', workflows: 'write', metadata: 'read' },
  // Reads gate.mjs from the CI-workflow template repository through the App installed on it.
  template: { contents: 'read', metadata: 'read' },
} satisfies Record<string, Permissions>;
const permissionNames: Record<string, string> = { contents: 'Contents', pull_requests: 'Pull requests', workflows: 'Workflows', metadata: 'Metadata' };
const levelNames: Record<string, string> = { read: 'Read-only', write: 'Read and write' };

class Blocked extends Error { constructor(readonly code: string, readonly detail: string) { super(code); } }
const encode = (path: string) => path.split('/').map(encodeURIComponent).join('/');
const now = () => new Date().toISOString();
const code = (text: string) => { const flat = text.replace(/\s*\n\s*/g, ' ⏎ '); return flat.includes('`') ? '`` ' + flat + ' ``' : '`' + flat + '`'; };
const scrub = (text: string) => text.replace(new RegExp(tokenPattern.source, 'g'), '[REDACTED]');

// ---- Sessions (shared by the console API and the workflow's task hooks) ------------------------------------------------
const sessionRow = (store: Store, id: string): Row | undefined => store.get('SELECT * FROM gate_onboarding_sessions WHERE id=?', id);
const latestSession = (store: Store, repositoryId: string): string | null =>
  store.get('SELECT id FROM gate_onboarding_sessions WHERE repository_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', repositoryId)?.id ?? null;
function updateSession(store: Store, id: string, changes: Record<string, string | number | null>): void {
  const keys = Object.keys(changes);
  store.run(`UPDATE gate_onboarding_sessions SET ${keys.map(key => key + '=?').join(',')},updated_at=? WHERE id=?`, ...keys.map(key => changes[key]!), now(), id);
}
function say(store: Store, id: string, role: GateMessage['role'], content: string): void {
  const row = sessionRow(store, id);
  if (!row) return; // Deleting the project removes its conversations, even while a step is finishing.
  const messages: GateMessage[] = JSON.parse(String(row.messages));
  messages.push({ role, content, at: now() });
  updateSession(store, id, { messages: JSON.stringify(messages) });
}
const mergeQueueOf = (row: Row, facts: GateFacts): 'enabled' | 'disabled' | 'unknown' =>
  facts.merge_queue.state !== 'unknown' ? facts.merge_queue.state : row.merge_queue === 'enabled' || row.merge_queue === 'disabled' ? row.merge_queue : 'unknown';
/**
 * Where the gate job can go: the workflow that already runs gate.mjs, or ci.yml / ci-gates.yml, new or existing (release
 * preflight and the gate status look for the gate there). Nothing is overwritten: an existing file gets the gate job merged in.
 */
function targets(facts: GateFacts): { path: string; mode: 'create' | 'update' }[] {
  const gate = facts.existing.gate_workflow, names = ['.github/workflows/ci.yml', '.github/workflows/ci-gates.yml'];
  const taken = new Set(facts.workflows.map(item => item.path)), readable = facts.workflows.filter(item => !item.error && item.path in facts.sources).map(item => item.path);
  return [...(gate ? [{ path: gate, mode: 'update' as const }] : []),
    ...names.filter(path => !taken.has(path)).map(path => ({ path, mode: 'create' as const })),
    ...names.filter(path => path !== gate && readable.includes(path)).map(path => ({ path, mode: 'update' as const }))];
}
/** The default place: the existing gate workflow, else a new ci.yml, else a new ci-gates.yml beside the repository's ci.yml. */
const defaultWorkflow = (facts: GateFacts) => targets(facts)[0]?.path ?? '.github/workflows/ci.yml';
/** What the files are rendered against; null when the plan names a workflow that is not one of the targets. */
function target(facts: GateFacts, mergeQueue: 'enabled' | 'disabled', plan: GatePlan): GateTarget | null {
  const path = plan.workflow || defaultWorkflow(facts), option = targets(facts).find(item => item.path === path);
  if (!option) return null;
  return { defaultBranch: facts.default_branch, mergeQueue, workflowPath: path, workflowSource: option.mode === 'update' ? facts.sources[path]! : null,
    configSource: facts.sources['.github/ci-gates.json'] ?? null, npmLock: facts.lockfiles.includes('package-lock.json'),
    // The release flow needs a tag-triggered release.yml: one is created when missing, an existing one is kept.
    releaseSource: facts.sources[releasePath] ?? null, releaseUsable: !!facts.release_workflow?.usable };
}
/** The files of the gate PR for a plan, or why there are none. */
function filesFor(facts: GateFacts, mergeQueue: 'enabled' | 'disabled', plan: GatePlan): { target: GateTarget; files: GateFile[] } | { problem: string; code: string } {
  const rendered = target(facts, mergeQueue, plan);
  if (!rendered) return { code: 'gate_workflow_invalid', problem: `方案里的 workflow ${plan.workflow} 不是可选的位置。` };
  try { return { target: rendered, files: gateFiles(plan, rendered) }; }
  catch (error) { if (error instanceof PlanError) return { code: error.code, problem: error.detail }; throw error; }
}
/** What the gate PR changes whatever the plan says: the agent tells the person about these as well as about its own changes. */
function standardChanges(facts: GateFacts): string[] {
  const config = facts.gate_config && typeof facts.gate_config === 'object' ? facts.gate_config as any : null;
  return [
    'The gate job checks out the PR head on pull requests and reports that commit (CI_GATES_SHA), not GitHub\'s merge preview.',
    'ci-gates.json maps each event to its lanes (events): pull_request and workflow_dispatch run pr-ready; merge_group and push to the default branch run pr-ready then pr-merge; schedule runs daily; release runs release.',
    'Triggers follow the merge queue: pull_request and merge_group always; push to the default branch only without a merge queue; schedule when daily has commands; workflow_dispatch.',
    'A workflow that holds only the gate job gets exactly those triggers (others, such as push under a merge queue, are removed) and its generated header is updated. A workflow shared with other jobs keeps all its triggers; the gate job gets an if: limiting it to the gate events.',
    'The lane commands run without a GitHub token.',
    'Only pull request runs of one branch cancel each other.',
    ...(config?.lanes?.build ? ['The existing build lane is removed; its commands are folded into pr-ready.'] : []),
    ...(!facts.existing.release_yml ? ['release.yml is created: a version tag runs the release lane, and the release flow waits for that run before the Release draft.'] : []),
    ...(!facts.existing.gate_script ? ['scripts/gate/gate.mjs is copied from CI-workflow.'] : []),
  ];
}

/** The session a turn belongs to, still waiting for this very task; anything else ends the task. */
function boundSession(store: Store, task: Row, input: any): Row {
  const row = sessionRow(store, String(input?.session_id || ''));
  if (!row || String(row.repository_id) !== String(task.repository_id)) return stop('gate_session_superseded', 'cancelled', '这次接入门禁对话已经删除。');
  if (latestSession(store, String(task.repository_id)) !== row.id || row.task_id !== task.id) return stop('gate_session_superseded', 'cancelled', '已经开始了新的接入门禁对话，或这一轮已经结束。');
  return row;
}

registerEventWork(workflowId, {
  async prepare(store, github, task, input, redactor) {
    const row = boundSession(store, task, input);
    // The control plane reads only what it needs to render and check the gate files; the agent studies the checkout itself.
    let facts: GateFacts;
    try {
      facts = redactor.clean(await collectFacts({ get: path => github.request('GET', path, undefined, true),
        graphql: (query, variables) => github.request('POST', '/graphql', { query, variables }) }, github.fullName));
    } catch (error) {
      if ((error as Error).message === 'repository_empty') return stop('repository_has_no_commit', 'failed', '仓库还没有任何提交，先推送代码再接入门禁。');
      if ((error as Error).message === 'repository_not_found') return stop('gate_repository_unreadable', 'waiting_permission', 'GitHub App 读不到这个仓库。');
      throw error;
    }
    const first = !row.facts, changes: Record<string, string | number | null> = { facts: JSON.stringify(facts) };
    if (Number(row.revision) === 0) Object.assign(changes, { plan: JSON.stringify(baselinePlan(facts)), revision: 1 });
    updateSession(store, row.id, changes);
    if (first) {
      say(store, row.id, 'system', factSummary(facts));
      const folded = (facts.gate_config as any)?.lanes?.build?.commands?.length ? '（原来的 build lane 已并入 pr-ready）' : '';
      if (facts.existing.ci_gates_json) say(store, row.id, 'system', `仓库已经接入门禁。右侧方案从当前的 .github/ci-gates.json${facts.existing.gate_workflow ? ` 和 ${facts.existing.gate_workflow} 里的门禁 job` : ''}开始${folded}；agent 审视后提出修改，你确认后才会开一个更新门禁的 PR。`);
    }
    const current = sessionRow(store, row.id)!, mergeQueue = mergeQueueOf(current, facts);
    const gate = { repository: facts.repository, default_branch: facts.default_branch, head_sha: facts.head_sha,
      merge_queue: { state: mergeQueue, evidence: facts.merge_queue.state === 'unknown' && mergeQueue !== 'unknown' ? 'answered by the person in the plan panel' : facts.merge_queue.evidence },
      required_checks: facts.required_checks, existing: facts.existing, gate_config: facts.gate_config, release_workflow: facts.release_workflow,
      workflows: facts.workflows, targets: targets(facts), default_workflow: defaultWorkflow(facts), open_gate_prs: facts.open_gate_prs,
      lanes: Object.fromEntries(gateLanes.map(lane => [lane, laneTimes[lane]])), events: laneEvents, standard_changes: standardChanges(facts) };
    return { sha: facts.head_sha,
      files: { 'conversation.json': JSON.stringify(JSON.parse(String(current.messages)).map(({ role, content }: GateMessage) => ({ role, content })), null, 2),
        'plan.json': JSON.stringify(JSON.parse(String(current.plan)), null, 2), 'gate.json': JSON.stringify(gate, null, 2) },
      contextFiles: [{ path: '../context/conversation.json', content: 'The conversation so far; answer its last message' },
        { path: '../context/plan.json', content: 'The current gate plan; lanes you leave out of your plan keep these commands' },
        { path: '../context/gate.json', content: 'What the control plane read from GitHub: merge queue, required checks, existing gate and release files, where the gate job can go, when each lane runs and what the gate PR always changes' }],
      context: { merge_queue: mergeQueue, work_name: '接入门禁', work_prompt: sectionText(store, task.repository_id, workflowId) } };
  },
  validate(store, task, input) { boundSession(store, task, input); },
  finish(store, task, input, result) {
    const row = boundSession(store, task, input), facts: GateFacts = JSON.parse(String(row.facts)), current: GatePlan = JSON.parse(String(row.plan));
    const reply = scrub(typeof result?.reply === 'string' ? result.reply.trim() : '');
    let plan: GatePlan | null = null, problem = '';
    if (result?.plan && typeof result.plan === 'object') {
      // Lanes and toolchains the agent left out keep their current values; an empty list still empties a lane.
      const submitted = { ...current, ...result.plan, toolchains: { ...current.toolchains, ...(result.plan.toolchains ?? {}) }, lanes: { ...current.lanes, ...(result.plan.lanes ?? {}) } };
      try {
        plan = normalizePlan(submitted);
        if (plan.workflow && !targets(facts).some(item => item.path === plan!.workflow)) throw new PlanError('gate_workflow_invalid', `workflow ${plan.workflow} 不在可选的位置里`);
      } catch (error) { if (!(error instanceof PlanError)) throw error; plan = null; problem = error.detail; }
    }
    say(store, row.id, 'agent', reply || '（agent 没有写回复）');
    // A plan that fails the checks never replaces the current one; the reply and its analysis are kept.
    if (problem) say(store, row.id, 'system', `agent 提交的方案没有通过检查（${problem}），右侧方案没有变化。`);
    const fresh = sessionRow(store, row.id)!;
    if (plan && JSON.stringify(plan) !== String(fresh.plan)) updateSession(store, row.id, { plan: JSON.stringify(plan), revision: Number(fresh.revision) + 1 });
    updateSession(store, row.id, { state: 'ready', task_id: null, error: null, detail: null });
    return { reply, plan_revision: Number(sessionRow(store, row.id)!.revision), plan_rejected: problem || null };
  },
  ended(store, task, errorCode, detail) {
    const row = sessionRow(store, String(JSON.parse(String(task.input || '{}')).session_id || ''));
    if (!row || row.task_id !== task.id) return;
    say(store, row.id, 'system', `agent 这一轮没有完成：${detail || errorCode}。可以再发一次，或直接修改右侧方案。`);
    updateSession(store, row.id, { state: row.facts ? 'ready' : 'failed', task_id: null, error: errorCode, detail: detail || null });
  }
});

// The Manager's decision on a turn: the task the session waits for, or why this turn will not run.
registerDispatchHook(workflowId, {
  created(store, task, ref: any) {
    const row = sessionRow(store, String(ref.session_id));
    if (row && row.state === 'thinking' && !row.task_id) updateSession(store, row.id, { task_id: String(task.id) });
  },
  declined(store, _event, reason, ref: any) {
    const row = sessionRow(store, String(ref.session_id));
    if (!row || row.state !== 'thinking' || row.task_id) return;
    say(store, row.id, 'system', `Manager 没有安排这一轮：${reason}。可以再发一次，或直接修改右侧方案。`);
    updateSession(store, row.id, { state: row.facts ? 'ready' : 'failed', error: 'manager_declined', detail: reason });
  }
});

export class GateOnboarding {
  /** Sessions whose gate PR is being created in this process; a `creating` state without one was interrupted by a restart. */
  private readonly running = new Set<string>();
  private readonly tokenGuards = new Map<string, () => void>();
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com',
    readonly templateRepo = process.env.BOT_CI_TEMPLATE_REPO || 'agent-CI-Infra/CI-workflow') { this.recover(); }

  // ---- GitHub access for the confirmed PR ----------------------------------------------------------------------------
  /** An empty token sends the request without credentials (public reads). 404 is null; other failures throw. */
  private async request(method: string, path: string, token: string, body?: unknown): Promise<any | null> {
    // The caller's existing guard follows background creation too, including each external write.
    this.store.checkAuthorization(); this.tokenGuards.get(token)?.();
    let response: Response;
    try {
      response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('github_unavailable'); }
    this.store.checkAuthorization(); this.tokenGuards.get(token)?.();
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('github_http_' + response.status);
    const text = await response.text(); this.store.checkAuthorization();
    return text ? JSON.parse(text) : {};
  }
  private async file(repo: string, path: string, token: string, ref?: string): Promise<string | null> {
    const value = await this.request('GET', `/repos/${repo}/contents/${encode(path)}${ref ? '?ref=' + encodeURIComponent(ref) : ''}`, token);
    return value && !Array.isArray(value) && typeof value.content === 'string' ? Buffer.from(value.content, 'base64').toString('utf8') : null;
  }
  /** Writes a file on the bot branch; a retry of the same session updates the copy it wrote before. */
  private async put(repo: string, path: string, content: string, branch: string, token: string): Promise<void> {
    const payload = { message: `chore(ci): add ${path}`, content: Buffer.from(content, 'utf8').toString('base64'), branch };
    try { await this.request('PUT', `/repos/${repo}/contents/${encode(path)}`, token, payload); }
    catch (error) {
      if (!String((error as Error).message).endsWith('422')) throw error;
      const current = await this.request('GET', `/repos/${repo}/contents/${encode(path)}?ref=${encodeURIComponent(branch)}`, token);
      if (!current?.sha) throw error;
      await this.request('PUT', `/repos/${repo}/contents/${encode(path)}`, token, { ...payload, sha: current.sha });
    }
  }
  private installation(app: AppSession, path: string): Promise<any | null> { app.guard(); return this.request('GET', path, appJwt(app.appId, app.privateKey)); }
  /** An installation token with the wanted permissions, lowered to what the installation has granted. */
  private async token(app: AppSession, installation: any, wanted: Permissions, scope: Json = {}): Promise<string> {
    app.guard();
    const granted = installation?.permissions || {}, permissions: Permissions = {};
    for (const [key, level] of Object.entries(wanted)) if (granted[key]) permissions[key] = granted[key] === 'read' ? 'read' : level;
    const access = await this.request('POST', `/app/installations/${encodeURIComponent(String(installation.id))}/access_tokens`, appJwt(app.appId, app.privateKey), { ...scope, permissions });
    const token = typeof access?.token === 'string' ? access.token : '';
    if (!token) throw new Error('github_token_missing');
    app.issued.push(token); this.tokenGuards.set(token, app.guard); app.guard(); return token;
  }
  /** The template repository through the App installed on it (needed when private), or a public read. */
  private async templateToken(app: AppSession, token: string): Promise<string | null> {
    const installation = await this.installation(app, `/repos/${this.templateRepo}/installation`);
    if (installation) return this.token(app, installation, gatePermissions.template, { repositories: [this.templateRepo.split('/')[1]] });
    for (const candidate of [token, '']) {
      const meta = await this.request('GET', `/repos/${this.templateRepo}`, candidate).catch(() => null);
      if (meta?.private === false) return candidate;
    }
    return null;
  }
  private permissionGap(installation: any, required: Permissions): Blocked | null {
    const missing = missingPermissions(installation.permissions, required);
    if (!missing.length) return null;
    const names = missing.map(item => `${permissionNames[item.permission] || item.permission}（${levelNames[item.required]}）`).join('、');
    return new Blocked('app_permissions_missing', `GitHub App 缺少权限，需要在 App 设置里新增，并在 ${String(installation.account?.login || installation.id)} 的安装里同意：${names}`);
  }
  /** The started repository and its App credentials; only GitHub App installation tokens are used, never a bot account's token. */
  private source(repositoryId: string): { row: Row; full: string; app: AppSession } {
    const row = this.store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
    if (!row) throw new Blocked('gate_project_not_started', '项目已经停止或删除');
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', String(row.account_id));
    if (account?.type !== 'github_app') throw new Blocked('github_app_required', '门禁接入只使用 GitHub App 安装令牌；这个仓库挂在机器人账号上，需要改为安装 GitHub App');
    const secrets = this.store.secrets.open(account.credentials, `account:${account.id}`);
    if (!secrets.private_key) throw new Blocked('github_credentials_missing', 'GitHub App 账号没有保存私钥');
    const guard = () => { if (installationExecutionDenied(this.store, String(account.id), repositoryId)) throw new Blocked('installation_access_revoked', 'GitHub App 安装已失效或正在核实范围，请先完成安装同步'); };
    guard();
    return { row, full: String(row.full_name), app: { appId: String(account.app_id), privateKey: String(secrets.private_key), issued: [], guard } };
  }
  private async revoke(app: AppSession) { await Promise.all(app.issued.splice(0).map(token => { this.tokenGuards.delete(token); return revokeInstallationToken(this.apiUrl, token).catch(() => false); })); }

  // ---- Conversation --------------------------------------------------------------------------------------------------
  private spawn(id: string, step: () => Promise<void>): void {
    this.running.add(id);
    void step().catch(error => {
      try {
        say(this.store, id, 'system', `这一步意外中断：${(error as Error).message}`);
        updateSession(this.store, id, { state: sessionRow(this.store, id)?.facts ? 'ready' : 'failed', error: (error as Error).message });
      } catch { /* The store is closing; the next start recovers the busy state. */ }
    }).finally(() => this.running.delete(id));
  }
  /** A restart ends a PR creation in progress (confirming again reuses its branch); agent turns are tasks and carry on. */
  private recover(): void {
    for (const row of this.store.all("SELECT id,state,facts FROM gate_onboarding_sessions WHERE state IN ('creating','collecting')")) {
      say(this.store, String(row.id), 'system', row.state === 'creating' ? '控制面重启，创建 PR 没有完成。再次确认会复用同一个分支继续。' : '控制面重启，这次对话没有完成，请重新开始。');
      updateSession(this.store, String(row.id), { state: row.facts ? 'ready' : 'failed', error: 'interrupted' });
    }
  }

  /**
   * Whether this repository can use gate onboarding now: like every workflow, its agent works in the project computer, so
   * the project must be started and enabled, its computer ready, the workflow on and a model configured.
   */
  readiness(repositoryId: string): { ok: boolean; code?: string; reason?: string; model?: string } {
    const no = (code: string, reason: string) => ({ ok: false, code, reason });
    if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) return no('gate_project_not_started', '项目还没有启动：先在仓库列表点「启动」，等虚拟电脑就绪后再接入门禁。');
    const policy = this.store.get('SELECT enabled FROM policies WHERE repository_id=?', repositoryId);
    if (!policy?.enabled) return no('gate_project_disabled', '项目已禁用：启用后再接入门禁。');
    const account = this.store.get('SELECT a.type FROM accounts a JOIN repositories r ON r.account_id=a.id WHERE r.id=?', repositoryId);
    if (account?.type !== 'github_app') return no('github_app_required', '门禁接入只使用 GitHub App 安装令牌；这个仓库挂在机器人账号上，需要改为安装 GitHub App。');
    if (!workActive(this.store, repositoryId, workflowId)) return no('work_disabled', '项目策略关闭了「接入门禁」；请项目管理员在管理对话中启用。');
    const environment = this.store.get('SELECT state FROM project_environments WHERE repository_id=?', repositoryId);
    if (!['ready', 'busy'].includes(String(environment?.state))) return no('gate_environment_not_ready', `项目的虚拟电脑还没有就绪（当前：${environment?.state || '未创建'}），就绪后再接入门禁。`);
    try { return { ok: true, model: selectedModel(this.store, repositoryId, workflowId).model }; }
    catch (error) { return no(error instanceof TaskError ? error.code : 'model_not_configured', error instanceof TaskError ? error.detail || error.code : (error as Error).message); }
  }

  private view(row: Row): Json {
    const facts: GateFacts | null = row.facts ? JSON.parse(String(row.facts)) : null, plan: GatePlan | null = row.plan ? JSON.parse(String(row.plan)) : null;
    const mergeQueue = facts ? mergeQueueOf(row, facts) : 'unknown';
    const rendered = facts && plan && mergeQueue !== 'unknown' ? filesFor(facts, mergeQueue, plan) : null;
    const { gate_config: _config, sources: _sources, ...summary } = facts || ({} as any);
    const task = row.task_id ? this.store.get('SELECT id,status,phase,error_code FROM tasks WHERE id=?', row.task_id) : null;
    return { id: row.id, repository_id: row.repository_id, state: row.state, busy: this.running.has(String(row.id)),
      latest: latestSession(this.store, String(row.repository_id)) === row.id, messages: JSON.parse(String(row.messages)), plan, revision: Number(row.revision),
      ready: this.readiness(String(row.repository_id)),
      facts: facts ? summary : null, task: task ? { id: task.id, status: task.status, phase: task.phase, error: task.error_code || null, active: eventTaskActive(task) } : null,
      merge_queue: facts ? { state: mergeQueue, evidence: facts.merge_queue.state === 'unknown' ? (row.merge_queue ? '由你在对话中确认' : facts.merge_queue.evidence) : facts.merge_queue.evidence,
        asked: facts.merge_queue.state === 'unknown' } : null,
      workflow_options: facts ? targets(facts) : [], default_workflow: facts ? defaultWorkflow(facts) : null,
      ...targetView(facts, plan, rendered),
      pr_url: row.pr_url || null, error: row.error || null, detail: row.detail || null, created_at: row.created_at, updated_at: row.updated_at };
  }
  /** The files a plan would produce, without saving it: the console previews the person's unsent edits with this. */
  preview(id: string, plan: unknown): Json {
    const row = sessionRow(this.store, id);
    if (!row?.facts) return fail(404, 'gate_onboarding_not_found');
    const facts: GateFacts = JSON.parse(String(row.facts)), mergeQueue = mergeQueueOf(row, facts);
    let normalized: GatePlan;
    try { normalized = normalizePlan(plan); } catch (error) { if (error instanceof PlanError) return fail(400, error.code); throw error; }
    return { ...targetView(facts, normalized, mergeQueue === 'unknown' ? null : filesFor(facts, mergeQueue, normalized)),
      basis: { revision: Number(row.revision), head_sha: facts.head_sha, merge_queue: mergeQueue } };
  }
  latest(repositoryId: string): Json | null {
    const id = latestSession(this.store, repositoryId);
    return id ? this.view(sessionRow(this.store, id)!) : null;
  }
  get(id: string): Json | null { const row = sessionRow(this.store, id); return row ? this.view(row) : null; }

  /** Asks the Manager for the next turn of a conversation; the turn's task binds to the session once it is created. */
  private ask(id: string): void {
    const row = sessionRow(this.store, id)!, messages = JSON.parse(String(row.messages)) as GateMessage[], turn = messages.filter(message => message.role === 'user').length + 1;
    updateSession(this.store, id, { state: 'thinking', task_id: null, error: null, detail: null });
    const last = [...messages].reverse().find(message => message.role === 'user');
    recordEvent(this.store, { repositoryId: String(row.repository_id), key: `${row.repository_id}:gate.manual:${id}:${turn}`, type: 'gate.manual', source: 'gate',
      summary: `接入门禁对话第 ${turn} 轮`, facts: { session_id: id, turn, message: last ? String(last.content).slice(0, 2000) : null, plan_revision: Number(row.revision) },
      options: [{ id: 'turn', work: workflowId, title: `接入门禁 第 ${turn} 轮`, default: true, hook: workflowId, ref: { session_id: id, turn },
        spec: { type: 'event', kind: workflowId, key: `${id}:${turn}`, sha: '', input: { session_id: id, turn }, summary: `接入门禁 第 ${turn} 轮` } }] });
  }

  /** Starts a new conversation; an unfinished one of the same repository is superseded and its turn stops. */
  start(repositoryId: string): Json {
    const ready = this.readiness(repositoryId);
    if (!ready.ok) return fail(409, ready.code!);
    // Two PR attempts for one repository would open two gate PRs.
    const creating = this.store.all("SELECT id FROM gate_onboarding_sessions WHERE repository_id=? AND state='creating'", repositoryId);
    if (creating.some(row => this.running.has(String(row.id)))) return fail(409, 'gate_onboarding_busy');
    const id = randomId(), time = now();
    this.store.run('INSERT INTO gate_onboarding_sessions(id,repository_id,state,messages,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, repositoryId, 'thinking', '[]', 0, time, time);
    this.ask(id);
    return this.get(id)!;
  }

  private open(id: string): Row {
    const row = sessionRow(this.store, id);
    if (!row) return fail(404, 'gate_onboarding_not_found');
    if (this.running.has(id)) return fail(409, 'gate_onboarding_busy');
    if (latestSession(this.store, String(row.repository_id)) !== id) return fail(409, 'gate_onboarding_superseded');
    if (row.state !== 'ready') return fail(409, row.state === 'thinking' ? 'gate_onboarding_busy' : 'gate_onboarding_closed');
    return row;
  }
  /** Saves the person's own edits as a new revision; `revision` must be the one they edited, so a newer plan is never lost. */
  private edit(row: Row, revision: unknown, plan: unknown): Row {
    if (plan === undefined) return row;
    if (revision !== Number(row.revision)) return fail(409, 'gate_plan_changed');
    let normalized: GatePlan;
    try { normalized = normalizePlan(plan); } catch (error) { if (error instanceof PlanError) return fail(400, error.code); throw error; }
    if (JSON.stringify(normalized) === String(row.plan)) return row;
    updateSession(this.store, String(row.id), { plan: JSON.stringify(normalized), revision: Number(row.revision) + 1 });
    say(this.store, String(row.id), 'system', `你修改了方案（第 ${Number(row.revision) + 1} 版）。`);
    return sessionRow(this.store, String(row.id))!;
  }

  /** The person's message, with any plan edits they made; the agent answers in its next turn. */
  message(id: string, content: unknown, revision?: unknown, plan?: unknown): Json {
    if (typeof content !== 'string' || !content.trim()) return fail(400, 'message_required');
    const opened = this.open(id), ready = this.readiness(String(opened.repository_id));
    if (!ready.ok) return fail(409, ready.code!);
    this.edit(opened, revision, plan);
    say(this.store, id, 'user', content.trim());
    this.ask(id);
    return this.get(id)!;
  }

  /** The person's answer when the facts could not tell whether the default branch uses a merge queue. */
  answerMergeQueue(id: string, answer: unknown): Json {
    const row = this.open(id), facts: GateFacts = JSON.parse(String(row.facts));
    if (facts.merge_queue.state !== 'unknown') return fail(409, 'merge_queue_known');
    if (answer !== 'enabled' && answer !== 'disabled') return fail(400, 'merge_queue_required');
    if (row.merge_queue !== answer) {
      updateSession(this.store, id, { merge_queue: answer });
      say(this.store, id, 'system', answer === 'enabled' ? '你确认默认分支启用了 merge queue：合入门禁在队列里运行，合入后不再重复运行。' : '你确认默认分支没有启用 merge queue：合入门禁在每次合入默认分支后运行。');
    }
    return this.get(id)!;
  }

  /** The person confirms a plan revision (with their last edits); the control plane opens the gate PR in the background. */
  confirm(id: string, revision: unknown, plan?: unknown, answer?: unknown): Json {
    let row = this.open(id);
    if (revision !== Number(row.revision)) return fail(409, 'gate_plan_changed');
    const facts: GateFacts = JSON.parse(String(row.facts));
    if (facts.merge_queue.state === 'unknown' && answer !== undefined) this.answerMergeQueue(id, answer);
    const mergeQueue = mergeQueueOf(sessionRow(this.store, id)!, facts);
    if (mergeQueue === 'unknown') return fail(400, 'merge_queue_required');
    // What blocks every plan is checked before the person's edits become a new revision.
    if (facts.open_gate_prs.length) return fail(409, 'gate_pr_open');
    const candidate = plan === undefined ? JSON.parse(String(row.plan)) : (() => { try { return normalizePlan(plan); } catch (error) { if (error instanceof PlanError) return fail(400, error.code); throw error; } })();
    const rendered = filesFor(facts, mergeQueue, candidate);
    if ('problem' in rendered) return fail(409, rendered.code);
    // A plan equal to what the repository already has would open an empty PR.
    if (!rendered.files.length) return fail(409, 'gate_no_changes');
    row = this.edit(sessionRow(this.store, id)!, revision, plan);
    say(this.store, id, 'system', `已确认第 ${row.revision} 版方案，正在创建门禁 PR。`);
    updateSession(this.store, id, { state: 'creating', error: null, detail: null });
    this.spawn(id, () => this.create(id));
    return this.get(id)!;
  }

  /** Opens the gate PR for the confirmed plan. A failure returns to the conversation, and confirming again reuses the branch. */
  private async create(id: string): Promise<void> {
    const row = sessionRow(this.store, id)!, repositoryId = String(row.repository_id), facts: GateFacts = JSON.parse(String(row.facts)), plan: GatePlan = JSON.parse(String(row.plan));
    const back = (code: string, detail: string) => { say(this.store, id, 'system', detail); updateSession(this.store, id, { state: 'ready', error: code, detail }); };
    const rendered = filesFor(facts, mergeQueueOf(row, facts) as 'enabled' | 'disabled', plan);
    if ('problem' in rendered) return back(rendered.code, rendered.problem);
    const { target, files } = rendered;
    let source: ReturnType<GateOnboarding['source']>;
    try { source = this.source(repositoryId); }
    catch (error) { if (error instanceof Blocked) return back(error.code, error.detail); throw error; }
    const { full, app } = source;
    try {
      const installation = await this.installation(app, `/repos/${full}/installation`);
      if (!installation) return back('repository_not_found', 'GitHub App 没有安装到该仓库');
      const gap = this.permissionGap(installation, gatePermissions.source);
      if (gap) return back(gap.code, gap.detail);
      const token = await this.token(app, installation, gatePermissions.source, { repository_ids: [Number(repositoryId)] });
      // Every file is written from what the conversation saw: if the default branch changed it since, nothing is written.
      for (const item of files) {
        if (await this.file(full, item.path, token) !== item.previous)
          return back('gate_file_changed', `默认分支上的 ${item.path} 在这一轮读取之后有变化，不会覆盖它。请再发一条消息让 agent 按最新的仓库内容调整，或重新开始。`);
      }
      const writes: { path: string; content: string }[] = files.map(({ path, content }) => ({ path, content }));
      if (!facts.existing.gate_script && await this.file(full, 'scripts/gate/gate.mjs', token) === null) {
        const templateToken = await this.templateToken(app, token);
        if (templateToken === null) return back('template_app_not_installed', `读取模板仓库 ${this.templateRepo} 被拒绝，需要把同一个 GitHub App 安装到该仓库`);
        const gateScript = await this.file(this.templateRepo, 'scripts/gate/gate.mjs', templateToken);
        if (!gateScript) return back('template_unavailable', '读取 CI-workflow 的 scripts/gate/gate.mjs 失败');
        writes.push({ path: 'scripts/gate/gate.mjs', content: gateScript });
      }
      const ref = await this.request('GET', `/repos/${full}/git/ref/heads/${encodeURIComponent(target.defaultBranch)}`, token);
      const sha = ref?.object?.sha;
      if (!sha) return back('base_branch_unavailable', '读不到默认分支的提交');
      const branch = `bot/gate-onboarding-${id.slice(0, 8)}`;
      try { await this.request('POST', `/repos/${full}/git/refs`, token, { ref: `refs/heads/${branch}`, sha }); }
      catch (error) { if (!String((error as Error).message).endsWith('422')) throw error; } // An earlier attempt of this session created it.
      for (const item of writes) await this.put(full, item.path, item.content, branch, token);
      const body = prBody(id, Number(row.revision), facts, plan, target, files, writes.some(item => item.path === 'scripts/gate/gate.mjs') ? this.templateRepo : null);
      const title = facts.existing.ci_gates_json ? 'chore(ci): update CI gates' : 'chore(ci): connect CI gates';
      let pr: any;
      try { pr = await this.request('POST', `/repos/${full}/pulls`, token, { title, head: branch, base: target.defaultBranch, body }); }
      catch (error) {
        if (!String((error as Error).message).endsWith('422')) throw error;
        const open = await this.request('GET', `/repos/${full}/pulls?state=open&head=${encodeURIComponent(`${full.split('/')[0]}:${branch}`)}`, token);
        pr = Array.isArray(open) ? open[0] : null;
      }
      if (!pr?.html_url) return back('pr_failed', '门禁 PR 创建失败');
      say(this.store, id, 'system', `已创建门禁 PR #${pr.number}：${pr.html_url}。合入后门禁生效；PR 上的 Actions 会运行这次确认的命令。`);
      updateSession(this.store, id, { state: 'done', pr_url: String(pr.html_url), error: null, detail: null });
    } catch (error) {
      const failure = (error as Error).message;
      back(failure, `创建门禁 PR 失败：${failure}。可以再次确认重试，会复用同一个分支。`);
    } finally { await this.revoke(app); }
  }
}

/** What the console shows of the files a plan produces: new files whole, changed files also as a diff. */
function targetView(facts: GateFacts | null, plan: GatePlan | null, rendered: { target: GateTarget; files: GateFile[] } | { problem: string; code: string } | null): Json {
  if (!rendered || !facts || !plan) return { target: null, target_problem: null };
  if ('problem' in rendered) return { target: null, target_problem: rendered.problem };
  const { target, files } = rendered;
  return { target_problem: null, target: { workflow_path: target.workflowPath, mode: target.workflowSource === null ? 'create' : 'update',
    events: gateEvents(plan, target), release_workflow: facts.release_workflow ?? { usable: true, reason: '这个 PR 新建', other_triggers: false }, gate_script: facts.existing.gate_script ? 'keep' : 'copy',
    files: files.map(file => ({ path: file.path, mode: file.previous === null ? 'create' : 'update', content: file.content,
      ...(file.previous === null ? {} : { diff: unifiedDiff(file.previous, file.content) }) })) } };
}

/** The facts in a few lines, as the first message of the conversation. */
function factSummary(facts: GateFacts): string {
  const languages = facts.languages.slice(0, 5).map(item => item.name).join('、') || '未识别';
  const workflows = facts.workflows.length ? facts.workflows.map(item => `${item.path.replace('.github/workflows/', '')}（${item.events.join('、') || '无触发'}${item.gate_job ? '，运行门禁' : ''}）`).join('、') : '没有';
  const queue = { enabled: '已启用', disabled: '未启用', unknown: '无法判断' }[facts.merge_queue.state];
  return [`控制面读取了 ${facts.repository} 默认分支 ${facts.default_branch}（${facts.head_sha.slice(0, 7)}）上的门禁事实，agent 在项目电脑里检出这个提交继续分析：`,
    `- 语言：${languages}`, `- 已有 workflow：${workflows}`,
    `- merge queue：${queue}（${facts.merge_queue.evidence}）`,
    `- 规则集要求的检查：${facts.required_checks === null ? '读不到' : facts.required_checks.length ? facts.required_checks.join('、') : '没有'}`,
    facts.existing.ci_gates_json ? `- 已接入门禁：.github/ci-gates.json${facts.existing.gate_workflow ? `，门禁 job 在 ${facts.existing.gate_workflow}` : '，但没有找到运行 gate.mjs 的 workflow'}`
      : facts.existing.ci_yml ? '- 已有 .github/workflows/ci.yml：不会覆盖；门禁 job 可以放进新的 ci-gates.yml，也可以并入 ci.yml' : '- 没有 .github/workflows/ci.yml',
    facts.release_workflow ? `- 已有 ${releasePath}：${facts.release_workflow.usable ? '可以用于发版本' : `不能用于发版本（${facts.release_workflow.reason}）`}` : `- 没有 ${releasePath}：门禁 PR 会新建，发版本靠它运行 release lane`,
    ...(facts.open_gate_prs.length ? [`- 已有未合入的门禁 PR：${facts.open_gate_prs.map(item => '#' + item.number).join('、')}，处理它之前不能再开新的门禁 PR`] : [])].join('\n');
}

/** The gate PR description: what was confirmed, what each lane runs, how the merge gate runs, and how releases use it. */
function prBody(id: string, revision: number, facts: GateFacts, plan: GatePlan, target: GateTarget, files: GateFile[], templateRepo: string | null): string {
  const events = gateEvents(plan, target), update = facts.existing.ci_gates_json;
  const lanes = gateLanes.map(lane => {
    // laneTimes says what the lane is for in general; the observe note says how this repository configured it.
    const commands = plan.lanes[lane], observe = plan.observe.includes(lane) && commands.length ? '（observe：失败只记录，不让门禁失败）' : '';
    return `- **${lane}**（${laneTimes[lane]}）：${commands.length ? commands.map(code).join('；') + observe : '未配置'}`;
  }).join('\n');
  const { node, python, go, java } = plan.toolchains;
  const toolchains = [`Node ${node}（运行 gate.mjs）`, python && `Python ${python}`, go && `Go ${go.endsWith('go.mod') ? `（按 ${go}）` : go}`, java && `Java ${java}（Temurin）`].filter(Boolean).join('、');
  const evidence = facts.merge_queue.state === 'unknown' ? '由仓库管理员在接入对话中确认' : facts.merge_queue.evidence;
  const queue = target.mergeQueue === 'enabled'
    ? `仓库默认分支启用了 merge queue（${evidence}）。PR 每次提交或更新时跑 pr-ready；进入队列后，在队列的合并结果上先跑 pr-ready 再跑 pr-merge（merge_group），合入默认分支后不再重复运行。队列里也会报告结果，所以合入后可以把 \`gate\` 设为必需检查。`
    : `仓库默认分支没有启用 merge queue（${evidence}）。PR 每次提交或更新时跑 pr-ready；每次合入默认分支后，在合入结果上先跑 pr-ready 再跑 pr-merge（push），确认多个 PR 合在一起没有互相影响。合入后可以把 \`gate\` 设为 PR 的必需检查；以后启用 merge queue，这道合入门禁会改在队列里运行。`;
  const fileLines = files.map(file => file.path === target.workflowPath
    ? `- \`${file.path}\`：${file.previous === null ? '新增门禁 workflow' : '并入或更新门禁 job，补上缺少的触发事件，其他 job 不变；门禁 job 只在这些事件上运行'}：${events.join('、')}`
    : file.path === '.github/ci-gates.json' ? `- \`.github/ci-gates.json\`：${file.previous === null ? '新增' : '更新'}各 lane 的命令和事件对应关系（events）${file.previous === null ? '' : '，其他配置项保持不变'}`
    : file.previous === null ? `- \`${file.path}\`：版本标签（如 v1.2.3）触发 release lane` : `- \`${file.path}\`：加入只在版本标签上运行 release lane 的 job，原有触发和 job 不变`);
  const release = facts.release_workflow && !facts.release_workflow.usable
    ? `仓库已有的 \`${releasePath}\` 不能用于发版本（${facts.release_workflow.reason}），这个 PR 没有修改它。需要给它加上 \`v*\` 版本标签触发，并运行 \`node scripts/gate/gate.mjs run --lane release\`，发版本才能使用。`
    : '在控制台「发版本」确认版本后，bot 打版本标签，标签触发 `release.yml` 运行 release lane；运行成功后，bot 按已核实的提交和 PR 写发行说明，创建 Release 草稿，由人正式发布。是否发布 PyPI、npm 包或镜像，由仓库开发者写进自己的 Release workflow。';
  return [`按接入门禁对话中确认的第 ${revision} 版方案${update ? '更新' : '接入'} CI-workflow 门禁。方案由 bot 在项目的受控环境里分析仓库后提出，控制面按确认的方案生成文件；检查是否通过以这个 PR 上的 Actions 结果为准。`,
    '', '### Lane 命令', '', lanes, '',
    '空 lane 只表示还没有配置检查，运行时报告 not_applicable，不表示检查通过。需要时在 `.github/ci-gates.json` 里补充命令。门禁检出并报告同一个提交：PR 上是 PR head，不是 GitHub 生成的合并预览。', '',
    '### 合入门禁与 merge queue', '', queue, '',
    '### 发版本', '', release, '',
    '### 运行环境', '', `- 工具链：${toolchains}`, `- 安装依赖：${plan.install.length ? plan.install.map(code).join('；') : '无'}`, '',
    '### 文件', '', ...fileLines,
    ...(templateRepo ? [`- \`scripts/gate/gate.mjs\`：门禁运行器，来自 ${templateRepo}`] : []),
    ...(target.workflowSource !== null && target.workflowPath !== facts.existing.gate_workflow ? ['', `门禁 job 并入了已有的 \`${target.workflowPath}\`，补上的触发事件也会让这个文件里的其他 job 在这些事件上运行；如果不希望这样，可以把门禁 job 移到单独的 workflow 文件。`] : []),
    '', `<!-- dept-bot:gate-onboarding:${id} -->`].join('\n');
}
