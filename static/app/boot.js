function timestamp(value) {
  if(value==null||value==='')return '';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
  // Local getters use the browser's time zone, including its offset and daylight-saving rules.
  const pad=(n,width=2)=>String(n).padStart(width,'0');
  return `${pad(date.getFullYear(),4)}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
// A row that appends " · zone" only does so when there is a reading in front of it; otherwise it says so.
function stamped(value, zone) {
  const reading = timestampAt(value, zone);
  return reading ? reading + ' · ' + zone : '时间或时区无法识别';
}
// A row keeps its own wording when the value is missing, and says the value cannot be read when it is there but
// unreadable. timestamp() itself still returns '' for both, so its other 90 call sites (and their .slice() uses) do
// not change.
function timeText(value, fallback = '时间未知') {
  if (value == null || value === '') return fallback;
  return timestamp(value) || '时间或时区无法识别';
}
// The same reading in a named zone, for the rows that keep a " · zone" suffix.
function timestampAt(value, zone) {
  if(value==null||value==='')return '';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const part=type=>parts.find(item=>item.type===type)?.value||'';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}
function options(select, rows, label) { const selected = select.value; while (select.options.length > 1) select.remove(1); rows.forEach(row => select.add(new Option(label(row), row.id))); if (rows.some(row => row.id === selected)) select.value = selected; }
function renderCurrentUser() {
  const who = $('who'), role = currentRoleText();
  const display = userDisplayName(me);
  const full = `${display} · ${role}`;
  who.replaceChildren(); who.title = full;
  const copy = element('span', '', 'current-user-copy'), name = element('span', display, 'current-user-name');
  name.title = full; copy.append(name, element('span', role, 'current-user-role'));
  if (me.github) {
    const avatar = document.createElement('img'); avatar.src = me.github.avatar_url;
    avatar.alt = t('identity.avatar', { login: me.github.login }); avatar.width = 28; avatar.height = 28; avatar.referrerPolicy = 'no-referrer';
    avatar.addEventListener('error', () => avatar.remove());
    who.append(avatar, copy);
  } else who.append(copy);
}
// #873: the card is page-level. Signed out it also takes the login header away; a signed-in start that failed leaves the
// session and its header alone, and only the workspace it could not fill is taken off the screen.
function showBootFailure(err, { keepSession = false } = {}) {
  $('boot').hidden = false;
  $('access').hidden = $('workspace').hidden = $('tabs').hidden = true;
  if (!keepSession) $('identity').hidden = true;
  document.body.classList.remove('board-mode');
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  const message = $('boot-message');
  message.textContent = t('chrome.boot_failed', { message: readErrorText(err) });
  message.setAttribute('role', 'alert'); message.classList.add('view-error');
  $('boot-retry').hidden = false;
}
async function start() {
  let setupState;
  try { setupState = await api('/api/setup'); } catch (err) { showBootFailure(err); return; }
  setup = !setupState.initialized;
  try { me = await api('/api/auth/me'); } catch { me = null; }
  if (me) { clearSessionExpired(); restoreSessionReturn(); }
  if (typeof syncManagementChat === 'function') syncManagementChat();
  // The shell was blank until both requests above answered; the boot line covers that gap and leaves with them.
  $('boot').hidden = true;
  $('access').hidden = !!me; $('workspace').hidden = !me; $('identity').hidden = !me; $('tabs').hidden = !me;
  if (typeof watchGithubVerification === 'function') watchGithubVerification();
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
  $('access-provider-status').textContent = ''; $('access-provider-note').textContent = '';
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
  if (authError) notice('message', identityError(authError), '', 'alert');
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  if (!me) return;
  renderCurrentUser();
  document.querySelectorAll('[data-super]').forEach(el => el.hidden = me.role !== 'super_admin');
  // #549: do not put 存储 back on a project administrator's sidebar. The address still opens; the management area is #550.
  // #873: this is the read that decides whether the signed-in console has anything to show. Before #873 a failure here
  // left the shell open on an empty list and only reached the message strip; it now stops like the signed-out boot does,
  // with the same card and retry, and the session header stays so the reader can see they are still signed in.
  let listed, listedAccounts = accounts;
  try {
    listed = (await api('/api/repositories')).repositories;
    if (me.role === 'super_admin') listedAccounts = (await api('/api/accounts')).accounts;
  } catch (err) {
    // #945: the console is already up and the notice already says this one list could not be read — its button is the
    // retry. A refresh whose read fails again keeps that page and that one retry instead of taking both off the screen.
    if (typeof githubRepositoriesUnreadShowing === 'function' && githubRepositoriesUnreadShowing()) {
      await showRepositoriesUnread(me, err).catch(error); return;
    }
    showBootFailure(err, { keepSession: true }); return;
  }
  accounts = listedAccounts; options($('account-filter'), accounts, a => a.name);
  if(me.role==='super_admin'&&!accounts.length&&(!location.hash||location.hash==='#/'))history.replaceState(null,'','#/settings/onboarding/0');
  else restoreConsoleStart(listed);
  // #945: this read of the whole list is the same read the notice's button makes, so it goes through the one function that
  // counts it as the recovery — clearing the notice and drawing the project picker and the pages from the new list.
  if (!(await applyGithubRepositories(me, listed))) await route();
  if (authError) notice('message', identityError(authError), '', 'alert');
}
if (typeof onLocaleChange === 'function') onLocaleChange(() => start().catch(error));
