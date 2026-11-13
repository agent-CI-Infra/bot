titles.identity = t('identity.title');
// Every code the GitHub login callback can put in ?auth_error (src/server.ts routes HttpError.code there), in words. A
// code this page does not know keeps the fallback sentence, which never prints the raw code: a code names an internal
// condition, not something the person can act on. Copy is looked up by code so it can follow the UI language (#527).
function identityError(code) {
  const key = 'identity.error.' + code;
  const text = t(key);
  return text === key ? t('identity.error.fallback') : text;
}
// A stalled reverify must not leave the button on "正在验证…" with no explanation.
const IDENTITY_REFRESH_TIMEOUT_MS = 20_000;
let identityRefreshNotice = '';
let identityRefreshNoticeIsError = false;
function identityRefreshError(err) {
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return t('identity.error.refresh_timeout');
  }
  if (err && err.code) return identityError(err.code);
  return (err && err.message) || t('identity.error.fallback');
}

// Identity times use the browser zone and name it, so "05:20" is not mistaken for UTC. Expiry is the remaining time ("还剩 N 分钟") plus the absolute time.
function identityTimezoneLabel(date) {
  const offset = -date.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-', abs = Math.abs(offset);
  const hours = Math.floor(abs / 60), minutes = abs % 60;
  return minutes ? `UTC${sign}${hours}:${String(minutes).padStart(2, '0')}` : `UTC${sign}${hours}`;
}
function identityTime(value) {
  const text = timestamp(value);
  if (!text) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return text;
  return t('identity.time_with_zone', { time: text, zone: identityTimezoneLabel(date) });
}
function identityExpiry(value) {
  if (value == null || value === '') return t('identity.expires_unknown');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return timestamp(value) || t('identity.expires_unknown');
  const absolute = identityTime(value), ms = date.getTime() - Date.now();
  if (ms <= 0) return t('identity.expiry.expired', { time: absolute });
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return t('identity.expiry.minutes', { minutes, time: absolute });
  const hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours < 24) return rest ? t('identity.expiry.hours_minutes', { hours, minutes: rest, time: absolute }) : t('identity.expiry.hours', { hours, time: absolute });
  const days = Math.floor(hours / 24);
  return t('identity.expiry.days', { days, time: absolute });
}

// A grant's state in words. `reason` is an additive server field: an older server omits it and every grant
// keeps the combined sentence it had before, so nothing here depends on it being present.
function grantStateText(grant, { short = false } = {}) {
  if (grant.reason) {
    const key = 'grant.reason.' + grant.reason, text = t(key);
    if (text !== key) return text;
  }
  if (short && grant.state === 'pending_verification') return t('grant.pending_short');
  const key = 'grant.' + grant.state, text = t(key);
  return text === key ? grant.state : text;
}
function grantSourceText(source) {
  return source === 'github_derived' ? t('identity.source_derived') : t('identity.source_delegated');
}
function grantRoleText(role) {
  if (role === 'super_admin') return t('identity.role.super_admin');
  const key = 'role.' + role, text = t(key);
  return text === key ? role : text;
}
function grantExpiryText(grant) {
  if (grant.expires_at == null) return grant.source === 'github_derived' ? t('identity.expires_derived') : t('identity.expires_unset');
  return identityExpiry(grant.expires_at);
}
// github_connection.status / next_step from the API are Chinese; the page translates by state code (#527).
function githubConnectionStatus(connection) {
  if (!connection || !connection.state) return '';
  const pending = (connection.pending_repositories || []).length;
  return t('identity.github.status.' + connection.state, { count: connection.repository_count, pending });
}
function githubConnectionNextStep(connection) {
  if (!connection || !connection.state) return '';
  const key = 'identity.github.next.' + connection.state, text = t(key);
  return text === key ? (connection.next_step || '') : text;
}

function githubReturnMessage(setup, auth) {
  if (setup === 'waiting_sync') return t('identity.return.waiting_sync');
  if (setup === 'ready') return t('identity.return.ready');
  if (setup === 'waiting_approval') return t('identity.return.waiting_approval');
  if (setup === 'access_revoked') return t('identity.return.access_revoked');
  if (setup === 'waiting_identity') return t('identity.return.waiting_identity');
  if (setup) return t('identity.return.setup');
  if (auth) return t('identity.return.auth');
  return t('identity.return.refreshed');
}

