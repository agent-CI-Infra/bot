import type { Store, Row } from '../storage/database.js';
import { savedWrites, writeCatalog, writeOptions, workType } from './catalog.js';
import { parseSections, ruleOverrides, withSection, escapeSectionBody, eventFilters, type WorkSetting } from './settings.js';
import { section } from './catalog.js';

/**
 * One-time upgrade from workflows (#207). For every project it moves what its workflows configured into the Manager and
 * the project configuration, keeps the old rows and the report in manager_migrations (the audit record), writes revision 1
 * of the Manager prompt, and finally drops the workflows table. It runs inside the store's start-up, in one transaction,
 * and only while that table still exists, so it happens exactly once.
 *
 * - prompts: console rule overrides become the review, development, labels and guide sections; console prompts of CI
 *   observation, release notes, Actions failure handling and gate onboarding become their sections; custom workflows
 *   become subsections of the reply section, with their triggers and writes written out.
 * - switches and writes: per work type in policies.work_settings (Actions failures keeps its policy switch).
 * - models: built-in workflows already used task_models; a custom workflow's model becomes the reply model.
 * - triggers: the union of the enabled workflows' triggers becomes the event filters; when they differed from the default
 *   flow, the dispatch section lists which workflow each event used to start, so the Manager keeps doing that.
 */
const builtinTriggers: Record<string, string[]> = {
  'review.issue': ['issue.opened', 'issue.updated', 'issue.labeled', 'comment.mention'],
  'review.pr': ['pull_request.opened', 'pull_request.synchronize', 'pull_request.updated', 'pull_request.labeled', 'comment.mention'],
  'development.issue': ['review.published', 'issue.labeled'], 'development.pr': ['review.published'],
  'release.observe': ['release.manual'], 'release.notes': ['release.manual'], 'actions.failures': ['actions.run_failed'], 'gate.onboarding': ['gate.manual']
};
const customTriggers = ['issue.opened', 'issue.updated', 'issue.labeled', 'pull_request.opened', 'pull_request.synchronize', 'pull_request.updated', 'pull_request.labeled', 'comment.mention'];
const labelTriggers = new Set(['issue.labeled', 'pull_request.labeled']);
const triggerTitles: Record<string, string> = { 'issue.opened': 'Issue 打开', 'issue.updated': 'Issue 标题或正文修改、有可信评论', 'issue.labeled': '有人给 Issue 加上标签',
  'pull_request.opened': 'PR 打开或 Ready for review', 'pull_request.synchronize': 'PR 推送新提交', 'pull_request.updated': 'PR 修改、讨论、检视或回复检视',
  'pull_request.labeled': '有人给 PR 加上标签', 'comment.mention': '评论提到 bot', 'review.published': '检视发布结论', 'release.manual': '「发版本」页的操作',
  'actions.run_failed': '默认分支的 Actions 运行失败', 'gate.manual': '「接入门禁」对话' };
const builtinNames: Record<string, string> = { 'review.issue': '检视 Issue', 'review.pr': '检视 PR', 'development.issue': '开发 Issue', 'development.pr': '跟进 bot PR',
  'release.observe': 'CI 观察', 'release.notes': '发行说明', 'actions.failures': 'Actions 失败处理', 'gate.onboarding': '接入门禁' };
