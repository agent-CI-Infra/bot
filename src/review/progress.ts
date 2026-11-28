import type { Store, Row } from '../storage/database.js';
import type { GitHub } from '../github/client.js';
import { Redactor, sha, TaskError } from '../agent/common.js';
import { configuredRedactor, publicText, registeredRedactor } from '../core/redaction.js';
import { taskBasis } from '../dispatch/basis.js';
import { developedLabel, developingIssueLabel, hasLabelName, needsHumanIssueLabel } from './labels.js';
import { developingLabel, needsHumanLabel } from '../rules/service.js';
import { reviewLanguage, testEvidence } from '../github/text.js';

/**
 * What an Issue development shows on the Issue while it runs (#1047): the project's developing label (default
 * `bot-developing`) and one status comment. The label is on while the development works and comes off once its pull request
 * exists or it stops without one. An Issue with a published pull request keeps bot-developed. The comment is only edited after creation.
 *
 * The comment holds milestones only: why the development started (the Manager's basis and brief), the analysis and plan and
 * the result, which the development agent submits with report_development_milestone, and how it ended (its pull request,
 * or why it stopped and what a person can do). The control plane renders it from this table and the task's state and writes
 * it to GitHub; a write that fails is retried from the table by the engine's sweep, which also settles developments that
 * ended outside a run (a person cancelled or paused one, the Issue was closed). Nothing here fails the development itself.
 */
export function progressStorage(store: Store) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS issue_development_progress(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    repository_id TEXT NOT NULL,number INTEGER NOT NULL,language TEXT NOT NULL,label TEXT,label_on INTEGER NOT NULL DEFAULT 0,
    needs_human_label TEXT,needs_human_on INTEGER NOT NULL DEFAULT 0,
    comment_id TEXT,posting INTEGER NOT NULL DEFAULT 0,milestones TEXT NOT NULL DEFAULT '{}',body_sha TEXT,settled_status TEXT,
    pending INTEGER NOT NULL DEFAULT 1,final INTEGER NOT NULL DEFAULT 0,failures INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,error TEXT,
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
  const cols = new Set(store.all('PRAGMA table_info(issue_development_progress)').map(r => String(r.name)));
  if (!cols.has('needs_human_label')) store.db.exec('ALTER TABLE issue_development_progress ADD COLUMN needs_human_label TEXT');
  if (!cols.has('needs_human_on')) store.db.exec('ALTER TABLE issue_development_progress ADD COLUMN needs_human_on INTEGER NOT NULL DEFAULT 0');
  store.db.exec('CREATE INDEX IF NOT EXISTS issue_development_progress_open ON issue_development_progress(final,next_at)');
}

/** The tool a development agent reports a milestone with; only an Issue development is offered it. */
export const milestoneToolName = 'report_development_milestone';
const text = { type: 'string' }, list = (description: string) => ({ type: 'array', maxItems: 12, items: text, description });
export const milestoneTool = { type: 'function', function: { name: milestoneToolName,
  description: 'Update the one status comment the control plane keeps on this Issue for your development; the people on the Issue read it to follow '
    + 'your work and correct it early. Report only these milestones, each when it happens: plan, once your analysis is done and before you change '
    + 'code; completed, right before create_pull_request (the control plane adds the pull request link once it exists); stopped, when you stop '
    + 'without a pull request. Reporting a milestone again replaces it. Never report routine status such as "developing" or "running tests". '
    + 'The comment is public: write for the people on the Issue, in the language its title and body are written in, whatever language your brief uses.',
  parameters: { type: 'object', additionalProperties: false, required: ['milestone'], properties: {
    milestone: { type: 'string', enum: ['plan', 'completed', 'stopped'] },
    conclusion: { type: 'string', description: 'plan: what your analysis found, in one to three sentences' },
    decisions: { type: 'array', maxItems: 8, description: 'plan: the design decisions you made on your own, each with its reason',
      items: { type: 'object', additionalProperties: false, required: ['decision', 'reason'], properties: { decision: text, reason: text } } },
    changes: list('plan: the main changes you will make; completed: the key points of the change you made'),
    acceptance: list('plan: how the change will be checked: the tests and criteria'),
    tests: list('completed: the tests you ran and what they showed'),
    reason: { type: 'string', description: 'stopped: background and concrete blocker explaining what was checked and why you stop' },
    options: { type: 'array', maxItems: 5, description: 'stopped: when multiple viable paths exist, list candidate options with one recommended option and pros and cons of each; omit for single-path blockers',
      items: { type: 'object', additionalProperties: false, required: ['option', 'pros', 'cons'], properties: {
        option: text, recommended: { type: 'boolean' }, pros: text, cons: text } } },
    human_action: { type: 'string', description: 'stopped: what a person must decide or do so that the work can go on' } } } } };

