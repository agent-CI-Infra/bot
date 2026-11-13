// Why an account change was refused, in words instead of the bare server code.
function accountChangeMessage(err) {
  const code = err.code || String(err.message).replace(/^\d+\s*·\s*/, '');
  if (code === 'account_has_projects') return '这个账号下还有已登记的项目，先在项目页处理它们，才能删除账号。';
  if (code === 'account_not_found') return '这个账号已经不存在，请刷新机器人账号列表。';
  if (code === 'invalid_rsa_private_key') return '这不是有效的 RSA 私钥：GitHub App 账号要保存 App 的私钥（PEM），不是令牌。';
  if (code === 'conflicting_credentials') return '一个账号只能用一种凭据：GitHub App 账号保存私钥，Token 账号保存 Token。';
  if (code === 'confirmation_required') return '删除账号需要再确认一次。';
  return err.message;
}
// A registered account row: where its authorization comes from and the way to its own page, in one line. Only a link is
// added, so the list keeps making exactly the requests the console already made at start. The install target lives on the
// installation detail page, which reads the archive directly.
function accountProfileLine(account) {
  const line = accountLine(account), content = line.querySelector('.row-content'), actions = line.querySelector('.actions');
  const source = account.type === 'github_app' ? 'GitHub App 安装（私钥换安装临时令牌）' : '用户 Token（按 Token 所属用户的仓库权限）';
  const origin = element('p', `凭据来源：${source}${account.credentials_configured ? '' : ' · 已撤销，需要重新登记'}`); origin.title = origin.textContent; content.append(origin);
  if (actions) actions.prepend(settingsLink('#/settings/accounts/' + encodeURIComponent(account.id), '详情'));
  return line;
}
// One account: what it is, which projects use it, where GitHub posts, and the three changes the API already offered
// (rename, rotate the credential, remove the account). Every request of this page happens here and nowhere in the list.
async function accountDetail(request, id) {
  const section = card('账号详情'), content = element('div', ''), back = settingsLink('#/settings/accounts', '返回机器人账号');
  section.append(back, content);
  const draw = async (notice, tone = 'view-success') => {
    content.replaceChildren(element('p', '正在加载…', 'muted'));
    try {
      const [{ account }, installations] = await Promise.all([api('/api/accounts/' + encodeURIComponent(id)), api('/api/installations')]);
      const projects = (installations.repositories || []).filter(row => row.account_id === id && row.registered);
      content.replaceChildren(...(notice ? [element('p', notice, tone)] : []), ...accountDetailBody(account, projects, draw));
    } catch (err) { content.replaceChildren(note('读不到这个账号：' + accountChangeMessage(err))); }
  };
  await draw('');
  return [section];
}
function accountDetailBody(account, projects, redraw) {
  const nodes = [], isApp = account.type === 'github_app', id = encodeURIComponent(account.id);
  nodes.push(element('h4', account.name),
    facts([['类型', isApp ? `GitHub App · App ID ${account.app_id}` : '用户 Token'],
      ['凭据', account.credentials_configured ? '凭据已配置' : '凭据已撤销，需要重新登记'],
      ['登记时间', account.created_at ? timestamp(account.created_at) : '未记录']]));
  // The count is the server's own registered-repository count; the names are the rows this page read alongside it.
  const named = Number(account.project_count ?? projects.length), projectSection = element('section', '');
  projectSection.append(element('h4', `使用项目（${named}）`));
  if (!projects.length) projectSection.append(element('p', named ? `已登记 ${named} 个项目，但这一页没有读到它们的名字（安装列表可能分页），到项目页查看。` : '这个账号还没有已登记的项目。', 'muted'));
  else for (const project of projects) projectSection.append(element('p', project.full_name));
  nodes.push(projectSection);
  // The installations this credential reaches come with the account view, so naming them adds no request of its own. An
  // installation GitHub stopped listing stays as history, a grant that was never read says so instead of "no gaps", and a
  // bot account states it has none at all because a user token does not go through an installation.
  const installs = account.installations || [], installSection = element('section', '');
  installSection.append(element('h4', `关联安装（${installs.length}）`));
  if (!installs.length) installSection.append(element('p', isApp
    ? '这个账号还没有关联的 GitHub 安装：同步安装列表后会出现，零仓库的安装也会保留。'
    : '用户 Token 账号按 Token 所属用户的仓库权限访问，没有 GitHub 安装；关联安装只属于 GitHub App 账号。', 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', ''), thead = document.createElement('thead'), tbody = document.createElement('tbody');
    for (const caption of ['安装', '目标', '状态', '仓库', '缺什么', '会挡住什么']) head.append(element('th', caption));
    thead.append(head); table.append(thead, tbody);
    for (const installation of installs) {
      const gaps = installation.access_gaps, row = element('tr', '');
      const cell = (label, value) => { const td = element('td'); td.dataset.label = label; td.append(value); return td; };
      // The installation number is the way into its archive, so the account page reaches the evidence it names.
      const ref = ['github.com', account.app_id, installation.installation_id].map(encodeURIComponent).join('/');
      row.append(cell('安装', settingsLink('#/settings/installations/' + ref, `安装 ${installation.installation_id}`)),
        cell('目标', installation.owner_login || '待同步'),
        cell('状态', installation.installed ? '仍在安装里' : 'GitHub 已移除，保留为历史'),
        cell('仓库', `${Number(installation.repositories) || 0} 个`),
        // A gap reading has two halves: the grant and the event table. The cell names whichever half is missing instead
        // of calling a grant that was read "unread", and neither half is ever turned into "no gaps".
        cell('缺什么', gaps === null ? (installation.permissions_checked_at ? '授权已读，事件表还没读，缺什么无法判断' : '授权未读取，缺什么无法判断')
          : gaps.length ? gaps.map(gapWhat).join('；') : '没有缺口'),
        cell('会挡住什么', gaps === null ? '不知道' : gaps.length ? [...new Set(gaps.flatMap(gap => gap.features.map(feature => featureNames[feature] || feature)))].join('、') : '不影响已开启的功能'));
      tbody.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); installSection.append(wrap);
    // Freshness is stated per account, and the reason for it is named: a grant read before a change at GitHub is stale,
    // while a grant that was read without the event table is incomplete — the two need different words.
    for (const installation of installs) if (installation.permissions_checked_at) {
      const read = timestamp(installation.permissions_checked_at);
      if (installation.access_gaps === null)
        installSection.append(element('p', `安装 ${installation.installation_id} 的授权是 ${read} 读到的，但那一次没有读到事件表，缺什么要等事件表回来才能判断；同步一次安装列表再读。`, 'endpoint-warning'));
      else if (installation.permissions_stale)
        installSection.append(element('p', `安装 ${installation.installation_id} 的授权是 ${read} 读到的，之后可能在 GitHub 上改过；到「安装档案」重新同步再读一次。`, 'endpoint-warning'));
    }
    const unread = installs.filter(installation => !installation.permissions_checked_at);
    if (unread.length) installSection.append(element('p', `安装 ${unread.map(installation => installation.installation_id).join('、')} 还没有读到授权，因此上面的「缺什么」不能当成「没有缺口」；同步一次安装列表再读。`, 'endpoint-warning'));
  }
  nodes.push(installSection);
  const endpointSection = element('section', ''); endpointSection.append(element('h4', `Webhook 入口（${(account.endpoints || []).length}）`));
  if (!(account.endpoints || []).length) endpointSection.append(element('p', '还没有 Webhook 入口。', 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', ''), thead = document.createElement('thead'), body = document.createElement('tbody'), table_ = table;
    for (const caption of ['路径', '密钥']) head.append(element('th', caption));
    thead.append(head); table_.append(thead, body);
    for (const endpoint of account.endpoints) {
      const row = element('tr', ''), path = element('td', endpoint.webhook_path), secret = element('td', '');
      path.dataset.label = '路径'; secret.dataset.label = '密钥';
      secret.append(endpoint.secret_configured ? badge('已配置', 'success') : badge('未配置', 'danger'));
      row.append(path, secret); body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table_); endpointSection.append(wrap);
  }
  nodes.push(endpointSection);

  // A rename goes through the account PATCH; the page repeats the saved name only after the server agreed.
  const rename = element('div', '', 'actions'), nameField = document.createElement('input');
  nameField.value = account.name; nameField.setAttribute('aria-label', '账号名称'); nameField.autocomplete = 'off';
  const saveName = button('保存名称', async () => {
    saveName.disabled = true;
    try { await api('/api/accounts/' + id, 'PATCH', { name: nameField.value.trim() }); await redraw('名称已保存'); }
    catch (err) { await redraw(accountChangeMessage(err), 'view-error'); }
    finally { saveName.disabled = false; }
  });
  rename.append(nameField, saveName); nodes.push(element('h4', '改名'), rename);

  // A new credential replaces the sealed one; the server validates it, so a wrong key is refused in words.
  const rotate = element('div', '', 'actions'), credentialField = document.createElement(isApp ? 'textarea' : 'input');
  credentialField.setAttribute('aria-label', isApp ? '新私钥（PEM）' : '新 Token');
  credentialField.setAttribute('autocomplete', 'new-password'); credentialField.spellcheck = false;
  if (!isApp) credentialField.type = 'password';
  const saveCredential = button('保存凭据', async () => {
    // The server ignores an empty credential and answers 200 with the account unchanged, so an empty field never reaches
    // it: saying "saved" there would claim a rotation that did not happen.
    const value = credentialField.value.trim();
    if (!value) { await redraw(isApp ? '先粘贴 App 的私钥（PEM），再保存；留空不会替换现在的私钥。' : '先粘贴新的 Token，再保存；留空不会替换现在的 Token。', 'view-error'); return; }
    saveCredential.disabled = true;
    try { await api('/api/accounts/' + id, 'PATCH', isApp ? { private_key: value } : { token: value }); await redraw('凭据已保存：之后的请求使用新凭据。'); }
    catch (err) { await redraw(accountChangeMessage(err), 'view-error'); }
    finally { saveCredential.disabled = false; }
  });
  rotate.append(credentialField, saveCredential); nodes.push(element('h4', '轮换凭据'), rotate);

  // Removal is confirmed in the console's own dialog, which keeps the server's refusal in place so it can be retried.
  const remove = element('div', '', 'actions'), deleteAccount = button('删除账号', async () => {
    deleteAccount.disabled = true;
    try {
      const removed = await confirmDialog({ title: `删除账号 ${account.name}？`, danger: true, action: '删除',
        body: ['只从本控制台删除这个账号；GitHub 上的 App 安装和仓库不会被改动。',
          '账号的 Webhook 入口、安装列表和封存的凭据一起删除；项目还登记在这个账号下时，服务端会拒绝。'],
        run: async () => { try { await api('/api/accounts/' + id, 'DELETE', { confirm: true }); } catch (err) { throw new Error(accountChangeMessage(err)); } } });
      if (removed) location.hash = '#/settings/accounts';
    } finally { deleteAccount.disabled = false; }
  }, 'danger');
  remove.append(deleteAccount); nodes.push(remove);
  return nodes;
}
