titles.identity = '身份与权限';
function identityError(code) {
  return ({ external_identity_conflict: '这个 GitHub 身份已绑定其他账号。请登录原账号解除绑定，或联系管理员处理。',
    github_identity_already_bound: '当前账号已有 GitHub 绑定。请先解除原绑定，再关联新的 GitHub 身份。',
    invalid_oauth_state: '登录验证已过期、已使用或不属于当前浏览器。请重新发起 GitHub 登录。',
    oauth_session_mismatch: '绑定时的本地会话已变化。请重新登录并发起绑定。',
    github_login_configuration_changed: 'GitHub 登录配置已更新，请重新发起登录。',
    github_oauth_failed: 'GitHub 授权失败，请重新授权。', github_oauth_denied: 'GitHub 授权已取消，请重新发起。',
    user_disabled: '账号已停用，请联系管理员。' })[code] || 'GitHub 身份暂时无法验证，请稍后重试或使用本地账号登录。';
}
async function renderIdentity() {
  const panel = $('identity-panel'), request = renderVersion, data = await api('/api/identity'); $('count').textContent = '';
  const selection = card('当前组织与项目范围'), select = document.createElement('select'), form = document.createElement('form');
  select.setAttribute('aria-label', '当前租户');
  const platform = data.scopes.some(s => s.scope === 'platform');
  select.add(new Option(platform ? '平台全部租户（超级管理员）' : '所有已授权组织与项目', ''));
  for (const tenant of data.tenants) select.add(new Option(`${tenant.display_name.split('/')[0]} · ${tenant.github_account_id}`, tenant.id));
  select.value = data.actor.tenant_id || '';
  const switcher = element('button', '切换组织'); switcher.type = 'submit'; form.append(select, switcher);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/api/identity/tenant', 'POST', { tenant_id: select.value || null }); await start(); }
    catch (err) { error(err); }
  });
  selection.append(form, note('选择组织后，项目、任务、日志和配置请求都会限制在该组织内。'), facts([['授权版本', String(data.actor.authorization_revision)]]));
  const identities = card('登录与账号绑定');
  identities.append(note('绑定需要同时证明当前本地会话和 GitHub 身份。同名或同邮箱账号不会自动合并，绑定本身不会增加管理权限。'));
  const enabled = (await api('/api/auth/github/status')).enabled;
  const bind = element('button', '绑定 GitHub 账号'); bind.disabled = !enabled;
  bind.addEventListener('click', async () => { try { const result = await api('/api/identity/github/bind', 'POST', {}); location.assign(result.url); } catch (err) { error(err); } });
  const refresh = element('button', '重新验证 GitHub 权限', 'quiet'); refresh.disabled = !enabled;
  refresh.addEventListener('click', async () => {
    refresh.disabled = true; refresh.textContent = '正在验证…';
    try { await api('/api/identity/refresh', 'POST', {}); await start(); } catch (err) { error(err); refresh.disabled = false; }
  }); identities.append(bind, refresh);
  if (!enabled) identities.append(note('GitHub 登录尚未启用。系统超级管理员可在「全局设置 → 接入向导」中配置；现有本地账号和显式委派继续可用。'));
  for (const identity of data.identities.filter(i => i.provider !== 'feishu')) {
    const row = element('div', '', 'row'), stateLabel = ({ active: '已验证', pending_verification: '待验证／需重新授权', revoked: '已撤销' })[identity.status] || identity.status;
    row.append(element('strong', identity.display_name), element('span', `${identity.provider} · ${stateLabel}`));
    if (identity.status !== 'revoked') {
      const revoke = element('button', '解除绑定', 'quiet');
      revoke.addEventListener('click', async () => {
        if (!confirm('解除绑定后，相关外部会话和 GitHub 派生权限立即失效。独立显式委派仍按其实际能力保留。继续？')) return;
        try { await api('/api/identity/bindings/' + encodeURIComponent(identity.id), 'DELETE', {}); await start(); } catch (err) { error(err); }
      }); row.append(revoke);
    }
    identities.append(row);
  }
  const permissions = card('当前角色与授权来源');
  permissions.append(note('GitHub 派生权限依赖当前 GitHub 证明和有效安装范围；显式委派独立保存。撤销其中一种来源不会移除另一种来源。'));
  for (const grant of data.scopes.filter(g => !data.actor.tenant_id || !g.tenant_id || g.tenant_id === data.actor.tenant_id)) {
    const row = element('div', '', 'row'), source = grant.source === 'github_derived' ? 'GitHub 当前权限（继承）' : '显式委派';
    row.append(element('strong', ({ super_admin: '平台超级管理员', org_admin: '组织管理员', project_admin: '项目管理员', delegated: '受委派成员' })[grant.role] || grant.role),
      element('p', `${source} · ${grant.project_id ? '项目 ' + grant.project_id : grant.tenant_id || '平台'}`),
      element('p', ({ active: '有效', pending_verification: '待验证／权限不足，请重新授权', revoked: '已撤销', quarantined: '归属待处理' })[grant.state] || grant.state),
      element('p', '能力：' + grant.capabilities.join(', ')));
    permissions.append(row);
  }
  if (!data.scopes.length) permissions.append(note('尚无管理授权。请联系管理员委派，或重新验证你在已安装项目上的 GitHub 权限。'));
  const feishu = await feishuIdentityCard(data);
  if (request !== renderVersion) return;
  panel.replaceChildren(selection, identities, feishu, permissions);
  if (location.hash === '#/identity/feishu') feishu.scrollIntoView({ block: 'start' });
  if (data.actor.tenant_id && data.scopes.some(g => g.state === 'active' && (g.scope === 'platform' || g.scope === 'tenant' && g.tenant_id === data.actor.tenant_id))) {
    const members = card('组织成员授权'), { grants } = await api('/api/identity/grants?tenant_id=' + encodeURIComponent(data.actor.tenant_id));
    members.append(note('继承授权和显式授权分别展示；撤销一条来源后，成员仍按其他有效来源拥有权限。'));
    for (const grant of grants) {
      const row = element('div', '', 'row');
      row.append(element('strong', grant.principal_name), element('p', `${grant.source === 'github_derived' ? 'GitHub 当前权限（继承）' : '显式委派'} · ${grant.project_id ? '项目 ' + grant.project_id : '组织'}`),
        element('p', ({ active: '有效', revoked: '已撤销', pending_verification: '待验证', quarantined: '归属待处理' })[grant.state] || grant.state));
      members.append(row);
    }
    panel.append(members);
  }
}
