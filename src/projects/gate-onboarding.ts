import { randomId, fail, type Json } from '../core/security.js';
import type { Store, Row } from '../storage/database.js';
import { appJwt, missingPermissions, revokeInstallationToken } from '../github/client.js';
import { selectedModel } from '../agent/model.js';
import { stop, TaskError } from '../agent/common.js';
import { collectFacts, baselinePlan, type GateFacts } from './gate-facts.js';
import { gateFiles, gateEvents, normalizePlan, PlanError, gateLanes, laneTimes, type GateFile, type GatePlan, type GateTarget } from './gate-plan.js';
import { unifiedDiff } from './text-diff.js';
import { gateAgentTurn, type GateMessage } from './gate-agent.js';

/**
 * Gate onboarding as a conversation. Opening it reads repository facts with a read-only token; the project's model (when
 * the project has one) proposes a plan from those facts and answers the person; nothing is written to the repository and
 * no repository script runs until the person confirms a plan revision. Only then does the control plane open the gate PR.
 */
// `connected` only appears on conversations from before existing gates were reviewed instead of left alone.
type State = 'collecting' | 'thinking' | 'ready' | 'creating' | 'done' | 'connected' | 'blocked' | 'failed';
const busyStates = ['collecting', 'thinking', 'creating'];
type Permissions = Record<string, string>;
/** One step's GitHub App credentials; every installation token it mints is revoked when the step ends. */
interface AppSession { appId: string; privateKey: string; issued: string[] }

