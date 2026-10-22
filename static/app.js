const $ = id => document.getElementById(id);
let me, setup = false, tab = 'events', offset = 0, repositories = [], accounts = [];
const titles = { events: 'Webhook 投递', repositories: '仓库', models: '模型', accounts: '机器人账号', users: '用户' };
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf_token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status} · ${value.error}`);
  return value;
}
function error(err) { $('message').textContent = err.message; if ($('editor').open) $('editor-error').textContent = err.message; }
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
function options(select, rows, label) { const selected = select.value; while (select.options.length > 1) select.remove(1); rows.forEach(row => select.add(new Option(label(row), row.id))); if (rows.some(row => row.id === selected)) select.value = selected; }
async function start() {
  setup = !(await api('/api/setup')).initialized;
  try { me = await api('/api/auth/me'); } catch { me = null; }
  $('access').hidden = !!me; $('workspace').hidden = !me; $('identity').hidden = !me;
  $('access-title').textContent = setup ? '创建第一名超级管理员' : '登录';
  $('access-description').textContent = setup ? '初始化只成功一次。请为本部署设置独立的管理员账号。' : '使用本系统账号进入你有权访问的仓库。';
  $('access-submit').textContent = setup ? '初始化并登录' : '登录';
  $('access-form').elements.password.autocomplete = setup ? 'new-password' : 'current-password';
  if (!me) return;
  $('who').textContent = `${me.username} · ${me.role === 'super_admin' ? '超级管理员' : '项目管理员'}`;
  document.querySelectorAll('[data-super]').forEach(el => el.hidden = me.role !== 'super_admin');
  repositories = (await api('/api/repositories')).repositories;
  if (me.role === 'super_admin') accounts = (await api('/api/accounts')).accounts;
  options($('repository-filter'), repositories, r => r.full_name); options($('account-filter'), accounts, a => a.name);
  await render();
}
async function render() {
  $('message').textContent = ''; $('page-title').textContent = titles[tab];
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  $('add').hidden = tab === 'events' || me.role !== 'super_admin' && tab !== 'models';
  $('filters').hidden = tab !== 'events'; $('account-filter-label').hidden = me.role !== 'super_admin'; $('paging').hidden = tab !== 'events';
  const params = new URLSearchParams({ offset: String(offset), limit: '50' });
  if ($('repository-filter').value) params.set('repository_id', $('repository-filter').value);
  if ($('account-filter').value && me.role === 'super_admin') params.set('account_id', $('account-filter').value);
  if ($('owner-filter').value) params.set('owner_id', $('owner-filter').value);
  const result = await api(`/api/${tab}${tab === 'events' ? '?' + params : ''}`), rows = result[tab];
  $('rows').replaceChildren(); $('count').textContent = tab === 'events' ? `本页 ${rows.length} 条投递` : `${rows.length} 条记录`;
  $('previous').disabled = offset === 0; $('next').disabled = rows.length < 50; $('page-number').textContent = `第 ${offset / 50 + 1} 页`;
  rows.forEach(row => {
    const line = element('div', '', 'row'), content = element('div', '', 'row-content');
    const name = row.full_name || row.name || row.username || row.model_name || row.route || '未知事件';
    content.append(element('strong', name));
    const detail = tab === 'events' ? `${row.received_at} · ${row.status}${row.duplicate ? ' · 重复投递' : ''} · 仓库 ${row.repository_id || '未关联'} · ${row.delivery_id}`
      : tab === 'models' ? `${row.api_url} · ${row.key_configured ? 'Key 已配置' : 'Key 已撤销'} · ${row.repository_id ? '仓库 ' + row.repository_id : '部署共享模型'}`
      : tab === 'accounts' ? `${row.type} · ${row.credentials_configured ? '凭据已配置' : '凭据已撤销'} · ${row.endpoints.map(e => e.webhook_path).join('，')}`
      : tab === 'users' ? `${row.role} · ${row.active ? '启用' : '停用'} · ID ${row.id}` : `仓库 ID ${row.id} · 组织 ID ${row.owner_id}`;
    content.append(element('p', detail)); line.append(content);
    if (tab === 'events') {
      const button = element('button', '查看详情', 'quiet'); button.addEventListener('click', async () => {
        try { $('detail-body').textContent = JSON.stringify(await api('/api/events/' + row.id), null, 2); $('detail').showModal(); } catch (err) { error(err); }
      }); line.append(button);
    }
    $('rows').append(line);
  });
}
const forms = {
  accounts: [['name', '账号名称'], ['type', '账号类型', [['bot_account', '机器人账号'], ['github_app', 'GitHub App']]], ['app_id', 'App ID（仅 GitHub App）'], ['private_key', 'App 私钥（仅 GitHub App）', 'textarea'], ['token', '机器人 Token（仅机器人账号）', 'password'], ['webhook_secret', 'Webhook 签名凭据', 'password']],
  repositories: [['id', 'GitHub 仓库 ID'], ['full_name', '仓库 owner/repo'], ['owner_id', '组织或所有者 ID'], ['account_id', '关联账号', () => accounts.map(a => [a.id, a.name])]],
  models: [['repository_id', '所属仓库', () => [...(me.role === 'super_admin' ? [['', '部署共享模型']] : []), ...repositories.map(r => [r.id, r.full_name])]], ['api_url', '接口 URL'], ['model_name', '模型名'], ['api_key', 'API Key', 'password']],
  users: [['username', '用户名'], ['password', '初始密码（至少 12 位）', 'password'], ['role', '角色', [['project_admin', '项目管理员'], ['super_admin', '超级管理员']]], ['repository_ids', '分配仓库 ID（逗号分隔，可留空）']]
};
$('add').addEventListener('click', () => {
  $('editor-title').textContent = '新增' + titles[tab]; $('editor-fields').replaceChildren(); $('editor-error').textContent = '';
  for (const [name, title, kind] of forms[tab]) {
    const label = element('label', title), choices = typeof kind === 'function' ? kind() : kind;
    const input = document.createElement(Array.isArray(choices) ? 'select' : kind === 'textarea' ? 'textarea' : 'input'); input.name = name;
    if (Array.isArray(choices)) choices.forEach(([value, caption]) => input.add(new Option(caption, value)));
    else if (kind === 'password') { input.type = 'password'; input.autocomplete = 'new-password'; }
    if (name === 'password') input.minLength = 12;
    label.append(input); $('editor-fields').append(label);
  }
  $('editor').showModal();
});
$('editor-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  if (tab === 'accounts') { if (data.type === 'github_app') delete data.token; else { delete data.private_key; delete data.app_id; } }
  if (tab === 'models' && !data.repository_id) data.repository_id = null;
  if (tab === 'users') data.repository_ids = data.repository_ids.split(',').map(s => s.trim()).filter(Boolean);
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { await api('/api/' + tab, 'POST', data); $('editor').close(); form.reset(); await start(); } catch (err) { error(err); } finally { submit.disabled = false; }
});
$('cancel').addEventListener('click', () => { $('editor').close(); $('editor-form').reset(); });
$('close-detail').addEventListener('click', () => $('detail').close());
$('access-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('access-submit'); button.disabled = true;
  try { await api(setup ? '/api/setup' : '/api/auth/login', 'POST', Object.fromEntries(new FormData(form))); form.reset(); await start(); } catch (err) { error(err); } finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); me = null; tab = 'events'; $('detail-body').textContent = ''; await start(); } catch (err) { error(err); } });
$('tabs').addEventListener('click', event => { if (event.target.dataset.tab) { tab = event.target.dataset.tab; offset = 0; render().catch(error); } });
$('refresh').addEventListener('click', () => start().catch(error));
$('filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; render().catch(error); });
for (const [id, delta] of [['previous', -50], ['next', 50]]) $(id).addEventListener('click', () => { offset += delta; render().catch(error); });
start().catch(error);
