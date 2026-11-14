const forms = {
  accounts: [['name', '账号名称'], ['type', '账号类型', [['bot_account', '机器人账号'], ['github_app', 'GitHub App']]], ['app_id', 'App ID（仅 GitHub App）'], ['private_key', 'App 私钥（仅 GitHub App）', 'textarea'], ['token', '机器人 Token（仅机器人账号）', 'password'], ['webhook_secret', 'Webhook 签名凭据', 'password']],
  users: [['username', '用户名'], ['password', '初始密码（至少 12 位）', 'password'], ['role', '角色', [['project_admin', '项目管理员'], ['super_admin', '管理员']]], ['grants', '仓库权限', 'grants']]
};
const editorTitles = { accounts: '新增机器人账号', users: '新增用户' };
function openEditor(kind) {
  editingUser = null; editorKind = kind; $('editor-note').hidden = false;
  $('editor-title').textContent = editorTitles[kind]; $('editor-fields').replaceChildren(); $('editor-error').textContent = '';
  for (const [name, title, kind] of forms[editorKind]) {
    if (kind === 'grants') { $('editor-fields').append(grantField(null)); continue; }
    const label = element('label', title), choices = typeof kind === 'function' ? kind() : kind;
    const input = document.createElement(Array.isArray(choices) ? 'select' : kind === 'textarea' ? 'textarea' : 'input'); input.name = name;
    if (Array.isArray(choices)) choices.forEach(([value, caption]) => input.add(new Option(caption, value)));
    else if (kind === 'password') { input.type = 'password'; input.autocomplete = 'new-password'; }
    if (name === 'password') input.minLength = 12;
    label.append(input); $('editor-fields').append(label);
  }
  // A super administrator sees every project and holds no grants, so the choice is only offered for project administrators.
  if (editorKind === 'users') { const role = $('editor-form').elements.role, field = $('editor-fields').querySelector('[data-grants]'); role.addEventListener('change', () => { field.hidden = role.value === 'super_admin'; }); }
  $('editor').showModal();
}
// Installed repositories grouped by owner. A group's first option grants the whole organization, which also covers repositories
// enabled there later; the other options grant one repository each and nothing the organization adds afterwards.
function grantField(user) {
  const label = element('label', '仓库权限'), select = document.createElement('select'); label.dataset.grants = ''; select.name = 'grants'; select.multiple = true;
  const held = (rows, key) => new Set(user ? rows.filter(row => row.user_id === user.id).map(row => row[key]) : []);
  const organizations = held(grants.organization_assignments, 'owner_id'), repos = held(grants.assignments, 'repository_id');
  const group = (caption, items) => { const node = document.createElement('optgroup'); node.label = caption; items.forEach(([text, value, chosen]) => node.append(new Option(text, value, chosen, chosen))); select.append(node); };
  for (const org of grants.organizations) group(org.owner_login, [[`整个组织 ${org.owner_login}（含以后启用的仓库）`, 'organization:' + org.owner_id, organizations.has(org.owner_id)],
    ...org.repositories.map(repo => [repo.full_name + (repo.registered ? '' : '（未启动）'), 'repository:' + repo.id, repos.has(repo.id)])]);
  // A project this user holds that no installation lists any more stays selected, so saving other changes keeps it.
  const listed = new Set(grants.organizations.flatMap(org => org.repositories.map(repo => repo.id))), kept = repositories.filter(repo => repos.has(repo.id) && !listed.has(repo.id));
  if (kept.length) group('不在安装列表的项目', kept.map(repo => [repo.full_name, 'repository:' + repo.id, true]));
  // So does a whole organization this user holds whose repositories all left the installation; deselecting it drops the grant.
  const owners = new Set(grants.organizations.map(org => org.owner_id)), keptOwners = [...organizations].filter(id => !owners.has(id));
  if (keptOwners.length) group('不在安装列表的组织', keptOwners.map(id => [`组织 ID ${id}（不在安装列表）`, 'organization:' + id, true]));
  select.size = Math.min(12, select.options.length + select.querySelectorAll('optgroup').length);
  label.append(select, element('span', select.options.length ? '这里只修改手工分配；按住 Ctrl（macOS 为 ⌘）可选多项。不选表示不增加手工授权，已验证的 GitHub 继承权限仍然有效。' : '还没有已安装的仓库，先在「项目」页同步安装列表。', 'muted'));
  return label;
}
function chosenGrants(form) {
  const chosen = [...form.elements.grants.selectedOptions].map(option => option.value.split(':')), ids = kind => chosen.filter(([value]) => value === kind).map(([, id]) => id);
  return { repository_ids: ids('repository'), organization_ids: ids('organization') };
}
// Manual assignments remain editable independently of the effective access shown above them.
function grantSummary(user) {
  const installed = new Map(grants.organizations.flatMap(org => org.repositories.map(repo => [repo.id, repo])));
  const organizations = grants.organization_assignments.filter(row => row.user_id === user.id)
    .map(row => grants.organizations.find(org => org.owner_id === row.owner_id)?.owner_login || `组织 ID ${row.owner_id}（不在安装列表）`);
  const repos = grants.assignments.filter(row => row.user_id === user.id).map(({ repository_id: id }) => { const repo = installed.get(id);
    return repo ? repo.full_name + (repo.registered ? '' : '（未启动）') : (repositories.find(project => project.id === id)?.full_name || '仓库 ID ' + id) + '（不在安装列表）'; });
  if (!organizations.length && !repos.length) return '手工分配：无';
  return '手工分配 · ' + [organizations.length ? '整个组织：' + organizations.join('、') : '', repos.length ? '仓库：' + repos.join('、') : ''].filter(Boolean).join(' · ');
}
function editGrants(user) {
  editingUser = user; editorKind = 'users'; $('editor-note').hidden = true; $('editor-title').textContent = `修改 ${userDisplayName(user)} 的仓库权限`;
  $('editor-fields').replaceChildren(grantField(user)); $('editor-error').textContent = ''; $('editor').showModal();
}
