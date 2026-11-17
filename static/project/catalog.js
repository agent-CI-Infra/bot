// Project pages: one settings page per repository (#/projects/<id>/<section>). The 项目入口 hub (#/projects/<id>/menu) lists
// every page; a work page shows a two-item breadcrumb and a settings page lists every settings category.
// Loaded after app.js and views.js and reuses their helpers.
const projectSections = [['overview', '项目总览'], ['management', '管理助手'], ['release', '发版本'], ['knowledge', '项目知识'], ['activity', '运行状态'], ['basic', '基本设置'], ['triggers', '监听与触发'], ['machine', '机器配置'], ['roles', '角色'], ['model', '模型'], ['schedules', '计划与通知'], ['external', '外部执行'], ['members', '成员']];
// #707: the settings categories are also the secondary nav of every settings page, so the hub, that nav and the phone's
// 当前页面 picker all read this one list.
const projectSettingsSections = [
  ['basic', '基本设置', '项目概况、分支与启停'],
  ['triggers', '监听与触发', '项目事件来源与自动处理范围'],
  ['machine', '机器配置', '虚拟电脑与运行环境'],
  ['roles', '角色', '角色分工与权限'],
  ['model', '模型', '项目默认模型'],
  ['schedules', '计划与通知', '定时任务与通知'],
  ['external', '外部执行', '外部执行端'],
  ['members', '成员', '项目成员与权限']
];
// #565: the 项目入口 hub groups.
const projectSectionGroups = [
  ['项目工作', [
    ['overview', '项目总览', '工作进展与待处理事项'],
    ['management', '管理助手', '查进展、找原因、调整配置'],
    ['release', '发版本', '发布与版本说明'],
    ['knowledge', '项目知识', '项目文档与资料'],
    ['activity', '运行状态', '近期运行与记录']
  ]],
  ['设置', projectSettingsSections]
];
// Older addresses open the Manager page: the workflows page it replaced, the task overview and the review, development and rule pages.
const legacyProjectSections = { workflows: 'manager-prompt', tasks: '', review: '', development: '', rules: 'rule-sources' };
// The only files the bot reads from a repository are its skills (#935): the rule texts are Manager prompt sections, the
// labels project settings and the computer the machine page. layerNames still names the sources of older records.
const layerNames = { builtin: '内置默认', console: '项目控制台', repository: '仓库文件' };
const ruleInfo = path => [path, 'skill ' + path.replace(/^\.agents\/skills\/|\/SKILL\.md$/g, ''), '全部任务', 'tasks'];
const specFields = ['cpus', 'memory_mb', 'pids', 'tmp_mb'];
const packagesText = list => (list || []).join(' '), envText = env => Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n');
const bytes = value => value == null ? '—' : value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : Math.round(value / 1024) + ' KB';
function parseEnv(text) {
  const env = {};
  text.split('\n').forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith('#')) return; const at = line.indexOf('=');
    if (at < 1) throw new Error(`环境变量第 ${index + 1} 行需要写成 名称=值`); env[line.slice(0, at).trim()] = line.slice(at + 1);
  });
  return env;
}
// The project's capability ceiling (#850): the one setting of what the bot may write here. Work-type writes, role GitHub
// writes, Feishu group levels and personal grants all stay at or below it.
const projectCeilingOptions = [
  ['read', '只读问答', '在飞书和控制台里回答、检视讨论；不在 GitHub 上写任何内容。'],
  ['comment', '可评论和打标签', '在 GitHub 上写 Issue 和 PR：评论、加删标签、改标题和正文、指派人、关闭或重开、提 Issue、发检视；Actions 失败可以重跑一次。不改代码。'],
  ['develop', '可开发并开 PR', '还可以改代码、交付 bot PR；Manager 默认还能合并 PR 和直接写分支（Contents 写）。']];
const projectCeilingOf = policy => policy.capability_ceiling || (policy.development_enabled ? 'develop' : policy.review_enabled ? 'comment' : 'read');
