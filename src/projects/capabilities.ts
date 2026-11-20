import type { Store } from '../storage/database.js';
import { covers, ceilingTitles, projectCeiling, type Ceiling } from './ceiling.js';
import { eventFilters, type EventFilters } from '../dispatch/settings.js';
import { roleConfiguration } from '../roles/definition.js';
import { bindingLevel, bindingPermissions, scopeProjects, type BindingLevel } from '../channels/service-bindings.js';
import { scheduledCheck } from '../dispatch/schedule.js';

/**
 * What the bot can do in a project right now (#1123): the six scenarios of the built-in Manager prompt, each projected from
 * settings that already exist — the capability ceiling, the event switches, the enabled roles, the Feishu groups bound to
 * the project with their level, and the project's scheduled checks. Nothing is stored; the projection is read again on
 * every call, so lowering the ceiling or switching an event shows at once. The same function describes a single chat
 * (`venue`), whose own level narrows what the project allows.
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
  /** Enabled Feishu groups bound to the project, by level. */
  groups: Partial<Record<BindingLevel, number>>;
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

const scenarioNeeds: Record<ScenarioId, Ceiling> = { qa: 'comment', triage: 'comment', review: 'comment', development: 'develop', testing: 'comment', ci: 'comment' };
const roleTitles: Record<string, string> = { reviewer: 'reviewer（检视）', dev: 'dev（开发）', test: 'test（测试）' };
const groupCount = (groups: CapabilityInputs['groups'], levels: BindingLevel[]) => levels.reduce((sum, level) => sum + (groups[level] ?? 0), 0);
const join = (parts: string[]) => parts.filter(Boolean).join('、');

/** The six scenario states for these facts. Pure: the project overview, the chat capability card and tests share it. */
export function capabilityStates(input: CapabilityInputs): Capability[] {
  const { ceiling, events } = input, has = (role: string) => input.roles.includes(role);
  const issueMention = input.mentions && events['issue.mention'], prMention = input.mentions && events['pull_request.mention'];
  const mentions = issueMention || prMention;
  const groupsAny = groupCount(input.groups, ['read', 'comment', 'dispatch', 'custom']);
  const groupsWrite = groupCount(input.groups, ['comment', 'dispatch', 'custom']), groupsDispatch = groupCount(input.groups, ['dispatch', 'custom']);
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
    const auto = join([events['issue.development_label'] ? '有人加开发标签' : '', events['review.published.issue'] && events['issue.opened'] ? '检视结论为可开发（自主开发规则）' : '']);
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

/** The facts of one project the projection reads. */
export function projectCapabilityInputs(store: Store, repositoryId: string): CapabilityInputs {
  const policy = store.get('SELECT * FROM policies WHERE repository_id=?', repositoryId);
  const roles = roleConfiguration(store, repositoryId).roles.filter((role: any) => role.enabled).map((role: any) => String(role.role_id));
  const groups: CapabilityInputs['groups'] = {};
  if (store.hasTable('channel_service_bindings'))
    for (const binding of store.all('SELECT * FROM channel_service_bindings WHERE enabled=1'))
      if (scopeProjects(store, String(binding.principal_id)).includes(repositoryId)) {
        const level = bindingLevel(bindingPermissions(binding));
        groups[level] = (groups[level] ?? 0) + 1;
      }
  const schedules = store.hasTable('schedules')
    ? store.all("SELECT spec FROM schedules WHERE project_id=? AND state='active'", repositoryId).filter(row => { try { return JSON.parse(String(row.spec)).workflow === scheduledCheck; } catch { return false; } }).length
    : 0;
  return { enabled: !!policy?.enabled, ceiling: projectCeiling(store, repositoryId, policy), events: eventFilters(store, repositoryId, policy), mentions: mentionNames().length > 0, roles, groups, schedules };
}

/** The project overview's capability card: the facts and the six scenarios. */
export function projectCapabilities(store: Store, repositoryId: string) {
  const inputs = projectCapabilityInputs(store, repositoryId);
  return { ceiling: inputs.ceiling, ceiling_title: ceilingTitles[inputs.ceiling], enabled: inputs.enabled, groups: inputs.groups, schedules: inputs.schedules,
    mentions: inputs.mentions, scenarios: capabilityStates(inputs) };
}