// Each step mints its own installation token, limited to what it does and to what the installation granted. Review and
// development tokens never ask for workflows, so only the confirmed gate PR can change `.github/workflows/`.
export const gatePermissions = {
  // Facts: files, workflows, rulesets, branch protection status and open gate PRs.
  read: { contents: 'read', pull_requests: 'read', metadata: 'read' },
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

export class GateOnboarding {
  /** Sessions with a step running in this process; a busy state without one was interrupted by a restart. */
  private readonly running = new Set<string>();
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com',
    readonly templateRepo = process.env.BOT_CI_TEMPLATE_REPO || 'agent-CI-Infra/CI-workflow') { this.recover(); }

  // ---- GitHub access -------------------------------------------------------------------------------------------------
  /** An empty token sends the request without credentials (public reads). 404 is null; other failures throw. */
  private async request(method: string, path: string, token: string, body?: unknown): Promise<any | null> {
    let response: Response;
    try {
      response = await fetch(this.apiUrl.replace(/\/$/, '') + path, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Error('github_unavailable'); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('github_http_' + response.status);
    const text = await response.text();
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
  private installation(app: AppSession, path: string): Promise<any | null> { return this.request('GET', path, appJwt(app.appId, app.privateKey)); }
  /** An installation token with the wanted permissions, lowered to what the installation has granted. */
  private async token(app: AppSession, installation: any, wanted: Permissions, scope: Json = {}): Promise<string> {
    const granted = installation?.permissions || {}, permissions: Permissions = {};
    for (const [key, level] of Object.entries(wanted)) if (granted[key]) permissions[key] = granted[key] === 'read' ? 'read' : level;
    const access = await this.request('POST', `/app/installations/${encodeURIComponent(String(installation.id))}/access_tokens`, appJwt(app.appId, app.privateKey), { ...scope, permissions });
    const token = typeof access?.token === 'string' ? access.token : '';
    if (!token) throw new Error('github_token_missing');
    app.issued.push(token); return token;
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
  /** The repository row and its App credentials; only GitHub App installation tokens are used, never a bot account's token. */
  private source(repositoryId: string): { row: Row; full: string; app: AppSession } {
    const row = this.store.get('SELECT * FROM repositories WHERE id=?', repositoryId) || this.store.get('SELECT * FROM installed_repositories WHERE repository_id=? AND installed=1', repositoryId);
    if (!row) throw new Blocked('repository_not_found', '仓库不在安装列表中');
    const account = this.store.get('SELECT * FROM accounts WHERE id=?', String(row.account_id));
    if (account?.type !== 'github_app') throw new Blocked('github_app_required', '门禁接入只使用 GitHub App 安装令牌；这个仓库挂在机器人账号上，需要改为安装 GitHub App');
    const secrets = this.store.secrets.open(account.credentials, `account:${account.id}`);
    if (!secrets.private_key) throw new Blocked('github_credentials_missing', 'GitHub App 账号没有保存私钥');
    return { row, full: String(row.full_name), app: { appId: String(account.app_id), privateKey: String(secrets.private_key), issued: [] } };
  }
  private async revoke(app: AppSession) { await Promise.all(app.issued.splice(0).map(token => revokeInstallationToken(this.apiUrl, token).catch(() => false))); }

  // ---- Sessions ------------------------------------------------------------------------------------------------------
  private row(id: string): Row | undefined { return this.store.get('SELECT * FROM gate_onboarding_sessions WHERE id=?', id); }
  private latestId(repositoryId: string): string | null {
    return this.store.get('SELECT id FROM gate_onboarding_sessions WHERE repository_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', repositoryId)?.id ?? null;
  }
  private update(id: string, changes: Record<string, string | number | null>): void {
    const keys = Object.keys(changes);
    this.store.run(`UPDATE gate_onboarding_sessions SET ${keys.map(key => key + '=?').join(',')},updated_at=? WHERE id=?`, ...keys.map(key => changes[key]!), now(), id);
  }
  private say(id: string, role: GateMessage['role'], content: string): void {
    const row = this.row(id);
    if (!row) return; // Deleting the project removes its conversations, even while a step is finishing.
    const messages: GateMessage[] = JSON.parse(String(row.messages));
    messages.push({ role, content, at: now() });
    this.update(id, { messages: JSON.stringify(messages) });
  }
  private spawn(id: string, step: () => Promise<void>): void {
    this.running.add(id);
    void step().catch(error => {
      try {
        this.say(id, 'system', `这一步意外中断：${(error as Error).message}`);
        this.update(id, { state: this.row(id)?.facts ? 'ready' : 'failed', error: (error as Error).message });
      } catch { /* The store is closing; the next start recovers the busy state. */ }
    }).finally(() => this.running.delete(id));
  }
  /** A restart ends the running steps: a turn or PR attempt can be repeated, reading facts starts over. */
  private recover(): void {
    for (const row of this.store.all(`SELECT id,state,facts FROM gate_onboarding_sessions WHERE state IN (${busyStates.map(() => '?').join(',')})`, ...busyStates)) {
      this.say(String(row.id), 'system', row.state === 'creating' ? '控制面重启，创建 PR 没有完成。再次确认会复用同一个分支继续。'
        : row.state === 'thinking' ? '控制面重启，agent 这一轮没有完成，可以重新发送。' : '控制面重启，读取仓库没有完成，请重新开始。');
      this.update(String(row.id), { state: row.facts ? 'ready' : 'failed', error: 'interrupted' });
    }
  }

  /** Whether the project's model can talk in this conversation; a repository that was never started has no model. */
  private agent(repositoryId: string): { available: boolean; model?: string; reason?: string } {
    if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) return { available: false, reason: '这个仓库还没有启动，没有可用的模型，agent 不能参与对话。' };
    try { return { available: true, model: selectedModel(this.store, repositoryId, 'gate.onboarding').model }; }
    catch (error) { return { available: false, reason: error instanceof TaskError ? error.detail || error.code : (error as Error).message }; }
  }
  private mergeQueue(row: Row, facts: GateFacts): 'enabled' | 'disabled' | 'unknown' {
    return facts.merge_queue.state !== 'unknown' ? facts.merge_queue.state : row.merge_queue === 'enabled' || row.merge_queue === 'disabled' ? row.merge_queue : 'unknown';
  }
  /**
   * Where the gate job can go: the workflow that already runs gate.mjs, or ci.yml / ci-gates.yml, new or existing (release
   * preflight and the gate status look for the gate there). Nothing is overwritten: an existing file gets the gate job merged in.
   */
  private targets(facts: GateFacts): { path: string; mode: 'create' | 'update' }[] {
    const gate = facts.existing.gate_workflow, names = ['.github/workflows/ci.yml', '.github/workflows/ci-gates.yml'];
    const taken = new Set(facts.workflows.map(item => item.path)), readable = facts.workflows.filter(item => !item.error && item.path in facts.sources).map(item => item.path);
    return [...(gate ? [{ path: gate, mode: 'update' as const }] : []),
      ...names.filter(path => !taken.has(path)).map(path => ({ path, mode: 'create' as const })),
      ...names.filter(path => path !== gate && readable.includes(path)).map(path => ({ path, mode: 'update' as const }))];
  }
  /** The default place: the existing gate workflow, else a new ci.yml, else a new ci-gates.yml beside the repository's ci.yml. */
  private defaultWorkflow(facts: GateFacts): string { return this.targets(facts)[0]?.path ?? '.github/workflows/ci.yml'; }
  /** What the files are rendered against; null when the plan names a workflow that is not one of the targets. */
  private target(facts: GateFacts, mergeQueue: 'enabled' | 'disabled', plan: GatePlan): GateTarget | null {
    const path = plan.workflow || this.defaultWorkflow(facts), option = this.targets(facts).find(item => item.path === path);
    if (!option) return null;
    return { defaultBranch: facts.default_branch, mergeQueue, workflowPath: path, workflowSource: option.mode === 'update' ? facts.sources[path]! : null,
      configSource: facts.sources['.github/ci-gates.json'] ?? null, npmLock: facts.lockfiles.includes('package-lock.json'),
      // New gates get the tag-triggered release.yml the console's release flow needs; existing gates only when the release lane has commands.
      releaseWorkflow: !facts.existing.release_yml && (!facts.existing.ci_gates_json || plan.lanes.release.length > 0) };
  }
  /** The files of the gate PR for a plan, or why there are none. */
  private files(facts: GateFacts, mergeQueue: 'enabled' | 'disabled', plan: GatePlan): { target: GateTarget; files: GateFile[] } | { problem: string; code: string } {
    const target = this.target(facts, mergeQueue, plan);
    if (!target) return { code: 'gate_workflow_invalid', problem: `方案里的 workflow ${plan.workflow} 不是可选的位置。` };
    try { return { target, files: gateFiles(plan, target) }; }
    catch (error) { if (error instanceof PlanError) return { code: error.code, problem: error.detail }; throw error; }
  }

  private view(row: Row): Json {
    const facts: GateFacts | null = row.facts ? JSON.parse(String(row.facts)) : null, plan: GatePlan | null = row.plan ? JSON.parse(String(row.plan)) : null;
    const mergeQueue = facts ? this.mergeQueue(row, facts) : 'unknown';
    const rendered = facts && plan && mergeQueue !== 'unknown' ? this.files(facts, mergeQueue, plan) : null;
    const { files: manifests, gate_config: _config, sources: _sources, ...summary } = facts || ({} as any);
    return { id: row.id, repository_id: row.repository_id, state: row.state, busy: this.running.has(String(row.id)),
      latest: this.latestId(String(row.repository_id)) === row.id, messages: JSON.parse(String(row.messages)), plan, revision: Number(row.revision),
      facts: facts ? { ...summary, manifests: Object.keys(manifests || {}) } : null,
      merge_queue: facts ? { state: mergeQueue, evidence: facts.merge_queue.state === 'unknown' ? (row.merge_queue ? '由你在对话中确认' : facts.merge_queue.evidence) : facts.merge_queue.evidence,
        asked: facts.merge_queue.state === 'unknown' } : null,
      agent: this.agent(String(row.repository_id)),
      workflow_options: facts ? this.targets(facts) : [], default_workflow: facts ? this.defaultWorkflow(facts) : null,
      ...targetView(facts, plan, rendered),
      pr_url: row.pr_url || null, error: row.error || null, detail: row.detail || null, created_at: row.created_at, updated_at: row.updated_at };
  }
  /** The files a plan would produce, without saving it: the console previews the person's unsent edits with this. */
  preview(id: string, plan: unknown): Json {
    const row = this.row(id);
    if (!row?.facts) return fail(404, 'gate_onboarding_not_found');
    const facts: GateFacts = JSON.parse(String(row.facts)), mergeQueue = this.mergeQueue(row, facts);
    let normalized: GatePlan;
    try { normalized = normalizePlan(plan); } catch (error) { if (error instanceof PlanError) return fail(400, error.code); throw error; }
    return targetView(facts, normalized, mergeQueue === 'unknown' ? null : this.files(facts, mergeQueue, normalized));
  }
  latest(repositoryId: string): Json | null {
    const id = this.latestId(repositoryId);
    return id ? this.view(this.row(id)!) : null;
  }
  get(id: string): Json | null { const row = this.row(id); return row ? this.view(row) : null; }
  repositoryOf(id: string): string | null { return this.row(id)?.repository_id ?? null; }

  /** Starts a new conversation; an unfinished one of the same repository is superseded and its agent turn stops. */
  start(repositoryId: string): Json {
    if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId) && !this.store.get('SELECT 1 FROM installed_repositories WHERE repository_id=? AND installed=1', repositoryId))
      return fail(404, 'repository_not_found');
    // Two PR attempts for one repository would open two gate PRs.
    const creating = this.store.all("SELECT id FROM gate_onboarding_sessions WHERE repository_id=? AND state='creating'", repositoryId);
    if (creating.some(row => this.running.has(String(row.id)))) return fail(409, 'gate_onboarding_busy');
    const id = randomId(), time = now();
    this.store.run('INSERT INTO gate_onboarding_sessions(id,repository_id,state,messages,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?)', id, repositoryId, 'collecting', '[]', 0, time, time);
    this.spawn(id, () => this.collect(id));
    return this.get(id)!;
  }

  private open(id: string): Row {
    const row = this.row(id);
    if (!row) return fail(404, 'gate_onboarding_not_found');
    if (this.running.has(id)) return fail(409, 'gate_onboarding_busy');
    if (this.latestId(String(row.repository_id)) !== id) return fail(409, 'gate_onboarding_superseded');
    if (row.state !== 'ready') return fail(409, 'gate_onboarding_closed');
    return row;
  }
  /** Saves the person's own edits as a new revision; `revision` must be the one they edited, so a newer plan is never lost. */
  private edit(row: Row, revision: unknown, plan: unknown): Row {
    if (plan === undefined) return row;
    if (revision !== Number(row.revision)) return fail(409, 'gate_plan_changed');
    let normalized: GatePlan;
    try { normalized = normalizePlan(plan); } catch (error) { if (error instanceof PlanError) return fail(400, error.code); throw error; }
    if (JSON.stringify(normalized) === String(row.plan)) return row;
    this.update(String(row.id), { plan: JSON.stringify(normalized), revision: Number(row.revision) + 1 });
    this.say(String(row.id), 'system', `你修改了方案（第 ${Number(row.revision) + 1} 版）。`);
    return this.row(String(row.id))!;
  }

  /** The person's message, with any plan edits they made; the agent answers in the background. */
  message(id: string, content: unknown, revision?: unknown, plan?: unknown): Json {
    if (typeof content !== 'string' || !content.trim()) return fail(400, 'message_required');
    const opened = this.open(id);
    if (!this.agent(String(opened.repository_id)).available) return fail(409, 'gate_agent_unavailable');
    this.edit(opened, revision, plan);
    this.say(id, 'user', content.trim());
    this.update(id, { state: 'thinking', error: null, detail: null });
    this.spawn(id, () => this.turn(id));
    return this.get(id)!;
  }

  /** The person's answer when the facts could not tell whether the default branch uses a merge queue. */
  answerMergeQueue(id: string, answer: unknown): Json {
    const row = this.open(id), facts: GateFacts = JSON.parse(String(row.facts));
    if (facts.merge_queue.state !== 'unknown') return fail(409, 'merge_queue_known');
    if (answer !== 'enabled' && answer !== 'disabled') return fail(400, 'merge_queue_required');
    if (row.merge_queue !== answer) {
      this.update(id, { merge_queue: answer });
      this.say(id, 'system', answer === 'enabled' ? '你确认默认分支启用了 merge queue：门禁在 PR 上和队列里运行，合入后不再重复运行。' : '你确认默认分支没有启用 merge queue：门禁在 PR 上和合入默认分支后运行。');
    }
    return this.get(id)!;
  }

  /** The person confirms a plan revision (with their last edits); the control plane opens the gate PR in the background. */
  confirm(id: string, revision: unknown, plan?: unknown, answer?: unknown): Json {
    let row = this.open(id);
    if (revision !== Number(row.revision)) return fail(409, 'gate_plan_changed');
    const facts: GateFacts = JSON.parse(String(row.facts));
    if (facts.merge_queue.state === 'unknown' && answer !== undefined) this.answerMergeQueue(id, answer);
    const mergeQueue = this.mergeQueue(this.row(id)!, facts);
    if (mergeQueue === 'unknown') return fail(400, 'merge_queue_required');
    // What blocks every plan is checked before the person's edits become a new revision.
    if (facts.open_gate_prs.length) return fail(409, 'gate_pr_open');
    const candidate = plan === undefined ? JSON.parse(String(row.plan)) : (() => { try { return normalizePlan(plan); } catch (error) { if (error instanceof PlanError) return fail(400, error.code); throw error; } })();
    const rendered = this.files(facts, mergeQueue, candidate);
    if ('problem' in rendered) return fail(409, rendered.code);
    // A plan equal to what the repository already has would open an empty PR.
    if (!rendered.files.length) return fail(409, 'gate_no_changes');
    row = this.edit(this.row(id)!, revision, plan);
    this.say(id, 'system', `已确认第 ${row.revision} 版方案，正在创建门禁 PR。`);
    this.update(id, { state: 'creating', error: null, detail: null });
    this.spawn(id, () => this.create(id));
    return this.get(id)!;
  }

  // ---- Steps ---------------------------------------------------------------------------------------------------------
  private async collect(id: string): Promise<void> {
    const repositoryId = String(this.row(id)!.repository_id);
    let source: ReturnType<GateOnboarding['source']>;
    try { source = this.source(repositoryId); }
    catch (error) { if (error instanceof Blocked) return this.close(id, 'blocked', error.code, error.detail); throw error; }
    let facts: GateFacts;
    try {
      const installation = await this.installation(source.app, `/repos/${source.full}/installation`);
      if (!installation) return this.close(id, 'blocked', 'repository_not_found', 'GitHub App 没有安装到该仓库');
      const token = await this.token(source.app, installation, gatePermissions.read, { repository_ids: [Number(repositoryId)] });
      facts = await collectFacts({ get: path => this.request('GET', path, token), graphql: (query, variables) => this.request('POST', '/graphql', token, { query, variables }) }, source.full);
    } catch (error) {
      const code = (error as Error).message;
      if (code === 'repository_empty') return this.close(id, 'blocked', code, '仓库还没有任何提交，先推送代码再接入门禁');
      if (code === 'repository_not_found') return this.close(id, 'blocked', code, '没有该仓库的访问权限');
      return this.close(id, 'failed', code, `读取仓库失败：${code}`);
    } finally { await this.revoke(source.app); }
    this.update(id, { facts: JSON.stringify(facts), plan: JSON.stringify(baselinePlan(facts)), revision: 1 });
    this.say(id, 'system', factSummary(facts));
    // A repository that already has gates is reviewed from its own configuration; nothing changes unless someone changes the plan.
    if (facts.existing.ci_gates_json) this.say(id, 'system', `仓库已经接入门禁。右侧方案就是当前的 .github/ci-gates.json${facts.existing.gate_workflow ? ` 和 ${facts.existing.gate_workflow} 里的门禁 job` : ''}；按建议修改并确认后，才会开一个更新门禁的 PR，确认前可以在「预览将提交的文件」里看到改动。`);
    const agent = this.agent(repositoryId);
    if (!agent.available) {
      this.say(id, 'system', `${agent.reason} 右侧是${facts.existing.ci_gates_json ? '仓库当前的门禁配置' : '只按仓库文件中确定的命令整理的初步方案'}，不确定的命令没有填入${facts.questions.length ? '，需要你补充：\n- ' + facts.questions.join('\n- ') : '。'}\n可以直接修改右侧方案，确认后才会创建门禁 PR。`);
      return this.update(id, { state: 'ready' });
    }
    this.update(id, { state: 'thinking' });
    await this.turn(id);
  }

  private async turn(id: string): Promise<void> {
    const row = this.row(id)!, repositoryId = String(row.repository_id), facts: GateFacts = JSON.parse(String(row.facts));
    const repository = this.store.get('SELECT * FROM repositories WHERE id=?', repositoryId);
    // A newer conversation of this repository, or a repository that is no longer started, ends this turn.
    const guard = async () => {
      if (this.latestId(repositoryId) !== id) stop('gate_session_superseded', 'cancelled', '已经开始了新的接入对话。');
      if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', repositoryId)) stop('gate_repository_stopped', 'cancelled', '仓库已经停止或删除。');
    };
    try {
      if (!repository) stop('gate_repository_stopped', 'cancelled', '这个仓库还没有启动，没有可用的模型。');
      const model = selectedModel(this.store, repositoryId, 'gate.onboarding'), messages: GateMessage[] = JSON.parse(String(row.messages));
      const result = await gateAgentTurn({ store: this.store, repository: repository!, model, apiUrl: this.apiUrl, guard, id, turn: messages.filter(item => item.role === 'user').length,
        facts, plan: JSON.parse(String(row.plan)), mergeQueue: this.mergeQueue(row, facts), messages, targets: this.targets(facts) });
      this.say(id, 'agent', result.reply);
      const current = this.row(id)!;
      if (result.plan && JSON.stringify(result.plan) !== String(current.plan)) this.update(id, { plan: JSON.stringify(result.plan), revision: Number(current.revision) + 1 });
    } catch (error) {
      if (!(error instanceof TaskError)) throw error;
      this.say(id, 'system', `agent 没有完成这一轮：${error.detail || error.code}`);
      this.update(id, { error: error.code });
    }
    this.update(id, { state: 'ready' });
  }

  private close(id: string, state: State, error: string | null, detail: string): void {
    this.say(id, 'system', detail);
    this.update(id, { state, error, detail });
  }

  /** Opens the gate PR for the confirmed plan. A failure returns to the conversation, and confirming again reuses the branch. */
  private async create(id: string): Promise<void> {
    const row = this.row(id)!, repositoryId = String(row.repository_id), facts: GateFacts = JSON.parse(String(row.facts)), plan: GatePlan = JSON.parse(String(row.plan));
    const back = (code: string, detail: string) => { this.say(id, 'system', detail); this.update(id, { state: 'ready', error: code, detail }); };
    const rendered = this.files(facts, this.mergeQueue(row, facts) as 'enabled' | 'disabled', plan);
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
          return back('gate_file_changed', `默认分支上的 ${item.path} 在对话开始后有变化，不会覆盖它。请重新开始，让方案按最新的仓库内容调整。`);
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
      this.say(id, 'system', `已创建门禁 PR #${pr.number}：${pr.html_url}。合入后门禁生效；PR 上的 Actions 会运行这次确认的命令。`);
      this.update(id, { state: 'done', pr_url: String(pr.html_url), error: null, detail: null });
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
    events: gateEvents(plan, target), release_workflow: target.releaseWorkflow, gate_script: facts.existing.gate_script ? 'keep' : 'copy',
    files: files.map(file => ({ path: file.path, mode: file.previous === null ? 'create' : 'update', content: file.content,
      ...(file.previous === null ? {} : { diff: unifiedDiff(file.previous, file.content) }) })) } };
}