const maxText = 1500, maxStopText = 3000, maxItem = 500;
type PublicationValues = Pick<Redactor, 'publicationPattern'>;
const safe = (text: string, limit: number) => {
  text = text.trim();
  return (text.length > limit ? text.slice(0, limit) + '…' : text).replace(/<!--/g, '&lt;!--');
};
// Mask before truncating: an excerpt may cut a private key before its closing delimiter.
const excerpt = (value: unknown, limit: number, redactor: PublicationValues) => safe(publicText(String(value ?? ''), redactor), limit);

/**
 * Checks and keeps a milestone the agent reported. Returns what the agent is told: the recorded milestone, or what to correct.
 * The comment itself is written by settleProgress.
 */
export function reportMilestone(store: Store, taskId: string, args: any): { recorded: true; milestone: string } | { error: string; message: string } {
  const row = store.get('SELECT milestones,language FROM issue_development_progress WHERE task_id=?', taskId);
  if (!row) return { error: 'milestone_unavailable', message: 'This development has no status comment yet; report the milestone again later.' };
  const redactor = configuredRedactor(store);
  const field = (value: unknown, limit: number) => excerpt(value, limit, redactor);
  const strings = (value: unknown) => Array.isArray(value) ? value.filter(v => typeof v === 'string' && v.trim()).slice(0, 12).map(v => field(v, maxItem)) : [];
  const kind = String(args?.milestone ?? ''), invalid = (message: string) => ({ error: 'milestone_invalid', message });
  let value: any;
  if (kind === 'plan') {
    value = { conclusion: field(args.conclusion, maxText), changes: strings(args.changes), acceptance: strings(args.acceptance),
      decisions: (Array.isArray(args.decisions) ? args.decisions : []).filter((d: any) => typeof d?.decision === 'string' && d.decision.trim()).slice(0, 8)
        .map((d: any) => ({ decision: field(d.decision, maxItem), reason: field(d.reason, maxItem) })) };
    if (!value.conclusion || !value.changes.length) return invalid('A plan needs the conclusion of your analysis and the main changes (changes).');
  } else if (kind === 'completed') {
    value = { changes: strings(args.changes), tests: strings(args.tests) };
    if (!value.changes.length || !value.tests.length) return invalid('A completed milestone needs the key points of the change (changes) and the tests you ran (tests).');
  } else if (kind === 'stopped') {
    const options = (Array.isArray(args.options) ? args.options : [])
      .filter((o: any) => typeof o?.option === 'string' && o.option.trim())
      .slice(0, 5)
      .map((o: any) => ({
        option: field(o.option, maxItem),
        recommended: o.recommended === true,
        pros: field(o.pros, maxItem),
        cons: field(o.cons, maxItem),
      }));
    value = { reason: field(args.reason, maxStopText), human_action: field(args.human_action, maxStopText), ...(options.length ? { options } : {}) };
    if (!value.reason) return invalid('A stopped milestone needs the reason.');
  } else return invalid('milestone must be plan, completed or stopped.');
  // The comment has one language, the one its headings use (the Issue's, unless the project sets one): a milestone in the
  // other is sent back once, so the comment does not mix them. Chinese is told by its characters, as for review comments.
  const chinese = /[㐀-鿿]/.test(JSON.stringify(value));
  if (row.language === 'en' && chinese) return { error: 'milestone_language', message: 'This Issue\'s status comment is in English: report the milestone again in English.' };
  if (row.language === 'zh' && !chinese) return { error: 'milestone_language', message: 'This Issue\'s status comment is in Simplified Chinese: report the milestone again in Simplified Chinese.' };
  const milestones = JSON.parse(row.milestones);
  milestones[kind] = { ...value, at: new Date().toISOString() };
  store.run('UPDATE issue_development_progress SET milestones=?,pending=1,next_at=0,updated_at=? WHERE task_id=?', JSON.stringify(milestones), new Date().toISOString(), taskId);
  return { recorded: true, milestone: kind };
}

