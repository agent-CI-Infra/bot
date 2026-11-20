import type { Store } from '../storage/database.js';
import { covers, ceilingTitles, projectCeiling, type Ceiling } from './ceiling.js';
import { eventFilters, type EventFilters } from '../dispatch/settings.js';
import { roleConfiguration } from '../roles/definition.js';
import { bindingLevel, bindingPermissions, scopeProjects, type BindingLevel } from '../channels/service-bindings.js';
import { scheduledCheck } from '../dispatch/schedule.js';
import { githubReadScopes, type RolePermissions } from '../roles/permissions.js';

/**
 * What the bot can do in a project right now (#1123): the six scenarios of the built-in Manager prompt, each projected from
 * settings that already exist — the capability ceiling, the event switches, the enabled roles, the Feishu groups bound to
 * the project with their level, and the project's scheduled checks. Nothing is stored; the projection is read again on
 * every call, so lowering the ceiling or switching an event shows at once. chatCapabilities() narrows the same states
 * for a single chat (a Feishu group's items, or a GitHub thread).
 *
 * States: ready — on, and the events or requests that start it reach the bot; mention_only — on, but only a mention or
 * request starts it (its automatic events are switched off); ceiling_limited — started, but the ceiling (or the chat's
 * level) is below what it needs; off — nothing starts it, or the role that does it is disabled.
 */
export type CapabilityState = 'ready' | 'mention_only' | 'ceiling_limited' | 'off';
export const capabilityStateTitles: Record<CapabilityState, string> = { ready: '已开启', mention_only: '仅提及触发', ceiling_limited: '受能力上限约束', off: '未开启' };
export type ScenarioId = 'qa' | 'triage' | 'review' | 'development' | 'testing' | 'ci';
export const scenarioTitles: Record<ScenarioId, string> = {
  qa: '代码仓问答与调研', triage: 'Issue/PR 日常管理', review: 'Issue/PR 检视',
  development: '特性开发与缺陷修复', testing: '分支/PR 自主测试', ci: 'CI 失败与定时主动发现',
};
/** The settings page each fact is changed on, as console addresses. */
export type SettingKey = 'triggers' | 'roles' | 'groups' | 'schedules' | 'manager';

export interface CapabilityInputs {
  enabled: boolean;
  ceiling: Ceiling;
  events: EventFilters;
  /** Whether "@bot" mentions are recognized at all (BOT_MENTION_NAMES=off turns them off). */
  mentions: boolean;
  roles: string[];
  /** Enabled Feishu groups bound to the project, by level (for display; custom is any set of items). */
  groups: Partial<Record<BindingLevel, number>>;
  /** The same groups counted by what their items allow (#1156 review): reading the repository, writing Issues or pull
   * requests, creating tasks. Without it, the preset levels stand for their items and custom groups count for nothing. */
  groupGates?: GroupGates;
  /** Active scheduled checks of the project. */
  schedules: number;
}
export interface Capability {
  id: ScenarioId; title: string; state: CapabilityState; state_title: string;
  /** The ceiling the scenario needs to act on GitHub (answering in a Feishu group needs none). */
  needs: Ceiling;
  /** One or two sentences: what starts it now and what holds it back. */
  detail: string;
  /** Where to change what decides the state, first the one that matters most now. */
  settings: SettingKey[];
}

export interface GroupGates { questions: number; write: number; dispatch: number }
const presetGates = (groups: CapabilityInputs['groups']): GroupGates => ({
  questions: groupCount(groups, ['read', 'comment', 'dispatch']), write: groupCount(groups, ['comment', 'dispatch']), dispatch: groupCount(groups, ['dispatch']) });