/** The facts in a few lines, as the first message of the conversation. */
function factSummary(facts: GateFacts): string {
  const languages = facts.languages.slice(0, 5).map(item => item.name).join('、') || '未识别';
  const workflows = facts.workflows.length ? facts.workflows.map(item => `${item.path.replace('.github/workflows/', '')}（${item.events.join('、') || '无触发'}${item.gate_job ? '，运行门禁' : ''}）`).join('、') : '没有';
  const queue = { enabled: '已启用', disabled: '未启用', unknown: '无法判断' }[facts.merge_queue.state];
  return [`已只读查看 ${facts.repository} 的默认分支 ${facts.default_branch}（${facts.head_sha.slice(0, 7)}）：`,
    `- 语言：${languages}`, `- 已有 workflow：${workflows}`,
    `- 构建与依赖文件：${Object.keys(facts.files).join('、') || '没有找到'}${facts.lockfiles.length ? `；锁文件：${facts.lockfiles.join('、')}` : ''}`,
    `- merge queue：${queue}（${facts.merge_queue.evidence}）`,
    `- 规则集要求的检查：${facts.required_checks === null ? '读不到' : facts.required_checks.length ? facts.required_checks.join('、') : '没有'}`,
    facts.existing.ci_gates_json ? `- 已接入门禁：.github/ci-gates.json${facts.existing.gate_workflow ? `，门禁 job 在 ${facts.existing.gate_workflow}` : '，但没有找到运行 gate.mjs 的 workflow'}`
      : facts.existing.ci_yml ? '- 已有 .github/workflows/ci.yml：不会覆盖；门禁 job 可以放进新的 ci-gates.yml，也可以并入已有 workflow' : '- 没有 .github/workflows/ci.yml',
    ...(facts.open_gate_prs.length ? [`- 已有未合入的门禁 PR：${facts.open_gate_prs.map(item => '#' + item.number).join('、')}，处理它之前不能再开新的门禁 PR`] : [])].join('\n');
}

