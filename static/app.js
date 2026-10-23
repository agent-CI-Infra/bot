const $ = id => document.getElementById(id);
let me, setup = false, tab = 'projects', offset = 0, repositories = [], accounts = [], renderVersion = 0;
const titles = { projects: '项目', events: 'Webhook 投递', reviews: '检视任务', developments: '开发任务', accounts: '机器人账号', users: '用户' };
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf_token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status} · ${value.error}`);
  return value;
}
function error(err) { $('message').textContent = err.message; if ($('editor').open) $('editor-error').textContent = err.message; }
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
const states = {
  accepted:['已接收','success'], invalid_signature:['签名无效','danger'], invalid_payload:['正文无效','danger'], payload_too_large:['正文过大','danger'],
  unknown_endpoint:['入口不存在','danger'], missing_event_or_delivery:['投递信息不全','danger'],
  queued:['待执行','info'], running:['执行中','info'], preparing:['准备中','info'], implementing:['开发中','info'], validating:['测试中','info'], publishing:['发布中','info'],
  succeeded:['已完成','success'], completed:['已完成','success'], pr_opened:['已创建 PR','success'], failed:['失败','danger'],
  waiting_configuration:['配置待补','warning'], waiting_environment:['等待环境','warning'], waiting_permission:['权限待处理','warning'],
  waiting_pr_head:['等待 PR 更新','info'], waiting_publication:['发布待确认','warning'], retry_wait:['等待重试','warning'], needs_replan:['需重新规划','warning'], cancelled:['已取消',''], superseded:['已过时',''],
  ready:['就绪','success'], busy:['执行中','info'], stopped:['已停止',''], provisioning:['创建中','info'], recovering:['恢复中','info'], resetting:['重置中','warning'], reset_failed:['重置失败','danger'], unavailable:['不可用','danger'], result_ready:['待发布','info'], deleted:['已移除','']
};
function state(value) { const [caption,tone]=states[value]||[value,'']; const badge=element('span',caption,'status'+(tone?' status-'+tone:''));badge.title=value;return badge; }
function deliveryCaption(row){return {tasks_created:'已创建任务',draft:'因草稿跳过',not_trigger:'不是触发事件',duplicate:'重复，不重复建任务',review_disabled:'检视未开启，仅归档',unregistered_repository:'仓库未启动，仅归档'}[row.processing_result]||row.processing_result||'已归档';}
function timestamp(value) { return value ? value.replace('T',' ').replace(/\.\d+Z$/,' UTC') : ''; }
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
  if(me.role==='super_admin'&&!accounts.length&&!location.hash&&tab==='projects')tab='onboarding';
  await route();
}
// Review and development are separate pages over the same task API.
const taskKinds = { reviews: 'review', developments: 'development' }, listTabs = ['events', 'reviews', 'developments', 'external','onboarding'];
// A project page (#/projects/<id>/<section>) replaces the list; any other address shows the current tab's list.
async function route() {
  const target = projectRoute(), page = $('project-page'), list = document.querySelector('.list-panel');
  if (target) tab = 'projects';
  if(location.hash==='#onboarding'&&me.role==='super_admin')tab='onboarding';
  page.hidden = !target; list.hidden = !!target;
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  if (target) { $('message').textContent = ''; await renderProject(target); } else await render();
}
window.addEventListener('hashchange', () => { if (me) route().catch(error); });
async function render() {
  const request=++renderVersion, taskTab = !!taskKinds[tab];
  $('message').textContent = ''; $('page-title').textContent = titles[tab];
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  $('add').hidden = listTabs.includes(tab) || me.role !== 'super_admin';
  $('add').textContent = tab === 'projects' ? '手动登记仓库' : '新增';
  $('filters').hidden = !listTabs.includes(tab); $('account-filter-label').hidden = me.role !== 'super_admin' || tab==='external'; $('owner-filter').parentElement.hidden=tab==='external'; $('paging').hidden = tab==='external' || !listTabs.includes(tab);
  $('rows').hidden=['external','onboarding'].includes(tab);$('external-panel').hidden=tab!=='external';$('onboarding-panel').hidden=tab!=='onboarding';$('sync').hidden=true;
  $('filters').classList.toggle('project-filters',me.role !== 'super_admin');
  const params = new URLSearchParams({ offset: String(offset), limit: '50' });
  if ($('repository-filter').value) params.set('repository_id', $('repository-filter').value);
  if ($('account-filter').value && me.role === 'super_admin') params.set('account_id', $('account-filter').value);
  if ($('owner-filter').value) params.set('owner_id', $('owner-filter').value);
  $('rows').replaceChildren();$('rows').dataset.view=tab;$('count').textContent='正在加载…';$('rows').setAttribute('aria-busy','true');
  if(tab==='onboarding'){$('filters').hidden=true;$('paging').hidden=true;try{await renderOnboarding(request);}finally{$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='external'){params.delete('account_id');params.delete('owner_id');try{await renderExternal(params,request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if (taskTab) params.set('kind', taskKinds[tab]);
  // Super administrators see every installed repository; project administrators see their registered ones.
  const installedView = tab === 'projects' && me.role === 'super_admin'; $('sync').hidden = !installedView;
  const endpoint = taskTab ? 'tasks' : tab === 'projects' ? 'repositories' : tab;
  let result;try{result=await api(installedView ? '/api/installations' : `/api/${endpoint}${listTabs.includes(tab) ? '?' + params : ''}`);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}
  if(request!==renderVersion)return;const rows=result[installedView ? 'repositories' : endpoint];
  $('rows').replaceChildren(); $('count').textContent = tab === 'events' ? `本页 ${rows.length} 条投递` : installedView ? `${rows.length} 个仓库 · ${syncSummary(result.syncs)}` : tab === 'projects' ? `${rows.length} 个项目` : `${rows.length} 条记录`;
  $('previous').disabled = offset === 0; $('next').disabled = rows.length < 50; $('page-number').textContent = `第 ${offset / 50 + 1} 页`;
  rows.forEach(row => {
    const line = element('div', '', 'row'), content = element('div', '', 'row-content'), status=element('div','','row-state');line.setAttribute('role','listitem');
    const name = taskTab ? `${row.kind === 'development.pr' ? '跟进 ' : ''}${objectLabel(row)} · ${row.full_name || '仓库 ' + row.repository_id}` : (tab==='events'?(row.full_name?row.full_name+' · '+row.route:row.route):row.full_name) || row.name || row.username || row.model_name || row.summary || row.route || '未知事件';
    content.append(element('strong', name));
    const detail = tab === 'events' ? `${timestamp(row.received_at)} · ${deliveryCaption(row)} · ${row.delivery_id}`
      : taskTab ? `${phaseLabels[row.phase] || row.phase} · ${row.head_sha ? '提交 ' + row.head_sha.slice(0,12) : '等待材料'} · 第 ${row.attempt} 次 · 更新于 ${timestamp(row.updated_at)}${row.error_code ? ' · '+taskErrorText(row.error_code) : ''}${tab === 'reviews' && Array.isArray(row.result?.findings) ? ` · ${row.result.findings.length} 条发现` : ''}`
      : tab === 'accounts' ? `${row.type === 'github_app' ? 'GitHub App · App ID '+row.app_id : '机器人账号'}`
      : tab === 'users' ? `${row.role === 'super_admin' ? '超级管理员' : '项目管理员'} · ID ${row.id}`
      : installedView ? installedDetail(row) : `仓库 ID ${row.id} · 检视${row.review_enabled ? '开' : '关'} · 开发${row.development_enabled ? '开' : '关'}${row.model_id ? '' : ' · 未选模型'}`;
    content.append(element('p', detail)); line.append(content);
    if(listTabs.includes(tab))status.append(taskTab ? taskState(row) : state(row.status));
    if(tab==='events')for(const task of row.tasks||[])content.append(button(`${kindLabels[task.kind]||task.kind} #${task.object_number} · 查看任务`,()=>openTask(task.id),'quiet linkish'));
    if(tab==='accounts')status.append(element('span',row.credentials_configured?'凭据已配置':'凭据已撤销','status status-'+(row.credentials_configured?'success':'warning')));
    if(tab==='users')status.append(element('span',row.active?'已启用':'已停用','status'+(row.active?' status-success':'')));
    if(installedView)status.append(...installedBadges(row));
    else if(tab==='projects')status.append(!row.enabled?badge('已禁用','warning'):row.review_enabled?badge('工作中','success'):badge('未开检视','warning'));
    if(tab==='accounts'&&row.endpoints.length){const endpoints=element('details',''),summary=element('summary',`${row.endpoints.length} 个 Webhook 入口`);endpoints.append(summary);row.endpoints.forEach(e=>endpoints.append(element('code',e.webhook_path)));content.append(endpoints);}
    if(taskTab&&row.result?.pr_url){try{const url=new URL(row.result.pr_url);if(['https:','http:'].includes(url.protocol)){const link=element('a',row.result.pr_number?'PR #'+row.result.pr_number:'查看 PR','result-link');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';content.lastElementChild.append(link);}}catch{}}
    if(status.childElementCount)line.append(status);
    if(installedView){const actions=installedActions(row,()=>start());if(actions.childElementCount)line.append(actions);}
    else if(tab==='projects'){const actions=element('div','','actions');actions.append(button('打开',()=>openProject(row.id)));line.append(actions);}
    if (tab === 'events') {
      const button = element('button', '查看详情', 'quiet'); button.addEventListener('click', async () => {
        try { $('detail-title').textContent='投递详情'; $('detail-body').textContent = JSON.stringify(await api('/api/events/' + row.id), null, 2); $('detail').showModal(); } catch (err) { error(err); }
      }); const actions=element('div','','actions');actions.append(button);line.append(actions);
    }
    if(taskTab){
      const actions=element('div','','actions'),detail=element('button','查看过程','quiet');
      detail.addEventListener('click',()=>openTask(row.id).catch(error));actions.append(detail);
      if(['failed','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','retry_wait','needs_replan'].includes(row.status)){
        const retry=element('button','重试','quiet');retry.addEventListener('click',async()=>{retry.disabled=true;try{await api('/api/tasks/'+row.id+'/retry','POST',{});await render();}catch(err){error(err);retry.disabled=false;}});actions.append(retry);
      }line.append(actions);
    }
    line.classList.toggle('has-actions',!!line.querySelector(':scope > .actions'));$('rows').append(line);
  });
}
const forms = {
  accounts: [['name', '账号名称'], ['type', '账号类型', [['bot_account', '机器人账号'], ['github_app', 'GitHub App']]], ['app_id', 'App ID（仅 GitHub App）'], ['private_key', 'App 私钥（仅 GitHub App）', 'textarea'], ['token', '机器人 Token（仅机器人账号）', 'password'], ['webhook_secret', 'Webhook 签名凭据', 'password']],
  projects: [['id', 'GitHub 仓库 ID'], ['full_name', '仓库 owner/repo'], ['owner_id', '组织或所有者 ID'], ['account_id', '关联账号', () => accounts.map(a => [a.id, a.name])]],
  users: [['username', '用户名'], ['password', '初始密码（至少 12 位）', 'password'], ['role', '角色', [['project_admin', '项目管理员'], ['super_admin', '超级管理员']]], ['repository_ids', '分配仓库 ID（逗号分隔，可留空）']]
};
$('add').addEventListener('click', () => {
  $('editor-title').textContent = tab === 'projects' ? '手动登记仓库' : '新增' + titles[tab]; $('editor-fields').replaceChildren(); $('editor-error').textContent = '';
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
  if (tab === 'users') data.repository_ids = data.repository_ids.split(',').map(s => s.trim()).filter(Boolean);
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { await api('/api/' + (tab === 'projects' ? 'repositories' : tab), 'POST', data); $('editor').close(); form.reset(); await start(); } catch (err) { error(err); } finally { submit.disabled = false; }
});
$('cancel').addEventListener('click', () => { $('editor').close(); $('editor-form').reset(); });
$('close-detail').addEventListener('click', () => $('detail').close());
$('access-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('access-submit'); button.disabled = true;
  try { await api(setup ? '/api/setup' : '/api/auth/login', 'POST', Object.fromEntries(new FormData(form))); form.reset(); await start(); } catch (err) { error(err); } finally { button.disabled = false; }
});
$('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); renderVersion++; me = null; tab = 'projects'; repositories=[];accounts=[]; $('rows').replaceChildren();$('detail-body').textContent = ''; await start(); } catch (err) { error(err); } });
$('tabs').addEventListener('click', event => { if (!event.target.dataset.tab) return; tab = event.target.dataset.tab; offset = 0;
  if (location.hash) history.pushState(null, '', location.pathname); route().catch(error); });
$('refresh').addEventListener('click', () => start().catch(error));
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true; $('message').textContent = '正在从 GitHub 同步安装列表…';
  try { const { results } = await api('/api/installations/sync', 'POST', {}); await start(); const failed = results.filter(r => r.error);
    $('message').textContent = failed.length ? '部分账号同步失败：' + failed.map(r => r.error).join('，') : ''; }
  catch (err) { error(err); } finally { $('sync').disabled = false; }
});
$('filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; render().catch(error); });
for (const [id, delta] of [['previous', -50], ['next', 50]]) $(id).addEventListener('click', () => { offset += delta; render().catch(error); });
document.addEventListener('DOMContentLoaded',()=>start().catch(error),{once:true});
setInterval(()=>{if(me&&['reviews','developments'].includes(tab)&&!projectRoute()&&!document.querySelector('dialog[open]'))render().catch(error);},5000);