const scenarioNeeds: Record<ScenarioId, Ceiling> = { qa: 'comment', triage: 'comment', review: 'comment', development: 'develop', testing: 'comment', ci: 'comment' };
const roleTitles: Record<string, string> = { reviewer: 'reviewer（检视）', dev: 'dev（开发）', test: 'test（测试）' };
const groupCount = (groups: CapabilityInputs['groups'], levels: BindingLevel[]) => levels.reduce((sum, level) => sum + (groups[level] ?? 0), 0);
const join = (parts: string[]) => parts.filter(Boolean).join('、');

/** The six scenario states for these facts. Pure: the project overview, the chat capability card and tests share it. */
export function capabilityStates(input: CapabilityInputs): Capability[] {
  const { ceiling, events } = input, has = (role: string) => input.roles.includes(role);
  const issueMention = input.mentions && events['issue.mention'], prMention = input.mentions && events['pull_request.mention'];
  const mentions = issueMention || prMention;
  const gates = input.groupGates ?? presetGates(input.groups), groupsAny = gates.questions, groupsWrite = gates.write, groupsDispatch = gates.dispatch;
  const mentionText = mentions ? `GitHub 上 @bot（${join([issueMention ? 'Issue' : '', prMention ? 'PR' : ''])}）` : '';
  const result: Capability[] = [];
  // Every scenario links to its chapter of the Manager prompt last: that is how it runs.
  const add = (id: ScenarioId, state: CapabilityState, detail: string, settings: SettingKey[]) =>
    result.push({ id, title: scenarioTitles[id], state, state_title: capabilityStateTitles[state], needs: scenarioNeeds[id], detail,
      settings: input.enabled ? [...settings.filter(key => key !== 'manager'), 'manager'] : settings });
  const below = (needed: Ceiling) => `能力上限是「${ceilingTitles[ceiling]}」，这项需要「${ceilingTitles[needed]}」`;

  if (!input.enabled) {
    for (const id of Object.keys(scenarioTitles) as ScenarioId[]) add(id, 'off', '项目已停用，事件和请求都不处理。', ['triggers']);
    return result;
  }

  // ① Questions: a mention on GitHub (answered there from comment up) or a bound group (any level answers in the group).
  {
    const via = join([mentionText, groupsAny ? `${groupsAny} 个飞书群` : '']);
    if (!via) add('qa', 'off', '没有打开 GitHub 提及，也没有绑定飞书群；仍可在控制台的管理助手里提问。', ['triggers', 'groups']);
    else if (!groupsAny && !covers(ceiling, 'comment')) add('qa', 'ceiling_limited', `${via}可以提问，但${below('comment')}，回答发不到 GitHub 上。`, ['triggers']);
    else add('qa', 'ready', `${via}提问时，bot 读代码和讨论后回答${groupsAny && !covers(ceiling, 'comment') ? '（GitHub 上的回答需要更高的能力上限，群里照常回答）' : ''}。`, ['triggers', 'groups']);
  }
  // ② Daily management acts on requests: a mention, or a group that may write.
  {
    const via = join([mentionText, groupsWrite ? `${groupsWrite} 个可写的飞书群` : '']);
    if (!via) add('triage', 'off', '没有可以提出整理请求的入口：GitHub 提及关闭，也没有可评论或可派活的飞书群。', ['triggers', 'groups']);
    else if (!covers(ceiling, 'comment')) add('triage', 'ceiling_limited', `${below('comment')}，不能改标签、指派或开关 Issue/PR。`, ['triggers']);
    else add('triage', 'ready', `${via}提出的请求按权限核实后处理；分类标签只用仓库已有的。`, ['triggers', 'groups', 'manager']);
  }
  // ③ Reviews start on their own when Issues or PRs open; otherwise only a mention asks for one.
  {
    const auto = join([events['issue.opened'] ? '新 Issue' : '', events['pull_request.opened'] ? '新 PR' : '']);
    if (!has('reviewer')) add('review', 'off', `${roleTitles.reviewer} 角色未启用。`, ['roles']);
    else if (!auto && !mentions) add('review', 'off', 'Issue 和 PR 打开的事件都关着，也没有打开 GitHub 提及。', ['triggers']);
    else if (!covers(ceiling, 'comment')) add('review', 'ceiling_limited', `${below('comment')}，检视结果不能发到 GitHub 上。`, ['triggers']);
    else if (!auto) add('review', 'mention_only', 'Issue 和 PR 打开时不自动检视，有人 @bot 要求时才检视。', ['triggers']);
    else add('review', 'ready', `${auto}自动检视${events['pull_request.synchronize'] ? '，PR 推送新提交后跟进' : ''}。`, ['triggers', 'manager']);
  }
  // ④ Development starts on a person's label or a review that concludes "ready" (the prompt's project rule); a
  // maintainer's request in a comment needs a mention to reach the Manager.
  {
    // A published Issue review starts development under the prompt's project rule however the review was started (#1156 review).
    const auto = join([events['issue.development_label'] ? '有人加开发标签' : '', events['review.published.issue'] ? '检视结论为可开发（自主开发规则）' : '']);
    if (!has('dev')) add('development', 'off', `${roleTitles.dev} 角色未启用。`, ['roles']);
    else if (!auto && !issueMention) add('development', 'off', '开发标签、Issue 检视发布和 Issue 提及的事件都关着。', ['triggers']);
    else if (!covers(ceiling, 'develop')) add('development', 'ceiling_limited', `${below('develop')}，不会开发或开 PR。`, ['triggers']);
    else if (!auto) add('development', 'mention_only', '只有维护者在 Issue 上 @bot 要求时才开发。', ['triggers']);
    else add('development', 'ready', `${auto}时开发并开 PR；不自行合并。`, ['triggers', 'manager']);
  }
  // ⑤ Tests run when someone asks: a PR mention, a group that may dispatch, or a label the project routes to the Manager.
  {
    const labels = events['pull_request.labels'].length;
    const via = join([prMention ? 'GitHub 上 @bot（PR）' : '', groupsDispatch ? `${groupsDispatch} 个可派活的飞书群` : '', labels ? `PR 标签（${events['pull_request.labels'].join('、')}）` : '']);
    if (!has('test')) add('testing', 'off', `${roleTitles.test} 角色未启用。`, ['roles']);
    else if (!via) add('testing', 'off', '没有可以要求测试的入口：PR 提及关闭，没有可派活的飞书群，也没有 PR 标签触发。', ['triggers', 'groups']);
    else if (!groupsDispatch && !covers(ceiling, 'comment')) add('testing', 'ceiling_limited', `可以检出运行，但${below('comment')}，结果不能回帖到 GitHub。`, ['triggers']);
    else add('testing', 'ready', `${via}要求时，检出 PR、分支或提交运行测试并报告命令和输出。`, ['triggers', 'groups']);
  }
  // ⑥ Failed Actions runs and scheduled checks find problems before people report them.
  {
    const via = join([events['actions.run_failed'] ? '默认分支和版本标签的 Actions 失败' : '', input.schedules ? `${input.schedules} 个定时检查` : '']);
    if (!via) add('ci', 'off', 'Actions 失败事件关着，也没有定时检查。', ['triggers', 'schedules']);
    else if (!covers(ceiling, 'comment')) add('ci', 'ceiling_limited', `${below('comment')}，不能重跑失败的运行或提报 Issue。`, ['triggers']);
    else add('ci', 'ready', `${via}会自动排查，按原因重跑或提报。`, ['triggers', 'schedules', 'manager']);
  }
  return result;
}