/** The gate PR description: what was confirmed, what each lane runs, and how the gate runs around a merge queue. */
function prBody(id: string, revision: number, facts: GateFacts, plan: GatePlan, target: GateTarget, files: GateFile[], templateRepo: string | null): string {
  const events = gateEvents(plan, target), update = facts.existing.ci_gates_json;
  const lanes = gateLanes.map(lane => {
    const commands = plan.lanes[lane], observe = plan.observe.includes(lane) && commands.length ? '，失败只记录（observe）' : '';
    const when = lane === 'build' && target.mergeQueue === 'enabled' ? 'PR 每次更新时和进入 merge queue 后跑，确认代码能构建' : laneTimes[lane];
    return `- **${lane}**（${when}${observe}）：${commands.length ? commands.map(code).join('；') : '未配置'}`;
  }).join('\n');
  const { node, python, go, java } = plan.toolchains;
  const toolchains = [`Node ${node}（运行 gate.mjs）`, python && `Python ${python}`, go && `Go ${go === 'go.mod' ? '（按 go.mod）' : go}`, java && `Java ${java}（Temurin）`].filter(Boolean).join('、');
  const evidence = facts.merge_queue.state === 'unknown' ? '由仓库管理员在接入对话中确认' : facts.merge_queue.evidence;
  const queue = target.mergeQueue === 'enabled'
    ? `仓库默认分支启用了 merge queue（${evidence}）。门禁在 PR 上（pull_request：build、pr-ready，报告 PR head 提交而不是 GitHub 的合并提交）和队列里（merge_group：build、pr-merge）运行，合入默认分支后不再重复运行。因为队列里也会报告结果，合入后可以把 \`gate\` 设为必需检查。`
    : `仓库默认分支没有启用 merge queue（${evidence}）。门禁在 PR 上（pull_request：build、pr-ready，报告 PR head 提交）和合入默认分支后（push：build）运行；merge_group 触发保留，启用 merge queue 后 pr-merge 会在队列里运行。合入后可以把 \`gate\` 设为必需检查。`;
  const fileLines = files.map(file => file.path === target.workflowPath
    ? `- \`${file.path}\`：${file.previous === null ? '新增门禁 workflow' : '并入或更新门禁 job，补上缺少的触发事件，其他 job 不变；门禁 job 只在这些事件上运行'}：${events.join('、')}`
    : file.path === '.github/ci-gates.json' ? `- \`.github/ci-gates.json\`：${file.previous === null ? '新增' : '更新'}各 lane 的命令${file.previous === null ? '' : '，其他配置项保持不变'}`
    : `- \`${file.path}\`：版本标签（如 v1.2.3）触发 release lane`);
  return [`按接入门禁对话中确认的第 ${revision} 版方案${update ? '更新' : '接入'} CI-workflow 门禁。控制面只根据这份方案生成文件，没有运行其中任何命令；检查是否通过以这个 PR 上的 Actions 结果为准。`,
    '', '### Lane 命令', '', lanes, '',
    '空 lane 只表示还没有配置检查，运行时报告 not_applicable，不表示检查通过。需要时在 `.github/ci-gates.json` 里补充命令。', '',
    '### merge queue', '', queue, '',
    '### 运行环境', '', `- 工具链：${toolchains}`, `- 安装依赖：${plan.install.length ? plan.install.map(code).join('；') : '无'}`, '',
    '### 文件', '', ...fileLines,
    ...(templateRepo ? [`- \`scripts/gate/gate.mjs\`：门禁运行器，来自 ${templateRepo}`] : []),
    ...(target.workflowSource !== null && target.workflowPath !== facts.existing.gate_workflow ? ['', `门禁 job 并入了已有的 \`${target.workflowPath}\`，补上的触发事件也会让这个文件里的其他 job 在这些事件上运行；如果不希望这样，可以把门禁 job 移到单独的 workflow 文件。`] : []),
    '', '控制面只提供门禁框架，并在人工确认版本后打标签；是否发布 PyPI、npm 包或镜像，由仓库开发者写进自己的 Release workflow。',
    '', `<!-- dept-bot:gate-onboarding:${id} -->`].join('\n');
}
