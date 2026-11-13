// Global settings (super administrators only), laid out like a project page: categories on the left, one category on the
// right, each with its own address (#/settings/<section>) so a reload stays on it. Loaded after app.js, views.js and
// project.js and reuses their helpers; tunnelCredential comes from onboarding.js, which loads later but before any page is drawn.
// The wizard settings and models are saved through the wizard's and the model APIs; a card redraws only itself.
titles.settings = '全局设置';
// waiting_token with a saved token means this deployment has no tunnel status endpoint to read.
const tunnelStates = { waiting_token: '读不到状态', not_running: 'tunnel 服务未运行', connecting: '正在连接', connected: '已连接' };
const settingsGroups = [
  ['系统与算力', [['work-computers', '工作电脑'], ['models', '模型'], ['service-roles', '服务角色'], ['assistant-computers', '助手电脑'], ['storage', '存储']]],
  ['接入与网络', [['onboarding', '接入向导'], ['access', '公网接入'], ['external', '外部执行']]],
  ['连接与渠道', [['accounts', '机器人账号'], ['installations', '安装档案'], ['feishu', '飞书连接']]],
  ['仓库与用户', [['projects', '项目管理'], ['users', '用户']]]
];
const settingsSections = settingsGroups.flatMap(([, items]) => items);
// A project administrator reaches global settings only for 存储, which lists their own projects.
const visibleSettingsGroups = () => typeof me === 'object' && me && me.role !== 'super_admin'
  ? settingsGroups.map(([title, items]) => [title, items.filter(([key]) => key === 'storage')]).filter(([, items]) => items.length) : settingsGroups;
const visibleSettingsSections = () => visibleSettingsGroups().flatMap(([, items]) => items);
// A settings address is a section and, for a detail page, one record inside it: #/settings/installations/<host>/<app>/<id>
// and #/settings/users/<id>. Unknown sections (the old #/settings/general among them) fall back to the first category the
// user may see (工作电脑 for a super administrator), an unreadable id is handled by the page itself.
function settingsRoute() {
  if (/^#\/settings\/onboarding(?:\/|$)/.test(location.hash)) return { section: 'onboarding', id: null };
  if (/^#\/settings\/feishu(?:\/|$)/.test(location.hash)) return { section: 'feishu', id: null };
  const match = /^#\/settings\/([a-z-]+)(?:\/(.+))?$/.exec(location.hash), key = match?.[1], sections = visibleSettingsSections();
  return { section: sections.some(([name]) => name === key) ? key : sections[0][0], id: match?.[2] ? decodeURIComponent(match[2]) : null };
}
// What the cards draw from; the model cards are redrawn together because deleting the default model clears it.
let settingsView = null;