/** Whether "@bot" mentions are recognized, from BOT_MENTION_NAMES (default bot,agent-ci-infra-bot; "off" turns them off). */
export const mentionNames = () => {
  const configured = (process.env.BOT_MENTION_NAMES ?? 'bot,agent-ci-infra-bot').trim();
  return configured.toLowerCase() === 'off' ? [] : configured.split(',').map(name => name.trim()).filter(Boolean);
};

/** What answering questions about the code reads: Checks or Commit Status reads alone do not let a group read code or discussions. */
const questionReads = new Set(['contents', 'issues', 'pull_requests', 'actions']);
/**
 * What one group's items allow, not its level's name (#1156 review): a custom binding may lack the reads questions need, Issue
 * and pull request writes, or task creation.
 */
export function groupGatesOf(items: RolePermissions): { questions: boolean; write: boolean; dispatch: boolean } {
  const venue = groupVenue(items);
  return { questions: githubReadScopes(items).some(resource => questionReads.has(resource)), write: !!(venue.issues || venue.pulls), dispatch: !!venue.dispatch };
}
/** The facts of one project the projection reads. */
export function projectCapabilityInputs(store: Store, repositoryId: string): CapabilityInputs {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const roles = roleConfiguration(store, repositoryId).roles.filter((role: any) => role.enabled).map((role: any) => String(role.role_id));
  const groups: CapabilityInputs['groups'] = {}, groupGates: GroupGates = { questions: 0, write: 0, dispatch: 0 };
  if (store.hasTable('channel_service_bindings'))
    for (const binding of store.all('SELECT * FROM channel_service_bindings WHERE enabled=1'))
      if (scopeProjects(store, String(binding.principal_id)).includes(repositoryId)) {
        const items = bindingPermissions(binding), level = bindingLevel(items), gates = groupGatesOf(items);
        groups[level] = (groups[level] ?? 0) + 1;
        groupGates.questions += Number(gates.questions); groupGates.write += Number(gates.write); groupGates.dispatch += Number(gates.dispatch);
      }
  const schedules = store.hasTable('schedules')
    ? store.all("SELECT spec FROM schedules WHERE project_id=? AND state='active'", repositoryId).filter(row => { try { return JSON.parse(String(row.spec)).workflow === scheduledCheck; } catch { return false; } }).length
    : 0;
  return { enabled: !!policy?.enabled, ceiling: projectCeiling(store, repositoryId, policy), events: eventFilters(store, repositoryId, policy), mentions: mentionNames().length > 0, roles, groups, groupGates, schedules };
}

