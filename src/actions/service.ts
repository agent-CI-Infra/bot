import { parse } from 'yaml';
import type { Store, Row } from '../storage/database.js';
import { randomId } from '../core/security.js';
import { GitHub, revokeInstallationToken } from '../github/client.js';
import { sha, stop, TaskError } from '../agent/common.js';
import { actionPages } from '../releases/actions.js';
import { activateActions, recordActionsRun, actionsWorkflowOn } from './storage.js';
import { classifyFailure, type Evidence, type FailureKind } from './classifier.js';
import { analysisDecision, analysisTask, classifiedEvidence, failedStepOutput, requestAnalysis, taskVerdicts, taskReports } from './analysis.js';
import { checkReports, type CheckedReport } from './reports.js';
import { publishReport, resumeReports } from './publisher.js';
import { eventTaskActive } from '../work/events.js';
import { workPermissions } from '../work/settings.js';
import { assertManagedExecution } from '../tasks/management.js';
import { taskPermissions } from '../tasks/configuration.js';
import { actionsConfigurationError, actionsRedactor, publicText } from './safety.js';

export const scanInterval = 60_000, scanPageSize = 50;
// Reruns of earlier runs are looked for every 10 minutes among runs created in the last 72 hours.
export const rerunCheckInterval = 10 * 60_000, rerunLookback = 72 * 3600_000;
type Window = { from: number; until: number; page: number };
const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');