/**
 * The development of `task` starts or goes on: its row is created the first time, with why it started (the Manager's basis
 * and brief), the label it puts on and the language of the comment. A development that runs again (a person's retry, the
 * label added again) drops how it stopped, so the label goes back on and the comment says it is working again.
 */
export function startProgress(store: Store, task: Row, issue: any, options?: { baseBranch?: string; defaultBranch?: string }) {
  const now = new Date().toISOString(), id = String(task.id);
  const parsedInput = (() => { try { return JSON.parse(task.input || '{}'); } catch { return {}; } })();
  const redactor = configuredRedactor(store);
  const resolvedBaseBranch = String(options?.baseBranch || parsedInput.base_branch || '').trim();
  const resolvedDefaultBranch = String(options?.defaultBranch || parsedInput.default_branch || '').trim();
  const nonDefaultBase = resolvedBaseBranch && resolvedDefaultBranch && resolvedBaseBranch !== resolvedDefaultBranch ? excerpt(resolvedBaseBranch, maxItem, redactor) : null;
  const existing = store.get('SELECT milestones FROM issue_development_progress WHERE task_id=?', id);
  if (existing) {
    const milestones = JSON.parse(existing.milestones);
    delete milestones.stopped;
    if (nonDefaultBase) milestones.start = { ...(milestones.start ?? {}), base_branch: nonDefaultBase };
    else if (resolvedBaseBranch && resolvedDefaultBranch && resolvedBaseBranch === resolvedDefaultBranch && milestones.start?.base_branch) delete milestones.start.base_branch;
    store.run('UPDATE issue_development_progress SET milestones=?,final=0,pending=1,next_at=0,settled_status=NULL,updated_at=? WHERE task_id=?', JSON.stringify(milestones), now, id);
    return;
  }
  const manager = parsedInput.manager;
  const brief = manager?.brief, basis = taskBasis(store, id);
  const setting = store.get('SELECT review_language FROM policies WHERE repository_id=?', task.repository_id)?.review_language;
  const start = { ...(basis ? { basis } : {}), ...(manager?.reason ? { reason: excerpt(manager.reason, maxText, redactor) } : {}),
    ...(nonDefaultBase ? { base_branch: nonDefaultBase } : {}),
    ...(brief?.goal ? { goal: excerpt(brief.goal, maxText * 2, redactor) } : {}), ...(Array.isArray(brief?.criteria) ? { criteria: brief.criteria.slice(0, 12).map((c: unknown) => excerpt(c, maxItem, redactor)) } : {}) };
  const nhLabel = needsHumanLabel(store, task.repository_id) || null;
  const priorNeedsHuman = nhLabel
    ? !!store.get(
        'SELECT 1 FROM issue_development_progress WHERE repository_id=? AND number=? AND needs_human_on=1 AND lower(coalesce(needs_human_label,\'\'))=lower(?) LIMIT 1',
        task.repository_id,
        Number(task.object_number),
        nhLabel,
      )
    : false;
  const nhOn = nhLabel && (hasLabelName(issue?.labels, nhLabel) || priorNeedsHuman) ? 1 : 0;
  store.run(`INSERT INTO issue_development_progress(task_id,repository_id,number,language,label,needs_human_label,needs_human_on,milestones,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO NOTHING`, id, task.repository_id, Number(task.object_number), reviewLanguage(setting, `${issue?.title ?? ''}\n${issue?.body ?? ''}`),
    developingLabel(store, task.repository_id) || null, nhLabel, nhOn, JSON.stringify({ start }), now, now);
}