/** The project overview's capability card: the facts and the six scenarios. */
export function projectCapabilities(store: Store, repositoryId: string) {
  const inputs = projectCapabilityInputs(store, repositoryId);
  return { ceiling: inputs.ceiling, ceiling_title: ceilingTitles[inputs.ceiling], enabled: inputs.enabled, groups: inputs.groups, schedules: inputs.schedules,
    mentions: inputs.mentions, scenarios: capabilityStates(inputs) };
}

/**
 * What one chat can use (#1123): a Feishu group, whose binding level narrows what the project allows, or a GitHub thread,
 * where a mention reaches the Manager. The project's facts still apply (ceiling, enabled roles, a stopped project); the chat
 * adds its own gate. State level_limited: the project could, but this group's level cannot ask for it.
 */
/** A Feishu group binding's level, as the console names it. */
export const groupLevelTitles: Record<BindingLevel, string> = { read: '只读问答', comment: '可评论和打标签', dispatch: '可派活', custom: '逐项设置' };
export type ChatState = 'ready' | 'ceiling_limited' | 'level_limited' | 'off';
export const chatStateTitles: Record<ChatState, string> = { ready: '可以用', ceiling_limited: '受项目能力上限约束', level_limited: '本群档位不支持', off: '未开启' };
export interface ChatVenue {
  kind: 'feishu_group' | 'github';
  /** Feishu group: Issue write and pull request write (separate items in a custom binding; both from comment level up), and
   * creating tasks through the Manager (dispatch level, or the custom item). */
  issues?: boolean; pulls?: boolean; dispatch?: boolean;
}
/** A group's gates from its binding's items, as github_write and create_project_task check them. */
export const groupVenue = (granted: RolePermissions): ChatVenue =>
  ({ kind: 'feishu_group', issues: granted.github_issues === 'write', pulls: granted.github_pull_requests === 'write', dispatch: granted.delegation === 'allow' });
