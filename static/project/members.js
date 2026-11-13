function membersSection() {
  const target = current, id = target.id, address = location.hash, section = card('项目成员与授权来源');
  const live = () => current === target && location.hash === address && section.isConnected;
  let readVersion = 0;
  const load = async () => {
    const request = ++readVersion, isCurrent = () => live() && request === readVersion;
    let data;
    try { data = await api(`/api/repositories/${id}/members`); }
    catch (err) {
      if (isCurrent()) section.replaceChildren(element('h3', '项目成员与授权来源'), consoleState('成员权限读取失败',
        err.status === 403 ? '需要本项目配置权限。请联系组织或平台管理员；身份绑定不会自动增加成员管理能力。' : err.message,
        { tone: 'error', retry: load }));
      return;
    }
    if (!isCurrent()) return;
    section.replaceChildren(element('h3', '项目成员与授权来源'), note(`本次读取：${timestamp(data.read_at)}。每次操作仍由服务端重新核验。平台超级管理员可管理全部项目，不计入下方项目授权。`));
    const list = element('div', '', 'project-member-list');
    for (const grant of data.grants) {
      const row = element('article', '', 'project-member'), inherited = grant.scope === 'tenant', github = grant.source === 'github_derived';
      row.append(element('h4', grant.principal_name), badge(({ active: '有效', revoked: '已撤销', inactive: '账号已停用', pending_verification: '待验证', quarantined: '归属待处理' })[grant.state] || grant.state, grant.state === 'active' ? 'success' : 'warning'),
        facts([['角色', ({ project_admin: '项目管理员', org_admin: '组织管理员', delegated: '受委派成员', service: '项目服务身份' })[grant.role] || grant.role],
          ['生效范围', inherited ? '整个组织，包含本项目' : '仅本项目'], ['授权来源', github ? 'GitHub 当前权限（继承）' : inherited ? '组织显式委派（继承）' : '项目显式委派'],
          ['最近核验', grant.verified_at ? timestamp(grant.verified_at) : '未提供核验时间'], ['到期时间', grant.expires_at == null ? '未设置到期时间' : timestamp(grant.expires_at)]]));
      const capabilities = element('details', '', 'fold'); capabilities.append(element('summary', '查看授权能力'), note(grant.capabilities.join('、') || '当前无有效能力')); row.append(capabilities);
      row.append(note(github ? '由当前 GitHub 身份和安装范围核验；请在 GitHub 修改后重新验证，不能在这里直接编辑。' : inherited ? '继承自组织授权，请在原授权来源调整；移除项目单独授权不会移除继承权限。' : grant.policy === 'legacy' ? '由平台管理员在下方管理项目分配。' : '独立显式委派沿用授权服务管理；撤销其他来源不会移除这条委派。'));
      list.append(row);
    }
    if (!data.grants.length) list.append(consoleState('没有本项目授权记录', '平台超级管理员仍可管理本项目。需要其他成员访问时，请由有转授权能力的管理员处理。'));
    section.append(button('刷新成员权限', load, 'quiet'), list);
    if (data.can_manage_legacy) {
      const legacy = card('项目管理员分配'); section.append(legacy); await loadLegacy(legacy, isCurrent);
    } else section.append(note('当前页面只展示授权。项目管理员不自动拥有 grants.manage，不能再转授权。'));
  };
  const loadLegacy = async (container, isCurrent) => {
    try {
    const [{ users }, { assignments, organization_assignments: organizations, organizations: installed }] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    if (!isCurrent()) return;
    const list = element('ul', '', 'history'), add = element('div', '', 'actions member-add'), message = element('p', '', 'view-error'); message.setAttribute('role', 'alert');
    container.append(note('只修改本项目的旧式显式分配；GitHub 派生、独立委派和整个组织授权保持各自来源。'), list, add, message);
    const assigned = user => assignments.filter(a => a.user_id === user.id).map(a => a.repository_id);
    // Only the single-repository grant is changed here; a whole-organization grant is edited on the users page.
    const wholeOrganization = user => organizations.some(o => o.user_id === user.id && o.owner_id === target.repository.owner_id);
    // A grant whose repository is neither installed nor a project any more would be refused, so saving here drops it.
    const grantable = new Set([...installed.flatMap(o => o.repositories.map(r => r.id)), ...repositories.map(r => r.id)]);
    let pending = false;
    const update = async (user, ids) => {
      if (pending || !live()) return; pending = true;
      container.querySelectorAll('button,select').forEach(control => control.disabled = true); message.textContent = '';
      try { await api('/api/project-admin-assignments', 'PUT', { user_id: user.id, repository_ids: ids.filter(id => grantable.has(id)) }); if (live()) await load(); }
      catch (err) { if (live()) message.textContent = '项目分配保存失败：' + err.message; }
      finally { pending = false; container.querySelectorAll('button,select').forEach(control => control.disabled = false); }
    };
    for (const user of users.filter(u => u.role === 'project_admin' && (assigned(u).includes(id) || wholeOrganization(u)))) {
      const li = element('li', ''); li.append(element('span', user.username + (user.active ? '' : '（已停用）')));
      if (wholeOrganization(user)) li.append(element('span', '整个组织授权，在「用户」页修改', 'muted'));
      if (assigned(user).includes(id)) li.append(button('移除', async () => {
        if (await askConfirm({ title: `移除 ${user.username} 的项目分配？`, body: ['只移除此项目的显式分配；组织继承、GitHub 派生和其他显式委派仍按各自条件生效。'], action: '移除分配', danger: true })) await update(user, assigned(user).filter(value => value !== id));
      }));
      list.append(li);
    }
    if (!list.childElementCount) list.append(element('li', '还没有项目管理员，超级管理员可以管理全部项目。', 'muted'));
    const candidates = users.filter(u => u.role === 'project_admin' && u.active && !assigned(u).includes(id) && !wholeOrganization(u)), select = document.createElement('select');
    select.setAttribute('aria-label', '添加项目管理员');
    select.add(new Option(candidates.length ? '选择项目管理员' : '没有可添加的项目管理员（在“用户”页创建）', '')); candidates.forEach(u => select.add(new Option(u.username, u.id)));
    add.append(select, button('添加', () => { const user = candidates.find(u => u.id === select.value); if (user) return update(user, [...assigned(user), id]); }));
    } catch (err) { if (isCurrent()) container.append(consoleState('项目分配读取失败', err.message, { tone: 'error', retry: () => { container.replaceChildren(element('h3', '项目管理员分配')); return loadLegacy(container, isCurrent); } })); }
  };
  section.append(consoleState('正在读取项目授权', '按本项目范围核对有效授权和历史来源。'));
  void load();
  return [section];
}