type Trigger = { id: string; label?: string };
const parse = (text: unknown): Trigger[] | null => {
  if (text == null) return null;
  try { const value = JSON.parse(String(text)); return Array.isArray(value) ? value.filter((t: any) => t && typeof t.id === 'string') : null; } catch { return null; }
};
// The trigger list a workflow ran with, read exactly as src/workflows/resolve.ts did before #207.
function legacyTriggers(id: string, row: Row | undefined, policy: Row): Trigger[] {
  const custom = id.startsWith('custom.'), allowed = new Set(custom ? customTriggers : builtinTriggers[id] ?? []);
  const saved = custom ? parse(row?.triggers) : parse(row?.trigger_list);
  if (saved) return saved.filter(trigger => allowed.has(trigger.id));
  const on = (key: string) => !!policy[key];
  if (id === 'review.issue') return [...(on('review_issues') ? [{ id: 'issue.opened' }, { id: 'comment.mention' }] : []), ...(on('review_issues') && on('review_issue_updates') ? [{ id: 'issue.updated' }] : [])];
  if (id === 'review.pr') return [...(on('review_pull_requests') ? [{ id: 'pull_request.opened' }, { id: 'comment.mention' }] : []), ...(on('review_pr_updates') ? [{ id: 'pull_request.synchronize' }] : []),
    ...(on('review_pull_requests') && on('review_pr_discussion') ? [{ id: 'pull_request.updated' }] : [])];
  return (builtinTriggers[id] ?? []).filter(trigger => id.startsWith('development.') || !labelTriggers.has(trigger)).map(trigger => ({ id: trigger }));
}
const legacyEnabled = (id: string, row: Row | undefined, policy: Row) => id === 'actions.failures' ? !!policy.actions_failures_enabled : id.startsWith('custom.') ? !!row?.enabled : row ? !!row.enabled : true;
const legacyWrites = (row: Row | undefined, id: string) => { let value: any = null; try { value = JSON.parse(String(row?.permissions ?? 'null')); } catch { value = null; } return savedWrites(value?.writes, id); };
// The event types a trigger stands for; a mention is the Issue's or the pull request's, after what the workflow handled.
const eventsOf = (trigger: string, side: 'issue' | 'pr' | 'any') => trigger === 'comment.mention'
  ? side === 'issue' ? ['issue.mention'] : side === 'pr' ? ['pull_request.mention'] : ['issue.mention', 'pull_request.mention'] : [trigger];
const writeTitles = (writes: string[]) => writes.map(id => writeCatalog.find(write => write.id === id)?.title ?? id).join('、') || '无';

