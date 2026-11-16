// Fields of an unsaved model: URL with its resolved addresses, key, name with an optional pick from the upstream list.
function modelFields(repositoryId) {
  const url = input('api_url', '', { type: 'url', required: true, placeholder: 'https://example.com/v1' }), key = input('api_key', '', { type: 'password', required: true, autocomplete: 'new-password' });
  const name = input('model_name', '', { required: true, maxLength: 200 }), picker = document.createElement('select'), pick = field('从上游列表选用', picker);
  const preview = element('div', '', 'endpoint-preview'), result = probeResult(), actions = element('div', '', 'actions probe-actions');
  preview.setAttribute('aria-live', 'polite'); pick.hidden = true;
  picker.addEventListener('change', () => { if (picker.value) name.value = picker.value; });
  // A changed address or key makes earlier upstream answers stale.
  const stale = () => { result.dataset.request = String(Number(result.dataset.request || 0) + 1); result.replaceChildren(); pick.hidden = true; picker.replaceChildren(); };
  watchEndpoint(url, preview, stale);
  key.addEventListener('input', stale);
  const missing = labels => () => { const empty = labels.filter(([el]) => !el.value.trim()).map(([, label]) => label); return empty.length ? `先填写${empty.join('、')}` : ''; };
  const target = () => ({ repository_id: repositoryId, api_url: url.value.trim(), api_key: key.value });
  actions.append(
    probeButton('获取模型列表', result, () => api('/api/models/upstream', 'POST', target()), value => {
      if (!value.ok) return listOutcome(value);
      picker.replaceChildren(new Option(value.models.length ? '选择一个模型 id' : '上游没有列出模型', ''), ...value.models.map(id => new Option(id, id)));
      pick.hidden = !value.models.length;
      return [...listOutcome(value).slice(0, 1), note('可以在「从上游列表选用」中选择，也可以在「模型名」里直接填写列表外的名字。')];
    }, missing([[url, '接口 URL'], [key, 'API Key']])),
    probeButton('测试模型', result, () => api('/api/models/test', 'POST', { ...target(), model_name: name.value.trim() }), testOutcome, missing([[url, '接口 URL'], [key, 'API Key'], [name, '模型名']])));
  return [field('接口 URL', url), note(modelUrlRule), preview, field('API Key', key), field('模型名', name), pick, actions, result];
}

// #878: the status is redrawn from `current` every time the card is built, so the expired marker lives in state (`read`)
// rather than only in this node. A failed refresh keeps the last readable answer and says it may no longer be current.
function showActionsFailureStatus(message, status, read) {
  message.className = status?.error ? 'endpoint-warning' : 'muted';
  const readable = status?.error ? status.error === 'actions_workflow_run_subscription_missing'
    ? '配置错误：此仓库使用的 App 安装未订阅 Webhook 事件「Workflow run」，Actions 失败分析已停止，不读取运行、不重跑、不提报。'
      + `请 App 管理员在 App 设置的 Permissions & events → Subscribe to events 勾选「Workflow run」并保存。${eventPermissionNotes.workflow_run}`
    : status.error === 'actions_permission_missing'
    ? '配置错误：此仓库使用的 App 安装没有 Actions 权限，GitHub 也不会向它投递「Workflow run」事件，Actions 失败分析已停止。'
      + '请 App 管理员在 Permissions & events 把 Actions 设为「Read and write」（读取运行只需只读，重跑失败的作业需要写），再由安装所有者接受新权限。不需要 Workflows 权限。'
    : /^model_/.test(status.error) ? `Actions 失败分析在等模型：${status.error}。请在「模型」页为 Actions 失败处理选择可用的模型，或检查项目默认模型。`
    : `Actions 失败处理已暂停：${status.error}。请检查账号授权或日志读取状态。`
    : status ? '配置检查通过后每分钟扫描；重复事件和人工重跑共用原运行的一次自动重试预算。' : '等待检查 App 事件订阅。';
  message.textContent = !read ? readable : `${readable} 读取失败，${read.at
    ? `显示上次结果（上次成功读取：${timestamp(read.at)}），可能已过期。` : '暂时没有可显示的上次结果。'}`;
}
async function refreshActionsFailureStatus(token) {
  if (token !== renderToken || current?.section !== 'triggers' || !current.policy.actions_failures_enabled) return;
  let delay = 5000;
  try {
    const value = await api('/api/repositories/' + current.id);
    if (token !== renderToken) return;
    current.actionsFailures = value.actions_failures;
    // #878: this answer read the same row, so it is the newest successful read and drops any expired marker.
    current.actionsFailuresSeenAt = new Date().toISOString(); current.actionsFailuresRead = null; current.actionsFailuresDelay = 0;
    const message = document.querySelector('[data-actions-status]'); if (message) showActionsFailureStatus(message, value.actions_failures);
  } catch (error) {
    if (token !== renderToken) return;
    // #743 / #878: 401/403/404 will not turn readable by asking again, so the scan stops and says why once; anything else
    // may clear by itself, so it keeps retrying with a delay that doubles up to half a minute, and the status says it
    // could not be refreshed instead of passing the last answer off as current.
    const answer = pollAfterError(error, current.actionsFailuresDelay || 0);
    if (answer.terminal) {
      const message = document.querySelector('[data-actions-status]');
      if (message) { message.className = 'endpoint-warning'; message.textContent = '配置检查已停止：当前身份无法读取这个仓库的设置。请刷新身份或联系管理员后重新打开本页。'; }
      return;
    }
    current.actionsFailuresRead = { at: current.actionsFailuresSeenAt || null }; current.actionsFailuresDelay = answer.delay; delay = answer.delay;
    const message = document.querySelector('[data-actions-status]');
    if (message) showActionsFailureStatus(message, current.actionsFailures, current.actionsFailuresRead);
  }
  if (token === renderToken) projectTimer = setTimeout(() => refreshActionsFailureStatus(token), delay);
}
