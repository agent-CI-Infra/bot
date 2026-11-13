// Project pages: one settings page per repository with categories on the left (#/projects/<id>/<section>).
// Loaded after app.js and views.js and reuses their helpers.
const projectSections = [['overview', '项目总览'], ['management', '管理对话'], ['release', '发版本'], ['knowledge', '项目知识'], ['activity', '运行状态'], ['basic', '基本设置'], ['machine', '机器配置'], ['roles', '角色'], ['model', '模型'], ['schedules', '计划与通知'], ['external', '外部执行'], ['members', '成员']];
// Older addresses open the Manager page: the workflows page it replaced, the task overview and the review, development and rule pages.
const legacyProjectSections = { workflows: 'manager-prompt', tasks: '', review: '', development: '', rules: 'rule-sources' };
// Every file has the same three layers: built-in default, project console override, default-branch repository file.
const ruleFiles = [
  ['.bot/guide.md', '行为指南', '全部任务', 'tasks'],
  ['.bot/rules/issue-review.md', 'Issue 检视规则', 'Issue 检视', 'tasks'],
  ['.bot/rules/pr-review.md', 'PR 检视规则', 'PR 检视', 'tasks'],
  ['.bot/rules/labels.md', '检视标签', 'Issue 与 PR 检视', 'tasks'],
  ['.bot/rules/issue-development.md', '开发规则', '开发与跟进 bot PR', 'tasks'],
  ['.bot/computer.yaml', '虚拟电脑', '全部任务', 'machine']];
const layerNames = { builtin: '内置默认', console: '项目控制台', repository: '仓库文件' };
const ruleInfo = path => ruleFiles.find(([p]) => p === path) || [path, '仓库 skill', '全部任务', 'tasks'];
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