// Stopped: the development is not working and waits for a person or has ended without a pull request. Ended: it is over.
const stoppedStates = new Set(['failed', 'cancelled', 'superseded', 'waiting_permission', 'waiting_configuration', 'waiting_environment', 'waiting_publication', 'needs_replan', 'needs_help', 'paused']);
const endedStates = new Set(['completed', 'succeeded', 'pr_opened', 'failed', 'cancelled', 'superseded']);
const silentStopCodes = new Set(['object_closed_or_draft', 'obsolete_closed', 'obsolete_superseded', 'obsolete_expired', 'user_cancel', 'manager_cancel', 'bot_pr_closed']);
function needsHumanWhenStopped(task: Row, now: ReturnType<typeof state>): boolean {
  if (!now.stopped) return false;
  if (now.status === 'superseded' || silentStopCodes.has(String(task.error_code ?? ''))) return false;
  return true;
}
/** Where the development is, from the task as the engine left it. */
function state(task: Row) {
  const result = (() => { try { return JSON.parse(task.result || 'null'); } catch { return null; } })(), status = String(task.status);
  const pr = ['pr_opened', 'completed'].includes(status) && result?.pr_url ? { number: Number(result.pr_number), url: String(result.pr_url), updated: status === 'completed', result } : null;
  const unchanged = status === 'completed' && result?.status === 'no_changes';
  const endedWithoutPr = !pr && (status === 'completed' || status === 'succeeded');
  const stopped = !pr && (unchanged || stoppedStates.has(status) || endedStates.has(status));
  return { status, result, pr, unchanged, endedWithoutPr, stopped, ended: endedStates.has(status) };
}

type Language = 'zh' | 'en';
const words = {
  zh: { title: 'bot 开发进展', status: '状态', working: '开发中', opened: (n: number) => `已开出 PR #${n}`, updated: (n: number) => `已更新 PR #${n}`, stopped: '已停止', paused: '已暂停',
    endedNoPr: '已结束（未开出 PR）', ended: '已结束', endedNoPrReason: '任务已正常结束，未开出 PR。', baseBranch: '基线分支',
    basis: '开始依据', goal: '目标', criteria: '验收标准', plan: '分析与计划', conclusion: '结论', decisions: '自动做的决定', changes: '主要改动', acceptance: '验收',
    done: '完成', pr: 'PR', highlights: '修改重点', tests: '测试', stop: '停止', reason: '原因', options: '备选方案', recommended: '推荐', pros: '优点', cons: '缺点', action: '需要人做的',
    footer: 'bot 只在这一条评论里更新这次开发的进展。',
    label: (who: string, label: string) => `${who} 加了开发标签「${label}」`, request: (who: string, url: string | null) => `维护者 ${who} 在${url ? `[评论](${url})` : '评论'}里要求开发`,
    rule: '项目 Manager 提示词里的规则允许 bot 自行开发', own: 'bot 从 Actions 失败提报的 Issue' },
  en: { title: 'Bot development progress', status: 'Status', working: 'In development', opened: (n: number) => `Pull request #${n} opened`, updated: (n: number) => `Pull request #${n} updated`,
    stopped: 'Stopped', paused: 'Paused', endedNoPr: 'Ended (no pull request)', ended: 'Ended', endedNoPrReason: 'The task ended normally without opening a pull request.', baseBranch: 'Base branch',
    basis: 'Started on', goal: 'Goal', criteria: 'Acceptance criteria', plan: 'Analysis and plan', conclusion: 'Conclusion',
    decisions: 'Decisions made on its own', changes: 'Main changes', acceptance: 'Acceptance', done: 'Done', pr: 'Pull request', highlights: 'Key changes', tests: 'Tests',
    stop: 'Stopped', reason: 'Reason', options: 'Candidate options', recommended: 'Recommended', pros: 'Pros', cons: 'Cons', action: 'What a person needs to do', footer: 'The bot reports this development only in this comment.',
    label: (who: string, label: string) => `${who} added the development label "${label}"`, request: (who: string, url: string | null) => `maintainer ${who} asked for it in ${url ? `[a comment](${url})` : 'a comment'}`,
    rule: 'a rule of the project\'s Manager prompt lets the bot develop it on its own', own: 'the bot filed this Issue from an Actions failure' } };

