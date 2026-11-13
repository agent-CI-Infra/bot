async function api(path, method = 'GET', body, { signal } = {}) {
  const response = await fetch(path, { method, signal, headers: { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf_token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value;
  // A proxy in front of the console can answer with its own page instead of the service's JSON (Cloudflare replaces 502
  // and 504 bodies); say so instead of surfacing a JSON parse error. Aborts and network errors pass through unchanged.
  try { value = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw Object.assign(new Error(`${response.status} · ${response.ok ? '服务返回了无法识别的内容，请刷新页面后重试。' : '入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。'}`),
      { status: response.status, code: 'response_not_json' });
  }
  // authorization_changed has its own guidance; field names the configuration path a validation error concerns
  // (for example roles.reviewer.harness_ref.id).
  if (!response.ok) throw Object.assign(new Error(value.error === 'authorization_changed' ? '权限已变化，请刷新页面后按当前权限重试。' : value.error === 'note_revision_changed' ? '文件已被其他操作更新，请刷新后再保存。' : `${response.status} · ${value.error}`), { status: response.status, code: typeof value.error === 'string' ? value.error : undefined, ...(value.field ? { field: value.field } : {}) });
  return value;
}
function notice(id, text = '', tone = '') {
  const box = $(id); box.replaceChildren();
  if (!text) return;
  const close = element('button', '关闭提示', 'quiet'); close.type = 'button'; close.addEventListener('click', () => notice(id));
  box.append(element('span', text, tone), close);
}
function retryErrorText(err) {
  if (/\btask_already_running\b/.test(err.message)) return '这个任务已经在执行或排队，不用再次重试。';
  if (/\btask_not_retryable\b/.test(err.message)) return '这个任务已经结束，不能重试。';
  return err.message;
}
function error(err) { if (!$('message').childElementCount) notice('message', err.message); if ($('editor').open) $('editor-error').textContent = err.message; }
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
