import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { sha, stop } from '../agent/common.js';
import { queueWebhook } from '../review/queue.js';
import { assertManagedExecution } from '../tasks/management.js';
import { taskPermissions } from '../tasks/configuration.js';
import { projectCeiling, withinCeiling } from '../projects/ceiling.js';
import { analysisTask } from './analysis.js';
import { normalizeSignature, type Evidence } from './classifier.js';
import { registeredRedactor, publicText } from '../core/redaction.js';
import { causeIdentity, type CheckedReport } from './reports.js';

// Kept byte-compatible with historical signatures, for matching an already-published upstream job on this run only.
export const legacySignature = (run: any, evidence: Evidence) => sha(JSON.stringify([String(run.name || 'Workflow'), evidence.job.key || evidence.job.name, normalizeSignature(evidence.quote || evidence.reason)]));
const markerFor = (id: string) => `<!-- dept-bot-actions:${id} -->`;

// Only the receipt may add platform comments. Redact after removing markup so it cannot split a credential.
const publicProse = (value: string, github: GitHub) => publicText(value.replace(/<!--[\s\S]*?(?:-->|$)/g, ''), github.redactor)
  .replace(/<!--/g, '&lt;!--');
const publicTitle = (value: string, github: GitHub) => publicProse(value, github).replace(/[\r\n]/g, ' ').slice(0, 240).trim();

/** A cause owns one outbox entry per attempt; both Issues and follow-ups carry the analysis author's diagnosis. */
export async function publishReport(store: Store, github: GitHub, run: any, report: CheckedReport, evidence: Evidence[]) {
  if (report.withheld_reason) return;
  const signature = 'cause-v2:' + sha(JSON.stringify([run.workflow_id, causeIdentity(report.cause)]));
  const id = sha(JSON.stringify([github.repository.id, run.id, run.run_attempt, signature]));
  const prose = publicProse(report.diagnosis, github), title = publicTitle(report.title, github);
  if (!prose.trim() || !title) {
    report.withheld_reason = 'The report has no publishable title or body.';
    return;
  }
  const body = prose + '\n\n' + markerFor(id);
  // GitHub bounds Issue/comment bodies. Never quietly clip a diagnosis or send a truncated report.
  if (body.length > 65_536) {
    report.withheld_reason = 'Report exceeds GitHub\'s 65,536-character body limit. The complete investigation is retained; no truncated report was published.';
    return;
  }
  // Pending pre-upgrade reports can still use their original diagnosis. Sent and uncertain receipts stay frozen.
  store.run(`INSERT INTO actions_failure_reports(id,repository_id,run_id,attempt,signature,classification,body,title,cause,workflow_id) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET body=excluded.body,title=excluded.title
    WHERE actions_failure_reports.state='pending' AND instr(actions_failure_reports.body,'<!-- dept-bot-actions-log-start -->')>0`,
    id, github.repository.id, run.id, run.run_attempt, signature, report.kind, body, title, publicText(report.cause, github.redactor), run.workflow_id);
  // An upgrade must not create a new Issue for the upstream job of an already-reported cause. Claim a legacy receipt
  // only on this run, with matching evidence and classification; a receipt already claimed by another cause is excluded.
  const primary = evidence.find(e => e.job.id === report.job_ids[0]);
  const legacy = primary?.quote ? legacySignature(run, primary) : null;
  await deliverReport(store, github, run, store.get('SELECT * FROM actions_failure_reports WHERE id=?', id)!, legacy);
}

/** Resume only existing historical outbox entries. Old verdicts and implicit unknowns never generate new reports. */
export async function resumeReports(store: Store, github: GitHub, run: any) {
  for (const row of store.all("SELECT * FROM actions_failure_reports WHERE repository_id=? AND run_id=? AND attempt=? AND state!='sent'", github.repository.id, run.id, run.run_attempt))
    await deliverReport(store, github, run, row);
}