// Why a development stopped when the control plane stopped it, and what a person can do, in the comment's language.
function controlStop(language: Language, status: string, code: string): { reason: string; action?: string } {
  const zh = language === 'zh';
  if (status === 'completed' || status === 'succeeded') return zh ? { reason: words.zh.endedNoPrReason } : { reason: words.en.endedNoPrReason };
  if (status === 'paused') {
    if (code === 'manager_pause') return zh ? { reason: '项目 Manager 暂停了这次开发。', action: '在控制台查看任务或点击「重试」继续。' } : { reason: 'The project Manager paused this development.', action: 'Inspect the task in the console or press Retry to continue.' };
    return zh ? { reason: '有人在控制台暂停了这次开发。', action: '在控制台的任务里点「重试」继续。' } : { reason: 'Someone paused this development in the console.', action: 'Press Retry on the task in the console to continue.' };
  }
  if (code === 'development_not_approved') return zh ? { reason: '开发标签被移除，开发停下。', action: '重新加上开发标签，开发会接着做。' } : { reason: 'The development label was removed, so the development stopped.', action: 'Add the development label again to continue it.' };
  if (code === 'object_closed_or_draft') return zh ? { reason: 'Issue 已关闭，开发取消。' } : { reason: 'The Issue was closed, so the development was cancelled.' };
  if (code === 'user_cancel') return zh ? { reason: '有人在控制台取消了这次开发。' } : { reason: 'Someone cancelled this development in the console.' };
  if (code === 'manager_cancel') return zh ? { reason: '项目 Manager 取消了这次开发（例如已有覆盖该问题的 PR 或不再需要继续）。' } : { reason: 'The project Manager cancelled this development (for example, a covering PR already exists or the work is no longer needed).' };
  if (code === 'bot_pr_closed') return zh ? { reason: '关联的 bot PR 已关闭，开发任务已自动取消。' } : { reason: 'The linked bot pull request was closed, so this development task was cancelled.' };
  if (status === 'superseded' || code === 'obsolete_superseded') return zh ? { reason: '同一 Issue 上更新的开发接手了这项工作。' } : { reason: 'A newer development of this Issue took the work over.' };
  if (status === 'needs_help') return zh ? { reason: `开发遇到需要人帮忙的问题（${code}）。`, action: '在控制台查看这个任务的说明并处理。' } : { reason: `The development needs a person's help (${code}).`, action: 'Read the task in the console and resolve what it names.' };
  if (status === 'waiting_permission') return zh ? { reason: `bot 缺少继续开发所需的权限（${code}）。`, action: '检查 GitHub App 的安装和权限，然后在控制台点「重试」。' } : { reason: `The bot lacks a permission it needs to go on (${code}).`, action: 'Check the GitHub App installation and its permissions, then press Retry in the console.' };
  if (status === 'cancelled') return zh ? { reason: `开发已取消（${code}）。` } : { reason: `The development was cancelled (${code}).` };
  return zh ? { reason: `开发失败（${code}）。`, action: '在控制台查看任务日志，处理后点「重试」。' } : { reason: `The development failed (${code}).`, action: 'Read the task log in the console, fix the cause and press Retry.' };
}