// After GitHub OAuth or App setup, the server 303s back with a query flag. Refresh once, show the result, and drop the flag so a later render does not repeat it.
async function applyGithubReturn(current) {
  const params = new URLSearchParams(location.search);
  const setup = params.get('github_setup');
  const auth = params.get('github_auth');
  if (setup === null && auth === null) return false;
  const url = new URL(location.href);
  url.searchParams.delete('github_setup');
  url.searchParams.delete('github_auth');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
  // A Feishu channel-binding return must not wait on an identity refresh or redirect back to GitHub.
  if (/^#\/identity\/feishu/.test(url.hash || location.hash)) return false;
  if (!me || setup === 'waiting_identity') {
    identityRefreshNotice = githubReturnMessage(setup, auth);
    identityRefreshNoticeIsError = false;
    return false;
  }
  const panel = $('identity-panel');
  if (panel) panel.replaceChildren(consoleState(t('identity.return.refreshing'), t('identity.return.refreshing_detail')));
  try {
    await api('/api/identity/refresh', 'POST', {}, { signal: AbortSignal.timeout(IDENTITY_REFRESH_TIMEOUT_MS) });
    if (!current()) return true;
    identityRefreshNotice = githubReturnMessage(setup, auth);
    identityRefreshNoticeIsError = false;
    await start();
    return true;
  } catch (err) {
    if (!current()) return true;
    identityRefreshNotice = identityRefreshError(err);
    identityRefreshNoticeIsError = true;
    if (err && err.code === 'github_reauthorization_required') {
      try {
        const result = await api('/api/identity/github/bind', 'POST', {});
        if (current()) {
          await new Promise(resolve => setTimeout(resolve, 400));
          if (current()) location.assign(result.url);
        }
        return true;
      } catch (bindErr) {
        if (current()) {
          identityRefreshNotice = identityRefreshError(bindErr);
          identityRefreshNoticeIsError = true;
        }
        return false;
      }
    }
    return false;
  }
}

function attachGithubReverify(button, { current, feedback }) {
  const label = t('identity.reverify');
  button.addEventListener('click', async () => {
    button.disabled = true; button.textContent = t('identity.reverifying');
    feedback.className = 'view-error'; feedback.setAttribute('role', 'alert'); feedback.textContent = '';
    try {
      const result = await api('/api/identity/refresh', 'POST', {}, { signal: AbortSignal.timeout(IDENTITY_REFRESH_TIMEOUT_MS) });
      if (!current()) return;
      if (result.status === 'active') {
        identityRefreshNotice = t('identity.reverified');
        identityRefreshNoticeIsError = false;
      } else {
        identityRefreshNotice = identityError('github_permission_pending');
        identityRefreshNoticeIsError = true;
      }
      await start();
    } catch (err) {
      if (!current()) return;
      feedback.className = 'view-error'; feedback.setAttribute('role', 'alert');
      feedback.textContent = identityRefreshError(err);
      if (err && (err.code === 'github_reauthorization_required' || err.code === 'github_oauth_failed')) {
        try {
          const result = await api('/api/identity/github/bind', 'POST', {});
          if (current()) {
            await new Promise(resolve => setTimeout(resolve, 400));
            if (current()) location.assign(result.url);
          }
        } catch (bindErr) {
          if (current()) feedback.textContent = identityRefreshError(err);
        }
      }
    } finally { button.disabled = false; button.textContent = label; }
  });
}
async function startGithubAuthorize(feedback, current) {
  feedback.textContent = '';
  const result = await api('/api/identity/github/bind', 'POST', {});
  if (current()) location.assign(result.url);
}

async function renderIdentity() {
  titles.identity = t('identity.title');
  const panel = $('identity-panel'), request = renderVersion;
  const current = () => request === renderVersion;
  if (await applyGithubReturn(current)) return;
  panel.classList.remove('identity-feishu-page');
  // Organization and repository admins add and manage their organization's Feishu apps here, with the same wizard
  // super administrators use in global settings (#424).
  if (/^#\/identity\/feishu-apps(?:\/|$)/.test(location.hash)) {
    const setup = element('div', '', 'feishu-setup');
    panel.replaceChildren(consoleState(t('identity.feishu_apps_loading'), t('identity.feishu_apps_loading_detail')));
    try { await renderFeishuSetup(setup, request); }
    catch (err) { if (current()) panel.replaceChildren(consoleState(t('identity.feishu_apps_failed'), feishuError(err), { tone: 'error', retry: () => render().catch(error) })); return; }
    if (current()) { $('count').textContent = ''; panel.replaceChildren(setup, channelLink('#/identity/feishu', t('identity.back_feishu'))); }
    return;
  }
  const feishuBindings = /^#\/identity\/feishu(?:$|\?|\/)/.test(location.hash);
  panel.classList.toggle('identity-feishu-page', feishuBindings);
  if (feishuBindings) {
    $('count').textContent = '';
    await renderFeishuBindingsPage(panel, current);
    return;
  }
  let data;
  panel.replaceChildren(consoleState(t('identity.loading'), t('identity.loading_detail')));
  try { data = await api('/api/identity'); }
  catch (err) {
    if (current()) panel.replaceChildren(consoleState(t('identity.load_failed'), err.message, { tone: 'error', retry: () => render().catch(error) }));
    return;
  }
  if (!current()) return;
  $('count').textContent = '';
  const scopes = data.scopes.filter(g => !data.actor.tenant_id || !g.tenant_id || g.tenant_id === data.actor.tenant_id);
  const active = scopes.filter(g => g.state === 'active'), pending = scopes.filter(g => g.state !== 'active');
  const connection = data.github_connection;
  const overview = card(t('identity.github_connection')); overview.classList.add('identity-overview');
  const statusText = connection ? githubConnectionStatus(connection) : (active.length ? t('identity.logged_in_with_grants') : t('identity.logged_in_no_grants'));
  overview.append(element('p', statusText, 'identity-connection-status'));
  if (connection && connection.state) {
    const next = githubConnectionNextStep(connection); if (next) overview.append(note(next));
  } else if (!connection) overview.append(note(active.length ? t('identity.overview_note_advanced') : t('identity.overview_note_connect')));
  const pendingRepos = (connection && connection.pending_repositories) || [];
  if (pendingRepos.length) {
    const list = element('ul', '', 'identity-pending-repos');
    list.setAttribute('aria-label', t('identity.pending_repos'));
    for (const repo of pendingRepos) {
      const item = element('li', '');
      item.append(element('strong', repo.full_name), element('span', t('identity.pending_repo_status'), 'status status-warning'));
      list.append(item);
    }
    overview.append(list);
  }
  const feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'alert');
  if (identityRefreshNotice) {
    feedback.className = identityRefreshNoticeIsError ? 'view-error' : 'view-success';
    feedback.setAttribute('role', identityRefreshNoticeIsError ? 'alert' : 'status');
    feedback.textContent = identityRefreshNotice; identityRefreshNotice = ''; identityRefreshNoticeIsError = false;
  }
  const githubEnabledButtons = [];
  const action = connection && connection.action;
  if (action === 'choose_repos' && connection.install_url) {
    // A public GitHub App install URL only. The App owner's settings page is never linked here.
    // Click mints a setup `state` so GitHub can return to this console instead of a JSON error page.
    const go = element('a', t('identity.choose_repos'), 'button-link identity-primary');
    go.href = rewriteGithubAppInstallUrl(connection.install_url); go.rel = 'noopener noreferrer';
    go.addEventListener('click', async (event) => {
      event.preventDefault();
      if (go.getAttribute('aria-busy') === 'true') return;
      go.setAttribute('aria-busy', 'true'); feedback.textContent = '';
      try {
        const result = await api('/api/identity/github/install', 'POST', {});
        if (current() && result.url) location.assign(result.url);
      } catch (err) {
        if (current()) feedback.textContent = identityRefreshError(err);
        go.removeAttribute('aria-busy');
      }
    });
    overview.append(go);
  } else if (action === 'connect') {
    const connect = element('button', t('identity.connect_github'), 'identity-primary'); connect.disabled = true;
    connect.addEventListener('click', async () => { connect.disabled = true; try { await startGithubAuthorize(feedback, current); } catch (err) { if (current()) feedback.textContent = identityRefreshError(err); connect.disabled = false; } });
    overview.append(connect); githubEnabledButtons.push(connect);
  } else if (action === 'reconnect') {
    const reconnect = element('button', t('identity.reconnect'), 'identity-primary'); reconnect.disabled = true;
    reconnect.addEventListener('click', async () => { reconnect.disabled = true; try { await startGithubAuthorize(feedback, current); } catch (err) { if (current()) feedback.textContent = identityRefreshError(err); reconnect.disabled = false; } });
    overview.append(reconnect); githubEnabledButtons.push(reconnect);
  } else if (action === 'reverify') {
    const reverify = element('button', t('identity.reverify'), 'identity-primary'); reverify.disabled = true;
    attachGithubReverify(reverify, { current, feedback });
    overview.append(reverify); githubEnabledButtons.push(reverify);
  }
  const disabledHint = element('p', '', 'muted identity-disabled-hint');
  disabledHint.hidden = true;
  overview.append(feedback, disabledHint);
  const selection = card(t('identity.scope')), select = document.createElement('select'), form = document.createElement('form');
  select.setAttribute('aria-label', t('identity.tenant_label'));
  const platform = data.scopes.some(s => s.scope === 'platform');
  select.add(new Option(platform ? t('identity.tenant_platform') : t('identity.tenant_all'), ''));
  for (const tenant of data.tenants) select.add(new Option(`${tenant.display_name.split('/')[0]} · ${tenant.github_account_id}`, tenant.id));
  select.value = data.actor.tenant_id || '';
  const switcher = element('button', t('identity.switch_org')); switcher.type = 'submit'; form.append(select, switcher);
  const switchMessage = element('p', '', 'view-error'); switchMessage.setAttribute('role', 'alert');
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (switcher.disabled) return;
    switcher.disabled = true; select.disabled = true; switchMessage.textContent = '';
    try { await api('/api/identity/tenant', 'POST', { tenant_id: select.value || null }); if (current()) await start(); }
    catch (err) { if (current()) switchMessage.textContent = err.message; }
    finally { switcher.disabled = false; select.disabled = false; }
  });
  form.className = 'identity-scope-form';
  selection.append(form, switchMessage, note(t('identity.scope_note')), facts([[t('identity.auth_revision'), String(data.actor.authorization_revision)]]));
  const identities = card(t('identity.bindings'));
  identities.append(note(t('identity.bindings_note')));
  const provider = element('div', '', 'identity-provider'), actions = element('div', '', 'actions');
  const advancedFeedback = element('p', '', 'view-error'); advancedFeedback.setAttribute('role', 'alert');
  const bind = element('button', t('identity.bind_github')); bind.disabled = true;
  bind.addEventListener('click', async () => { bind.disabled = true; try { await startGithubAuthorize(advancedFeedback, current); } catch (err) { if (current()) advancedFeedback.textContent = identityRefreshError(err); bind.disabled = false; } });
  githubEnabledButtons.push(bind);
  // When reverify is already the front-page action, do not put a second identical button here.
  let refresh = null;
  if (action !== 'reverify') {
    refresh = element('button', t('identity.reverify'), 'quiet'); refresh.disabled = true;
    attachGithubReverify(refresh, { current, feedback: advancedFeedback });
    githubEnabledButtons.push(refresh);
    actions.append(bind, refresh);
  } else actions.append(bind);
  identities.append(actions, advancedFeedback, provider);
  for (const identity of data.identities.filter(i => i.provider !== 'feishu')) {
    const row = element('div', '', 'row'), stateLabel = ({ active: t('identity.binding_active'), pending_verification: t('identity.binding_pending'), revoked: t('identity.binding_revoked') })[identity.status] || identity.status;
    row.classList.add('identity-binding');
    row.append(element('strong', identity.display_name), element('span', `${identity.provider} · ${stateLabel}`),
      facts([[t('identity.binding_source'), identity.host || identity.provider], [t('identity.last_verified'), identity.verified_at ? identityTime(identity.verified_at) : t('identity.never_verified')]]));
    if (identity.status !== 'revoked') {
      const revoke = element('button', t('identity.unbind'), 'quiet');
      revoke.addEventListener('click', async () => {
        if (!confirm(t('identity.unbind_confirm'))) return;
        revoke.disabled = true; advancedFeedback.textContent = '';
        try { await api('/api/identity/bindings/' + encodeURIComponent(identity.id), 'DELETE', {}); if (current()) await start(); } catch (err) { if (current()) advancedFeedback.textContent = err.message; revoke.disabled = false; }
      }); row.append(revoke);
    }
    identities.append(row);
  }
  const permissions = card(t('identity.permissions'));
  permissions.append(note(t('identity.permissions_note')));
  const activeList = element('div', '', 'identity-grants'), history = element('details', '', 'fold identity-history');
  activeList.setAttribute('aria-label', t('identity.active_list')); history.append(element('summary', t('identity.history_summary', { count: pending.length })));
  history.open = !active.length && pending.length > 0;
  for (const grant of [...active, ...pending]) {
    const row = element('div', '', 'row perm-row'), source = grantSourceText(grant.source);
    const scope = grant.project_id ? t('identity.scope_project', { id: grant.project_id }) : grant.tenant_id || t('identity.scope_platform');
    row.append(element('strong', grantRoleText(grant.role)),
      element('p', `${source} · ${scope}`),
      element('p', grantStateText(grant)), facts([[t('identity.last_verified'), grant.verified_at ? identityTime(grant.verified_at) : t('identity.verified_missing')],
        [t('identity.expires'), grantExpiryText(grant)]]));
    const capabilities = element('details', '', 'fold'); capabilities.append(element('summary', t('identity.capabilities')), element('p', t('identity.capabilities_prefix') + grant.capabilities.join(', '))); row.append(capabilities);
    if (grant.state !== 'active') row.append(note(grant.state === 'revoked' ? t('identity.revoked_note') : t('identity.inactive_note')));
    (grant.state === 'active' ? activeList : history).append(row);
  }
  permissions.append(activeList); if (pending.length) permissions.append(history);
  if (!active.length) permissions.append(note(t('identity.no_grants')));
  const feishuSlot = element('div', '', 'identity-feishu');
  // A nested loading line must not use role=status: the identity refresh notice is the panel's status.
  feishuSlot.append(element('p', t('identity.feishu_loading'), 'muted'));
  const diagnostic = card(t('identity.diagnostics'));
  diagnostic.append(facts([
    [t('identity.system_username'), me.username],
    [t('identity.org'), data.tenants.find(t => t.id === data.actor.tenant_id)?.display_name || (data.actor.tenant_id ? data.actor.tenant_id : t('identity.all_authorized'))],
    [t('identity.active_management'), t('identity.grant_count', { count: active.length })],
    [t('identity.inactive_grants'), t('identity.grant_count', { count: pending.length })],
    [t('identity.page_read_at'), identityTime(Date.now())]
  ]), note(active.length ? t('identity.diagnostic_note_active') : t('identity.overview_note_empty')));
  const advanced = element('details', '', 'fold identity-advanced');
  advanced.append(element('summary', t('identity.advanced')), diagnostic, selection, identities, permissions);
  const layout = element('div', '', 'identity-layout'); layout.append(overview, feishuSlot, advanced); panel.replaceChildren(layout);
  const loadProvider = async () => {
    try {
      const { enabled } = await api('/api/auth/github/status'); if (!current()) return;
      for (const b of githubEnabledButtons) b.disabled = !enabled;
      const disabledText = t('identity.github_disabled');
      provider.replaceChildren(...(enabled ? [] : [note(disabledText)]));
      const primaryDisabled = !enabled && githubEnabledButtons.some(b => overview.contains(b));
      disabledHint.textContent = disabledText;
      disabledHint.hidden = !primaryDisabled;
    } catch (err) { if (current()) provider.replaceChildren(consoleState(t('identity.github_status_failed'), err.message, { tone: 'error', retry: () => loadProvider() })); }
  };
  const loadFeishu = async () => {
    try { const data = await api('/api/channels/bindings'), feishu = card(t('identity.feishu_card')); if (typeof notePersonalApps === 'function') notePersonalApps(data); feishu.append(await channelBindingOverview(data)); if (!current()) return; feishuSlot.replaceChildren(feishu); }
    catch (err) { if (current()) feishuSlot.replaceChildren(consoleState(t('identity.feishu_failed'), err.message, { tone: 'error', retry: () => loadFeishu() })); }
  };
  const loading = [loadProvider(), loadFeishu()];
  if (data.actor.tenant_id && data.scopes.some(g => g.state === 'active' && (g.scope === 'platform' || g.scope === 'tenant' && g.tenant_id === data.actor.tenant_id))) {
    const members = card(t('identity.members')); advanced.append(members);
    const loadMembers = async () => {
      let grants;
      try { ({ grants } = await api('/api/identity/grants?tenant_id=' + encodeURIComponent(data.actor.tenant_id))); }
      catch (err) { if (current()) members.replaceChildren(element('h3', t('identity.members')), consoleState(t('identity.members_failed'), err.message, { tone: 'error', retry: () => loadMembers() })); return; }
      if (!current()) return; members.replaceChildren(element('h3', t('identity.members')));
      members.append(note(t('identity.members_note')));
      for (const grant of grants) {
        const row = element('div', '', 'row');
        row.append(element('strong', grant.principal_name), element('p', `${grantSourceText(grant.source)} · ${grant.project_id ? t('identity.scope_project', { id: grant.project_id }) : t('identity.scope_org')}`),
          element('p', grantStateText(grant, { short: true })),
          facts([[t('identity.grantor'), grant.grantor_name || t('identity.grantor_missing')],
            [t('identity.last_verified'), grant.verified_at ? identityTime(grant.verified_at) : t('identity.verified_missing')],
            [t('identity.expires'), grantExpiryText(grant)]]));
        members.append(row);
      }
    }; loading.push(loadMembers());
  }
  await Promise.all(loading);
}