async function deliverReport(store: Store, github: GitHub, run: any, row: Row, legacy?: string | null) {
  if (row.state === 'sent') return;
  const id = github.repository.id, key = row.id, marker = markerFor(key);
  const issues = await github.pages(github.path('/issues?state=all&sort=created&direction=desc'));
  const isReceipt = (post: any) => String(post.user?.id) === github.actorId && String(post.body).includes(marker);
  let issue = issues.find(i => !i.pull_request && isReceipt(i));
  if (!issue && row.issue_number) {
    const comments = await github.pages(github.path(`/issues/${row.issue_number}/comments`));
    if (comments.some(isReceipt)) issue = issues.find(i => i.number === row.issue_number);
  }
  if (!issue && ['sending', 'unknown'].includes(row.state)) stop('actions_report_write_unknown');
  if (!issue) {
    const matching = store.all(`SELECT number FROM actions_failure_issues WHERE repository_id=? AND signature=?
      UNION SELECT issue_number AS number FROM actions_failure_reports WHERE repository_id=? AND signature=? AND state='sent'`, id, row.signature, id, row.signature);
    if (legacy) matching.push(...store.all(`SELECT issue_number AS number FROM actions_failure_reports old WHERE repository_id=? AND run_id=? AND signature=? AND classification=? AND state='sent'
      AND NOT EXISTS(SELECT 1 FROM actions_failure_reports newer WHERE newer.repository_id=old.repository_id AND newer.issue_number=old.issue_number AND newer.signature LIKE 'cause-v2:%' AND newer.signature!=?)`, id, run.id, legacy, row.classification, row.signature));
    issue = issues.find(i => i.state === 'open' && !i.pull_request && matching.some(m => m.number === i.number));
    if (issue) store.run('UPDATE actions_failure_reports SET issue_number=? WHERE id=?', issue.number, key);
    store.run("UPDATE actions_failure_reports SET state='sending' WHERE id=?", key);
    const previous = github.beforeWrite;
    try {
      // Recover old pending receipts from their frozen text. The legacy log appendix is never public prose.
      const prose = String(row.body).split('<!-- dept-bot-actions-log-start -->')[0]!.replace(/(?:\n\n)?<!-- dept-bot-actions:[^>]* -->$/, '');
      const payload = { body: '', ...(issue ? {} : { title: '' }) };
      // GitHub invokes this after its asynchronous guard and token refresh, including on a retried request.
      github.beforeWrite = () => {
        previous?.();
        const source = analysisTask(store, id, run.id, run.run_attempt);
        if (String(row.signature).startsWith('cause-v2:') && source?.status !== 'succeeded') stop('actions_analysis_not_succeeded');
        if (source) assertManagedExecution(store, source);
        const allowedWrites = source ? taskPermissions(store, source).writes : withinCeiling(projectCeiling(store, id), ['actions_rerun', 'issue']);
        if (!allowedWrites.includes('issue')) stop('write_not_allowed');
        registeredRedactor(store, github.redactor);
        const safe = publicProse(prose, github), title = publicTitle(row.title, github);
        if (!safe.trim() || !title) stop('actions_report_sensitive');
        payload.body = safe + '\n\n' + marker;
        if (!issue) payload.title = title;
        store.run('UPDATE actions_failure_reports SET body=?,title=? WHERE id=?', payload.body, title, key);
      };
      if (issue) await github.request('POST', github.path(`/issues/${issue.number}/comments`), payload);
      else issue = await github.request('POST', github.path('/issues'), payload);
    } catch (error) {
      store.run('UPDATE actions_failure_reports SET state=? WHERE id=?', (error as any)?.code === 'github_response_unknown' ? 'unknown' : 'pending', key);
      throw error;
    } finally { github.beforeWrite = previous; }
  }
  if (!Number.isSafeInteger(issue?.number)) stop('actions_report_identity_missing');
  store.transaction(() => {
    store.run("UPDATE actions_failure_reports SET state='sent',issue_number=? WHERE id=?", issue.number, key);
    store.run(`INSERT INTO actions_failure_issues(repository_id,number,signature,classification) VALUES(?,?,?,?)
      ON CONFLICT(repository_id,number) DO UPDATE SET classification=CASE WHEN classification=excluded.classification THEN classification ELSE 'unknown' END`, id, issue.number, row.signature, row.classification);
    queueWebhook(store, id, 'issues', { action: 'opened', issue }, 'actions-' + key);
  });
}
