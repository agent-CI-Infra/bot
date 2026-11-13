// Task process and project computer views. Loaded after app.js and reuses its helpers ($, api, element, state, states, timestamp).
const terminalStates = ['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed'];
const kindLabels = { 'gate.onboarding': '接入门禁', 'review.issue': '检视 Issue', 'review.pr': '检视 PR', 'development.issue': '开发 Issue', 'development.pr': '跟进 bot PR', 'release.observe': 'CI 观察', 'release.notes': '发行说明', 'actions.failures': 'Actions 失败分析',
  'workflow.issue': '通用回复 Issue', 'workflow.pr': '通用回复 PR', 'task.request': '普通任务', 'task.development': '开发任务' };
const modeLabels = { 'review.issue': '检视', 'review.pr': '检视', 'development.issue': '开发', 'development.pr': '跟进' };
const phaseLabels = { prepare: '准备工作区', model: '模型执行', validate: '测试验证', acceptance: '独立验收', publish: '发布', done: '完成' };
// Role coordination words shared by the task view and the 「Manager 与角色」 page. A harness is how a role runs;
// the built-in roles keep their short names (Manager delegates Dev, Test, Reviewer and UX; QA stays independent).
// Role ids are chosen by the project (a custom observer may be called "constructor"), so lookups by id read own
// properties only and fall back to the role's own name.
const own = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;
const harnessNames = { pi: 'Pi', native: 'Native', process: 'Process', acp: 'ACP', claude_code: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };
const harnessName = id => own(harnessNames, id) || id || '—';
const builtinRoleNames = { manager: 'Manager', dev: 'Dev', test: 'Test', reviewer: 'Reviewer', ux: 'UX', qa: '独立 QA', coordinator: '跨任务协调' };
const roleLabel = (id, name) => own(builtinRoleNames, id) || name || id;
const acceptanceLabels = { pass: '通过', pass_with_issues: '带问题通过', return: '退回修改', insufficient_evidence: '证据不足', needs_human: '需要人决定' };
const shortId = value => value ? String(value).slice(0, 12) : '—';
const mutedLine = text => element('p', text, 'muted');
const publicationLabels = { comment: '总结评论', review: '行内检视（COMMENT）', label: '标签', branch: 'bot 分支', pull_request: 'PR' };
const publicationStates = { sent: ['已发布', 'success'], pending: ['待发布', 'info'], inflight: ['发布中', 'info'], unknown: ['结果待确认', 'warning'], recheck: ['重试前再查一次', 'info'] };
const emptyRepositoryMessage = '仓库还没有提交；默认分支出现提交后会自动继续。';
function taskErrorText(code) { return code === 'repository_has_no_commit' ? emptyRepositoryMessage : code; }
// The cause says whose move it is (a passing outage, a GitHub setting, the bot itself); the code stays for searching logs.
function faultSummary(code, cause) { return code === 'repository_has_no_commit' || !cause ? taskErrorText(code) : `${cause.label}（${code}）`; }
// What a project computer's fault code means.
const environmentErrors = {
  manager_unavailable: '连不上虚拟电脑管理服务（manager）', recovery_failed: '容器停止后没能恢复', provision_failed: '创建虚拟电脑失败',
  operation_failed: '操作中途失败，电脑已停止', reset_interrupted: '重置被 manager 重启打断，需要再次重置', runner_not_ready: '容器启动后 runner 没有就绪',
  approved_image_missing: '找不到批准的项目镜像', image_build_failed: '软件包镜像构建失败', docker_operation_failed: 'Docker 拒绝了操作',
  docker_protocol_failed: 'Docker 返回了无法识别的内容', container_not_stopped: '容器没能停止', container_missing: '容器不存在',
  resource_ownership_mismatch: '同名容器、卷或网络不属于这个部署', recovery_required: '容器在命令执行中重启', runner_failed: 'runner 执行请求失败',
  runner_protocol_failed: 'runner 返回了无法识别的内容', environment_not_ready: '电脑还没有就绪', unauthorized: 'manager 拒绝了控制面的内部令牌' };
// Where each code's cause is written down: the control plane logs a manager it cannot reach; a refused internal token is
// logged by neither side; everything else comes from the manager.
const environmentFaultCause = {
  manager_unavailable: '原因见控制面日志：docker compose -p bot logs bot',
  unauthorized: 'bot 和 manager 读到的内部令牌不一致（两边日志都不记录这种拒绝）：检查共用的 internal-keys 卷里的 manager.token，然后重启 bot 和 manager' };
function environmentFault(code) { return code ? `${environmentErrors[code] || '未归类的故障'}（${code}）。${environmentFaultCause[code] || '原因见日志：docker compose -p bot logs manager bot'}` : null; }
function taskState(task) { return task.status === 'waiting_configuration' && task.error_code === 'repository_has_no_commit' ? badge('仓库还没有提交', 'warning') : state(task.status); }

