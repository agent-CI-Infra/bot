const $ = id => document.getElementById(id);
let me, setup = false, tab = 'projects', offset = 0, repositories = [], accounts = [], renderVersion = 0, forceIntegrationCheck = false, integrationAutoRefresh = false, permissionAutoRefresh = false;
// Project administrators' grants and the installed repositories to choose from (users page); the user whose grants the editor changes.
let grants = { assignments: [], organization_assignments: [], organizations: [] }, editingUser = null, editorKind = null;
const titles = { projects: '项目', board: '看板', costs: '成本', events: 'Webhook 投递', reviews: '检视任务', developments: '开发任务' };
// Every page has an address, so a reload or a shared link opens the same page. Accounts and users live in global settings.
const tabAddresses = { projects: '#/projects', board: '#/board', costs: '#/costs', reviews: '#/reviews', developments: '#/developments', events: '#/events',
  external: '#/external', onboarding: '#onboarding', settings: '#/settings' }, superTabs = ['onboarding', 'settings'];
const retryableStates = ['failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'waiting_pr_head', 'retry_wait', 'needs_replan'];
let messagePage = null;
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf_token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(`${response.status} · ${value.error}`);
  return value;
}
function notice(id, text = '') {
  const box = $(id); box.replaceChildren();
  if (!text) return;
  const close = element('button', '关闭提示', 'quiet'); close.type = 'button'; close.addEventListener('click', () => notice(id));
  box.append(element('span', text), close);
}
function retryErrorText(err) {
  if (/\btask_already_running\b/.test(err.message)) return '这个任务已经在执行或排队，不用再次重试。';
  if (/\btask_not_retryable\b/.test(err.message)) return '这个任务已经结束，不能重试。';
  return err.message;
}
function error(err) { if (!$('message').childElementCount) notice('message', err.message); if ($('editor').open) $('editor-error').textContent = err.message; }
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
function timestamp(value) {
  if(value==null||value==='')return '';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
  // Local getters use the browser's time zone, including its offset and daylight-saving rules.
  const pad=(n,width=2)=>String(n).padStart(width,'0');
  return `${pad(date.getFullYear(),4)}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function options(select, rows, label) { const selected = select.value; while (select.options.length > 1) select.remove(1); rows.forEach(row => select.add(new Option(label(row), row.id))); if (rows.some(row => row.id === selected)) select.value = selected; }
async function start() {
  setup = !(await api('/api/setup')).initialized;
  try { me = await api('/api/auth/me'); } catch { me = null; }
  $('access').hidden = !!me; $('workspace').hidden = !me; $('identity').hidden = !me; $('tabs').hidden = !me;
  if (!me) document.body.classList.remove('board-mode');
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
  if(me.role==='super_admin'&&!accounts.length&&!location.hash)history.replaceState(null,'',tabAddresses.onboarding);
  await route();
}
// Review and development are separate pages over the same task API.
const taskKinds = { reviews: 'review', developments: 'development' }, listTabs = ['events', 'reviews', 'developments', 'external','onboarding'];
// The wizard's address may name a step by index (#onboarding/2), so GitHub's return and a reload open that step.
const onboardingAddress = /^#onboarding(?:\/([0-5]))?$/;
// A project page (#/projects/<id>/<section>) replaces the list; any other address shows the current tab's list.
// The tab an address names: #/<tab>, a project page, a wizard step, or an older address (#external, #/accounts, #/users).
function addressTab(hash) {
  if (projectRoute() || hash === '#/projects') return 'projects';
  if (onboardingAddress.test(hash)) return 'onboarding';
  if (hash === '#external') return 'external';
  const name = /^#\/([a-z]+)(?:\/|$)/.exec(hash)?.[1];
  return ['accounts', 'users'].includes(name) ? 'settings' : tabAddresses[name] ? name : null;
}
async function route() {
  renderVersion++;
  // Accounts and users were tabs of their own; their old addresses open the matching settings section.
  const moved = /^#\/(accounts|users)$/.exec(location.hash); if (moved) history.replaceState(null, '', '#/settings/' + moved[1]);
  // An address the console does not know keeps the current page (on a fresh load that is the projects page).
  let next = addressTab(location.hash) || tab;
  if (superTabs.includes(next) && me.role !== 'super_admin') next = 'projects';
  if (next !== tab) offset = 0; tab = next;
  const target = projectRoute(), page = $('project-page'), list = document.querySelector('.list-panel');
  const address=tab+':'+location.hash;if(messagePage!==address){notice('message');messagePage=address;}
  page.hidden = !target; list.hidden = !!target;
  // The board fills the viewport and scrolls inside its columns; every other page keeps normal document scrolling.
  document.body.classList.toggle('board-mode', !target && tab === 'board');
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  if (target) await renderProject(target); else await render();
}
window.addEventListener('hashchange', () => { if (me) route().catch(error); });
// `quiet` is the periodic refresh: the list stays on screen while loading, and only rows whose data changed are replaced
// (a running task's runtime changes every refresh; the rows around it, and whatever the user is pointing at, stay put).
let listSignature = ''; const rowSignatures = new WeakMap();
async function render(quiet = false) {
  const request=++renderVersion, taskTab = !!taskKinds[tab];
  $('page-title').textContent = titles[tab];
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  $('filters').hidden = !listTabs.includes(tab); $('account-filter-label').hidden = me.role !== 'super_admin' || tab==='external'; $('owner-filter').parentElement.hidden=tab==='external'; $('paging').hidden = tab==='external' || !listTabs.includes(tab);
  $('rows').hidden=['external','onboarding','board','costs','settings'].includes(tab);$('external-panel').hidden=tab!=='external';$('onboarding-panel').hidden=tab!=='onboarding';$('board-panel').hidden=tab!=='board';$('costs-panel').hidden=tab!=='costs';$('settings-panel').hidden=tab!=='settings';$('sync').hidden=true;$('check').hidden=true;
  $('filters').classList.toggle('project-filters',me.role !== 'super_admin');
  const params = new URLSearchParams({ offset: String(offset), limit: '50' });
  if ($('repository-filter').value) params.set('repository_id', $('repository-filter').value);
  if ($('account-filter').value && me.role === 'super_admin') params.set('account_id', $('account-filter').value);
  if ($('owner-filter').value) params.set('owner_id', $('owner-filter').value);
  $('rows').dataset.view=tab;if(!quiet){$('rows').replaceChildren();listSignature='';$('count').textContent='正在加载…';$('rows').setAttribute('aria-busy','true');}
  if(tab==='board'){try{await renderBoard(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='costs'){try{await renderCosts(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='settings'){try{await renderSettings(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='onboarding'){$('filters').hidden=true;$('paging').hidden=true;try{await renderOnboarding(request);}finally{$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='external'){params.delete('account_id');params.delete('owner_id');try{await renderExternal(params,request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if (taskTab) params.set('kind', taskKinds[tab]);
  // Super administrators see every installed repository; project administrators see their registered ones.
  const installedView = tab === 'projects' && me.role === 'super_admin'; $('sync').hidden = !installedView; $('check').hidden = !installedView;
  $('hidden-filter-label').hidden = !installedView;
  // The 已隐藏 filter swaps the list for the rows an administrator removed from it; each one can be restored.
  const hiddenView = installedView && $('hidden-filter').checked;
  // Gate / dashboard connection status (cached; refreshed on demand).
  const integrationMap = new Map(); let staleIntegrations = false;
  if (installedView && !hiddenView) {
    let integrations = [], checked = false; try { integrations = (await api('/api/integrations')).integrations || []; } catch {}
    if (!integrations.length || forceIntegrationCheck) {
      forceIntegrationCheck = false; checked = true;
      try { $('count').textContent = '正在检查门禁和看板的接入状态…'; integrations = (await api('/api/integrations/check', 'POST', {})).integrations || []; } catch {}
    }
    integrations.forEach(item => integrationMap.set(item.repository_id, item));
    // What a check just returned is not checked again here, even if part of it is still stale.
    staleIntegrations = !checked && integrations.some(item => item.stale);
  }
  const endpoint = taskTab ? 'tasks' : tab === 'projects' ? 'repositories' : tab;
  const address = hiddenView ? '/api/installations/hidden' : installedView ? '/api/installations' : `/api/${endpoint}${listTabs.includes(tab) ? '?' + params : ''}`;
  let result;try{result=await api(address);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}
  if(request!==renderVersion)return;const rows=result[installedView ? 'repositories' : endpoint];
  const signature=tab+'\n'+(hiddenView?'hidden\n':'')+params+'\n'+JSON.stringify(rows);if(quiet&&signature===listSignature)return;listSignature=signature;
  const lines=[]; $('count').textContent = tab === 'events' ? `本页 ${rows.length} 条投递` : hiddenView ? `${rows.length} 个已隐藏仓库` : installedView ? `${rows.length} 个仓库 · ${syncSummary(result.syncs)}` : tab === 'projects' ? `${rows.length} 个项目` : `${rows.length} 条记录`;
  $('previous').disabled = offset === 0; $('next').disabled = rows.length < 50; $('page-number').textContent = `第 ${offset / 50 + 1} 页`;
  rows.forEach(row => {
    const line = element('div', '', 'row'), content = element('div', '', 'row-content'), status=element('div','','row-state');line.setAttribute('role','listitem');line.dataset.key=String(row.id);rowSignatures.set(line,JSON.stringify(row));
    const name = taskTab ? `${row.kind === 'development.pr' ? '跟进 ' : ''}${objectLabel(row)} · ${row.full_name || '仓库 ' + row.repository_id}` : (tab==='events'?(row.full_name?row.full_name+' · '+row.route:row.route):row.full_name) || row.name || row.username || row.model_name || row.summary || row.route || '未知事件';
    content.append(element('strong', name));
    const detail = tab === 'events' ? `${timestamp(row.received_at)} · ${deliveryCaption(row)} · ${row.delivery_id}`
      : taskTab ? `${phaseLabels[row.phase] || row.phase} · ${row.head_sha ? '提交 ' + row.head_sha.slice(0,12) : '等待材料'} · 第 ${row.attempt} 次 · 更新于 ${timestamp(row.updated_at)}${row.error_code ? ' · '+faultSummary(row.error_code,row.error_cause) : ''}${tab === 'reviews' && Array.isArray(row.result?.findings) ? ` · ${row.result.findings.length} 条发现` : ''}`
      : installedView ? installedDetail(row) : `仓库 ID ${row.id}${row.model_id ? '' : ' · 未选模型'}`;
    content.append(element('p', detail)); line.append(content);
    if(listTabs.includes(tab))status.append(taskTab ? taskState(row) : state(row.status));
    if(tab==='events')for(const task of row.tasks||[])content.append(button(`${kindLabels[task.kind]||task.kind} #${task.object_number} · 查看任务`,()=>openTask(task.id),'quiet linkish'));
    if(installedView){status.append(...installedBadges(row));if(!hiddenView)status.append(...installedIntegration(integrationMap.get(row.id),row));}
    if(tab==='projects'&&!hiddenView){line.classList.add('project-list-row');line.dataset.repositoryId=row.id;status.classList.add('project-overview');status.append(projectListControls(row));}
    if(taskTab&&row.result?.pr_url){try{const url=new URL(row.result.pr_url);if(['https:','http:'].includes(url.protocol)){const link=element('a',row.result.pr_number?'PR #'+row.result.pr_number:'查看 PR','result-link');link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';content.lastElementChild.append(link);}}catch{}}
    if(status.childElementCount)line.append(status);
    if(installedView){const actions=hiddenView?element('div','','actions'):installedActions(row,()=>start());
      if(hiddenView)actions.append(button('恢复',()=>restoreInstalled(row,()=>start()).catch(error),'quiet'));
      if(actions.childElementCount)line.append(actions);}
    else if(tab==='projects'){const actions=element('div','','actions');actions.append(button('设置',()=>openProject(row.id)));line.append(actions);}
    if (tab === 'events') {
      const button = element('button', '查看详情', 'quiet'); button.addEventListener('click', async () => {
        try { $('detail-title').textContent='投递详情'; $('detail-body').textContent = JSON.stringify(await api('/api/events/' + row.id), null, 2); $('detail').showModal(); } catch (err) { error(err); }
      }); const actions=element('div','','actions');actions.append(button);line.append(actions);
    }
    if(taskTab){
      const actions=element('div','','actions'),detail=element('button','查看过程','quiet');
      detail.addEventListener('click',()=>openTask(row.id).catch(error));actions.append(detail);
      if(retryableStates.includes(row.status)){
        const retry=element('button','重试','quiet');retry.addEventListener('click',async()=>{
          retry.disabled=true;const address=tab+':'+location.hash;
          try{await api('/api/tasks/'+row.id+'/retry','POST',{});if(address!==tab+':'+location.hash)return;notice('message');await render();}
          catch(err){if(address===tab+':'+location.hash)notice('message',retryErrorText(err));retry.disabled=false;}
        });actions.append(retry);
      }line.append(actions);
    }
    if(taskTab)content.append(taskMetricsLine(row));
    line.classList.toggle('has-actions',!!line.querySelector(':scope > .actions'));lines.push(line);
  });
  const shown=[...$('rows').children];
  if(quiet&&shown.length===lines.length&&shown.every((node,index)=>node.dataset.key===lines[index].dataset.key))
    shown.forEach((node,index)=>{if(rowSignatures.get(node)!==rowSignatures.get(lines[index]))node.replaceWith(lines[index]);});
  else $('rows').replaceChildren(...lines);
  if(staleIntegrations)refreshStaleIntegrations();
  if(installedView&&!hiddenView&&rows.some(row=>row.permissions_stale))refreshStalePermissions();
}
// Stale chips are checked once in the background and only the chips change; the list is neither reloaded nor cleared.
// A result that is still stale (a failed check, or more repositories than one check covers) waits for a manual refresh.
async function refreshStaleIntegrations() {
  if (integrationAutoRefresh) return; integrationAutoRefresh = true;
  try { updateIntegrationChips((await api('/api/integrations/check', 'POST', {})).integrations || []); } catch {}
  finally { integrationAutoRefresh = false; }
}
// Grants older than the cache are read again once when the list opens; only the permission badges change. They are not
// part of the five-second task refresh, and a failed check waits for the next visit or a manual sync.
async function refreshStalePermissions() {
  if (permissionAutoRefresh) return; permissionAutoRefresh = true;
  try { updatePermissionBadges((await api('/api/installations/permissions/check', 'POST', {})).repositories || []); } catch {}
  finally { permissionAutoRefresh = false; }
}
// One account or user as a list row, the same markup as the other lists; drawn by the global settings sections.
function settingsRow(title, detail, extra, badges, actions) {
  const line = element('div', '', 'row has-actions'), content = element('div', '', 'row-content'), status = element('div', '', 'row-state'), group = element('div', '', 'actions');
  line.setAttribute('role', 'listitem'); content.append(element('strong', title), element('p', detail), ...extra); status.append(...badges); group.append(...actions);
  line.append(content, status, group); return line;
}
function accountLine(row) {
  const extra = [];
  if (row.type === 'github_app' && row.credentials_configured) extra.push(appPermissionCheck(row));
  if (row.endpoints.length) { const endpoints = element('details', ''); endpoints.append(element('summary', `${row.endpoints.length} 个 Webhook 入口`), ...row.endpoints.map(e => element('code', e.webhook_path))); extra.push(endpoints); }
  return settingsRow(row.name, row.type === 'github_app' ? 'GitHub App · App ID ' + row.app_id : '机器人账号（Token）', extra,
    [element('span', row.credentials_configured ? '凭据已配置' : '凭据已撤销', 'status status-' + (row.credentials_configured ? 'success' : 'warning'))],
    [button('删除', () => deleteAccount(row).catch(error), 'quiet destructive')]);
}
function userLine(row) {
  return settingsRow(row.username, `${row.role === 'super_admin' ? '超级管理员 · 管理全部项目' : '项目管理员'} · ID ${row.id}`, row.role === 'project_admin' ? [element('p', grantSummary(row))] : [],
    [element('span', row.active ? '已启用' : '已停用', 'status' + (row.active ? ' status-success' : ''))],
    [...(row.role === 'project_admin' ? [button('修改仓库权限', () => editGrants(row))] : []), button('删除', () => deleteUser(row).catch(error), 'quiet destructive')]);
}
async function deleteUser(row) {
  const self = row.id === me.id, kept = '仓库和组织授权、个人看板设置一并去掉，登录名可以重新使用；操作审计保留。';
  const deleted = await askConfirm({ title: self ? `删除你自己的账号 ${row.username}？` : `删除用户 ${row.username}？`, action: '删除', danger: true,
    body: self ? ['只有还剩另一名活跃的超级管理员时才能删除。删除后当前会话立即失效，需要用其他超级管理员登录。', kept] : ['它的会话立即失效。', kept, '不能删除最后一名活跃的超级管理员。'],
    run: () => api('/api/users/' + encodeURIComponent(row.id), 'DELETE', { confirm: true }).catch(err => { throw new Error(removalMessage(err)); }) });
  if (!deleted) return;
  // The session ended with the user; show the login page without calling logout.
  if (self) { renderVersion++; me = null; tab = 'projects'; repositories = []; accounts = []; $('rows').replaceChildren(); }
  await start();
}
async function deleteAccount(row) {
  const kind = row.type === 'github_app' ? 'GitHub App' : '机器人账号';
  const deleted = await askConfirm({ title: `删除${kind} ${row.name}？`, action: '删除', danger: true,
    body: ['只从本系统移除：它的 Webhook 入口、安装同步记录和封存的凭据一并删除。', '不会在 GitHub 上卸载 App，也不会删除任何 GitHub 仓库。', '还有项目使用这个账号时不能删除，需要先删除这些项目。'],
    run: () => api('/api/accounts/' + encodeURIComponent(row.id), 'DELETE', { confirm: true }).catch(err => {
      const used = repositories.filter(repo => repo.account_id === row.id).map(repo => repo.full_name);
      throw new Error(removalMessage(err) + (/account_has_projects/.test(err.message) && used.length ? `（${used.join('、')}）` : ''));
    }) });
  if (deleted) await start();
}
// Deletes the control-plane records only; unlike the off-installation delete this one never asks GitHub.
async function deleteProjectRecord(row, after) {
  const deleted = await askConfirm({ title: `删除项目 ${row.full_name}？`, action: '删除', danger: true,
    body: ['只从本系统移除：项目策略、成员分配、专属模型、公共配置记录、任务记录和安装列表里的这一行一并删除，操作审计保留。',
      '不会在 GitHub 上删除仓库，也不会卸载 App 安装，GitHub 上的内容完全不动。',
      '以后安装同步如果又看到这个仓库，它会像新仓库一样出现；需要时重新启动即可。'],
    run: () => api(`/api/projects/${encodeURIComponent(row.id)}`, 'DELETE', {}).catch(err => { throw new Error(removalMessage(err)); }) });
  if (deleted) await after();
}
const forms = {
  accounts: [['name', '账号名称'], ['type', '账号类型', [['bot_account', '机器人账号'], ['github_app', 'GitHub App']]], ['app_id', 'App ID（仅 GitHub App）'], ['private_key', 'App 私钥（仅 GitHub App）', 'textarea'], ['token', '机器人 Token（仅机器人账号）', 'password'], ['webhook_secret', 'Webhook 签名凭据', 'password']],
  users: [['username', '用户名'], ['password', '初始密码（至少 12 位）', 'password'], ['role', '角色', [['project_admin', '项目管理员'], ['super_admin', '超级管理员']]], ['grants', '仓库权限', 'grants']]
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
  label.append(select, element('span', select.options.length ? '按住 Ctrl（macOS 为 ⌘）可选多项。不选表示不授权，看不到任何项目。' : '还没有已安装的仓库，先在「项目」页同步安装列表。', 'muted'));
  return label;
}
function chosenGrants(form) {
  const chosen = [...form.elements.grants.selectedOptions].map(option => option.value.split(':')), ids = kind => chosen.filter(([value]) => value === kind).map(([, id]) => id);
  return { repository_ids: ids('repository'), organization_ids: ids('organization') };
}
// What a project administrator holds, as chosen: whole organizations and single repositories.
function grantSummary(user) {
  const installed = new Map(grants.organizations.flatMap(org => org.repositories.map(repo => [repo.id, repo])));
  const organizations = grants.organization_assignments.filter(row => row.user_id === user.id)
    .map(row => grants.organizations.find(org => org.owner_id === row.owner_id)?.owner_login || `组织 ID ${row.owner_id}（不在安装列表）`);
  const repos = grants.assignments.filter(row => row.user_id === user.id).map(({ repository_id: id }) => { const repo = installed.get(id);
    return repo ? repo.full_name + (repo.registered ? '' : '（未启动）') : (repositories.find(project => project.id === id)?.full_name || '仓库 ID ' + id) + '（不在安装列表）'; });
  if (!organizations.length && !repos.length) return '未分配仓库，看不到任何项目';
  return [organizations.length ? '整个组织：' + organizations.join('、') : '', repos.length ? '仓库：' + repos.join('、') : ''].filter(Boolean).join(' · ');
}
function editGrants(user) {
  editingUser = user; editorKind = 'users'; $('editor-note').hidden = true; $('editor-title').textContent = `修改 ${user.username} 的仓库权限`;
  $('editor-fields').replaceChildren(grantField(user)); $('editor-error').textContent = ''; $('editor').showModal();
}
$('editor-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  if (editorKind === 'accounts') { if (data.type === 'github_app') delete data.token; else { delete data.private_key; delete data.app_id; } }
  if (editorKind === 'users') { delete data.grants; if (data.role !== 'super_admin') Object.assign(data, chosenGrants(form)); }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { if (editingUser) await api('/api/project-admin-assignments', 'PUT', { user_id: editingUser.id, ...chosenGrants(form) }); else await api('/api/' + editorKind, 'POST', data); $('editor').close(); form.reset(); await start(); } catch (err) { error(err); } finally { submit.disabled = false; }
});
$('cancel').addEventListener('click', () => { $('editor').close(); $('editor-form').reset(); });
$('close-detail').addEventListener('click', () => $('detail').close());
$('access-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, button = $('access-submit'); button.disabled = true;
  try { await api(setup ? '/api/setup' : '/api/auth/login', 'POST', Object.fromEntries(new FormData(form))); form.reset(); await start(); } catch (err) { error(err); } finally { button.disabled = false; }
});
// Signing out returns to the default page, so whoever signs in next does not land on the previous user's page; the wizard
// keeps its address (onboarding.js resets it to the first step).
$('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); renderVersion++; me = null; tab = 'projects'; if (!onboardingAddress.test(location.hash)) history.replaceState(null, '', location.pathname); repositories=[];accounts=[]; $('rows').replaceChildren();$('detail-body').textContent = ''; await start(); } catch (err) { error(err); } });
// The address is written without waiting for hashchange, so the page switches in the same click; back and forward still
// fire hashchange and draw the page they return to.
$('tabs').addEventListener('click', event => { const name = event.target.dataset.tab; if (!name) return;
  if (location.hash !== tabAddresses[name]) history.pushState(null, '', tabAddresses[name]); offset = 0; route().catch(error); });
$('refresh').addEventListener('click', () => start().catch(error));
$('check').addEventListener('click', () => { forceIntegrationCheck = true; start().catch(error); });
// The onboarding dialog calls this once a run reaches a terminal state.
window.refreshIntegrations = () => api('/api/integrations/check', 'POST', {}).then(() => start()).catch(() => {});
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true; $('message').textContent = '正在从 GitHub 同步安装列表…';
  try { const { results } = await api('/api/installations/sync', 'POST', {}); await start(); const failed = results.filter(r => r.error);
    $('message').textContent = failed.length ? '部分账号同步失败：' + failed.map(r => r.error).join('，') : ''; }
  catch (err) { error(err); } finally { $('sync').disabled = false; }
});
$('filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; render().catch(error); });
$('hidden-filter').addEventListener('change', () => { offset = 0; render().catch(error); });
for (const [id, delta] of [['previous', -50], ['next', 50]]) $(id).addEventListener('click', () => { offset += delta; render().catch(error); });
document.addEventListener('DOMContentLoaded',()=>start().catch(error),{once:true});
setInterval(()=>{if(me&&['reviews','developments'].includes(tab)&&!projectRoute()&&!document.hidden&&!document.querySelector('dialog[open]'))render(true).catch(error);},5000);

setInterval(()=>{if(me&&tab==='projects'&&!$('hidden-filter').checked&&!projectRoute()&&!document.querySelector('dialog[open]'))refreshProjectActivity();},5000);