export interface ChatCapability { id: ScenarioId; title: string; state: ChatState; state_title: string; how: string; examples: string[] }

/** Requests people can copy, per scenario; `<repo>` is replaced with the repository's full name. */
const chatExamples: Record<ChatVenue['kind'], Record<ScenarioId, string[]>> = {
  feishu_group: {
    qa: ['@bot <repo> 里 README 写的本地测试命令是什么？', '@bot <repo> 最近合入的 3 个 PR 各改了什么？'],
    triage: ['@bot 给 <repo> 的 Issue #12 加上仓库已有的 type/bug 标签'],
    review: ['@bot 检视一下 <repo> 的 PR #34'],
    development: ['@bot 开发 <repo> 的 Issue #56，完成后开 PR'],
    testing: ['@bot 在 <repo> 的 PR #34 上跑一下测试，把结果发到群里'],
    ci: ['@bot 看看 <repo> main 分支最近一次 CI 为什么失败'],
  },
  github: {
    qa: ['@bot 这个函数还在哪些地方被调用？', '@bot 这个改动会影响哪些模块？'],
    triage: ['@bot 请给这个 Issue 加上仓库已有的 type/bug 标签（作者或维护者提出）'],
    review: ['@bot 请检视一下这个 PR'],
    development: ['@bot 请开发这个 Issue，完成后开 PR（维护者提出）'],
    testing: ['@bot 请在这个 PR 上跑一下测试，把结果回复在这里'],
    ci: ['@bot 最近一次 main 上的 CI 为什么失败？'],
  },
};
/** The order examples are picked in, so three examples show different kinds of work. */
const exampleOrder: ScenarioId[] = ['qa', 'testing', 'review', 'development', 'triage', 'ci'];

