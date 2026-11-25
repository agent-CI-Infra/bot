// Global settings (super administrators only), laid out like a project page: categories on the left, one category on the
// right, each with its own address (#/settings/<section>) so a reload stays on it. Loaded after app.js, views.js and
// project.js and reuses their helpers; tunnelCredential comes from onboarding.js, which loads later but before any page is drawn.
// The wizard settings and models are saved through the wizard's and the model APIs; a card redraws only itself.
titles.settings = '全局设置';
// waiting_token with a saved token means this deployment has no tunnel status endpoint to read.
const tunnelStates = { waiting_token: '读不到状态', not_running: 'tunnel 服务未运行', connecting: '正在连接', connected: '已连接' };
// Each group carries its own stable key, so a category that later moves into the dictionary is named by identity, not by
// matching the Chinese caption it happens to have today.
const settingsGroups = [
  ['system', '系统与算力', [['work-computers', '工作电脑'], ['models', '模型'], ['management-assistant', '管理助手设置'], ['memory-consolidation', '夜间记忆整理'], ['assistant-computers', '助手电脑'], ['agent-tools', 'Agent CLI 工具卷'], ['storage', '存储'], ['feedback', '意见箱']]],
  ['access', '接入与网络', [['onboarding', '系统初始化'], ['access', '公网接入'], ['external', '外部执行']]],
  ['channels', '连接与渠道', [['accounts', '机器人账号'], ['installations', '安装档案'], ['feishu', '飞书连接']]],
  ['repository', '仓库与用户', [['projects', '项目管理'], ['users', '用户']]]
];
const settingsSections = settingsGroups.flatMap(([, , items]) => items);
// #527: a category that already lives in the dictionary is renamed when the nav is drawn, so the installation archive's
// label and the group holding it follow a language switch with the page instead of waiting for a reload. Keyed by the
// section key and the group key, not by the caption, so renaming or translating a caption later cannot silently drop the
// mapping. Every other category keeps its literal and moves in a later slice.
const settingsSectionCaptions = { installations: 'settings.nav.installations', feedback: 'settings.nav.feedback' };
const settingsGroupCaptions = { channels: 'settings.nav.group_channels' };
const settingsCaption = (captions, key, caption) => (captions[key] ? t(captions[key]) : caption);
// #1039: a settings page carries its own h1 (全局设置, or 存储 for the one page a project administrator may open), so the
// cards under it are h2. Only these files use this wrapper: card() keeps its h3 default for every page outside settings,
// and views.css restates the old h3 sizes on .side-card>h2 so the change is tag-only.
const settingsCard = (title, level = 'h2') => card(title, level);
// #799: the settings shell names the category it shows, not the whole platform: 存储 is a page a project administrator
// may open, and the first crumb says 工作区 for them, 平台管理 only for a super administrator.
function settingsPageTitle(section = settingsRoute().section) { return section === 'storage' ? t('nav.storage') : t('nav.settings'); }
function settingsScope() { return typeof me === 'object' && me && me.role === 'super_admin' ? t('nav.platform') : t('nav.workspace'); }
// A project administrator reaches global settings only for 存储, which lists their own projects.
const visibleSettingsGroups = () => {
  const groups = typeof me === 'object' && me && me.role !== 'super_admin'
    ? settingsGroups.map(([group, title, items]) => [group, title, items.filter(([key]) => key === 'storage')]).filter(([, , items]) => items.length) : settingsGroups;
  return groups.map(([group, title, items]) => [settingsCaption(settingsGroupCaptions, group, title),
    items.map(([key, caption]) => [key, settingsCaption(settingsSectionCaptions, key, caption)])]);
};
const visibleSettingsSections = () => visibleSettingsGroups().flatMap(([, items]) => items);
// A settings address is a section and, for a detail page, one record inside it: #/settings/installations/<host>/<app>/<id>
// and #/settings/users/<id>. Unknown sections (the old #/settings/general among them) fall back to the first category the
// user may see (工作电脑 for a super administrator), an unreadable id is handled by the page itself.
function settingsRoute() {
  if (/^#\/settings\/onboarding(?:\/|$)/.test(location.hash)) return { section: 'onboarding', id: null };
  if (/^#\/settings\/feishu(?:\/|$)/.test(location.hash)) return { section: 'feishu', id: null };
  if (/^#\/settings\/service-roles(?:\/|$)/.test(location.hash)) return { section: 'management-assistant', id: null };
  const match = /^#\/settings\/([a-z-]+)(?:\/(.+))?$/.exec(location.hash), key = match?.[1], sections = visibleSettingsSections();
  // #736: an id that is not valid percent-encoding reads as no id, so the section opens as its list instead of throwing.
  return { section: sections.some(([name]) => name === key) ? key : sections[0][0], id: match?.[2] ? safeDecode(match[2]) : null };
}
// What the cards draw from; the model cards are redrawn together because deleting the default model clears it.
let settingsView = null;
