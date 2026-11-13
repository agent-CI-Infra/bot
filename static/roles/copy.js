/** Role-config names and duties in Chinese or English (#568). Not full-site i18n (#527). */
function consoleLocale() {
  if (typeof globalThis !== 'undefined' && globalThis.__consoleLocale) return globalThis.__consoleLocale;
  const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '';
  return String(lang).toLowerCase().startsWith('en') ? 'en' : 'zh';
}

const roleCatalogNames = {
  zh: {
    coordinator: '跨任务协调',
    manager: '项目管理者',
    dev: '开发',
    test: '测试',
    reviewer: '检视',
    ux: '体验检视',
    qa: '独立验收',
  },
  en: {
    coordinator: 'Task coordinator',
    manager: 'Project controller',
    dev: 'Developer',
    test: 'Tester',
    reviewer: 'Reviewer',
    ux: 'UX reviewer',
    qa: 'Independent QA',
  }
};

const roleCatalogDuties = {
  zh: {
    coordinator: '处理明确的跨任务协调请求，没有产品执行或验收权限。',
    manager: '为单个任务协调项目流程：查询任务事实、委派有范围的工作、把交付提给独立验收。',
    dev: '在入口已有的权限范围内实现或调查任务。',
    test: '独立测试既定的交付候选。',
    reviewer: '独立检视既定候选，找出可处理的缺陷。',
    ux: '检视候选的用户交互、可见状态和可访问性。',
    qa: '在全新上下文中判定该候选是否满足任务约定。',
  },
  en: {
    coordinator: 'Resolves explicit cross-task coordination requests without product execution or acceptance authority.',
    manager: 'Coordinates the project flow for one task: queries task facts, delegates bounded work, nominates a delivery for independent QA.',
    dev: "Implements or investigates the task within the entry point's existing authority.",
    test: 'Independently tests the fixed candidate.',
    reviewer: 'Independently inspects the fixed candidate for actionable defects.',
    ux: 'Inspects user interactions, visible state and accessibility of the candidate.',
    qa: 'Decides whether the exact candidate meets the task contract, in a fresh context.',
  }
};

// Historic short labels and both-locale catalog values count as "not a custom name".
const historicRoleNames = ['Manager', 'Dev', 'Test', 'Reviewer', 'UX', '独立 QA', 'Task Coordinator', 'Independent QA', 'Project controller', 'UX reviewer'];
const allCatalogNames = new Set([...historicRoleNames, ...Object.values(roleCatalogNames.zh), ...Object.values(roleCatalogNames.en)]);
const allCatalogDuties = new Set([...Object.values(roleCatalogDuties.zh), ...Object.values(roleCatalogDuties.en)]);

function isCatalogRoleName(id, name) {
  if (!name || name === id) return true;
  return allCatalogNames.has(name);
}
function isCatalogRoleDuty(id, duty) {
  if (!duty) return true;
  return allCatalogDuties.has(duty);
}

/** Display name on the role list and form: locale catalog when the stored value is a built-in default. */
function roleConfigName(id, name) {
  const catalog = roleCatalogNames[consoleLocale()] || roleCatalogNames.zh;
  if (Object.hasOwn(catalog, id) && isCatalogRoleName(id, name)) return catalog[id];
  return name || catalog[id] || id;
}

/** Display duty on the role list and form: same rule as the name. */
function roleConfigDuty(id, duty) {
  const catalog = roleCatalogDuties[consoleLocale()] || roleCatalogDuties.zh;
  if (Object.hasOwn(catalog, id) && isCatalogRoleDuty(id, duty)) return catalog[id];
  return duty || '';
}

const rolePageCopy = {
  zh: {
    overview: '角色概览',
    columns: ['角色', '启用', '职责', '状态'],
    tableLabel: '角色解析结果',
    overviewNote: '点角色名称打开完整表单，在同一页编辑并保存。列表只展示名称、是否启用、职责和状态。',
    emptyDuty: '未填写职责',
    introTitle: '使用推荐的角色分工',
    introNote: '还没有保存过角色配置。可以先使用推荐配置，按默认的项目管理者、开发、测试、检视等角色开始工作。技能、提示词、权限和预算不必现在改，需要时再打开「高级」。',
    displayName: '显示名称',
    enable: '启用角色',
    duty: '职责',
    basic: '基本信息',
    agent: 'Agent 与模型',
    prompts: '提示词',
    advanced: '高级设置',
    roleId: '角色标识',
    formSuffix: ' 设置',
    promptNote: '这份提示词会发给模型，包含角色完整的职责与行为要求，可以全部修改或清空；系统不会再追加固定职责。推荐配置使用英文模板（模型常用英文指令），可以改成中文或自行撰写。',
    systemNote: '所有角色共用的系统背景、环境说明和基本行为准则。角色职责与任务记录规则在下面的提示词中直接修改。',
    requiredNote: '新增角色默认使用可编辑的检视模板。项目管理者、跨任务协调和独立验收是必需角色，其余角色都可以删除。',
    requiredEnable: '{name}是必需角色，不能关闭。',
    adopt: '使用推荐配置',
    foldAdvanced: '高级',
    enableList: '启用',
    statusEnabled: '已启用',
    statusDisabled: '已关闭',
    statusUnsaved: '有未保存的更改',
    statusSaved: '已保存',
    statusRecommended: '推荐配置',
  },
  en: {
    overview: 'Roles',
    columns: ['Role', 'Enabled', 'Duty', 'Status'],
    tableLabel: 'Role list',
    overviewNote: 'Open a role name to edit and save on a single page. The list shows the name, whether it is enabled, its duty and its status.',
    emptyDuty: 'No duty written',
    introTitle: 'Use the recommended roles',
    introNote: 'This project has no saved role configuration yet. You can start with the recommended Project controller, Developer, Tester and Reviewer roles. Skills, prompts, permissions and budgets can wait until you need them, in Advanced.',
    displayName: 'Display name',
    enable: 'Enable role',
    duty: 'Duty',
    basic: 'Basics',
    agent: 'Agent and model',
    prompts: 'Prompts',
    advanced: 'Advanced',
    roleId: 'Role id',
    formSuffix: ' settings',
    promptNote: 'This prompt is sent to the model. It is the full duty and behaviour for the role; you may edit or clear it, and the system will not append a fixed duty. The recommended template is in English, which models commonly follow.',
    systemNote: 'Shared system background, environment and basic behaviour for every role. Role duties and task-record rules are edited in the prompt below.',
    requiredNote: 'A new role starts from the editable review template. The Project controller, Task coordinator and Independent QA are required; every other role can be removed.',
    requiredEnable: '{name} is required and cannot be turned off.',
    adopt: 'Use recommended configuration',
    foldAdvanced: 'Advanced',
    enableList: 'Enabled',
    statusEnabled: 'Enabled',
    statusDisabled: 'Disabled',
    statusUnsaved: 'Unsaved changes',
    statusSaved: 'Saved',
    statusRecommended: 'Recommended',
  }
};

function rolePageText(key) {
  const pack = rolePageCopy[consoleLocale()] || rolePageCopy.zh;
  return pack[key];
}
