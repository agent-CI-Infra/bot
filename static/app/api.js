// #715: an expired session is one state for the whole console, not a per-page read failure. The first 401 from a
// signed-in console raises a single banner, the header stops naming a role, and every error card shown while it lasts
// says 登录已过期 with 重新登录 (the page's own wording and the raw code move under 技术信息). A wrong password during
// sign-in (invalid_login) and the signed-out boot check are not expiries.
let sessionExpired = false, sessionBanner = null;
const sessionReturnKey = 'launchpad.session_return_hash';
function isSessionExpiry(status, code) { return code === 'login_required' || (status === 401 && code !== 'invalid_login'); }
function markSessionExpired() {
  if (sessionExpired || !me) return;
  sessionExpired = true; document.body.classList.add('session-expired');
  const banner = element('div', '', 'session-expired-banner'); banner.id = 'session-expired-banner'; banner.setAttribute('role', 'alert');
  banner.append(element('span', t('session.expired_banner')), button(t('session.sign_in_again'), () => signInAgain(), 'btn-primary'));
  $('main-content').prepend(banner); sessionBanner = banner;
  if (typeof renderCurrentUser === 'function') renderCurrentUser();
  if ($('console-account-role')) $('console-account-role').textContent = currentRoleText();
}
function clearSessionExpired() {
  sessionExpired = false; document.body.classList.remove('session-expired');
  sessionBanner?.remove(); sessionBanner = null;
}
function currentRoleText() {
  if (sessionExpired) return t('session.expired_role');
  return me?.role === 'super_admin' ? t('role.super_admin') : t('role.project_admin');
}
// Sign in again and come back to this address: GitHub sign-in returns to #/identity, so the hash is kept for one boot.
async function signInAgain() {
  try { sessionStorage.setItem(sessionReturnKey, location.hash); } catch {}
  let github = false;
  try { github = !!(await api('/api/auth/github/status')).enabled; } catch {}
  if (github) location.assign('/auth/github/start'); else location.reload();
}
function restoreSessionReturn() {
  let saved = null;
  try { saved = sessionStorage.getItem(sessionReturnKey); sessionStorage.removeItem(sessionReturnKey); } catch {}
  if (!saved || !/^#\/[^\s]*$/.test(saved) || saved === location.hash) return;
  if (new URLSearchParams(location.search).has('github_auth') && location.hash === '#/identity') history.replaceState(null, '', location.pathname + location.search + saved);
}
// The card every error state becomes while the session is expired; what the page itself would have said stays readable.
function sessionExpiredState(title, text) {
  const box = element('div', '', 'console-state console-state-error console-state-session');
  box.setAttribute('role', 'status'); box.setAttribute('data-testid', 'console-state-error'); box.dataset.sessionExpired = 'true';
  if (typeof consoleIcon === 'function') { const mark = consoleIcon('alert'); mark.classList.add('console-state-icon'); box.append(mark); }
  const details = element('details', '', 'console-state-details');
  details.append(element('summary', t('session.technical')), element('code', [title, text].filter(Boolean).join(' · ')));
  box.append(element('h2', t('session.expired_title')), element('p', t('session.expired_text')),
    button(t('session.sign_in_again'), () => signInAgain(), 'btn-secondary'), details);
  return box;
}
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
  if (!response.ok && isSessionExpiry(response.status, value?.error)) markSessionExpired();
  if (!response.ok) throw Object.assign(new Error(value.error === 'authorization_changed' ? '权限已变化，请刷新页面后按当前权限重试。' : value.error === 'note_revision_changed' ? '文件已被其他操作更新，请刷新后再保存。' : `${response.status} · ${value.error}`), { status: response.status, code: typeof value.error === 'string' ? value.error : undefined, ...(value.field ? { field: value.field } : {}), ...(value.detail ? { detail: value.detail } : {}) });
  return value;
}
// #738: the strip carries the semantics of the message now in it, not of whatever error came last. `kind` is the
// announcement — alert writes role=alert and aria-live=assertive, status writes role=status and aria-live=polite — and it
// is written on every notice, so an error cannot leave the strip assertive for the next ordinary message. The static
// aria-live in index.html is overridden either way, which is why both attributes are written. `tone` stays the visual
// class ('view-success' or ''), because it never says whether a message is a failure.
function notice(id, text = '', tone = '', kind = 'status') {
  const box = $(id); box.replaceChildren();
  // #738 review: clearing the shared strip puts its semantics back too — a failed login's alert used to survive into the
  // next message because the only reset lived in the login handler.
  if (!text) { if (id === 'message') { box.setAttribute('role', 'status'); box.setAttribute('aria-live', 'polite'); } return; }
  // #738 review: the shared strip carries the semantics of whichever message it now holds, while a box a page authored
  // keeps its own — #task-error is created as a role=alert box that only ever holds an error, so a caller that forgets
  // `kind` must not downgrade it to a polite status. An explicit `kind: 'alert'` still wins anywhere, and aria-live
  // always follows the role that is written, so a static aria-live in the markup can never contradict it.
  const alert = kind === 'alert' || (id !== 'message' && box.getAttribute('role') === 'alert');
  box.setAttribute('role', alert ? 'alert' : 'status');
  box.setAttribute('aria-live', alert ? 'assertive' : 'polite');
  const close = element('button', '关闭提示', 'quiet'); close.type = 'button'; close.addEventListener('click', () => notice(id));
  box.append(element('span', text, tone), close);
}
// #800: a read that never reached the service put the browser's own English text on the page — "Failed to fetch" in
// Chrome, "NetworkError when attempting to fetch resource." in Firefox, "Load failed" in Safari — because every read
// card interpolated err.message. The wording is chosen by the error's kind, not by matching one browser's sentence: a
// TypeError is the network, an abort is a page switch cancelling a read on purpose, and anything the service answered
// keeps its own message (that is the code #715's technical details already expose, and it is not a network failure).
// Callers end the sentence they build, so these strings carry no trailing full stop.
function readErrorText(err) {
  const name = err && err.name;
  if (name === 'AbortError') return '请求已取消';
  if (err instanceof TypeError || name === 'TypeError' || /failed to fetch|networkerror|network error|load failed|network request failed/i.test(err?.message || '')) return '网络连接失败，请稍后重试';
  const message = (err && err.message) || '';
  return message || '请求失败';
}
function retryErrorText(err) {
  if (/\btask_already_running\b/.test(err.message)) return '这个任务已经在执行或排队，不用再次重试。';
  if (/\btask_not_retryable\b/.test(err.message)) return '这个任务已经结束，不能重试。';
  return readErrorText(err);
}
// A page-level failure is a network failure only when it is one: a programming TypeError (a null lookup inside render)
// keeps its own text, so a crash is never reported to the reader as a dropped connection.
function globalErrorText(err) {
  const name = err && err.name;
  const network = err instanceof TypeError || name === 'TypeError' || /failed to fetch|networkerror|network error|load failed|network request failed/i.test(err?.message || '');
  if (!network) return readErrorText(err);
  if (name === 'AbortError' || /failed to fetch|networkerror|network error|load failed|network request failed/i.test(err?.message || '')) return '网络连接失败，请稍后重试';
  return (err && err.message) || '请求失败';
}
function error(err) { if (sessionExpired && isSessionExpiry(err?.status, err?.code)) return; if (!$('message').childElementCount) notice('message', globalErrorText(err), '', 'alert'); if ($('editor').open) $('editor-error').textContent = globalErrorText(err); }
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
// Fold technical terms out of a first screen: the summary stays visible, the body opens on demand.
function advancedHelp(summary, ...content) {
  const box = document.createElement('details');
  box.className = 'advanced-help';
  box.setAttribute('data-testid', 'advanced-help');
  box.append(element('summary', summary || '高级说明'));
  for (const item of content) box.append(typeof item === 'string' ? element('p', item, 'muted') : item);
  return box;
}
