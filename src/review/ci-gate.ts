import { type Store, type Row } from '../storage/database.js';
import { randomId, type Json } from '../core/security.js';
import { recordEvent, type EventInput } from '../dispatch/store.js';
import { GitHub } from '../github/client.js';
import { Redactor } from '../agent/common.js';

const headShaOf = (value: unknown) => /^[a-f0-9]{40}$/.test(String(value || '')) ? String(value) : null;

/** Default wait for required checks; matches this repository's merge-queue check timeout. */
export const CI_REVIEW_TIMEOUT_MS = 60 * 60 * 1000;
/** When a branch lists no required checks, wait this long for any check to appear before treating the SHA as having no CI. */
export const CI_REVIEW_GRACE_MS = 2 * 60 * 1000;

export type CheckLike = { name: string; status: string; conclusion?: string | null; started_at?: string | null; completed_at?: string | null; id?: number | null };
export type StatusLike = { context: string; state: string; updated_at?: string | null };
export type CiGateResult =
  | { state: 'waiting'; pending: string[] }
  | { state: 'ready'; checks: string[] }
  | { state: 'failed'; failed: { name: string; conclusion: string }[]; pending?: string[] }
  | { state: 'timed_out'; pending: string[] };

const green = new Set(['success', 'neutral', 'skipped']);
const failedConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

function latestByName(checks: CheckLike[], statuses: StatusLike[] = []): Map<string, { name: string; completed: boolean; green: boolean; conclusion: string; at: number }> {
  const map = new Map<string, { name: string; completed: boolean; green: boolean; conclusion: string; at: number }>();
  const take = (name: string, completed: boolean, ok: boolean, conclusion: string, at: number) => {
    const key = name.toLowerCase(), previous = map.get(key);
    if (!previous || at >= previous.at) map.set(key, { name, completed, green: ok, conclusion, at });
  };
  for (const check of checks) {
    const name = String(check.name || '').trim();
    if (!name) continue;
    const completed = check.status === 'completed';
    const conclusion = String(check.conclusion || '');
    const at = Date.parse(String(check.completed_at || check.started_at || '')) || Number(check.id) || 0;
    take(name, completed, completed && green.has(conclusion), completed ? conclusion : 'pending', at);
  }
  for (const status of statuses) {
    const name = String(status.context || '').trim();
    if (!name) continue;
    const state = String(status.state || '');
    const completed = state !== 'pending';
    const conclusion = state === 'success' ? 'success' : state === 'pending' ? 'pending' : 'failure';
    const at = Date.parse(String(status.updated_at || '')) || 0;
    take(name, completed, state === 'success', conclusion, at);
  }
  return map;
}

/** Decide whether a pull-request head is ready for an automatic review. */
export function evaluateCiGate(input: {
  required: string[];
  checks: CheckLike[];
  statuses?: StatusLike[];
  now: number;
  waitingSince: number;
  timeoutMs?: number;
  graceMs?: number;
}): CiGateResult {
  const timeoutMs = input.timeoutMs ?? CI_REVIEW_TIMEOUT_MS, graceMs = input.graceMs ?? CI_REVIEW_GRACE_MS;
  const latest = latestByName(input.checks, input.statuses);
  const required = [...new Set(input.required.map(name => name.trim()).filter(Boolean))];
  const names = required.length ? required : [...latest.values()].map(item => item.name);
  const pending: string[] = [], failed: { name: string; conclusion: string }[] = [], passed: string[] = [];
  for (const name of names) {
    const item = latest.get(name.toLowerCase());
    if (!item || !item.completed) pending.push(name);
    else if (item.green) passed.push(item.name);
    else if (failedConclusions.has(item.conclusion) || !item.green) failed.push({ name: item.name, conclusion: item.conclusion || 'failure' });
  }
  if (failed.length) return { state: 'failed', failed, ...(pending.length ? { pending } : {}) };
  if (!required.length && !latest.size) {
    if (input.now - input.waitingSince < graceMs) return { state: 'waiting', pending: [] };
    return { state: 'ready', checks: [] };
  }
  if (pending.length) {
    if (input.now - input.waitingSince >= timeoutMs) return { state: 'timed_out', pending };
    return { state: 'waiting', pending };
  }
  return { state: 'ready', checks: passed };
}