/** The status comment of a development, as it reads for the task's current state. */
export function renderProgress(row: Row, task: Row, redactor: PublicationValues = new Redactor()): string {
  const language: Language = row.language === 'zh' ? 'zh' : 'en', w = words[language], m = JSON.parse(row.milestones || '{}'), now = state(task);
  const taskInput = (() => { try { return JSON.parse(task.input || '{}'); } catch { return {}; } })();
  const colon = language === 'zh' ? '：' : ': ', field = (name: string, value: string) => `**${name}**${colon}${value}`;
  const bullets = (items: string[]) => items.map(item => `- ${item}`).join('\n');
  const parts: string[] = [`### ${w.title}`];
  parts.push(field(w.status, now.pr ? (now.pr.updated ? w.updated(now.pr.number) : w.opened(now.pr.number)) : now.endedWithoutPr ? w.endedNoPr : now.stopped ? (now.status === 'paused' ? w.paused : w.stopped) : w.working));
  const start = m.start ?? {}, basis = start.basis, lines: string[] = [];
  const said = basis?.kind === 'label' ? w.label(`\`${basis.labeled_by}\``, basis.label) : basis?.kind === 'maintainer_request' ? w.request(`\`${basis.author}\``, basis.url)
    : basis?.kind === 'project_rule' ? w.rule : basis?.kind === 'own_issue' ? w.own : null;
  if (said) lines.push(field(w.basis, said + (language === 'zh' && start.reason ? `。${start.reason}` : '')));
  const displayBaseBranch = start.base_branch
    || (typeof taskInput.base_branch === 'string' && typeof taskInput.default_branch === 'string' && taskInput.base_branch.trim() && taskInput.default_branch.trim() && taskInput.base_branch.trim() !== taskInput.default_branch.trim()
      ? excerpt(taskInput.base_branch.trim(), maxItem, redactor)
      : null);
  if (displayBaseBranch) lines.push(field(w.baseBranch, `\`${displayBaseBranch}\``));
  if (start.goal) lines.push(field(w.goal, start.goal));
  if (start.criteria?.length) lines.push(`**${w.criteria}**\n${bullets(start.criteria)}`);
  if (lines.length) parts.push(lines.join('\n\n'));
  if (m.plan) parts.push([`#### ${w.plan}`, field(w.conclusion, m.plan.conclusion), ...(m.plan.decisions?.length ? [`**${w.decisions}**\n${bullets(m.plan.decisions.map((d: any) => d.reason ? `${d.decision}${colon}${d.reason}` : d.decision))}`] : []),
    `**${w.changes}**\n${bullets(m.plan.changes)}`, ...(m.plan.acceptance?.length ? [`**${w.acceptance}**\n${bullets(m.plan.acceptance)}`] : [])].join('\n\n'));
  if (now.pr) {
    // The agent's own account of the change, or else what it said when it published (the pull request summary and tests).
    const highlights = m.completed?.changes ?? [safe(publicText(String(now.pr.result.summary ?? ''), redactor).split(/\n\s*\n/)[0]!, 600)].filter(Boolean);
    const tests = m.completed?.tests ?? (now.pr.result.validation ? publicText(testEvidence(now.pr.result), redactor).split('\n').filter(Boolean).map(line => safe(line, maxItem)) : []);
    parts.push([`#### ${w.done}`, field(w.pr, `[#${now.pr.number}](${now.pr.url})`), ...(highlights.length ? [`**${w.highlights}**\n${bullets(highlights)}`] : []),
      ...(tests.length ? [`**${w.tests}**\n${bullets(tests)}`] : [])].join('\n\n'));
  } else if (now.endedWithoutPr) {
    const summaryText = typeof now.result?.summary === 'string' && now.result.summary.trim() ? excerpt(now.result.summary, maxText, redactor) : null;
    const reason = (typeof m.stopped?.reason === 'string' && m.stopped.reason.trim() ? m.stopped.reason : null) ?? summaryText ?? w.endedNoPrReason;
    const humanAction = typeof m.stopped?.human_action === 'string' && m.stopped.human_action.trim() ? m.stopped.human_action : null;
    parts.push([`#### ${w.ended}`, field(w.reason, reason), ...(humanAction ? [field(w.action, humanAction)] : [])].join('\n\n'));
  } else if (now.stopped) {
    // The agent's reason when it stopped on its own (a milestone, or the summary of an unchanged tree), else the control plane's.
    const own = m.stopped ?? (now.unchanged && now.result?.summary ? { reason: excerpt(now.result.summary, maxStopText, redactor) } : null);
    const told = own ?? controlStop(language, now.status, String(task.error_code ?? now.status));
    const sep = language === 'zh' ? '；' : '; ';
    const formatOption = (o: any) => {
      const badge = o.recommended ? (language === 'zh' ? `（${w.recommended}）` : ` (${w.recommended})`) : '';
      const details = [o.pros ? `${w.pros}${colon}${o.pros}` : '', o.cons ? `${w.cons}${colon}${o.cons}` : ''].filter(Boolean).join(sep);
      return `**${o.option}**${badge}${details ? `${colon}${details}` : ''}`;
    };
    const optionBlock = Array.isArray((told as any).options) && (told as any).options.length
      ? [`**${w.options}**\n${bullets((told as any).options.map(formatOption))}`]
      : [];
    parts.push([`#### ${w.stop}`, field(w.reason, told.reason), ...optionBlock, ...(told.human_action || (told as any).action ? [field(w.action, told.human_action || (told as any).action)] : [])].join('\n\n'));
  }
  parts.push(`<sub>${w.footer}</sub>`, `<!-- dept-bot:development-status:${row.task_id} -->`);
  return publicText(parts.join('\n\n'), redactor);
}

