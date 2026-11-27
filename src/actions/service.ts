import type { Store, Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { GitHub, renewBeforeMs } from '../github/client.js';
import { stop, TaskError } from '../agent/common.js';
import { actionPages } from '../releases/actions.js';
import { activateActions, recordActionsRun, actionsWorkflowOn } from './storage.js';
import { failedStepOutput } from './classifier.js';
import { requestAnalysis } from './analysis.js';
import { eventTaskActive } from '../tasks/event-adapters.js';
import { actionsConfigurationError } from './safety.js';
import { registeredRedactor } from '../core/redaction.js';

// The scan is the fallback for lost workflow_run deliveries (#1411): runs and attempts a delivery records are processed on the
// next five-second tick, so discovery only needs to come round every ten minutes. A failed round waits as long.
export const scanInterval = 10 * 60_000, scanPageSize = 50;
// Reruns of earlier runs are looked for every 10 minutes among runs created in the last 72 hours.
export const rerunCheckInterval = 10 * 60_000, rerunLookback = 72 * 3600_000;
type Window = { from: number; until: number; page: number };
const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

// A repository's connected client, kept across ticks (#1411). `scan.lease` is the current tick's lease, which its guard checks;
// `installation` is the local revision of the repository's installation when it connected.
type Connected = { github: GitHub; scan: { lease: string }; credentials: unknown; installation: unknown };
// The installation sync and installation webhooks raise this revision when the installation's permissions, event
// subscriptions, scope or target change, so a client connected before such a change is not reused.
const installationRevision = (store: Store, repo: Row) => store.get(`SELECT i.revision FROM installed_repositories r
  JOIN github_installations i ON i.account_id=r.account_id AND i.installation_id=r.installation_id
  WHERE r.account_id=? AND r.repository_id=?`, repo.account_id, repo.id)?.revision ?? null;

export class ActionsFailures {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private closing = false;
  private readonly clients = new Map<string, Connected>();
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com') {}
  start() { this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref(); void this.tick(); }
  async close() { this.closing = true; clearInterval(this.timer); await this.active; await Promise.all([...this.clients.keys()].map(id => this.drop(id))); }
  async tick() {
    if (this.closing) return;
    if (this.active) return this.active;
    this.active = this.work().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async work() {
    const repos = this.store.all('SELECT r.* FROM repositories r JOIN policies p ON p.repository_id=r.id WHERE p.enabled=1 AND p.actions_failures_enabled=1').filter(repo => actionsWorkflowOn(this.store, repo.id));
    // A repository that left Actions failure handling (switched off, project disabled or removed) gives up its token at once.
    const handled = new Set(repos.map(repo => String(repo.id)));
    for (const id of [...this.clients.keys()]) if (!handled.has(id)) await this.drop(id);
    for (const repo of repos) {
      if (this.closing) break;
      if (!this.store.get('SELECT 1 FROM actions_failure_scans WHERE repository_id=?', repo.id)) activateActions(this.store, repo.id);
      const row = this.store.get('SELECT * FROM actions_failure_scans WHERE repository_id=?', repo.id)!;
      if (row.error && row.next_scan > Date.now()) continue;
      if (row.next_scan > Date.now() && row.windows === '[]' && !this.store.get("SELECT 1 FROM actions_failure_attempts WHERE repository_id=? AND state='pending'", repo.id)) continue;
      const lease = randomId();
      if (!this.store.run('UPDATE actions_failure_scans SET lease=?,lease_until=? WHERE repository_id=? AND lease_until<=?', lease, Date.now() + 120_000, repo.id, Date.now()).changes) continue;
      try { await this.repository(repo, lease); }
      catch (error) {
        // A failed round revokes its tokens; the next one connects again.
        await this.drop(repo.id);
        // Stable codes only: HTTP messages and source logs can contain credentials.
        this.store.run('UPDATE actions_failure_scans SET error=?,next_scan=? WHERE repository_id=? AND lease=?', error instanceof TaskError ? error.code : 'actions_processing_failed', Date.now() + scanInterval, repo.id, lease);
      } finally { this.store.run('UPDATE actions_failure_scans SET lease=NULL,lease_until=0 WHERE repository_id=? AND lease=?', repo.id, lease); }
    }
  }
  /**
   * The repository's client for this tick. A connected client is kept while its token has more than renewBeforeMs left and
   * the repository row, its account's credentials and its installation's local revision are unchanged, so a tick sends
   * neither `connect`'s requests (the JWT installation lookup and token, `GET /repositories/:id`) nor a revoke. Otherwise
   * the old tokens are revoked and it connects again. The default branch has no local source: a renamed one is read at the
   * next connect, within the token's life.
   */
  private async client(repo: Row, lease: string): Promise<GitHub> {
    const account = this.store.get('SELECT type,credentials FROM accounts WHERE id=?', repo.account_id);
    const installation = installationRevision(this.store, repo);
    const held = this.clients.get(repo.id);
    if (held) {
      const known = held.github.repository;
      if (known.account_id === repo.account_id && known.owner_id === repo.owner_id && known.full_name === repo.full_name &&
        held.credentials === account?.credentials && held.installation === installation &&
        Date.parse(held.github.expiresAt) - Date.now() > renewBeforeMs) {
        held.scan.lease = lease;
        return held.github;
      }
      await this.drop(repo.id);
    }
    if (account?.type !== 'github_app') stop('actions_app_required');
    const scan = { lease };
    const guard = async () => {
      if (this.closing || !actionsWorkflowOn(this.store, repo.id)) stop('actions_failures_disabled');
      if (!this.store.run('UPDATE actions_failure_scans SET lease_until=? WHERE repository_id=? AND lease=? AND lease_until>?', Date.now() + 120_000, repo.id, scan.lease, Date.now()).changes) stop('actions_lease_lost');
    };
    const github = new GitHub(this.store, repo, registeredRedactor(this.store), guard, this.apiUrl);
    // Kept before connecting, so the token of a connect that fails half-way is revoked with the rest.
    this.clients.set(repo.id, { github, scan, credentials: account!.credentials, installation });
    await github.connect(false, undefined, { contents: 'read', actions: 'read' });
    return github;
  }
  private async drop(id: string) {
    const held = this.clients.get(id);
    if (!held) return;
    this.clients.delete(id);
    await held.github.revokeTokens('actions_failures');
  }
  private async repository(repo: Row, lease: string) {
    const github = await this.client(repo, lease);
    const configuration = actionsConfigurationError(github); if (configuration) stop(configuration);
    this.store.run('UPDATE actions_failure_scans SET error=NULL,configured_at=? WHERE repository_id=? AND lease=?', new Date().toISOString(), repo.id, lease);
    // Poll tracked runs even when discovery no longer returns their original creation window.
    let pendingError: unknown;
    for (const run of this.store.all(`SELECT * FROM actions_failure_runs WHERE repository_id=? AND
      (tracking=1 OR EXISTS(SELECT 1 FROM actions_failure_attempts a WHERE a.repository_id=? AND a.run_id=actions_failure_runs.run_id AND a.state='pending'))`, repo.id, repo.id)) {
      try { await this.processRun(github, run.run_id); }
      catch (error) {
        if (error instanceof TaskError && ['actions_failures_disabled', 'actions_lease_lost', 'github_rate_limited'].includes(error.code)) throw error;
        pendingError ??= error;
      }
    }
    // Keep this scan page in place while allowing other tracked runs to advance.
    if (pendingError) throw pendingError;
    await this.scan(github);
    await this.reconcileReruns(github);
    this.store.run('UPDATE actions_failure_scans SET next_scan=? WHERE repository_id=? AND lease=?', Date.now() + scanInterval, repo.id, lease);
  }
  private async scan(github: GitHub) {
    const id = github.repository.id, state = this.store.get('SELECT * FROM actions_failure_scans WHERE repository_id=?', id)!;
    let windows: Window[] = JSON.parse(state.windows);
    if (!windows.length) {
      // An unfiltered, fixed creation window has stable membership even as runs complete or rerun.
      const until = Math.floor(Date.now() / 1000) - 2;
      windows = [{ from: state.cursor, until, page: 1 }];
      this.store.run('UPDATE actions_failure_scans SET windows=? WHERE repository_id=?', JSON.stringify(windows), id);
    }
    const window = windows[0]!;
    let saved = state.page_data ? JSON.parse(state.page_data) : null;
    if (!saved) {
      const range = encodeURIComponent(timestamp(window.from) + '..' + timestamp(window.until));
      const value = await github.request('GET', github.path(`/actions/runs?created=${range}&per_page=${scanPageSize}&page=${window.page}`));
      if (!Array.isArray(value.workflow_runs) || !Number.isSafeInteger(value.total_count)) stop('actions_scan_incomplete');
      // GitHub caps filtered queries at 1,000 results. Split before consuming any page.
      if (value.total_count > 1000) {
        if (window.from >= window.until) stop('actions_scan_window_overflow');
        const mid = Math.floor((window.from + window.until) / 2);
        windows.splice(0, 1, { from: window.from, until: mid, page: 1 }, { from: mid + 1, until: window.until, page: 1 });
        this.store.run('UPDATE actions_failure_scans SET windows=? WHERE repository_id=?', JSON.stringify(windows), id);
        return;
      }
      if (value.workflow_runs.length < Math.min(scanPageSize, Math.max(0, value.total_count - (window.page - 1) * scanPageSize))) stop('actions_scan_incomplete');
      saved = { runs: value.workflow_runs, index: 0, total: value.total_count };
      this.store.run('UPDATE actions_failure_scans SET page_data=? WHERE repository_id=?', JSON.stringify(saved), id);
    }
    while (saved.index < saved.runs.length) {
      const run = saved.runs[saved.index];
      if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt)) stop('actions_scan_incomplete');
      if (run.status !== 'completed' || Date.parse(run.updated_at) >= Date.parse(state.enabled_at)) {
        recordActionsRun(this.store, id, run);
        await this.processRun(github, run.id);
      }
      saved.index++;
      this.store.run('UPDATE actions_failure_scans SET page_data=? WHERE repository_id=?', JSON.stringify(saved), id);
    }
    if (saved.runs.length === scanPageSize && window.page * scanPageSize < saved.total) window.page++;
    else windows.shift();
    this.store.run('UPDATE actions_failure_scans SET windows=?,page_data=NULL,cursor=? WHERE repository_id=?', JSON.stringify(windows), windows.length ? state.cursor : window.until, id);
  }
  // A rerun keeps its run's creation time, so the creation windows above never return it again. A person's rerun of an
  // earlier, no longer tracked run therefore reaches us only through workflow_run; this finds it when that delivery is
  // lost. Only failed latest attempts not yet recorded are taken, through the same idempotent run + attempt path. GitHub
  // lists at most 1,000 runs per query, newest first; older runs beyond that in the lookback are left to the webhook.
  private async reconcileReruns(github: GitHub) {
    const id = github.repository.id, state = this.store.get('SELECT enabled_at,reconciled_at FROM actions_failure_scans WHERE repository_id=?', id)!;
    if (Date.now() - state.reconciled_at < rerunCheckInterval) return;
    const now = Date.now(), range = encodeURIComponent(timestamp(Math.floor((now - rerunLookback) / 1000)) + '..' + timestamp(Math.floor(now / 1000)));
    for (let page = 1; page <= 10; page++) {
      const value = await github.request('GET', github.path(`/actions/runs?created=${range}&per_page=100&page=${page}`));
      if (!Array.isArray(value.workflow_runs)) stop('actions_scan_incomplete');
      for (const run of value.workflow_runs) {
        if (!Number.isSafeInteger(run.id) || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 2 || run.status !== 'completed' || run.conclusion !== 'failure') continue;
        if (Date.parse(run.updated_at) < Date.parse(state.enabled_at)) continue;
        if (this.store.get('SELECT 1 FROM actions_failure_attempts WHERE repository_id=? AND run_id=? AND attempt=?', id, run.id, run.run_attempt)) continue;
        recordActionsRun(this.store, id, run);
        await this.processRun(github, run.id);
      }
      if (value.workflow_runs.length < 100) break;
    }
    this.store.run('UPDATE actions_failure_scans SET reconciled_at=? WHERE repository_id=?', now, id);
  }
  /**
   * Whether this failure handling takes the run. Returns null when it does not; otherwise `{ tag }`, where `tag` is the
   * version tag the run was started for, or null for a default-branch run. PR-related runs never count. A run that
   * pushing a tag started counts whatever its workflow is called (#1028): GitHub gives such a run event `push` and the tag
   * name in `head_branch`, so that name must be a tag of this repository that names the run's own commit (a branch of
   * that name does not count), and the commit must be on the default branch history. It stays a plain Actions failure:
   * nothing here reads or writes release records.
   */
  private async eligible(github: GitHub, run: any): Promise<{ tag: string | null } | null> {
    if (['pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment'].includes(run.event) || run.pull_requests?.length) return null;
    if (run.head_branch === github.defaultBranch) return { tag: null };
    if (run.event !== 'push' || typeof run.head_branch !== 'string' || !run.head_branch) return null;
    if (await this.tagCommit(github, run.head_branch) !== run.head_sha) return null;
    const comparison = await github.request('GET', github.path(`/compare/${run.head_sha}...${encodeURIComponent(github.defaultBranch)}`));
    return comparison.merge_base_commit?.sha === run.head_sha ? { tag: run.head_branch } : null;
  }
  // The commit a tag names, through annotated tag objects; null when there is no such tag or it names no commit.
  private async tagCommit(github: GitHub, name: string): Promise<string | null> {
    let object = (await github.request('GET', github.path('/git/ref/tags/' + name.split('/').map(encodeURIComponent).join('/')), undefined, true))?.object;
    for (let depth = 0; depth < 8 && object?.type === 'tag' && /^[a-f0-9]{40}$/.test(object.sha); depth++)
      object = (await github.request('GET', github.path('/git/tags/' + object.sha), undefined, true))?.object;
    return object?.type === 'commit' && /^[a-f0-9]{40}$/.test(object.sha) ? object.sha : null;
  }
  async processRun(github: GitHub, runId: number) {
    const id = github.repository.id, live = await github.request('GET', github.path('/actions/runs/' + runId));
    if (live.id !== runId || String(live.repository?.id) !== id || !/^[a-f0-9]{40}$/.test(live.head_sha) || !Number.isSafeInteger(live.run_attempt)) stop('actions_run_identity_changed');
    recordActionsRun(this.store, id, live);
    const budget = this.store.get('SELECT * FROM actions_failure_runs WHERE repository_id=? AND run_id=?', id, runId)!;
    if (budget.head_sha && (budget.head_sha !== live.head_sha || budget.head_branch !== live.head_branch)) stop('actions_rerun_identity_changed');
    const activated = this.store.get('SELECT enabled_at FROM actions_failure_scans WHERE repository_id=?', id)!.enabled_at;
    let analyzing = false;
    for (const attempt of this.store.all("SELECT * FROM actions_failure_attempts WHERE repository_id=? AND run_id=? AND state='pending' ORDER BY attempt", id, runId)) {
      const run = attempt.attempt === live.run_attempt ? live : await github.request('GET', github.path(`/actions/runs/${runId}/attempts/${attempt.attempt}`));
      if (run.id !== runId || run.run_attempt !== attempt.attempt || run.head_sha !== live.head_sha || run.head_branch !== live.head_branch) stop('actions_attempt_identity_changed');
      const finish = () => this.store.run("UPDATE actions_failure_attempts SET state='done' WHERE repository_id=? AND run_id=? AND attempt=?", id, runId, attempt.attempt);
      if (run.status !== 'completed') continue;
      if (!Number.isFinite(Date.parse(run.updated_at))) stop('actions_completion_time_missing');
      const eligible = run.conclusion !== 'failure' || budget.retry_state === 'none' && Date.parse(run.updated_at) < Date.parse(activated) ? null : await this.eligible(github, run);
      if (!eligible) { finish(); continue; }
      const key = `${id}:actions.run_failed:${runId}:${run.run_attempt}`;
      const event = this.store.get('SELECT id,state,decision,reason FROM dispatch_events WHERE event_key=?', key);
      if (event?.state === 'failed') stop('manager_dispatch_failed', 'retry_wait', 'Manager 没能分派这次失败分析，请在项目的事件记录里重试。');
      if (event?.state === 'pending' || event?.state === 'dispatching') { analyzing = true; continue; }
      if (event) {
        const legacy = this.store.get('SELECT status FROM tasks WHERE unique_key=?', `${id}:actions.failures:${runId}:${run.run_attempt}`);
        if (eventTaskActive(legacy)) { analyzing = true; continue; }
        if (event.decision === 'ignore' && !attempt.data) {
          this.store.run('UPDATE actions_failure_attempts SET classification=?,data=? WHERE repository_id=? AND run_id=? AND attempt=?', 'ignored',
            JSON.stringify({ kind: 'ignored', evidence: [], reason: String(event.reason || '') }), id, runId, run.run_attempt);
        }
        finish();
        continue;
      }
      // A pre-upgrade attempt can already have a classification or a pending publication receipt.
      // Keep the evidence without opening a second investigation or resending a write.
      if (attempt.data) { finish(); continue; }
      const jobs = await actionPages(github, github.path(`/actions/runs/${runId}/attempts/${run.run_attempt}/jobs`), 'jobs');
      if (jobs.some(j => j.run_id !== runId || j.run_attempt && j.run_attempt !== run.run_attempt)) stop('actions_jobs_identity_changed');
      const failed = [];
      for (const job of jobs.filter(j => j.conclusion === 'failure')) {
        let log: string | null = null;
        try { log = await github.jobLog(job.id); }
        catch (error) {
          if (error instanceof TaskError && ['actions_failures_disabled', 'actions_lease_lost', 'github_rate_limited'].includes(error.code)) throw error;
        }
        failed.push({ job, output: failedStepOutput(job, log) });
      }
      await github.guard();
      requestAnalysis(this.store, github, run, failed, eligible.tag);
      analyzing = true;
    }
    // An outstanding legacy rerun can still produce a new attempt. Keep tracking it briefly without trying to send it again.
    const awaiting = ['sent', 'sending', 'unknown'].includes(budget.retry_state) && live.run_attempt < budget.expected_attempt
      && Date.now() - budget.retry_at <= 5 * 60_000;
    this.store.run('UPDATE actions_failure_runs SET tracking=? WHERE repository_id=? AND run_id=?', Number(awaiting || analyzing || live.status !== 'completed'), id, runId);
  }
}
