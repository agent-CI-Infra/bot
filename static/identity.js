titles.identity = '身份与权限';
function identityError(code) {
  return ({ external_identity_conflict: '这个 GitHub 身份已绑定其他账号。请登录原账号解除绑定，或联系管理员处理。',
    github_identity_already_bound: '当前账号已有 GitHub 绑定。请先解除原绑定，再关联新的 GitHub 身份。',
    invalid_oauth_state: '登录验证已过期、已使用或不属于当前浏览器。请重新发起 GitHub 登录。',
    oauth_session_mismatch: '绑定时的本地会话已变化。请重新登录并发起绑定。',
    github_oauth_excessive_scope: '这个 OAuth App 的旧授权包含额外权限。请到 GitHub Settings → Applications → Authorized OAuth Apps 撤销它，再重新登录；管理员应使用专用于登录的新 OAuth App。',
    github_login_configuration_changed: 'GitHub 登录配置已更新，请重新发起登录。',
    github_oauth_failed: 'GitHub 授权失败，请重新授权。', github_oauth_denied: 'GitHub 授权已取消，请重新发起。',
    user_disabled: '账号已停用，请联系管理员。' })[code] || 'GitHub 身份暂时无法验证，请稍后重试或使用本地账号登录。';
}
// A grant's state in words. `reason` is an additive server field: an older server omits it and every grant
// keeps the combined sentence it had before, so nothing here depends on it being present.
function grantStateText(grant) {
  const reason = ({ installation_pending: '安装待同步：GitHub App 安装已更新或尚在同步，稍后会自动重试。',
    permission_pending: '安装或权限待核验：GitHub App 安装已停用或权限范围仍待确认，请重新验证 GitHub 权限。',
    tenant_missing: '归属待处理：这条授权还没有可用的组织，请联系管理员处理。' })[grant.reason];
  if (reason) return reason;
  return ({ active: '有效', pending_verification: '待验证／权限不足，请重新授权', revoked: '已撤销', quarantined: '归属待处理' })[grant.state] || grant.state;
}
async function renderIdentity() {
  const panel = $('identity-panel'), request = renderVersion;
  const current = () => request === renderVersion;
  let data;
  panel.replaceChildren(consoleState('正在读取身份与权限', '正在核对当前会话的组织、身份绑定和授权记录。'));
  try { data = await api('/api/identity'); }
  catch (err) {
    if (current()) panel.replaceChildren(consoleState('身份与权限读取失败', err.message, { tone: 'error', retry: () => render().catch(error) }));
    return;
  }
  if (!current()) return;
  $('count').textContent = '';
  const scopes = data.scopes.filter(g => !data.actor.tenant_id || !g.tenant_id || g.tenant_id === data.actor.tenant_id);
  const active = scopes.filter(g => g.state === 'active'), pending = scopes.filter(g => g.state !== 'active');
  const overview = card('我的身份与有效权限'); overview.classList.add('identity-overview');
  overview.append(facts([['当前账户', me.username], ['当前组织', data.tenants.find(t => t.id === data.actor.tenant_id)?.display_name || (data.actor.tenant_id ? data.actor.tenant_id : '全部已授权范围')],
    ['有效授权', `${active.length} 条`], ['待验证或历史授权', `${pending.length} 条`], ['本次读取', timestamp(Date.now())]]),
    note(active.length ? '下方展示本次读取时的有效授权。实际操作仍由服务端重新校验；身份绑定与项目管理权限分别核验。' : '已登录，尚无有效管理授权。请联系管理员委派，或重新验证 GitHub 权限。'),
    button('刷新身份与授权', () => render().catch(error)));
  const selection = card('当前组织与项目范围'), select = document.createElement('select'), form = document.createElement('form');
  select.setAttribute('aria-label', '当前租户');
  const platform = data.scopes.some(s => s.scope === 'platform');
  select.add(new Option(platform ? '平台全部租户（超级管理员）' : '所有已授权组织与项目', ''));
  for (const tenant of data.tenants) select.add(new Option(`${tenant.display_name.split('/')[0]} · ${tenant.github_account_id}`, tenant.id));
  select.value = data.actor.tenant_id || '';
  const switcher = element('button', '切换组织'); switcher.type = 'submit'; form.append(select, switcher);
  const switchMessage = element('p', '', 'view-error'); switchMessage.setAttribute('role', 'alert');
  form.addEventListener('submit', async e => {
    e.preventDefault(); if (switcher.disabled) return;
    switcher.disabled = true; select.disabled = true; switchMessage.textContent = '';
    try { await api('/api/identity/tenant', 'POST', { tenant_id: select.value || null }); if (current()) await start(); }
    catch (err) { if (current()) switchMessage.textContent = err.message; }
    finally { switcher.disabled = false; select.disabled = false; }
  });
  form.className = 'identity-scope-form';
  selection.append(form, switchMessage, note('选择组织后，项目、任务、日志和配置请求都会限制在该组织内。'), facts([['授权版本', String(data.actor.authorization_revision)]]));
  const identities = card('登录与账号绑定');
  identities.append(note('关联 GitHub 账号时，需同时证明当前平台会话和 GitHub 身份。同名或同邮箱账号不会自动合并，关联本身不会增加管理权限。'));
  const feedback = element('p', '', 'view-error'); feedback.setAttribute('role', 'alert');
  const provider = element('div', '', 'identity-provider'), actions = element('div', '', 'actions');
  const bind = element('button', '绑定 GitHub 账号'); bind.disabled = true;
  bind.addEventListener('click', async () => { bind.disabled = true; feedback.textContent = ''; try { const result = await api('/api/identity/github/bind', 'POST', {}); if (current()) location.assign(result.url); } catch (err) { if (current()) feedback.textContent = err.message; bind.disabled = false; } });
  const refresh = element('button', '重新验证 GitHub 权限', 'quiet'); refresh.disabled = true;
  refresh.addEventListener('click', async () => {
    refresh.disabled = true; refresh.textContent = '正在验证…';
    feedback.textContent = '';
    try { await api('/api/identity/refresh', 'POST', {}); if (current()) await start(); } catch (err) { if (current()) feedback.textContent = err.message; }
    finally { refresh.disabled = false; refresh.textContent = '重新验证 GitHub 权限'; }
  }); actions.append(bind, refresh); identities.append(actions, feedback, provider);
  for (const identity of data.identities.filter(i => i.provider !== 'feishu')) {
    const row = element('div', '', 'row'), stateLabel = ({ active: '已验证', pending_verification: '待验证／需重新授权', revoked: '已撤销' })[identity.status] || identity.status;
    row.classList.add('identity-binding');
    row.append(element('strong', identity.display_name), element('span', `${identity.provider} · ${stateLabel}`),
      facts([['身份来源', identity.host || identity.provider], ['最近核验', identity.verified_at ? timestamp(identity.verified_at) : '尚无核验时间']]));
    if (identity.status !== 'revoked') {
      const revoke = element('button', '解除绑定', 'quiet');
      revoke.addEventListener('click', async () => {
        if (!confirm('解除绑定后，相关外部会话和 GitHub 派生权限立即失效。独立显式委派仍按其实际能力保留。继续？')) return;
        revoke.disabled = true; feedback.textContent = '';
        try { await api('/api/identity/bindings/' + encodeURIComponent(identity.id), 'DELETE', {}); if (current()) await start(); } catch (err) { if (current()) feedback.textContent = err.message; revoke.disabled = false; }
      }); row.append(revoke);
    }
    identities.append(row);
  }
  const permissions = card('当前角色与授权来源');
  permissions.append(note('GitHub 派生权限依赖当前 GitHub 证明和有效安装范围；显式委派独立保存。撤销其中一种来源不会移除另一种来源。'));
  const activeList = element('div', '', 'identity-grants'), history = element('details', '', 'fold identity-history');
  activeList.setAttribute('aria-label', '有效授权'); history.append(element('summary', `待验证与历史授权（${pending.length}）`));
  history.open = !active.length && pending.length > 0;
  for (const grant of [...active, ...pending]) {
    const row = element('div', '', 'row perm-row'), source = grant.source === 'github_derived' ? 'GitHub 当前权限（继承）' : '显式委派';
    row.append(element('strong', ({ super_admin: '平台超级管理员', org_admin: '组织管理员', project_admin: '项目管理员', delegated: '受委派成员' })[grant.role] || grant.role),
      element('p', `${source} · ${grant.project_id ? '项目 ' + grant.project_id : grant.tenant_id || '平台'}`),
      element('p', grantStateText(grant)), facts([['最近核验', grant.verified_at ? timestamp(grant.verified_at) : '未提供核验时间'],
        ['授权有效期', grant.expires_at == null ? (grant.source === 'github_derived' ? '未提供到期时间，仍须核验身份与安装' : '未设置到期时间') : timestamp(grant.expires_at) || '未知']]));
    const capabilities = element('details', '', 'fold'); capabilities.append(element('summary', '查看具体能力'), element('p', '能力：' + grant.capabilities.join(', '))); row.append(capabilities);
    if (grant.state !== 'active') row.append(note(grant.state === 'revoked' ? '这条授权已撤销，不计入当前有效能力。需要恢复时联系授权来源的管理员。' : '这条授权当前不生效。请重新验证 GitHub 权限；显式委派或归属问题请联系管理员。'));
    (grant.state === 'active' ? activeList : history).append(row);
  }
  permissions.append(activeList); if (pending.length) permissions.append(history);
  if (!active.length) permissions.append(note('尚无管理授权。请联系管理员委派，或重新验证你在已安装项目上的 GitHub 权限。'));
  const feishuSlot = element('div', '', 'identity-feishu');
  feishuSlot.append(consoleState('正在读取飞书绑定', 'GitHub 身份与管理权限已独立展示。'));
  const layout = element('div', '', 'identity-layout'); layout.append(overview, selection, identities, permissions, feishuSlot); panel.replaceChildren(layout);
  const loadProvider = async () => {
    try {
      const { enabled } = await api('/api/auth/github/status'); if (!current()) return;
      bind.disabled = !enabled; refresh.disabled = !enabled;
      provider.replaceChildren(...(enabled ? [] : [note('GitHub 登录尚未启用。系统超级管理员可在「全局设置 → 接入向导」中配置；现有本地账号和显式委派继续可用。')]));
    } catch (err) { if (current()) provider.replaceChildren(consoleState('GitHub 登录状态读取失败', err.message, { tone: 'error', retry: () => loadProvider() })); }
  };
  const loadFeishu = async () => {
    try { const feishu = await feishuIdentityCard(); if (!current()) return; feishuSlot.replaceChildren(feishu); if (location.hash.startsWith('#/identity/feishu')) feishu.scrollIntoView({ block: 'start' }); }
    catch (err) { if (current()) feishuSlot.replaceChildren(consoleState('飞书绑定读取失败', err.message, { tone: 'error', retry: () => loadFeishu() })); }
  };
  const loading = [loadProvider(), loadFeishu()];
  if (data.actor.tenant_id && data.scopes.some(g => g.state === 'active' && (g.scope === 'platform' || g.scope === 'tenant' && g.tenant_id === data.actor.tenant_id))) {
    const members = card('组织成员授权'); layout.append(members);
    const loadMembers = async () => {
      let grants;
      try { ({ grants } = await api('/api/identity/grants?tenant_id=' + encodeURIComponent(data.actor.tenant_id))); }
      catch (err) { if (current()) members.replaceChildren(element('h3', '组织成员授权'), consoleState('成员授权读取失败', err.message, { tone: 'error', retry: () => loadMembers() })); return; }
      if (!current()) return; members.replaceChildren(element('h3', '组织成员授权'));
      members.append(note('继承授权和显式授权分别展示；撤销一条来源后，成员仍按其他有效来源拥有权限。'));
      for (const grant of grants) {
        const row = element('div', '', 'row');
        row.append(element('strong', grant.principal_name), element('p', `${grant.source === 'github_derived' ? 'GitHub 当前权限（继承）' : '显式委派'} · ${grant.project_id ? '项目 ' + grant.project_id : '组织'}`),
          element('p', ({ active: '有效', revoked: '已撤销', pending_verification: '待验证', quarantined: '归属待处理' })[grant.state] || grant.state));
        members.append(row);
      }
    }; loading.push(loadMembers());
  }
  await Promise.all(loading);
}