async function addIssueLabel(github: GitHub, number: number, label: typeof developedLabel) {
  if (!await github.request('GET', github.path('/labels/' + encodeURIComponent(label.name)), undefined, true)) {
    await github.request('POST', github.path('/labels'), label).catch(error => {
      // A concurrent development may have created the label after our GET.
      if (!(error instanceof TaskError && error.code === 'github_http_422')) throw error;
    });
  }
  await github.request('POST', github.path(`/issues/${number}/labels`), { labels: [label.name] });
}
// Settling is serialized per development: a run and the sweep never write the same comment at once.
const locks = new Map<string, Promise<unknown>>();
const maxFailures = 12;
/**
 * Brings the Issue in line with the development's state: the label on or off, and the comment created or edited when its
 * text changed. Returns whether the Issue is up to date; a failure is recorded and retried later with growing waits.
 * `github` may be a function that connects a client: it is called only when something has to be written.
 */
export async function settleProgress(store: Store, taskId: string, github: GitHub | (() => Promise<GitHub>)): Promise<boolean> {
  const target = store.get('SELECT repository_id,number FROM issue_development_progress WHERE task_id=?', taskId);
  const lockKey = target ? `issue:${target.repository_id}:${target.number}` : `task:${taskId}`;
  const previous = locks.get(lockKey) ?? Promise.resolve();
  const work = previous.then(() => settle(store, taskId, github), () => settle(store, taskId, github));
  locks.set(lockKey, work); work.finally(() => { if (locks.get(lockKey) === work) locks.delete(lockKey); }).catch(() => {});
  return work;
}
function hasNewerIssueProgress(store: Store, row: Row): boolean {
  return !!store.get(
    `SELECT 1 FROM issue_development_progress
     WHERE repository_id=? AND number=? AND task_id<>?
       AND (created_at>? OR (created_at=? AND rowid>?))
     LIMIT 1`,
    row.repository_id, row.number, row.task_id, row.created_at, row.created_at, row.rowid,
  );
}
async function settle(store: Store, taskId: string, client: GitHub | (() => Promise<GitHub>)): Promise<boolean> {
  const row = store.get('SELECT rowid,* FROM issue_development_progress WHERE task_id=?', taskId), task = store.get('SELECT * FROM tasks WHERE id=?', taskId);
  if (!row || !task) return true;
  const now = state(task), number = Number(row.number);
  // Once a continuous multi-round task enters Round 2+ PR revisions, never mutate or regress the
  // original Issue's labels or status comment once PR opening has been settled (or while non-PR states run).
  const inputRound = (() => { try { return Number(JSON.parse(String(task.input || '{}')).round || 1); } catch { return 1; } })();
  if (inputRound > 1 && (row.settled_status === 'pr_opened' || !now.pr)) return true;
  const supersededByNewer = hasNewerIssueProgress(store, row);
  const wanted = !now.pr && !now.stopped ? developingIssueLabel(String(row.label ?? '')) : null;
  // An older development settling after a newer one started on the same Issue must not remove the newer task's
  // developing label or re-add needs_human_label; the newer row owns the Issue's label state.
  const changeDeveloping = !supersededByNewer && (!!wanted !== !!row.label_on);
  const nhDef = needsHumanIssueLabel(String(row.needs_human_label ?? ''));
  const wantNeedsHuman = !!nhDef && needsHumanWhenStopped(task, now);
  const changeNeedsHuman = !supersededByNewer && !!nhDef && wantNeedsHuman !== !!row.needs_human_on;
  const markDeveloped = !!now.pr && row.settled_status !== now.status;
  const update = (fields: Record<string, unknown>) => store.run(`UPDATE issue_development_progress SET ${Object.keys(fields).map(key => key + '=?').join(',')},updated_at=? WHERE task_id=?`,
    ...Object.values(fields) as any[], new Date().toISOString(), taskId);
  const settled = () => update({ settled_status: now.status, pending: 0, final: now.ended ? 1 : 0, failures: 0, next_at: 0, error: null });
  try {
    if (typeof client === 'function' && !changeDeveloping && !changeNeedsHuman && !markDeveloped && sha(renderProgress(row, task, configuredRedactor(store))) === row.body_sha) {
      settled();
      return true;
    }
    const github = typeof client === 'function' ? await client() : client;
    if (changeDeveloping) {
      if (wanted) await addIssueLabel(github, number, wanted);
      else await github.request('DELETE', github.path(`/issues/${number}/labels/${encodeURIComponent(row.label)}`), undefined, true);
      update({ label_on: wanted ? 1 : 0 });
    }
    if (changeNeedsHuman && nhDef) {
      if (wantNeedsHuman) await addIssueLabel(github, number, nhDef);
      else await github.request('DELETE', github.path(`/issues/${number}/labels/${encodeURIComponent(nhDef.name)}`), undefined, true);
      update({ needs_human_on: wantNeedsHuman ? 1 : 0 });
      if (!wantNeedsHuman) {
        store.run('UPDATE issue_development_progress SET needs_human_on=0 WHERE repository_id=? AND number=? AND task_id<>? AND needs_human_on=1',
          row.repository_id, number, taskId);
      }
    }
    // The PR label and the linked comment can succeed independently. Keep the row pending until both are on GitHub.
    let labelError: unknown;
    if (markDeveloped) {
      try {
        await addIssueLabel(github, number, developedLabel);
        update({ settled_status: now.status, pending: 1 });
      } catch (error) { labelError = error; }
    }
    const redactor = registeredRedactor(store);
    for (const value of github.redactor?.values ?? []) redactor.add(value);
    const body = renderProgress(row, task, redactor), digest = sha(body);
    if (digest !== row.body_sha) {
      const marker = `<!-- dept-bot:development-status:${taskId} -->`;
      let id: string | null = row.comment_id ? String(row.comment_id) : null;
      if (id && !await github.request('PATCH', github.path('/issues/comments/' + id), { body }, true)) id = null;
      else if (id) update({ body_sha: digest });
      if (!id) {
        // A create whose answer was lost may still have made the comment: find it by its marker before creating another.
        const made = row.posting ? (await github.pages(github.path(`/issues/${number}/comments`))).find(c => String(c.user?.id) === github.actorId && String(c.body ?? '').includes(marker)) : null;
        if (made && String(made.body) !== body) await github.request('PATCH', github.path('/issues/comments/' + made.id), { body });
        update({ posting: 1 });
        const created = made ?? await github.request('POST', github.path(`/issues/${number}/comments`), { body });
        update({ comment_id: String(created.id), posting: 0, body_sha: digest });
      }
    }
    if (labelError) throw labelError;
    settled();
    return true;
  } catch (error) {
    deferProgress(store, taskId, error instanceof TaskError ? error.code : 'progress_write_failed');
    return false;
  }
}
/**
 * A write to the Issue failed, or no client could be made for it: try again later, waiting longer each time. A development
 * whose Issue cannot be written for hours is given up; the task itself is not affected.
 */
export function deferProgress(store: Store, taskId: string, code: string) {
  const failures = Number(store.get('SELECT failures FROM issue_development_progress WHERE task_id=?', taskId)?.failures ?? 0) + 1;
  store.run('UPDATE issue_development_progress SET failures=?,error=?,pending=1,next_at=?,final=?,updated_at=? WHERE task_id=?', failures, code,
    Date.now() + Math.min(30_000 * 2 ** (failures - 1), 3600_000), failures >= maxFailures ? 1 : 0, new Date().toISOString(), taskId);
}

/** The developments whose Issue is behind their state: a write to retry, or a state the sweep has not settled yet. */
export function dueProgress(store: Store, now = Date.now()): { task_id: string; repository_id: string }[] {
  return store.all(`SELECT p.task_id,p.repository_id FROM issue_development_progress p JOIN tasks t ON t.id=p.task_id
    WHERE p.final=0 AND p.next_at<=? AND (p.pending=1 OR p.settled_status IS NULL OR p.settled_status<>t.status) ORDER BY p.repository_id,p.updated_at LIMIT 50`, now) as any;
}
