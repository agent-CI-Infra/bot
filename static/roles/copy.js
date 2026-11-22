/** Role settings and built-in duties in Chinese or English (#568). Not full-site i18n (#527). */
function consoleLocale() {
  if (typeof globalThis !== 'undefined' && globalThis.__consoleLocale) return globalThis.__consoleLocale;
  const lang = (typeof document !== 'undefined' && document.documentElement && document.documentElement.lang) || '';
  return String(lang).toLowerCase().startsWith('en') ? 'en' : 'zh';
}

const roleCatalogDuties = {
  zh: {
    manager: '负责项目事件分派、任务内多角色编排与跨任务排期及依赖协调。',
    dev: '在入口已有的权限范围内实现或调查任务。',
    test: '独立测试既定的交付候选。',
    reviewer: '独立检视既定候选，找出可处理的缺陷。',
    ux: '检视候选的用户交互、可见状态和可访问性。',
    qa: '在全新上下文中判定该候选是否满足任务约定。',
  },
  en: {
    manager: 'Manages project event dispatch, coordinates multi-role task execution, and handles cross-task scheduling and dependencies.',
    dev: "Implements or investigates the task within the entry point's existing authority.",
    test: 'Independently tests the fixed candidate.',
    reviewer: 'Independently inspects the fixed candidate for actionable defects.',
    ux: 'Inspects user interactions, visible state and accessibility of the candidate.',
    qa: 'Decides whether the exact candidate meets the task contract, in a fresh context.',
  }
};

const retiredCatalogDuties = [
  '为单个任务协调项目流程：查询任务事实、委派有范围的工作、把交付提给独立验收。',
  'Coordinates the project flow for one task: queries task facts, delegates bounded work, nominates a delivery for independent QA.',
];

const allCatalogDuties = new Set([...Object.values(roleCatalogDuties.zh), ...Object.values(roleCatalogDuties.en), ...retiredCatalogDuties]);

function isCatalogRoleDuty(id, duty) {
  if (!duty) return true;
  return allCatalogDuties.has(duty);
}

const roleConfigName = role => roleLabel(role.role_id, role.name);

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
    requiredNote: names => `新增角色默认使用可编辑的检视模板。${names}是必需角色，其余角色都可以删除。`,
    requiredEnable: name => `${name}是必需角色，不能关闭。`,
    enableList: '启用',
    statusEnabled: '已启用',
    statusDisabled: '已关闭',
    statusUnsaved: '有未保存的更改',
    statusSaved: '已保存',
    statusDefault: '默认配置',
    followsDefault: '正在使用默认配置，内置默认更新时自动跟随。',
    defaultDirty: '有未保存的更改。保存后成为自定义配置，不再跟随内置默认；正在运行的任务不受影响。',
    savedCustom: '角色配置已保存为自定义配置，不再跟随内置默认。新任务使用新配置；收回权限会阻止后续调用',
    customNote: '这是项目自己的配置，内置默认更新时不会改变。',
    restore: '恢复默认',
    restoreTitle: '恢复默认配置？',
    restoreBody: ['恢复后按内置默认运行，内置默认更新时自动跟随。', '当前配置保留在修订历史里；正在运行的任务继续使用开始时的配置。'],
    restoreDraft: '这页未保存的更改也会丢弃。',
    restored: '已恢复默认配置。新任务按内置默认运行，内置默认更新时自动跟随',
  },
  en: {
    overview: 'Roles',
    columns: ['Role', 'Enabled', 'Duty', 'Status'],
    tableLabel: 'Role list',
    overviewNote: 'Open a role name to edit and save on a single page. The list shows the name, whether it is enabled, its duty and its status.',
    emptyDuty: 'No duty written',
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
    requiredNote: names => `A new role starts from the editable review template. ${names} are required. Every other role can be removed.`,
    requiredEnable: name => `${name} is required and cannot be turned off.`,
    enableList: 'Enabled',
    statusEnabled: 'Enabled',
    statusDisabled: 'Disabled',
    statusUnsaved: 'Unsaved changes',
    statusSaved: 'Saved',
    statusDefault: 'Default',
    followsDefault: 'Using the default configuration; it follows built-in updates.',
    defaultDirty: 'Unsaved changes. Saving makes this a custom configuration that no longer follows built-in updates; running tasks are not affected.',
    savedCustom: 'Saved as a custom configuration that no longer follows built-in updates. New tasks use it; revoked permissions stop later calls',
    customNote: 'This is the project\'s own configuration; built-in updates do not change it.',
    restore: 'Restore defaults',
    restoreTitle: 'Restore the default configuration?',
    restoreBody: ['The project then runs the built-in defaults and follows their updates.', 'The current configuration stays in the revision history; running tasks keep the configuration they started with.'],
    restoreDraft: 'Unsaved changes on this page are discarded too.',
    restored: 'Default configuration restored. New tasks run the built-in defaults and follow their updates',
  }
};

function rolePageText(key) {
  const pack = rolePageCopy[consoleLocale()] || rolePageCopy.zh;
  return pack[key];
}
