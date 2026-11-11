// Drafts and uncertain submissions stay in this page's memory, scoped to the signed-in user and project.
let taskCreationOwner = null;
const taskCreationDrafts = new Map();
function resetTaskCreation() { taskCreationDrafts.clear(); taskCreationOwner = null; }
function taskCreationError(value) {
  const code = String(value || '状态未知');
  const messages = { capability_forbidden: '当前身份没有创建此项目任务的权限。', project_disabled: '项目已禁用，请先由有权管理员启用。',
    installation_unavailable: '项目安装当前不可用，请先检查接入状态。', installation_scope_changed: '安装仓库范围已变化，请重新同步。',
    management_revision_conflict: '项目配置已变化。重新读取执行上下文后再提交。', task_pull_request_forbidden: '项目或执行角色未获代码与 PR 写入权限，请核对配置。',
    task_software_disabled: '项目尚未启用普通任务的软件交付，请核对工作类型与开发设置。' };
  return messages[code] || code;
}
async function renderNewTask(request) {
  const page = $('console-page'), owner = me.id, address = location.hash;
  if (taskCreationOwner !== owner) { taskCreationDrafts.clear(); taskCreationOwner = owner; }
  const id = /^#\/new-task\/([1-9]\d*)$/.exec(address)?.[1] || '';
  const root = element('section', '', 'task-create-page');
  const alive = () => root.isConnected && me?.id === owner && location.hash === address && request === renderVersion;
  const heading = element('div', '', 'console-page-head');
  heading.append(element('p', 'NEW TASK', 'eyebrow'), element('h1', '新建任务'), note('写清需求与验收条件，提交后查看真实任务进展和证据。'));
  const picker = document.createElement('select'); picker.setAttribute('aria-label', '任务项目');
  picker.add(new Option('请选择项目', '')); repositories.forEach(repo => picker.add(new Option(repo.full_name, repo.id))); picker.value = id;
  picker.addEventListener('change', () => { location.hash = '#/new-task' + (picker.value ? '/' + picker.value : ''); });
  root.append(heading, field('任务项目', picker)); page.replaceChildren(root);
  if (!id || !repositories.some(repo => String(repo.id) === id)) {
    root.append(consoleState(id ? '项目暂不可访问' : '先选择任务所属项目', id ? '请选择当前有权访问的项目。' : '任务沿用所选项目的配置、权限和执行环境。')); return;
  }
  let draft = taskCreationDrafts.get(id);
  if (!draft) { draft = { request: '', goal: '', scope: '', criteria: '', endpoint: 'report', envelope: null, receipt: null, sending: false }; taskCreationDrafts.set(id, draft); }
  const layout = element('div', '', 'task-create-layout'), form = document.createElement('form'), set = document.createElement('fieldset');
  form.className = 'project-form task-create-form'; set.disabled = true;
  const original = textarea('request', draft.request, { rows: 4, required: true, maxLength: 16000 });
  const goal = textarea('goal', draft.goal, { rows: 2, required: true, maxLength: 16000 });
  const scope = textarea('scope', draft.scope, { rows: 3, required: true, maxLength: 16000 });
  const criteria = textarea('criteria', draft.criteria, { rows: 4, required: true, maxLength: 16000 });
  const endpoint = document.createElement('select'); endpoint.name = 'endpoint';
  endpoint.setAttribute('aria-label', '交付类型');
  endpoint.add(new Option('报告 / 分析产物', 'report')); endpoint.add(new Option('可检视的代码 PR', 'reviewable_pull_request')); endpoint.value = draft.endpoint;
  for (const [key, control] of Object.entries({ request: original, goal, scope, criteria, endpoint })) {
    control.addEventListener('input', () => { draft[key] = control.value; });
    control.addEventListener('change', () => { draft[key] = control.value; });
  }
  set.append(field('原始需求', original), field('任务目标', goal), field('工作范围（每行一项）', scope), field('验收条件（每行一项）', criteria), field('交付类型', endpoint));
  set.append(note('代码 PR 仍需项目与执行角色的代码和 PR 权限、验证及独立 QA；创建 PR 后仍须按仓库规则合入。'));
  const submit = element('button', '提交任务'); submit.type = 'submit'; submit.disabled = true;
  const feedback = element('div', '', 'task-create-feedback'); feedback.setAttribute('role', 'alert');
  form.append(set, feedback, submit);
  const context = card('执行上下文'), contextBody = element('div'), reload = button('重新读取执行上下文', () => void readContext(), 'quiet');
  context.setAttribute('role', 'region'); context.setAttribute('aria-label', '执行上下文');
  context.append(contextBody, reload, note('从控制台以当前身份发起，沿用项目的角色流程和创建时配置。页面不会增加写入权限。'), consoleLink('#/projects/' + id + '/roles', '查看角色与 Manager'), consoleLink('#/projects/' + id + '/basic', '查看项目设置'));
  const receiptBox = element('section', '', 'task-create-receipt'); receiptBox.setAttribute('aria-label', '创建任务回执'); receiptBox.setAttribute('aria-live', 'polite');
  layout.append(form, context); root.append(layout, receiptBox);
  let effective = null, contextVersion = 0;
  const sync = () => { set.disabled = !effective?.task_creation?.allowed || !!draft.envelope || draft.sending; submit.disabled = set.disabled; reload.disabled = draft.sending; };
  function revoked(err) {
    if (![401, 403, 404].includes(err.status)) return false;
    taskCreationDrafts.delete(id); effective = null;
    root.replaceChildren(consoleState('任务创建权限已变化', '本页草稿已清除。请重新打开当前有权访问的项目。', { tone: 'error' }), consoleLink('#/projects', '返回项目列表')); return true;
  }
  async function readContext() {
    const version = ++contextVersion; effective = null; sync(); contextBody.replaceChildren(note('正在核对当前项目与执行权限…'));
    try {
      const result = await api('/api/management/query', 'POST', { operation: 'get_effective_config', target: { project_id: id }, arguments: {} });
      if (!alive() || version !== contextVersion) return;
      effective = result;
      contextBody.replaceChildren(element('p', '当前身份：' + me.username), element('p', '项目：' + repositories.find(repo => String(repo.id) === id).full_name),
        note(result.task_creation?.allowed ? '当前允许提交任务；服务端将在提交时重新核验配置、预算和授权。' : taskCreationError(result.task_creation?.reason || '无法确认创建权限')));
    } catch (err) {
      if (!alive() || version !== contextVersion) return;
      if (!revoked(err)) contextBody.replaceChildren(consoleState('执行上下文未能读取', err.message, { tone: 'error' }));
    } finally { if (alive() && version === contextVersion) sync(); }
  }
  function showReceipt() {
    receiptBox.replaceChildren();
    const receipt = draft.receipt;
    if (!receipt) {
      if (draft.envelope) {
        receiptBox.append(consoleState('提交结果待核实', '保留本页草稿，核对同一次提交的回执；此时不能改写需求或重新创建。重新载入网页会丢失本页草稿，应先在管理审计中核对结果。', { tone: 'error' }));
        const retry = button('核对同一次提交', () => void send()); retry.disabled = draft.sending; receiptBox.append(retry);
      }
      return;
    }
    const names = { succeeded: '任务已创建', failed: '创建未成功', pending: '命令已接收', executing: '命令处理中', unknown: '结果待核实', rejected: '已拒绝' };
    const created = receipt.state === 'succeeded' && typeof receipt.result?.id === 'string';
    receiptBox.append(element('h2', receipt.state === 'succeeded' && !created ? '命令完成，任务编号待核验' : names[receipt.state] || '命令状态：' + receipt.state), note('回执编号：' + receipt.id));
    if (receipt.state === 'succeeded' && typeof receipt.result?.id === 'string') {
      receiptBox.append(note('任务编号：' + receipt.result.id), button('查看已创建的任务', async () => {
        try { await openTask(receipt.result.id); } catch (err) { if (alive()) feedback.textContent = err.message; }
      }), button('再建一个任务', () => { taskCreationDrafts.delete(id); void renderNewTask(++renderVersion); }, 'quiet'));
    } else if (receipt.state === 'failed' || receipt.state === 'rejected') {
      receiptBox.append(note(taskCreationError(receipt.result?.error || receipt.state)), button('返回草稿并重新核验', async () => {
        draft.envelope = null; draft.receipt = null; draft.uncertain = false; feedback.replaceChildren(); showReceipt(); await readContext();
      }, 'quiet'));
    } else {
      receiptBox.append(note('回执尚未确认任务创建成功。'));
      const refresh = button('刷新创建回执', async () => {
        refresh.disabled = true;
        try { const result = await api('/api/management/commands/' + receipt.id); draft.receipt = result; if (alive()) showReceipt(); }
        catch (err) { if (alive() && !revoked(err)) feedback.textContent = err.message; }
        finally { refresh.disabled = false; }
      }, 'quiet'); receiptBox.append(refresh);
    }
  }
  draft.update = () => { if (alive()) { feedback.textContent = draft.error || ''; sync(); showReceipt(); } };
  async function send() {
    if (draft.sending || !draft.envelope) return;
    const replay = !!draft.uncertain;
    draft.sending = true; draft.error = '正在提交并核对服务端回执…'; draft.update();
    try {
      draft.receipt = await api('/api/management/commands', 'POST', draft.envelope);
      draft.error = '';
    } catch (err) {
      // A definitive pre-command rejection permits editing. An uncertain earlier attempt keeps its original key.
      if (!replay && err.status >= 400 && err.status < 500 && !/idempotency_conflict/.test(err.message)) {
        draft.envelope = null;
        draft.error = err.message + '。草稿已保留，请核对执行上下文后重试。';
        if (alive() && !revoked(err)) await readContext();
      } else { draft.uncertain = true; draft.error = err.message + '。请核对同一次提交；不自动重新创建。'; if (alive()) revoked(err); }
    }
    finally { draft.sending = false; draft.update?.(); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (submit.disabled || draft.envelope || !form.reportValidity()) return;
    const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
    const values = { request: original.value.trim(), goal: goal.value.trim(), scope: lines(scope.value), criteria: lines(criteria.value) };
    if (!values.request || !values.goal || !values.scope.length || !values.criteria.length || values.scope.length > 100 || values.criteria.length > 100) {
      feedback.textContent = '需求和目标不能为空，工作范围与验收条件各需 1–100 项。'; return;
    }
    const key = 'console-task:' + crypto.randomUUID();
    draft.uncertain = false;
    draft.envelope = { operation: 'task.create', target: { project_id: id }, arguments: { request: values.request, contract: { goal: values.goal, scope: values.scope, criteria: values.criteria, endpoint: endpoint.value } },
      expected_revision: effective.revision, idempotency_key: key, source_conversation: 'console:new-task', source_message: key };
    void send();
  });
  showReceipt(); await readContext();
}
