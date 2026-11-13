function timestamp(value) {
  if(value==null||value==='')return '';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
  // Local getters use the browser's time zone, including its offset and daylight-saving rules.
  const pad=(n,width=2)=>String(n).padStart(width,'0');
  return `${pad(date.getFullYear(),4)}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function options(select, rows, label) { const selected = select.value; while (select.options.length > 1) select.remove(1); rows.forEach(row => select.add(new Option(label(row), row.id))); if (rows.some(row => row.id === selected)) select.value = selected; }
function renderCurrentUser() {
  const who = $('who'), role = me.role === 'super_admin' ? t('role.super_admin') : t('role.project_admin');
  who.replaceChildren();
  if (!me.github) { who.textContent = `${me.username} · ${role}`; return; }
  const avatar = document.createElement('img'); avatar.src = me.github.avatar_url;
  avatar.alt = t('identity.avatar', { login: me.github.login }); avatar.width = 28; avatar.height = 28; avatar.referrerPolicy = 'no-referrer';
  avatar.addEventListener('error', () => avatar.remove());
  const copy = element('span', '', 'current-user-copy'), name = element('span', '@' + me.github.login, 'current-user-name');
  name.title = me.github.login; copy.append(name, element('span', role, 'current-user-role')); who.append(avatar, copy);
}
function showBootFailure(err) {
  $('boot').hidden = false;
  $('access').hidden = $('workspace').hidden = $('identity').hidden = $('tabs').hidden = true;
  document.body.classList.remove('board-mode');
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  const message = $('boot-message');
  message.textContent = t('chrome.boot_failed', { message: err.message });
  message.setAttribute('role', 'alert'); message.classList.add('view-error');
  $('boot-retry').hidden = false;
}
async function start() {
  let setupState;
  try { setupState = await api('/api/setup'); } catch (err) { showBootFailure(err); return; }
  setup = !setupState.initialized;
  try { me = await api('/api/auth/me'); } catch { me = null; }
  if (typeof syncManagementChat === 'function') syncManagementChat();
  // The shell was blank until both requests above answered; the boot line covers that gap and leaves with them.
  $('boot').hidden = true;
  $('access').hidden = !!me; $('workspace').hidden = !me; $('identity').hidden = !me; $('tabs').hidden = !me;
  if (!me) document.body.classList.remove('board-mode');
  $('access-title').textContent = setup ? t('setup.title') : t('login.title');
  $('access-description').textContent = setup ? t('setup.description') : t('login.description');
  $('access-submit').textContent = setup ? t('setup.submit') : t('login.submit');
  $('access-form').elements.password.autocomplete = setup ? 'new-password' : 'current-password';
  $('access-password').type = 'password'; $('access-password-toggle').textContent = t('login.show_password'); $('access-password-toggle').setAttribute('aria-pressed', 'false');
  // The same feedback component stays next to the action that failed, including OAuth callbacks.
  (me ? $('main-content') : $('access-feedback')).append($('message'));
  $('access').dataset.mode = setup ? 'setup' : 'local'; $('access-setup-note').hidden = !setup;
  $('github-login').hidden = true; $('access-local-divider').hidden = true; $('access-provider-retry').hidden = true;
  $('access-provider-status').textContent = ''; $('access-provider-note').textContent = setup ? '' : t('login.local_note');
  if (!me && !setup) {
    try {
      const enabled = (await api('/api/auth/github/status')).enabled;
      $('github-login').hidden = !enabled; $('access-local-divider').hidden = !enabled;
      $('access').dataset.mode = enabled ? 'github' : 'local';
      if (enabled) $('access-provider-note').textContent = t('login.github_note');
    } catch {
      $('access-provider-status').textContent = t('login.github_status_failed'); $('access-provider-retry').hidden = false;
    }
  }

  const channelChallenge = /^#\/identity\/feishu\?challenge=([a-f0-9]{48})$/.exec(location.hash)?.[1];
  $('github-login').href = '/auth/github/start' + (channelChallenge ? '?channel_challenge=' + channelChallenge : '');
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) notice('message', identityError(authError));
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  if (!me) return;
  renderCurrentUser();
  document.querySelectorAll('[data-super]').forEach(el => el.hidden = me.role !== 'super_admin');
  // #549: do not put 存储 back on a project administrator's sidebar. The address still opens; the management area is #550.
  if (typeof applyConsoleNavVisibility === 'function') applyConsoleNavVisibility();
  repositories = (await api('/api/repositories')).repositories;
  if (me.role === 'super_admin') accounts = (await api('/api/accounts')).accounts;
  options($('repository-filter'), repositories, r => r.full_name); options($('account-filter'), accounts, a => a.name);
  if(me.role==='super_admin'&&!accounts.length&&!location.hash)history.replaceState(null,'','#/settings/onboarding/0');
  await route();
  if (authError) notice('message', identityError(authError));
}
if (typeof onLocaleChange === 'function') onLocaleChange(() => start().catch(error));
