$('editor-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  if (editorKind === 'accounts') { if (data.type === 'github_app') delete data.token; else { delete data.private_key; delete data.app_id; } }
  if (editorKind === 'users') { delete data.grants; if (data.role !== 'super_admin') Object.assign(data, chosenGrants(form)); }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { if (editingUser) await api('/api/project-admin-assignments', 'PUT', { user_id: editingUser.id, ...chosenGrants(form) }); else await api('/api/' + editorKind, 'POST', data); $('editor').close(); form.reset(); await start(); } catch (err) { error(err); } finally { submit.disabled = false; }
});
$('cancel').addEventListener('click', () => { $('editor').close(); $('editor-form').reset(); });
$('close-detail').addEventListener('click', () => $('detail').close());
$('boot-retry').addEventListener('click', async () => {
  const retry = $('boot-retry'), message = $('boot-message');
  retry.disabled = true; retry.hidden = true;
  message.textContent = '正在载入…'; message.setAttribute('role', 'status'); message.classList.remove('view-error');
  try { await start(); } catch (err) { error(err); } finally { retry.disabled = false; }
});
let accessPending = false;
$('access-password-toggle').addEventListener('click', () => {
  const password = $('access-password'), shown = password.type === 'password'; password.type = shown ? 'text' : 'password';
  $('access-password-toggle').textContent = shown ? '隐藏密码' : '显示密码'; $('access-password-toggle').setAttribute('aria-pressed', String(shown));
});
$('github-login').addEventListener('click', event => { if (accessPending) event.preventDefault(); });
$('access-provider-retry').addEventListener('click', async () => {
  $('access-provider-retry').disabled = true; try { await start(); } catch (err) { error(err); } finally { $('access-provider-retry').disabled = false; }
});
$('access-form').addEventListener('submit', async event => {
  event.preventDefault(); if (accessPending) return;
  const form = event.currentTarget, data = Object.fromEntries(new FormData(form)), submit = $('access-submit'), initializing = setup;
  const controls = [...form.elements].map(control => [control, control.disabled]);
  accessPending = true; controls.forEach(([control]) => { control.disabled = true; }); form.setAttribute('aria-busy', 'true');
  submit.textContent = initializing ? '正在初始化…' : '正在登录…'; $('github-login').setAttribute('aria-disabled', 'true'); notice('message');
  try {
    await api(initializing ? '/api/setup' : '/api/auth/login', 'POST', data);
    form.reset(); $('message').setAttribute('role', 'status'); const url = new URL(location.href); url.searchParams.delete('auth_error'); history.replaceState(null, '', url);
    try { await start(); } catch (err) { showBootFailure(err); }
  } catch (err) {
    const text = /invalid_login/.test(err.message) ? '用户名或密码不正确，请检查后重试。' : /login_rate_limited/.test(err.message) ? '登录尝试过于频繁，请稍后再试。' : /already_initialized/.test(err.message) ? '系统已经初始化，请使用已有账号登录。' : err instanceof TypeError ? '网络连接失败，请检查连接后重试。已输入的内容仍保留在当前页面。' : err.message;
    if (/already_initialized/.test(err.message)) await start().catch(error);
    notice('message', text); $('message').setAttribute('role', 'alert');
  } finally {
    accessPending = false; controls.forEach(([control, disabled]) => { control.disabled = disabled; }); form.removeAttribute('aria-busy');
    submit.textContent = setup ? '初始化并登录' : '登录'; $('github-login').removeAttribute('aria-disabled');
  }
});
// Signing out returns to the default page, so whoever signs in next does not land on the previous user's page; the wizard
// keeps its address (onboarding.js resets it to the first step).
$('logout').addEventListener('click', async () => {
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave(true)) return;
  try { await api('/api/auth/logout', 'POST', {}); renderVersion++; me = null; tab = 'projects'; if (!onboardingAddress.test(location.hash)) history.replaceState(null, '', location.pathname); repositories=[];accounts=[]; $('rows').replaceChildren();$('detail-body').replaceChildren(); await start(); } catch (err) { error(err); } });
// The address is written without waiting for hashchange, so the page switches in the same click; back and forward still
// fire hashchange and draw the page they return to.
$('tabs').addEventListener('click', async event => { const name = event.target.dataset.tab; if (!name) return;
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  if (name === 'management') { void openManagementPage(projectRoute()?.id || null).catch(error); return; }
  if (location.hash !== tabAddresses[name]) history.pushState(null, '', tabAddresses[name]); offset = 0; route().catch(error); });
$('refresh').addEventListener('click', () => start().catch(error));
// The onboarding dialog calls this once a run reaches a terminal state.
window.refreshIntegrations = () => api('/api/integrations/check', 'POST', {}).then(() => start()).catch(() => {});
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true; $('message').textContent = '正在从 GitHub 同步安装列表…';
  try { const result = await api('/api/installations/sync', 'POST', {}); if (typeof forgetConsoleGaps === 'function') forgetConsoleGaps(); await start(); const conclusion = installationSyncNotice(result); notice('message', conclusion.text, conclusion.tone); }
  catch (err) { notice('message', '安装列表同步失败：' + err.message + '，还不能判断全部正常。'); } finally { $('sync').disabled = false; }
});
$('filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; render().catch(error); });
$('hidden-filter').addEventListener('change', () => { offset = 0; render().catch(error); });
for (const [id, delta] of [['previous', -50], ['next', 50]]) $(id).addEventListener('click', () => { offset += delta; render().catch(error); });
document.addEventListener('DOMContentLoaded',()=>start().catch(error),{once:true});
setInterval(()=>{if(me&&tab==='projects'&&!$('hidden-filter').checked&&!projectRoute()&&!document.querySelector('dialog[open]'))refreshProjectActivity();},5000);