export function ciEventSha(event: string, payload: any): string | null {
  const raw = event === 'check_run' ? payload?.check_run?.head_sha
    : event === 'check_suite' ? payload?.check_suite?.head_sha
    : event === 'workflow_run' ? payload?.workflow_run?.head_sha
    : event === 'status' ? payload?.sha
    : null;
  return headShaOf(raw);
}

let wake: (() => void) | null = null;
export const onPrReviewCiWait = (callback: (() => void) | null) => { wake = callback; };
export function kickPrReviewCiWaits() { queueMicrotask(() => wake?.()); }

export function ciReviewGateStorage(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS pr_review_ci_waits(
    id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,number INTEGER NOT NULL,head_sha TEXT NOT NULL,event_type TEXT NOT NULL,
    event TEXT NOT NULL,delivery_id TEXT,state TEXT NOT NULL,waiting_since INTEGER NOT NULL,last_checked_at INTEGER,detail TEXT,
    comment_url TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(repository_id,number,head_sha));
    CREATE INDEX IF NOT EXISTS pr_review_ci_waits_due ON pr_review_ci_waits(state,waiting_since);
    CREATE INDEX IF NOT EXISTS pr_review_ci_waits_repository ON pr_review_ci_waits(repository_id,number);`);
}

export function holdPrReviewForCi(store: Store, input: EventInput, now = Date.now()): void {
  ciReviewGateStorage(store);
  const number = Number(input.object?.number);
  const eventHead = typeof (input.options[0]?.spec as any)?.head === 'string' ? headShaOf((input.options[0]!.spec as any).head) : null;
  const headSha = eventHead || headShaOf((input.facts as any)?.object?.head);
  if (input.object?.type !== 'pr' || !Number.isSafeInteger(number) || number < 1 || !headSha) return;
  const existing = store.get('SELECT id,state FROM pr_review_ci_waits WHERE repository_id=? AND number=? AND head_sha=?', input.repositoryId, number, headSha);
  const clock = new Date(now).toISOString();
  for (const older of store.all("SELECT id FROM pr_review_ci_waits WHERE repository_id=? AND number=? AND head_sha<>? AND state='waiting'", input.repositoryId, number, headSha))
    store.run("UPDATE pr_review_ci_waits SET state='superseded',updated_at=? WHERE id=?", clock, older.id);
  if (existing) {
    if (existing.state === 'waiting') store.run('UPDATE pr_review_ci_waits SET event=?,event_type=?,delivery_id=?,updated_at=? WHERE id=?',
      JSON.stringify(input), input.type, input.delivery ?? null, clock, existing.id);
    return;
  }
  store.run(`INSERT INTO pr_review_ci_waits(id,repository_id,number,head_sha,event_type,event,delivery_id,state,waiting_since,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,'waiting',?,?,?)`, randomId(), input.repositoryId, number, headSha, input.type, JSON.stringify(input), input.delivery ?? null, now, clock, clock);
}

export function cancelPrReviewCiWaits(store: Store, repositoryId: string, number: number, now = Date.now()): void {
  if (!store.hasTable('pr_review_ci_waits')) return;
  store.run("UPDATE pr_review_ci_waits SET state='cancelled',updated_at=? WHERE repository_id=? AND number=? AND state='waiting'",
    new Date(now).toISOString(), repositoryId, number);
}

export function skipComment(language: 'zh' | 'en', result: Extract<CiGateResult, { state: 'failed' | 'timed_out' }>, timeoutMs = CI_REVIEW_TIMEOUT_MS): string {
  const minutes = Math.max(1, Math.round(timeoutMs / 60000));
  if (result.state === 'failed') {
    const list = result.failed.map(item => `${item.name}: ${item.conclusion}`).join(language === 'en' ? ', ' : '、');
    return language === 'en'
      ? `Required checks on this head did not pass (${list}). Automatic review is skipped until a new head finishes CI successfully.`
      : `这条提交的必需检查未通过（${list}），本次不开始自动检视。推送新提交并在检查通过后再检视。`;
  }
  const pending = result.pending.length ? (language === 'en' ? result.pending.join(', ') : result.pending.join('、')) : (language === 'en' ? 'required checks' : '必需检查');
  return language === 'en'
    ? `Timed out after ${minutes} minutes waiting for checks on this head (still pending: ${pending}). Automatic review is skipped until a new head finishes CI successfully.`
    : `等待这条提交的检查已超过 ${minutes} 分钟（仍未完成：${pending}），本次不开始自动检视。推送新提交并在检查通过后再检视。`;
}

export function commentMarker(waitId: string) { return `<!-- dept-bot:ci-gate:${waitId} -->`; }

export function applyPrReviewCiResult(store: Store, wait: Row, result: CiGateResult, now = Date.now(), language: 'zh' | 'en' = 'zh'): { created: number; comment: { body: string; number: number; repositoryId: string; marker: string } | null } {
  ciReviewGateStorage(store);
  if (wait.state !== 'waiting') return { created: 0, comment: null };
  const clock = new Date(now).toISOString();
  store.run('UPDATE pr_review_ci_waits SET last_checked_at=?,detail=?,updated_at=? WHERE id=?', now, JSON.stringify(result), clock, wait.id);
  if (result.state === 'waiting') return { created: 0, comment: null };
  if (result.state === 'ready') {
    let created = 0;
    try { created = recordEvent(store, JSON.parse(String(wait.event)) as EventInput); } catch { created = 0; }
    store.run("UPDATE pr_review_ci_waits SET state='released',updated_at=? WHERE id=?", clock, wait.id);
    return { created, comment: null };
  }
  store.run("UPDATE pr_review_ci_waits SET state=? WHERE id=?", result.state, wait.id);
  if (wait.comment_url) return { created: 0, comment: null };
  return { created: 0, comment: { body: skipComment(language, result) + '\n\n' + commentMarker(String(wait.id)), number: Number(wait.number), repositoryId: String(wait.repository_id), marker: commentMarker(String(wait.id)) } };
}

/** Test helper and worker entry: evaluate every waiting row with `decide`. */
export function advancePrReviewCiWaits(store: Store, decide: (wait: Row) => CiGateResult, now = Date.now(), languageFor = (_wait: Row): 'zh' | 'en' => 'zh'): { created: number; comments: { body: string; number: number; repositoryId: string; marker: string; waitId: string }[] } {
  ciReviewGateStorage(store);
  let created = 0;
  const comments: { body: string; number: number; repositoryId: string; marker: string; waitId: string }[] = [];
  for (const wait of store.all("SELECT * FROM pr_review_ci_waits WHERE state='waiting' ORDER BY waiting_since,id")) {
    const applied = applyPrReviewCiResult(store, wait, decide(wait), now, languageFor(wait));
    created += applied.created;
    if (applied.comment) comments.push({ ...applied.comment, waitId: String(wait.id) });
  }
  return { created, comments };
}

export function requiredCheckNames(rules: any[] | null | undefined, protection?: { contexts?: string[] } | null): string[] {
  const fromRules = (rules || []).filter((rule: any) => rule?.type === 'required_status_checks')
    .flatMap((rule: any) => (rule.parameters?.required_status_checks || []).map((check: any) => String(check?.context || ''))).filter(Boolean);
  const fromProtection = Array.isArray(protection?.contexts) ? protection!.contexts!.map(String).filter(Boolean) : [];
  return [...new Set([...fromRules, ...fromProtection])];
}

export async function loadPrCiSnapshot(github: GitHub, head: string, baseBranch: string): Promise<{ required: string[]; checks: CheckLike[]; statuses: StatusLike[] }> {
  let rules: any[] | null = null;
  try {
    const value = await github.request('GET', github.path('/rules/branches/' + encodeURIComponent(baseBranch)), undefined, true);
    rules = Array.isArray(value) ? value : null;
  } catch { rules = null; }
  let protection: { contexts?: string[] } | null = null;
  try {
    const value = await github.request('GET', github.path('/branches/' + encodeURIComponent(baseBranch) + '/protection/required_status_checks'), undefined, true);
    if (value && Array.isArray(value.contexts)) protection = { contexts: value.contexts };
  } catch { protection = null; }
  const checks: CheckLike[] = [];
  for (let page = 1; page <= 100; page++) {
    const result = await github.request('GET', github.path(`/commits/${head}/check-runs?filter=latest&per_page=100&page=${page}`), undefined, true);
    const rows = Array.isArray(result?.check_runs) ? result.check_runs : [];
    for (const row of rows) checks.push({ name: String(row.name || ''), status: String(row.status || ''), conclusion: row.conclusion ?? null, started_at: row.started_at ?? null, completed_at: row.completed_at ?? null, id: row.id ?? null });
    if (rows.length < 100) break;
  }
  let statuses: StatusLike[] = [];
  try {
    const value = await github.request('GET', github.path('/commits/' + head + '/status'), undefined, true);
    statuses = Array.isArray(value?.statuses) ? value.statuses.map((row: any) => ({ context: String(row.context || ''), state: String(row.state || ''), updated_at: row.updated_at ?? null })) : [];
  } catch { statuses = []; }
  return { required: requiredCheckNames(rules, protection), checks, statuses };
}

export class PrReviewCiGate {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  constructor(readonly store: Store, readonly githubUrl?: string) {}
  start() {
    onPrReviewCiWait(() => { void this.tick(); });
    this.timer = setInterval(() => { void this.tick(); }, 5000);
    this.timer.unref();
    void this.tick();
  }
  close() { if (this.timer) clearInterval(this.timer); this.timer = undefined; onPrReviewCiWait(null); }
  async tick() {
    if (this.running || !this.store.hasTable('pr_review_ci_waits')) return;
    const waiting = this.store.all("SELECT * FROM pr_review_ci_waits WHERE state='waiting' ORDER BY waiting_since,id LIMIT 20");
    if (!waiting.length) return;
    this.running = true;
    try {
      for (const wait of waiting) {
        const repo = this.store.get('SELECT * FROM repositories WHERE id=?', wait.repository_id);
        if (!repo) { this.store.run("UPDATE pr_review_ci_waits SET state='cancelled',updated_at=? WHERE id=?", new Date().toISOString(), wait.id); continue; }
        const language = this.store.get('SELECT review_language FROM policies WHERE repository_id=?', wait.repository_id)?.review_language === 'en' ? 'en' : 'zh';
        let result: CiGateResult;
        try {
          const github = new GitHub(this.store, repo, new Redactor(), async () => {}, this.githubUrl);
          await github.connect(false, undefined, { checks: 'read', statuses: 'read', pull_requests: 'read', issues: 'write', metadata: 'read' }, false);
          const input = JSON.parse(String(wait.event)) as EventInput;
          const base = String((input.facts as any)?.object?.base || '') || String(repo.default_branch || 'main');
          const snapshot = await loadPrCiSnapshot(github, String(wait.head_sha), base);
          result = evaluateCiGate({ required: snapshot.required, checks: snapshot.checks, statuses: snapshot.statuses, now: Date.now(), waitingSince: Number(wait.waiting_since) });
          const applied = this.store.transaction(() => applyPrReviewCiResult(this.store, this.store.get('SELECT * FROM pr_review_ci_waits WHERE id=?', wait.id)!, result, Date.now(), language));
          if (applied.comment && !this.store.get('SELECT comment_url FROM pr_review_ci_waits WHERE id=?', wait.id)?.comment_url) {
            try {
              const posted = await github.request('POST', github.path(`/issues/${applied.comment.number}/comments`), { body: applied.comment.body });
              this.store.run('UPDATE pr_review_ci_waits SET comment_url=?,updated_at=? WHERE id=?', String(posted?.html_url || posted?.url || 'posted'), new Date().toISOString(), wait.id);
            } catch { /* leave comment_url empty and retry the comment later */ }
          }
        } catch {
          this.store.run("UPDATE pr_review_ci_waits SET last_checked_at=?,updated_at=? WHERE id=? AND state='waiting'", Date.now(), new Date().toISOString(), wait.id);
        }
      }
    } finally { this.running = false; }
  }
}