export class ActionsFailures {
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private closing = false;
  constructor(readonly store: Store, readonly apiUrl = 'https://api.github.com') {}
  start() { this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref(); void this.tick(); }
  async close() { this.closing = true; clearInterval(this.timer); await this.active; }
  async tick() {
    if (this.closing) return;
    if (this.active) return this.active;
    this.active = this.work().finally(() => { this.active = undefined; });
    return this.active;
  }
  private async work() {
    for (const repo of this.store.all('SELECT r.* FROM repositories r JOIN policies p ON p.repository_id=r.id WHERE p.enabled=1 AND p.actions_failures_enabled=1').filter(repo => actionsWorkflowOn(this.store, repo.id))) {
      if (this.closing) break;
      if (!this.store.get('SELECT 1 FROM actions_failure_scans WHERE repository_id=?', repo.id)) activateActions(this.store, repo.id);
      const row = this.store.get('SELECT * FROM actions_failure_scans WHERE repository_id=?', repo.id)!;
      if (row.error && row.next_scan > Date.now()) continue;
      if (row.next_scan > Date.now() && row.windows === '[]' && !this.store.get("SELECT 1 FROM actions_failure_attempts WHERE repository_id=? AND state='pending'", repo.id)) continue;
      const lease = randomId();
      if (!this.store.run('UPDATE actions_failure_scans SET lease=?,lease_until=? WHERE repository_id=? AND lease_until<=?', lease, Date.now() + 120_000, repo.id, Date.now()).changes) continue;
      try { await this.repository(repo, lease); }
      catch (error) {
        // Stable codes only: HTTP messages and source logs can contain credentials.
        this.store.run('UPDATE actions_failure_scans SET error=?,next_scan=? WHERE repository_id=? AND lease=?', error instanceof TaskError ? error.code : 'actions_processing_failed', Date.now() + scanInterval, repo.id, lease);
      } finally { this.store.run('UPDATE actions_failure_scans SET lease=NULL,lease_until=0 WHERE repository_id=? AND lease=?', repo.id, lease); }
    }
  }
  private async repository(repo: Row, lease: string) {
    const guard = async () => {
      if (this.closing || !actionsWorkflowOn(this.store, repo.id)) stop('actions_failures_disabled');
      if (!this.store.run('UPDATE actions_failure_scans SET lease_until=? WHERE repository_id=? AND lease=? AND lease_until>?', Date.now() + 120_000, repo.id, lease, Date.now()).changes) stop('actions_lease_lost');
    };
    const redactor = actionsRedactor(this.store), github = new GitHub(this.store, repo, redactor, guard, this.apiUrl);
    try {
      if (this.store.get('SELECT type FROM accounts WHERE id=?', repo.account_id)?.type !== 'github_app') stop('actions_app_required');
      await github.connect(false, undefined, { contents: 'read', actions: 'write', issues: 'write' }, false);
      const configuration = actionsConfigurationError(github); if (configuration) stop(configuration);
      this.store.run('UPDATE actions_failure_scans SET error=NULL,configured_at=? WHERE repository_id=? AND lease=?', new Date().toISOString(), repo.id, lease);
      // Poll sent/uncertain reruns even when discovery no longer returns their original creation window.
      let pendingError: unknown;
      for (const run of this.store.all(`SELECT * FROM actions_failure_runs WHERE repository_id=? AND
        (tracking=1 OR EXISTS(SELECT 1 FROM actions_failure_attempts a WHERE a.repository_id=? AND a.run_id=actions_failure_runs.run_id AND a.state='pending'))`, repo.id, repo.id)) {
        try { await this.processRun(github, run.run_id); }
        catch (error) {
          if (error instanceof TaskError && ['actions_failures_disabled', 'actions_lease_lost', 'github_rate_limited'].includes(error.code)) throw error;
          pendingError ??= error;
        }
      }
      // Keep this scan page in place, but do not let one uncertain report strand other tracked reruns.
      if (pendingError) throw pendingError;
      await this.scan(github);
      await this.reconcileReruns(github);
      this.store.run('UPDATE actions_failure_scans SET next_scan=? WHERE repository_id=? AND lease=?', Date.now() + scanInterval, repo.id, lease);
    } finally { if (github.token) await revokeInstallationToken(this.apiUrl, github.token).catch(() => false); }
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
  private async eligible(github: GitHub, run: any) {
    if (['pull_request', 'pull_request_target', 'pull_request_review', 'pull_request_review_comment'].includes(run.event) || run.pull_requests?.length) return false;
    if (run.head_branch === github.defaultBranch) return true;
    // A tag Release can fail on a default-branch commit, but does not gain a dispatch trigger here.
    if (run.name !== 'Release' || run.event !== 'push') return false;
    const comparison = await github.request('GET', github.path(`/compare/${run.head_sha}...${encodeURIComponent(github.defaultBranch)}`));
    return comparison.merge_base_commit?.sha === run.head_sha;
  }
  async processRun(github: GitHub, runId: number) {
    const id = github.repository.id, live = await github.request('GET', github.path('/actions/runs/' + runId));
    if (live.id !== runId || String(live.repository?.id) !== id || !/^[a-f0-9]{40}$/.test(live.head_sha) || !Number.isSafeInteger(live.run_attempt)) stop('actions_run_identity_changed');
    recordActionsRun(this.store, id, live);
    let budget = this.store.get('SELECT * FROM actions_failure_runs WHERE repository_id=? AND run_id=?', id, runId)!;
    if (budget.head_sha && (budget.head_sha !== live.head_sha || budget.head_branch !== live.head_branch)) stop('actions_rerun_identity_changed');
    const activated = this.store.get('SELECT enabled_at FROM actions_failure_scans WHERE repository_id=?', id)!.enabled_at;
    // The work type's writes: without actions_rerun nothing is rerun, without issue nothing is reported. A task the Manager
    // created with fewer writes keeps to those.
    const projectWrites = workPermissions(this.store, id, 'actions.failures').writes;
    let analyzing = false;
    for (const attempt of this.store.all("SELECT * FROM actions_failure_attempts WHERE repository_id=? AND run_id=? AND state='pending' ORDER BY attempt", id, runId)) {
      const run = attempt.attempt === live.run_attempt ? live : await github.request('GET', github.path(`/actions/runs/${runId}/attempts/${attempt.attempt}`));
      if (run.id !== runId || run.run_attempt !== attempt.attempt || run.head_sha !== live.head_sha || run.head_branch !== live.head_branch) stop('actions_attempt_identity_changed');
      const finish = () => this.store.run("UPDATE actions_failure_attempts SET state='done' WHERE repository_id=? AND run_id=? AND attempt=?", id, runId, attempt.attempt);
      if (run.status !== 'completed') continue;
      if (!Number.isFinite(Date.parse(run.updated_at))) stop('actions_completion_time_missing');
      if (run.conclusion !== 'failure' || budget.retry_state === 'none' && Date.parse(run.updated_at) < Date.parse(activated) || !await this.eligible(github, run)) { finish(); continue; }
      let data: { version?: number; kind: FailureKind; evidence: Evidence[]; reports?: CheckedReport[]; summary?: string };
      const task = analysisTask(this.store, id, runId, run.run_attempt);
      if(task)assertManagedExecution(this.store,task);
      // The rerun and the reports are framework deliveries (#381): the work type's writes decide, not the executing role.
      const writes = task ? taskPermissions(this.store, task).writes : projectWrites;
      if (attempt.data) data = JSON.parse(attempt.data);
      else {
        // The analysis runs as a task in the project computer; until it ends, the attempt waits and nothing is written.
        const decision = task ? null : analysisDecision(this.store, id, runId, run.run_attempt);
        if (decision?.state === 'pending') { analyzing = true; continue; }
        // A decision that will not come (the dispatch failed) keeps the run waiting, like a model that cannot be reached.
        if (decision?.state === 'failed') stop('manager_dispatch_failed', 'retry_wait', 'Manager 没能分派这次失败分析，请在项目的事件记录里重试。');
        // The Manager decided this failure needs nothing: record that, rerun nothing and report nothing.
        if (decision?.state === 'declined') {
          this.store.run('UPDATE actions_failure_attempts SET classification=?,data=? WHERE repository_id=? AND run_id=? AND attempt=?', 'ignored',
            JSON.stringify({ kind: 'ignored', evidence: [], reason: decision.reason }), id, runId, run.run_attempt);
          finish(); continue;
        }
        if (task && eventTaskActive(task)) {
          analyzing = true;
          // A model that cannot be reached keeps the run waiting, as the failure status of the whole workflow.
          if (/^model_|^task_models_invalid$/.test(String(task.error_code || ''))) stop(task.error_code, 'retry_wait', '等待模型恢复后继续分析。');
          continue;
        }
        const jobs = await actionPages(github, github.path(`/actions/runs/${runId}/attempts/${run.run_attempt}/jobs`), 'jobs');
        if (jobs.some(j => j.run_id !== runId || j.run_attempt && j.run_attempt !== run.run_attempt)) stop('actions_jobs_identity_changed');
        const failed = jobs.filter(j => j.conclusion === 'failure'), logs: { job: any; log: string | null }[] = [], evidence: Evidence[] = [];
        for (const job of failed) {
          let log: string | null = null;
          try { log = await github.jobLog(job.id); } catch (error) { if (error instanceof TaskError && ['actions_failures_disabled', 'actions_lease_lost', 'github_rate_limited'].includes(error.code)) throw error; }
          logs.push({ job, log });
        }
        // The workflow's agent classifies the failed jobs; the control plane checks what it cites and acts on the result.
        const outputs = logs.map(({ job, log }) => ({ job, output: failedStepOutput(job, log) }));
        // Missing logs still merit investigation of source/artifacts; they never manufacture a public report.
        if (outputs.length && !task) { requestAnalysis(this.store, github, run, outputs); analyzing = true; continue; }
        const verdicts = task ? taskVerdicts(task) : null;
        for (const classified of failed.length ? classifiedEvidence(outputs, verdicts) : []) {
          const job = classified.job;
          // A non-empty excerpt that publicText empties could not be made safe; the report says so instead of "no evidence".
          const quote = publicText(classified.quote, github.redactor).slice(0, 2400), context = classified.context ? publicText(classified.context, github.redactor).slice(-1200) : '';
          // Keep readable reasons in the attempt record; only explicit cause reports are published.
          const reason = publicText(classified.reason, github.redactor).replace(/@/g, '&#64;') || 'The reason could not be made safe for public disclosure.';
          evidence.push({ ...classified, reason, job: { id: job.id, key: sha(String(job.name)), name: publicText(String(job.name), github.redactor).replace(/[\r\n`#<>@]/g, ' ') || 'Failed job' }, quote, context,
            withheld: !!classified.quote && !quote || !!classified.context && !context });
        }
        if (!evidence.length) evidence.push({ job: { name: 'Workflow', id: null }, kind: 'unknown', reason: 'Failed job evidence is unavailable.', quote: '' });
        data = { version: 2, kind: classifyFailure(evidence), evidence, reports: task ? await checkReports(github, run, taskReports(task), outputs) : [],
          summary: task?.status === 'succeeded' ? publicText(String(JSON.parse(task.result || '{}').summary || ''), github.redactor) : 'Analysis did not return a usable result; no report was requested.' };
        this.store.run('UPDATE actions_failure_attempts SET classification=?,data=? WHERE repository_id=? AND run_id=? AND attempt=?', data.kind, JSON.stringify(data), id, runId, run.run_attempt);
      }
      budget = this.store.get('SELECT * FROM actions_failure_runs WHERE repository_id=? AND run_id=?', id, runId)!;
      let reason = '';
      if (data.kind === 'external' && !writes.includes('actions_rerun')) reason = 'This project does not rerun runs automatically.';
      else if (data.kind === 'external') {
        if (budget.retry_state === 'none') {
          // A human may have rerun while we read logs. Never rerun a newer/incomplete attempt on this evidence.
          const current = await github.request('GET', github.path('/actions/runs/' + runId));
          if (current.id !== runId || current.head_sha !== run.head_sha || current.head_branch !== run.head_branch) stop('actions_rerun_identity_changed');
          if (current.run_attempt !== run.run_attempt || current.status !== 'completed') { finish(); continue; }
          if (await this.dispatchSupported(github, run)) {
            this.store.run(`UPDATE actions_failure_runs SET retry_state='sending',before_attempt=?,expected_attempt=?,retry_at=?,head_sha=?,head_branch=?
              WHERE repository_id=? AND run_id=? AND retry_state='none'`, run.run_attempt, run.run_attempt + 1, Date.now(), run.head_sha, run.head_branch, id, runId);
            const previous = github.beforeWrite;
            try {
              github.beforeWrite = () => {
                previous?.();
                if (task) assertManagedExecution(this.store, task);
                if (!(task ? taskPermissions(this.store, task) : workPermissions(this.store, id, 'actions.failures')).writes.includes('actions_rerun')) stop('write_not_allowed');
              };
              await github.request('POST', github.path(`/actions/runs/${runId}/rerun`));
              this.store.run("UPDATE actions_failure_runs SET retry_state='sent' WHERE repository_id=? AND run_id=?", id, runId);
            } catch (error) {
              const uncertain = error instanceof TaskError && error.code === 'github_response_unknown';
              this.store.run('UPDATE actions_failure_runs SET retry_state=? WHERE repository_id=? AND run_id=?', uncertain ? 'unknown' : 'denied', id, runId);
              if (!uncertain && error instanceof TaskError && ['actions_failures_disabled', 'actions_lease_lost'].includes(error.code)) throw error;
            } finally { github.beforeWrite = previous; }
            budget = this.store.get('SELECT * FROM actions_failure_runs WHERE repository_id=? AND run_id=?', id, runId)!;
            // Always reconcile an uncertain send, including the first tick, without another POST.
            if (budget.retry_state === 'unknown') await github.request('GET', github.path('/actions/runs/' + runId));
            if (budget.retry_state !== 'denied') { finish(); continue; }
          } else this.store.run("UPDATE actions_failure_runs SET retry_state='unsupported' WHERE repository_id=? AND run_id=?", id, runId);
          budget = this.store.get('SELECT * FROM actions_failure_runs WHERE repository_id=? AND run_id=?', id, runId)!;
        }
        if (['sent', 'sending', 'unknown'].includes(budget.retry_state) && run.run_attempt < budget.expected_attempt) { finish(); continue; }
        reason = budget.retry_state === 'unsupported' ? 'This workflow does not already support workflow_dispatch; no automatic rerun was sent.'
          : budget.retry_state === 'denied' ? 'The single automatic retry could not be sent with the installation token. No further automatic retry will be attempted.'
          : 'The single automatic retry budget for this original run has already been used. No further automatic retry will be attempted.';
      }
      if (writes.includes('issue')) {
        if (data.version === 2) for (const report of data.reports || []) {
          const before = report.withheld_reason;
          await publishReport(this.store, github, run, report, data.evidence, reason);
          if (report.withheld_reason !== before) this.store.run('UPDATE actions_failure_attempts SET data=? WHERE repository_id=? AND run_id=? AND attempt=?', JSON.stringify(data), id, runId, run.run_attempt);
        }
        // Upgrade recovery honors existing receipts without replaying per-job verdicts as new Issues.
        await resumeReports(this.store, github, run);
      }
      finish();
    }
    budget = this.store.get('SELECT * FROM actions_failure_runs WHERE repository_id=? AND run_id=?', id, runId)!;
    const awaiting = ['sent', 'sending', 'unknown'].includes(budget.retry_state) && live.run_attempt < budget.expected_attempt;
    if (awaiting && Date.now() - budget.retry_at > 5 * 60_000) {
      const attempt = this.store.get('SELECT data FROM actions_failure_attempts WHERE repository_id=? AND run_id=? AND attempt=?', id, runId, budget.before_attempt);
      const source = analysisTask(this.store, id, runId, budget.before_attempt);
      const allowed = source ? taskPermissions(this.store, source).writes : projectWrites;
      if (attempt?.data && allowed.includes('issue')) {
        const saved = JSON.parse(attempt.data), original = { ...live, run_attempt: budget.before_attempt };
        if (saved.version === 2) for (const report of saved.reports || []) {
          const before = report.withheld_reason;
          await publishReport(this.store, github, original, report, saved.evidence, 'The single automatic retry request could not be confirmed after querying the original run. It will not be resent; completion is still being monitored.');
          if (report.withheld_reason !== before) this.store.run('UPDATE actions_failure_attempts SET data=? WHERE repository_id=? AND run_id=? AND attempt=?', JSON.stringify(saved), id, runId, budget.before_attempt);
        }
        await resumeReports(this.store, github, original);
      }
    }
    this.store.run('UPDATE actions_failure_runs SET tracking=? WHERE repository_id=? AND run_id=?', Number(awaiting || analyzing || live.status !== 'completed'), id, runId);
  }
  private async dispatchSupported(github: GitHub, run: any): Promise<boolean> {
    const workflow = await github.request('GET', github.path('/actions/workflows/' + run.workflow_id));
    if (typeof workflow.path !== 'string' || !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(workflow.path)) return false;
    // Read the actual original commit: rerun never changes SHA/ref or writes the workflow.
    const file = await github.request('GET', github.path('/contents/' + workflow.path + '?ref=' + run.head_sha), undefined, true);
    if (!file || file.encoding !== 'base64' || typeof file.content !== 'string') return false;
    try { const on = parse(Buffer.from(file.content, 'base64').toString('utf8'))?.on;
      return typeof on === 'string' ? on === 'workflow_dispatch' : Array.isArray(on) ? on.includes('workflow_dispatch') : !!on && Object.hasOwn(on, 'workflow_dispatch');
    } catch { return false; }
  }
}
