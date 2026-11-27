// Fields of an unsaved model, saved as a provider of its own: the provider's name (blank: the server names it after the
// host, adding -2, -3 … when taken) and interface, URL with its resolved addresses, key, name with an optional pick from
// the upstream list.
function modelFields(repositoryId) {
  const provider = input('provider_name', '', { maxLength: 100, placeholder: '留空则用地址主机名，重名时自动加序号' }), protocol = interfaceSelect(), protocolHint = element('p', '', 'muted provider-protocol-hint');
  const url = input('api_url', '', { type: 'url', required: true, placeholder: 'https://example.com/v1' }), key = input('api_key', '', { type: 'password', required: true, autocomplete: 'new-password' });
  const name = input('model_name', '', { required: true, maxLength: 200 }), picker = document.createElement('select'), pick = field('从上游列表选用', picker);
  const preview = element('div', '', 'endpoint-preview'), result = probeResult(), actions = element('div', '', 'actions probe-actions');
  preview.setAttribute('aria-live', 'polite'); pick.hidden = true;
  picker.addEventListener('change', () => { if (picker.value) name.value = picker.value; });
  // A changed address, interface or key makes earlier upstream answers stale.
  const stale = () => { result.dataset.request = String(Number(result.dataset.request || 0) + 1); result.replaceChildren(); pick.hidden = true; picker.replaceChildren(); };
  const hint = value => { protocolHint.textContent = protocol.value !== 'auto' ? `使用 ${interfaceName(protocol.value)}（手动）。` : value ? `自动推断：${protocolText(value)}${value.source === 'url' ? '，地址已指明接口' : '；目录里有记录的模型按目录推断'}。` : '自动推断：填写地址后显示。'; };
  const refresh = watchEndpoint(url, preview, stale, () => protocol.value, hint);
  protocol.addEventListener('change', () => { stale(); hint(null); refresh(0); });
  key.addEventListener('input', stale); hint(null);
  const missing = labels => () => { const empty = labels.filter(([el]) => !el.value.trim()).map(([, label]) => label); return empty.length ? `先填写${empty.join('、')}` : ''; };
  const target = () => ({ repository_id: repositoryId, api_url: url.value.trim(), api_key: key.value, interface_type: protocol.value });
  actions.append(
    probeButton('获取模型列表', result, () => api('/api/models/upstream', 'POST', target()), value => {
      if (!value.ok) return listOutcome(value);
      picker.replaceChildren(new Option(value.models.length ? '选择一个模型 id' : '上游没有列出模型', ''), ...value.models.map(id => new Option(id, id)));
      pick.hidden = !value.models.length;
      return [...listOutcome(value).slice(0, 1), note('可以在「从上游列表选用」中选择，也可以在「模型名」里直接填写列表外的名字。')];
    }, missing([[url, '接口 URL'], [key, 'API Key']])),
    probeButton('测试模型', result, () => api('/api/models/test', 'POST', { ...target(), model_name: name.value.trim() }), testOutcome, missing([[url, '接口 URL'], [key, 'API Key'], [name, '模型名']])));
  return [field('供应商名称', provider), field('接口 URL', url), note(modelUrlRule), field('接口协议', protocol), protocolHint, preview, field('API Key', key), field('模型名', name), pick, actions, result];
}

// #1078: this row is a live region, and a reader announces any child-node change inside it — including the same words
// written again. The poll re-answers every five seconds, so the sentence and the class are only written when they really
// differ; re-assigning an unchanged answer would interrupt the reader with nothing new.
function writeActionsStatus(message, text, className) {
  if (message.className !== className) message.className = className;
  if (message.textContent !== text) message.textContent = text;
}

// #1079: the policy sentence describes what the check does, not what this read found, so it does not live in the live
// region: it is the muted note beside it, and the row only keeps a result. Keeping the two apart stops a reader from
// taking "配置检查通过后…" for an answer, and drops the ASCII space that used to join them after a Chinese full stop.
const actionsPolicySentence = '配置检查通过后随 Webhook 处理，并每 10 分钟补扫一次，发现符合条件的失败运行后交给 Manager。';
const actionsPolicyNote = message => message.parentElement?.querySelector('[data-actions-policy]') ?? null;
function writeActionsPolicy(policy, text) {
  if (!policy) return;
  if (policy.textContent !== text) policy.textContent = text;
  policy.hidden = !text;
}

// #878: the status is redrawn from `current` every time the card is built, so the expired marker lives in state (`read`)
// rather than only in this node. A failed refresh keeps the last readable answer and says it may no longer be current.
function showActionsFailureStatus(message, status, read, policy = actionsPolicyNote(message)) {
  const readable = status?.error ? status.error === 'actions_workflow_run_subscription_missing'
    ? '配置错误：此仓库使用的 App 安装未订阅 Webhook 事件「Workflow run」，失败运行无法生成排查事件。'
      + `请 App 管理员在 App 设置的 Permissions & events → Subscribe to events 勾选「Workflow run」并保存。${eventPermissionNotes.workflow_run}`
    : status.error === 'actions_permission_missing'
    ? '配置错误：此仓库使用的 App 安装没有 Actions 权限，GitHub 也不会向它投递「Workflow run」事件，Actions 失败分析已停止。'
      + '请 App 管理员在 Permissions & events 为 Actions 授予至少「Read-only」，再由安装所有者接受新权限。不需要 Workflows 权限。'
    : /^model_/.test(status.error) ? `Actions 失败分析在等模型：${status.error}。请在「模型」页检查项目默认模型，或在「角色」页检查对应角色的模型设置。`
    : `Actions 失败处理已暂停：${status.error}。请检查账号授权或日志读取状态。`
    : status ? actionsPolicySentence : '等待检查 App 事件订阅。';
  const result = read ? `读取失败，${read.at
    ? `显示上次结果（上次成功读取：${timestamp(read.at)}），可能已过期。` : '暂时没有可显示的上次结果。'}` : '';
  // A configuration error is an answer of its own, so it keeps the warning style and the row; only the policy sentence
  // steps out into the note, where the reader finds it as context rather than as the result of this read.
  const separate = Boolean(result) && !status?.error;
  writeActionsStatus(message, separate ? result : result ? readable + result : readable, status?.error ? 'endpoint-warning' : 'muted');
  writeActionsPolicy(policy, separate ? readable : '');
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
      // The check has stopped for good, so the policy sentence it used to describe is no longer true either.
      if (message) { writeActionsStatus(message, '配置检查已停止：当前身份无法读取这个仓库的设置。请刷新身份或联系管理员后重新打开本页。', 'endpoint-warning'); writeActionsPolicy(actionsPolicyNote(message), ''); }
      return;
    }
    current.actionsFailuresRead = { at: current.actionsFailuresSeenAt || null }; current.actionsFailuresDelay = answer.delay; delay = answer.delay;
    const message = document.querySelector('[data-actions-status]');
    if (message) showActionsFailureStatus(message, current.actionsFailures, current.actionsFailuresRead);
  }
  if (token === renderToken) projectTimer = setTimeout(() => refreshActionsFailureStatus(token), delay);
}
