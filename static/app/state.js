const $ = id => document.getElementById(id);
let me, setup = false, tab = 'projects', offset = 0, repositories = [], accounts = [], renderVersion = 0, integrationAutoRefresh = false, permissionAutoRefresh = false;
// Project administrators' grants and the installed repositories to choose from (users page); the user whose grants the editor changes.
let grants = { assignments: [], organization_assignments: [], organizations: [] }, editingUser = null, editorKind = null;
const titles = { projects: '项目', costs: '用量与成本', management: '管理助手', design: '设计系统样例', 'new-task': '新建任务', task: '任务详情', 'not-found': '找不到页面' };
