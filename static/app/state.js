const $ = id => document.getElementById(id);
let me, setup = false, tab = 'projects', offset = 0, repositories = [], accounts = [], renderVersion = 0, integrationAutoRefresh = false, permissionAutoRefresh = false;
// Project administrators' grants and the installed repositories to choose from (users page); the user whose grants the editor changes.
let grants = { assignments: [], organization_assignments: [], organizations: [] }, editingUser = null, editorKind = null;
const titles = { projects: '项目', board: '看板', costs: '统计', events: 'Webhook 投递', management: '管理对话', design: '设计系统样例', 'new-task': '新建任务', 'not-found': '找不到页面' };