export function migrateWorkflows(store: Store) {
  if (!store.hasTable('workflows') || !store.hasTable('policies')) return;
  const policyColumns = new Set(store.all('PRAGMA table_info(policies)').map(row => String(row.name)));
  store.transaction(() => {
    for (const policy of store.all('SELECT * FROM policies')) {
      const repositoryId = String(policy.repository_id);
      if (store.get('SELECT 1 FROM manager_migrations WHERE repository_id=?', repositoryId)) continue;
      const rows = store.all('SELECT * FROM workflows WHERE repository_id=? ORDER BY created_at,id', repositoryId), row = (id: string) => rows.find(entry => entry.id === id);
      const customs = rows.filter(entry => String(entry.id).startsWith('custom.')), warnings: string[] = [];
      const overrides = policyColumns.has('rule_overrides') ? JSON.parse(String(policy.rule_overrides || '{}')) : {};
      const taskModels = JSON.parse(String(policy.task_models || '{}'));
      // What each workflow ran on, for every enabled workflow (the project's review/development switches still apply after).
      const ran = new Map<string, Trigger[]>();
      for (const id of Object.keys(builtinTriggers)) if (legacyEnabled(id, row(id), policy)) ran.set(id, legacyTriggers(id, row(id), policy));
      for (const custom of customs) if (custom.enabled) ran.set(String(custom.id), legacyTriggers(String(custom.id), custom, policy));
      const has = (trigger: string, who: (id: string) => boolean) => [...ran].some(([id, list]) => who(id) && list.some(entry => entry.id === trigger));
      const issueSide = (id: string) => id === 'review.issue' || id.startsWith('custom.'), prSide = (id: string) => id === 'review.pr' || id.startsWith('custom.');
      const labels = (trigger: string, who: (id: string) => boolean) => [...new Set([...ran].filter(([id]) => who(id)).flatMap(([, list]) => list.filter(entry => entry.id === trigger && entry.label).map(entry => String(entry.label).trim())))];
      const filters = { 'issue.opened': has('issue.opened', issueSide), 'issue.updated': has('issue.updated', issueSide), 'issue.mention': has('comment.mention', issueSide),
        'issue.labels': labels('issue.labeled', issueSide), 'issue.development_label': has('issue.labeled', id => id === 'development.issue'),
        'pull_request.opened': has('pull_request.opened', prSide), 'pull_request.synchronize': has('pull_request.synchronize', prSide), 'pull_request.updated': has('pull_request.updated', prSide),
        'pull_request.mention': has('comment.mention', prSide), 'pull_request.labels': labels('pull_request.labeled', prSide),
        'review.published.issue': has('review.published', id => id === 'development.issue'), 'review.published.pr': has('review.published', id => id === 'development.pr') };
      // Switches and writes of the built-in work types, only where a workflow row saved them; reply from the custom workflows.
      const work: Record<string, WorkSetting> = {};
      for (const id of Object.keys(builtinTriggers)) {
        const saved = row(id); if (!saved) continue;
        work[id] = { ...(id === 'actions.failures' ? {} : { enabled: !!saved.enabled }), ...(saved.permissions != null ? { writes: legacyWrites(saved, id) } : {}), version: 0 };
        if (saved.name && saved.name !== builtinNames[id]) warnings.push(`内置工作流 ${id} 曾改名为「${saved.name}」；工作类型名称固定为「${workType(id)?.name}」。`);
      }
      // In a customized project each object work type is offered only on the events that used to start it, so the
      // Manager is never offered a review (or a reply) on an event that did not run one before.
      const customized = customs.length > 0 || rows.some(entry => !String(entry.id).startsWith('custom.') && (entry.trigger_list != null || !legacyEnabled(String(entry.id), entry, policy)));
      if (customized) for (const [id, side] of [['review.issue', 'issue'], ['review.pr', 'pr']] as const) if (ran.has(id))
        work[id] = { ...(work[id] ?? {}), events: [...new Set(ran.get(id)!.flatMap(trigger => eventsOf(trigger.id, side)))], version: 0 };
      if (customs.length) {
        const enabled = customs.filter(entry => entry.enabled), source = enabled.length ? enabled : customs;
        const union = [...new Set(source.flatMap(entry => legacyWrites(entry, 'reply')))], writes = writeOptions('reply').map(write => write.id).filter(write => union.includes(write));
        work.reply = { enabled: enabled.length > 0, writes, events: [...new Set(enabled.flatMap(custom => legacyTriggers(String(custom.id), custom, policy).flatMap(trigger => eventsOf(trigger.id, 'any'))))], version: 0 };
        if (source.some(entry => JSON.stringify(legacyWrites(entry, 'reply')) !== JSON.stringify(writes)))
          warnings.push(`自定义工作流的写入不完全相同，「通用回复」取它们的并集：${writeTitles(writes)}。需要更窄时在项目配置里收窄。`);
        const models = [...new Set(source.map(entry => entry.model_id).filter(Boolean).map(String))];
        if (models.length && !Object.hasOwn(taskModels, 'reply')) taskModels.reply = models[0];
        if (models.length > 1) warnings.push(`自定义工作流用了不同的模型（${models.join('、')}），「通用回复」使用 ${models[0]}。`);
      }
      // The Manager prompt: rule overrides and console prompts as sections, custom workflows in the reply section.
      let content = '';
      const escaped = (text: string, where: string) => { if (escapeSectionBody(text) !== text.replace(/\r\n/g, '\n')) warnings.push(`${where} 里有像章节标题的行或未闭合的代码块，迁移时已转义，请检查。`); return text; };
      // A dispatch section only when the old triggers differ from the default flow: then it says which event started what.
      if (customized) {
        const name = (id: string) => id.startsWith('custom.') ? `通用回复「${customs.find(c => c.id === id)?.name ?? id}」` : builtinNames[id] ?? id;
        const table = Object.keys(triggerTitles).map(trigger => {
          const who = [...ran].filter(([, list]) => list.some(entry => entry.id === trigger)).map(([id, list]) => name(id) + (labelTriggers.has(trigger) && !id.startsWith('development.') ? `（标签 ${list.filter(e => e.id === trigger).map(e => e.label).join('、')}）` : ''));
          return `| ${triggerTitles[trigger]} | ${who.join('；') || '不运行'} |`;
        });
        content = withSection(content, 'dispatch', [section('dispatch')!.builtin().replace(/^# .*\n+/, '').trim(), '', `### 本项目升级前的触发配置`, '',
          '升级前，下列事件分别启动这些工作流。默认流程与这张表不一致时，以这张表为准：事件只交给表里列出的工作，「不运行」的事件选择不处理。新建「通用回复」任务时，用 writes 收窄到对应小节写明的迁移前写入。', '',
          '| 事件 | 迁移前运行的工作 |', '| --- | --- |', ...table].join('\n'));
      }
      for (const entry of ['review.issue', 'review.pr', 'development', 'labels', 'guide']) {
        const rule = section(entry)!.rule!; if (Object.hasOwn(overrides, rule)) content = withSection(content, entry, escaped(String(overrides[rule]), rule));
      }
      for (const id of ['release.observe', 'release.notes', 'actions.failures', 'gate.onboarding']) if (row(id)?.prompt != null) content = withSection(content, id, escaped(String(row(id)!.prompt), id));
      if (customs.length) content = withSection(content, 'reply', ['升级前的自定义工作流迁移到这里。Manager 新建「通用回复」任务时，任务按下面对应的小节执行；理由和简要说明写明是哪一节。', '',
        ...customs.flatMap(custom => {
          const triggers = legacyTriggers(String(custom.id), custom, policy).map(trigger => (triggerTitles[trigger.id] ?? trigger.id) + (trigger.label ? `「${trigger.label}」` : '')).join('、') || '无';
          return [`### ${custom.name}（原自定义工作流 \`${custom.id}\`${custom.enabled ? '' : '，迁移时已关闭，不要为它新建任务'}）`, '',
            ...(custom.description ? [`说明：${custom.description}`, ''] : []), `迁移前的触发源：${triggers}。`, `迁移前允许的写入：${writeTitles(legacyWrites(custom, 'reply'))}。`, '',
            escaped(String(custom.prompt ?? '').trim(), String(custom.name)), ''];
        })].join('\n'));
      const now = new Date().toISOString(), saved = JSON.parse(String(policy.event_filters || '{}'));
      for (const key of ['issue.labels', 'issue.development_label', 'pull_request.labels', 'review.published.issue', 'review.published.pr']) saved[key] = (filters as any)[key];
      // Updates and mentions follow their opening switch unless the old trigger lists said otherwise.
      for (const [key, fallback] of [['issue.updated', filters['issue.opened'] && filters['issue.updated']], ['issue.mention', filters['issue.opened']],
        ['pull_request.updated', filters['pull_request.opened'] && filters['pull_request.updated']], ['pull_request.mention', filters['pull_request.opened']]] as const)
        if ((filters as any)[key] !== fallback) saved[key] = (filters as any)[key]; else delete saved[key];
      store.run(`UPDATE policies SET review_issues=?,review_issue_updates=?,review_pull_requests=?,review_pr_updates=?,review_pr_discussion=?,work_settings=?,event_filters=?,task_models=?
        WHERE repository_id=?`, Number(filters['issue.opened']), Number(filters['issue.updated']), Number(filters['pull_request.opened']), Number(filters['pull_request.synchronize']),
        Number(filters['pull_request.updated']), JSON.stringify(work), JSON.stringify(saved), JSON.stringify(taskModels), repositoryId);
      if (policyColumns.has('rule_overrides')) store.run('UPDATE policies SET rule_overrides=? WHERE repository_id=?', JSON.stringify(ruleOverrides(content, overrides)), repositoryId);
      store.run('INSERT INTO manager_revisions VALUES(?,?,?,?,?,?,?,?)', repositoryId, 1, content, JSON.stringify(work), JSON.stringify(eventFilters(store, repositoryId)), 'migration', null, now);
      const report = { manager_revision: 1, sections: [...parseSections(content).sections.keys()], work_settings: work, event_filters: filters,
        models: { reply: taskModels.reply ?? null }, custom_workflows: customs.map(custom => ({ id: custom.id, name: custom.name, enabled: !!custom.enabled })), warnings };
      const archive = { workflows: rows, policy: Object.fromEntries(['review_enabled', 'development_enabled', 'actions_failures_enabled', 'review_issues', 'review_issue_updates', 'review_pull_requests',
        'review_pr_updates', 'review_pr_discussion', 'task_models', 'rule_overrides'].filter(key => policyColumns.has(key)).map(key => [key, policy[key]])) };
      store.run('INSERT INTO manager_migrations VALUES(?,?,?,?)', repositoryId, now, JSON.stringify(archive), JSON.stringify(report));
      store.audit('system', 'manager.migrated', repositoryId, repositoryId);
    }
    store.db.exec('DROP TABLE workflows');
  });
}