export function chatCapabilities(input: CapabilityInputs, venue: ChatVenue): ChatCapability[] {
  const project = new Map(capabilityStates(input).map(c => [c.id, c])), has = (role: string) => input.roles.includes(role);
  const group = venue.kind === 'feishu_group', dispatch = !group || !!venue.dispatch;
  const issues = !group || !!venue.issues, pulls = !group || !!venue.pulls;
  const out: ChatCapability[] = [];
  const add = (id: ScenarioId, state: ChatState, how: string, title = scenarioTitles[id], examples = chatExamples[venue.kind][id]) =>
    out.push({ id, title, state, state_title: chatStateTitles[state], how, examples: state === 'ready' ? examples : [] });
  const ceilingNote = (needed: Ceiling) => `项目能力上限是「${ceilingTitles[input.ceiling]}」，这项需要「${ceilingTitles[needed]}」`;
  if (!input.enabled) { for (const id of Object.keys(scenarioTitles) as ScenarioId[]) add(id, 'off', '项目已停用。'); return out; }
  // ① In a group the assistant reads and answers itself; on GitHub the answer is a comment.
  if (group) add('qa', 'ready', '@bot 提问，读代码、Issue、PR 和 Actions 记录后在群里回答。');
  else add('qa', covers(input.ceiling, 'comment') ? 'ready' : 'ceiling_limited', covers(input.ceiling, 'comment') ? '@bot 提问，读代码和讨论后在这里回复。' : ceilingNote('comment') + '，GitHub 上不能回复。');
  // ② Labels, assignees, titles and open/closed state: Issue and pull request writes are separate items of a group; the
  // ceiling must cover comment.
  const only = issues && !pulls ? '（本群只有 Issue 写入，PR 不能整理）' : pulls && !issues ? '（本群只有 PR 写入，Issue 不能整理）' : '';
  if (!issues && !pulls) add('triage', 'level_limited', '本群没有 Issue/PR 写入；改标签、指派或开关 Issue/PR 需要「可评论和打标签」或以上档位。');
  else if (!covers(input.ceiling, 'comment')) add('triage', 'ceiling_limited', ceilingNote('comment') + '。');
  else add('triage', 'ready', (group ? '@bot 提出明确的整理请求，只用仓库已有的标签，回复里写明请求来源' : 'Issue/PR 的作者或维护者 @bot 提出整理请求；只用仓库已有的标签') + only + '。',
    undefined, issues ? chatExamples[venue.kind].triage : ['@bot 给 <repo> 的 PR #34 加上仓库已有的 type/bug 标签']);
  // ③④⑤ Work handed to the project's Manager: a group needs dispatch; the role must be enabled; GitHub writes need the ceiling.
  const handed = (id: ScenarioId, role: string, needed: Ceiling | null, how: string) => {
    if (!dispatch) add(id, 'level_limited', '把工作交给项目需要本群能派活（「可派活」档位）。');
    else if (!has(role)) add(id, 'off', `项目没有启用 ${roleTitles[role] ?? role} 角色。`);
    else if (needed && !covers(input.ceiling, needed)) add(id, 'ceiling_limited', ceilingNote(needed) + '。');
    else add(id, 'ready', how);
  };
  handed('review', 'reviewer', 'comment', group ? '@bot 要求检视某个 PR 或 Issue，交给项目 Manager 派 reviewer，结果发到 GitHub 并通知本群。' : '@bot 要求检视，reviewer 发布一份结构化检视。');
  handed('development', 'dev', 'develop', group ? '@bot 要求开发某个 Issue，Manager 核实依据后在 bot 分支开 PR；不会自行合并。' : '维护者 @bot 要求开发，Manager 核实依据后在 bot 分支开 PR；不会自行合并。');
  handed('testing', 'test', group ? null : 'comment', group ? '@bot 要求在 PR、分支或提交上跑测试，test 检出运行后把命令和输出发回本群。' : '@bot 要求在这个 PR 上跑测试，test 检出运行后回复命令和输出。');
  // ⑥ A group reads Actions itself, on request; finding failures on its own is the project's (its Actions switch or a
  // scheduled check), so the title says which of the two this group gets. Filing an Issue needs Issue write.
  if (group) {
    // Whether the project watches CI is its switch and its scheduled checks, whatever the ceiling; the ceiling only decides
    // whether what it finds can be rerun or reported on GitHub.
    const watched = input.events['actions.run_failed'] || input.schedules > 0, files = issues && covers(input.ceiling, 'comment');
    const automatic = !watched ? '。项目没有打开 Actions 失败事件，也没有定时检查，不会自动发现。'
      : covers(input.ceiling, 'comment') ? '。项目也会自动排查失败的 Actions 运行或按定时检查发现问题。'
      : `。项目会自动排查失败的 Actions 运行或按定时检查发现问题，但${ceilingNote('comment')}，不会重跑或提报 Issue。`;
    add('ci', 'ready', '@bot 查 CI 失败原因并在群里说明' + (files ? '，需要时提报 Issue；也可以让 bot 设定时检查' : '；提报 Issue 需要 Issue 写入和「可评论和打标签」以上的能力上限') + automatic,
      watched ? scenarioTitles.ci : 'CI 失败原因排查（按需）');
  } else { const c = project.get('ci')!; add('ci', c.state === 'ready' ? 'ready' : c.state === 'ceiling_limited' ? 'ceiling_limited' : 'off', c.detail); }
  return out;
}

/** Three copyable requests from the ready scenarios, different kinds of work first. */
export function chatExamplesFor(capabilities: ChatCapability[], repository: string, count = 3): string[] {
  const ready = exampleOrder.map(id => capabilities.find(c => c.id === id)).filter((c): c is ChatCapability => !!c && c.state === 'ready');
  const picked: string[] = [];
  for (let round = 0; picked.length < count && ready.some(c => c.examples[round]); round++)
    for (const c of ready) if (c.examples[round] && picked.length < count) picked.push(c.examples[round]!.replaceAll('<repo>', repository));
  return picked;
}
