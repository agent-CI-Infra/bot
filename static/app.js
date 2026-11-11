const $ = id => document.getElementById(id);
let me, setup = false, tab = 'projects', offset = 0, repositories = [], accounts = [], renderVersion = 0, integrationAutoRefresh = false, permissionAutoRefresh = false;
// Project administrators' grants and the installed repositories to choose from (users page); the user whose grants the editor changes.
let grants = { assignments: [], organization_assignments: [], organizations: [] }, editingUser = null, editorKind = null;
const titles = { projects: '项目', board: '看板', costs: '统计', events: 'Webhook 投递', management: '管理对话', design: '设计系统样例', 'new-task': '新建任务' };
// Every page has an address, so a reload or a shared link opens the same page. Accounts and users live in global settings.
const tabAddresses = { projects: '#/projects', board: '#/board', costs: '#/costs', events: '#/events',
  more: '#/more', inbox: '#/inbox', external: '#/external', settings: '#/settings', identity: '#/identity', management: '#/management', 'new-task': '#/new-task' }, superTabs = ['settings'];
const retryableStates = ['paused', 'failed', 'waiting_configuration', 'waiting_environment', 'waiting_permission', 'waiting_publication', 'waiting_pr_head', 'retry_wait', 'needs_replan'];
let messagePage = null;
async function api(path, method = 'GET', body, { signal } = {}) {
  const response = await fetch(path, { method, signal, headers: { 'Content-Type': 'application/json', ...(me ? { 'X-CSRF-Token': me.csrf_token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  let value;
  // A proxy in front of the console can answer with its own page instead of the service's JSON (Cloudflare replaces 502
  // and 504 bodies); say so instead of surfacing a JSON parse error. Aborts and network errors pass through unchanged.
  try { value = await response.json(); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw Object.assign(new Error(`${response.status} · ${response.ok ? '服务返回了无法识别的内容，请刷新页面后重试。' : '入口网关返回了错误页面，没有带回具体原因。请稍后重试；持续出现时请管理员查看服务日志。'}`),
      { status: response.status, code: 'response_not_json' });
  }
  // authorization_changed has its own guidance; field names the configuration path a validation error concerns
  // (for example roles.reviewer.harness_ref.id).
  if (!response.ok) throw Object.assign(new Error(value.error === 'authorization_changed' ? '权限已变化，请刷新页面后按当前权限重试。' : value.error === 'note_revision_changed' ? '文件已被其他操作更新，请刷新后再保存。' : `${response.status} · ${value.error}`), { status: response.status, code: typeof value.error === 'string' ? value.error : undefined, ...(value.field ? { field: value.field } : {}) });
  return value;
}
function notice(id, text = '', tone = '') {
  const box = $(id); box.replaceChildren();
  if (!text) return;
  const close = element('button', '关闭提示', 'quiet'); close.type = 'button'; close.addEventListener('click', () => notice(id));
  box.append(element('span', text, tone), close);
}
function retryErrorText(err) {
  if (/\btask_already_running\b/.test(err.message)) return '这个任务已经在执行或排队，不用再次重试。';
  if (/\btask_not_retryable\b/.test(err.message)) return '这个任务已经结束，不能重试。';
  return err.message;
}
function error(err) { if (!$('message').childElementCount) notice('message', err.message); if ($('editor').open) $('editor-error').textContent = err.message; }
function element(tag, text, className) { const el = document.createElement(tag); el.textContent = text; if (className) el.className = className; return el; }
// Navigation links are also used by ordinary lists, so keep their DOM helper in the shared base layer.
function consoleLink(href, caption, hint = '') {
  const a = element('a', '', 'console-link'); a.href = href;
  a.append(element('span', caption)); if (hint) a.append(element('small', hint)); return a;
}
function consoleState(title, text, { tone = '', retry } = {}) {
  const box = element('div', '', 'console-state' + (tone ? ' console-state-' + tone : ''));
  box.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  box.append(element('h2', title), element('p', text));
  if (retry) box.append(button('重新加载', retry)); return box;
}
const states = {
  accepted:['已接收','success'], invalid_signature:['签名无效','danger'], invalid_payload:['正文无效','danger'], payload_too_large:['正文过大','danger'],
  unknown_endpoint:['入口不存在','danger'], missing_event_or_delivery:['投递信息不全','danger'],
  queued:['待执行','info'], running:['执行中','info'], preparing:['准备中','info'], implementing:['开发中','info'], validating:['测试中','info'], publishing:['发布中','info'],
  succeeded:['已完成','success'], completed:['已完成','success'], pr_opened:['已创建 PR','success'], failed:['失败','danger'],
  waiting_configuration:['配置待补','warning'], waiting_environment:['等待环境','warning'], waiting_permission:['权限待处理','warning'],
  waiting_pr_head:['等待 PR 更新','info'], waiting_publication:['发布待确认','warning'], retry_wait:['等待重试','warning'], needs_replan:['需重新规划','warning'], paused:['已暂停','warning'], cancelled:['已取消',''], superseded:['已过时',''],
  ready:['就绪','success'], busy:['执行中','info'], stopped:['已停止',''], provisioning:['创建中','info'], recovering:['恢复中','info'], resetting:['重置中','warning'], reset_failed:['重置失败','danger'], unavailable:['不可用','danger'], result_ready:['待发布','info'], deleted:['已移除','']
};
function state(value) { const [caption,tone]=states[value]||[value,'']; const badge=element('span',caption,'status'+(tone?' status-'+tone:''));badge.title=value;return badge; }
function deliveryCaption(row){return {tasks_created:'已创建任务',draft:'因草稿跳过',not_trigger:'不是触发事件',duplicate:'重复，不重复建任务',review_disabled:'检视未开启，仅归档',project_disabled:'项目已禁用，仅归档',unregistered_repository:'仓库未启动，仅归档'}[row.processing_result]||row.processing_result||'已归档';}
// #238: reception, signature verification and processing are read as separate facts. Archive outcomes keep their own
// neutral wording, so duplicate/draft/disabled/untriggered rows never borrow the refusal styling of a bad signature.
const deliveryOutcomes = {
  tasks_created:['已创建任务','success'], duplicate:['重复投递，未重复创建','info'], draft:['草稿跳过','info'], not_trigger:['不触发处理',''],
  review_disabled:['检视未开启，仅归档',''], project_disabled:['项目已禁用，仅归档',''], unregistered_repository:['仓库未启动，仅归档',''],
  invalid_signature:['未处理：签名无效','danger'], invalid_payload:['未处理：正文无效','danger'], payload_too_large:['未处理：正文过大','danger'],
  unknown_endpoint:['未处理：入口不存在','danger'], missing_event_or_delivery:['未处理：投递信息不全','danger'] };
const deliveryIgnoreReasons = {
  duplicate:'同一入口已经处理过这个 delivery ID，未再次分派。', draft:'草稿 PR 不交给 Manager。',
  project_disabled:'项目已禁用，事件只归档，未交给 Manager。', review_disabled:'检视未开启，事件只归档，未交给 Manager。',
  not_trigger:'这个事件或动作不触发任务，未交给 Manager。', unregistered_repository:'仓库未启动，事件只归档，未交给 Manager。',
  invalid_signature:'签名无效，未通过验签，未进入处理。', invalid_payload:'正文不是合法 JSON，未进入处理。',
  payload_too_large:'正文超过大小上限，未读取签名与入口。', unknown_endpoint:'账号下没有这个 Webhook 入口，未验签、未处理。',
  missing_event_or_delivery:'缺少事件名或 delivery ID，未进入处理。' };
function deliveryOutcome(row){ const result=row.processing_result; return deliveryOutcomes[result]||[deliveryCaption(row),'']; }
function deliveryFacet(kind,row){
  const reception=row.reception||{}, signature=row.signature||{};
  const [caption,tone]=kind==='reception'?(reception.accepted?['已接收','success']:['已拒收'+(reception.http_status?'（HTTP '+reception.http_status+'）':''),'danger'])
    :kind==='signature'?(signature.state==='verified'?['签名有效','success']:signature.state==='invalid'?['签名无效','danger']:['未验签',''])
    :deliveryOutcome(row);
  const node=element('span',caption,'status'+(tone?' status-'+tone:''));
  node.dataset.deliveryFacet=kind;
  node.dataset.deliveryState=kind==='reception'?(reception.accepted?'accepted':'rejected'):kind==='signature'?(signature.state||'unchecked'):String(row.processing_result||'');
  node.title=kind==='reception'?'接收':kind==='signature'?'验签':'处理结果'; return node;
}
function dispatchCaption(event){ return ({create:'新建任务',continue:'续接任务',ignore:'不处理'})[event.decision]||event.decision||event.state||'待分派'; }
function deliverySection(name,title,rows){ const section=element('section','','detail-section'); section.dataset.detailSection=name;
  section.append(element('h3',title), facts(rows)); return section; }
// The detail keeps the same three facts as sections, then the Manager dispatch and the archived raw request, which stays
// collapsed because it is evidence rather than the conclusion.
function deliveryDetail(value){
  const event=value.event, source=event.source||{}, reception=event.reception||{}, signature=event.signature||{};
  const delivery=element('code',String(event.delivery_id||'')); delivery.dataset.deliveryId='';
  const nodes=[], origin=element('section','','detail-section'); origin.dataset.detailSection='source';
  origin.append(element('h3','来源与引用'), facts([['GitHub delivery ID',delivery],['归档引用',source.reference||('deliveries:'+event.id)],
    ['事件',event.event],['路由',event.route],['账号 / 入口',[event.account_id,event.endpoint_id].filter(Boolean).join(' / ')],
    ['仓库',event.full_name||event.repository_id],['接收时间',timestamp(event.received_at)]])); nodes.push(origin);
  nodes.push(deliverySection('reception','接收',[['HTTP 状态',reception.http_status],['正文完整',reception.body_complete?'是':'否'],
    ['结果',reception.accepted?'已接收':'已拒收'+(reception.code?' · '+reception.code:'')]]));
  nodes.push(deliverySection('signature','验签',[['结果',signature.state==='verified'?'签名有效':signature.state==='invalid'?'签名无效':'未验签'],
    ['依据',signature.state==='verified'?'签名凭据、正文与入口都核验通过':'未通过验签，请求没有进入处理']]));
  const processing=element('section','','detail-section'); processing.dataset.detailSection='processing';
  const [caption]=deliveryOutcome(event), rows=[['处理结果',caption]];
  if(deliveryIgnoreReasons[event.processing_result])rows.push(['说明',deliveryIgnoreReasons[event.processing_result]]);
  if(event.response?.review_outcome)rows.push(['Manager 前的归档结论',event.response.review_outcome]);
  processing.append(element('h3','处理'), facts(rows));
  if((event.tasks||[]).length){ const tasks=element('ul','','delivery-tasks');
    for(const task of event.tasks)tasks.append(element('li',`${kindLabels[task.kind]||task.kind} #${task.object_number} · ${task.status}`)); processing.append(tasks); }
  nodes.push(processing);
  const dispatch=element('section','','detail-section'); dispatch.dataset.detailSection='dispatch'; dispatch.append(element('h3','Manager 分派'));
  if((event.dispatch||[]).length)for(const item of event.dispatch){
    const entry=element('div','','dispatch-entry'); entry.append(element('p',`${dispatchCaption(item)} · ${item.type||item.source||'事件'}`),
      element('p',item.reason?'原因：'+item.reason:'没有记录原因','muted'), element('p',timestamp(item.decided_at||item.created_at),'muted')); dispatch.append(entry); }
  else dispatch.append(element('p','未交给 Manager：'+(deliveryIgnoreReasons[event.processing_result]||'这个投递没有分派记录。'),'muted'));
  nodes.push(dispatch);
  // The archive removes credential-ish request headers by name only; the JSON body is stored as received, so the summary
  // says exactly that rather than promising a sanitised payload.
  const raw=element('details','','fold raw-payload'); raw.append(element('summary','原始请求与响应（请求头凭据已移除，正文未脱敏）'),
    element('pre',JSON.stringify({request_headers:event.request_headers,payload:event.payload,response:event.response},null,2),'output')); nodes.push(raw);
  return nodes;
}
function timestamp(value) {
  if(value==null||value==='')return '';
  const date=new Date(value);if(Number.isNaN(date.getTime()))return '';
  // Local getters use the browser's time zone, including its offset and daylight-saving rules.
  const pad=(n,width=2)=>String(n).padStart(width,'0');
  return `${pad(date.getFullYear(),4)}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function options(select, rows, label) { const selected = select.value; while (select.options.length > 1) select.remove(1); rows.forEach(row => select.add(new Option(label(row), row.id))); if (rows.some(row => row.id === selected)) select.value = selected; }
function renderCurrentUser() {
  const who = $('who'), role = me.role === 'super_admin' ? '超级管理员' : '项目管理员';
  who.replaceChildren();
  if (!me.github) { who.textContent = `${me.username} · ${role}`; return; }
  const avatar = document.createElement('img'); avatar.src = me.github.avatar_url;
  avatar.alt = `${me.github.login} 的 GitHub 头像`; avatar.width = 28; avatar.height = 28; avatar.referrerPolicy = 'no-referrer';
  avatar.addEventListener('error', () => avatar.remove());
  const copy = element('span', '', 'current-user-copy'), name = element('span', '@' + me.github.login, 'current-user-name');
  name.title = me.github.login; copy.append(name, element('span', role, 'current-user-role')); who.append(avatar, copy);
}
function showBootFailure(err) {
  $('boot').hidden = false;
  $('access').hidden = $('workspace').hidden = $('identity').hidden = $('tabs').hidden = true;
  document.body.classList.remove('board-mode');
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  const message = $('boot-message');
  message.textContent = `控制台载入失败：${err.message}。请检查网络连接或服务状态后重试。`;
  message.setAttribute('role', 'alert'); message.classList.add('view-error');
  $('boot-retry').hidden = false;
}
async function start() {
  let setupState;
  try { setupState = await api('/api/setup'); } catch (err) { showBootFailure(err); return; }
  setup = !setupState.initialized;
  try { me = await api('/api/auth/me'); } catch { me = null; }
  if (typeof syncManagementChat === 'function') syncManagementChat();
  // The shell was blank until both requests above answered; the boot line covers that gap and leaves with them.
  $('boot').hidden = true;
  $('access').hidden = !!me; $('workspace').hidden = !me; $('identity').hidden = !me; $('tabs').hidden = !me;
  if (!me) document.body.classList.remove('board-mode');
  $('access-title').textContent = setup ? '创建第一名超级管理员' : '登录';
  $('access-description').textContent = setup ? '初始化只成功一次。请为本部署设置独立的管理员账号。' : '使用本系统账号进入你有权访问的仓库。';
  $('access-submit').textContent = setup ? '初始化并登录' : '登录';
  $('access-form').elements.password.autocomplete = setup ? 'new-password' : 'current-password';
  $('access-password').type = 'password'; $('access-password-toggle').textContent = '显示密码'; $('access-password-toggle').setAttribute('aria-pressed', 'false');
  // The same feedback component stays next to the action that failed, including OAuth callbacks.
  (me ? $('main-content') : $('access-feedback')).append($('message'));
  $('access').dataset.mode = setup ? 'setup' : 'local'; $('access-setup-note').hidden = !setup;
  $('github-login').hidden = true; $('access-local-divider').hidden = true; $('access-provider-retry').hidden = true;
  $('access-provider-status').textContent = ''; $('access-provider-note').textContent = setup ? '' : '使用本地账号，进入你有权管理的项目。';
  if (!me && !setup) {
    try {
      const enabled = (await api('/api/auth/github/status')).enabled;
      $('github-login').hidden = !enabled; $('access-local-divider').hidden = !enabled;
      $('access').dataset.mode = enabled ? 'github' : 'local';
      if (enabled) $('access-provider-note').textContent = 'GitHub 登录与项目授权分别核验，登录不会自动获得项目管理权限。';
    } catch {
      $('access-provider-status').textContent = 'GitHub 登录入口暂不可读取。可使用本地账号，或重新读取入口。'; $('access-provider-retry').hidden = false;
    }
  }

  const channelChallenge = /^#\/identity\/feishu\?challenge=([a-f0-9]{48})$/.exec(location.hash)?.[1];
  $('github-login').href = '/auth/github/start' + (channelChallenge ? '?channel_challenge=' + channelChallenge : '');
  const authError = new URLSearchParams(location.search).get('auth_error');
  if (authError) notice('message', identityError(authError));
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  if (!me) return;
  renderCurrentUser();
  document.querySelectorAll('[data-super]').forEach(el => el.hidden = me.role !== 'super_admin');
  repositories = (await api('/api/repositories')).repositories;
  if (me.role === 'super_admin') accounts = (await api('/api/accounts')).accounts;
  options($('repository-filter'), repositories, r => r.full_name); options($('account-filter'), accounts, a => a.name);
  if(me.role==='super_admin'&&!accounts.length&&!location.hash)history.replaceState(null,'','#/settings/onboarding/0');
  await route();
  if (authError) notice('message', identityError(authError));
}
// The generic list renderer still understands task rows; their old top-level addresses now select a board category.
const taskKinds = { reviews: 'review', developments: 'development' }, listTabs = ['projects','events','external'];
// Wizard steps live inside global settings; old top-level addresses are normalized by route().
const onboardingAddress = /^#\/settings\/onboarding(?:\/([0-6]))?$/;
const legacyOnboardingAddress = /^#onboarding(?:\/(\d+))?$/;
// A project page (#/projects/<id>/<section>) replaces the list; any other address shows the current tab's list.
// The tab an address names: #/<tab>, a project page, a wizard step, or an older address (#external, #/accounts, #/users).
function addressTab(hash) {
  if (/^#\/new-task(?:\/[1-9]\d*)?$/.test(hash)) return 'new-task';
  if (projectRoute() || hash === '#/projects') return 'projects';
  if (['#/reviews', '#/developments'].includes(hash)) return 'board';
  if (onboardingAddress.test(hash)) return 'settings';
  if (hash === '#external') return 'external';
  // #224-A: the component/state sample page. It has an address of its own so a deep link works, and no #tabs entry:
  // it is the reviewed evidence surface for the design tokens, not a feature users navigate to.
  if (hash === '#/design') return 'design';
  const name = /^#\/([a-z]+)(?:\/|$)/.exec(hash)?.[1];
  return ['accounts', 'users'].includes(name) ? 'settings' : tabAddresses[name] ? name : null;
}
async function route() {
  renderVersion++;
  if (/^#\/channels(?:\/|$)/.test(location.hash)) history.replaceState(null, '', '#/identity/feishu');
  // A project chat link keeps the project context; the top-level management address is a page of its own.
  const chatProject = /^#\/projects\/([^/]+)\/management$/.exec(location.hash)?.[1];
  // The project chat trigger has no settings section of its own: keep the project, open its first page underneath,
  // so a shared or reloaded address does not silently become 基本设置.
  if (chatProject) history.replaceState(null, '', `#/projects/${chatProject}/overview`);
  const legacy = legacyOnboardingAddress.exec(location.hash);
  if (legacy) history.replaceState(null, '', '#/settings/onboarding/' + ([0, 1, 3, 4, 5, 6][Number(legacy[1] || 0)] ?? 0));
  // Accounts and users were tabs of their own; their old addresses open the matching settings section.
  const moved = /^#\/(accounts|users)$/.exec(location.hash); if (moved) history.replaceState(null, '', '#/settings/' + moved[1]);
  // An address the console does not know keeps the current page (on a fresh load that is the projects page).
  let next = addressTab(location.hash) || tab;
  if (superTabs.includes(next) && me.role !== 'super_admin') next = 'projects';
  // The sample page issues no fetch of its own - every panel is constant markup - so a client-side role check is
  // the whole gate. If it ever reads server data, it needs a server-side gate first: hiding a route is not one.
  if (next === 'design' && me.role !== 'super_admin') next = 'projects';
  if (next !== tab) offset = 0; tab = next;
  const target = projectRoute(), page = $('project-page'), list = document.querySelector('.list-panel');
  const address=tab+':'+location.hash;if(messagePage!==address){notice('message');messagePage=address;}
  const consolePage = ['more', 'inbox', 'new-task'].includes(tab);
  const sample = !target && tab === 'design', samplePage = $('design-page');
  page.hidden = !target; samplePage.hidden = !sample; list.hidden = !!target || tab === 'management' || consolePage || sample;
  $('console-page').hidden = !consolePage;
  if (typeof syncConsoleShell === 'function') syncConsoleShell(target);
  // The board fills the viewport and scrolls inside its columns; every other page keeps normal document scrolling.
  document.body.classList.toggle('board-mode', !target && tab === 'board');
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  if (consolePage) {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    await renderConsolePage(renderVersion);
  } else if (sample) {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    renderDesignPage();
  } else if (tab === 'management' && !target) await renderManagementPage();
  else {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    if (target) await renderProject(target); else await render();
    if (chatProject) void openManagementChat(chatProject).catch(error);
  }
  if (typeof syncConsoleShell === 'function') syncConsoleShell(target);
  if (typeof restoreConsolePosition === 'function') restoreConsolePosition();
}
window.addEventListener('hashchange', () => { if (me) route().catch(error); });
// `quiet` is the periodic refresh: the list stays on screen while loading, and only rows whose data changed are replaced
// (a running task's runtime changes every refresh; the rows around it, and whatever the user is pointing at, stay put).
let listSignature = ''; const rowSignatures = new WeakMap();
function listParams() {
  const params = new URLSearchParams({ offset: String(offset), limit: '50' });
  if ($('repository-filter').value) params.set('repository_id', $('repository-filter').value);
  if ($('account-filter').value && me.role === 'super_admin') params.set('account_id', $('account-filter').value);
  if ($('owner-filter').value) params.set('owner_id', $('owner-filter').value);
  return params;
}
function projectListAddress(hidden = false, params = listParams()) {
  return (me.role !== 'super_admin' ? '/api/repositories' : hidden ? '/api/installations/hidden' : '/api/installations') + '?' + params;
}
async function render(quiet = false) {
  const request=++renderVersion, taskTab = !!taskKinds[tab];
  $('page-title').textContent = titles[tab];
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', el.dataset.tab === tab ? 'page' : 'false'));
  $('filters').hidden = !listTabs.includes(tab); $('account-filter-label').hidden = me.role !== 'super_admin' || tab==='external'; $('owner-filter').parentElement.hidden=tab==='external'; $('paging').hidden = tab==='external' || !listTabs.includes(tab);
  $('rows').hidden=['external','board','costs','settings','identity'].includes(tab);$('external-panel').hidden=tab!=='external';$('board-panel').hidden=tab!=='board';$('costs-panel').hidden=tab!=='costs';$('settings-panel').hidden=tab!=='settings';$('identity-panel').hidden=tab!=='identity';$('sync').hidden=true;$('hidden-filter-label').hidden=true;
  $('filters').classList.toggle('project-filters',me.role !== 'super_admin');
  const params = listParams();
  $('rows').dataset.view=tab;if(!quiet){$('rows').replaceChildren();listSignature='';$('count').textContent='正在加载…';$('rows').setAttribute('aria-busy','true');}
  if(tab==='board'){try{await renderBoard(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='costs'){try{await renderCosts(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='identity'){try{await renderIdentity();}finally{$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='settings'){try{await renderSettings(request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if(tab==='external'){params.delete('account_id');params.delete('owner_id');try{await renderExternal(params,request);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}return;}
  if (taskTab) params.set('kind', taskKinds[tab]);
  // Super administrators see every installed repository; project administrators see their registered ones.
  const installedView = tab === 'projects' && me.role === 'super_admin'; $('sync').hidden = !installedView;
  $('hidden-filter-label').hidden = !installedView;
  // The 已隐藏 filter swaps the list for the rows an administrator removed from it; each one can be restored.
  const hiddenView = installedView && $('hidden-filter').checked;
  // Gate / dashboard connection status (cached; refreshed on demand).
  const integrationMap = new Map(); let staleIntegrations = false;
  if (installedView && !hiddenView) {
    let integrations = [], checked = false; try { integrations = (await api('/api/integrations')).integrations || []; } catch {}
    if (!integrations.length) {
      checked = true;
      try { $('count').textContent = '正在检查门禁和看板的接入状态…'; integrations = (await api('/api/integrations/check', 'POST', {})).integrations || []; } catch {}
    }
    integrations.forEach(item => integrationMap.set(item.repository_id, item));
    // What a check just returned is not checked again here, even if part of it is still stale.
    staleIntegrations = !checked && integrations.some(item => item.stale);
  }
  const endpoint = taskTab ? 'tasks' : tab === 'projects' ? 'repositories' : tab;
  const address = tab === 'projects' ? projectListAddress(hiddenView, params) : `/api/${endpoint}${listTabs.includes(tab) ? '?' + params : ''}`;
  let result;try{result=await api(address);}finally{if(request===renderVersion)$('rows').removeAttribute('aria-busy');}
  if(request!==renderVersion)return;const rows=result[installedView ? 'repositories' : endpoint];
  const signature=tab+'\n'+(hiddenView?'hidden\n':'')+params+'\n'+JSON.stringify(rows);if(quiet&&signature===listSignature)return;listSignature=signature;
  const lines=[]; $('count').textContent = tab === 'events' ? `本页 ${rows.length} 条投递` : hiddenView ? `${rows.length} 个已隐藏仓库` : installedView ? `${rows.length} 个仓库 · ${syncSummary(result.syncs)}` : tab === 'projects' ? `${rows.length} 个项目` : `${rows.length} 条记录`;
  if (installedView && !hiddenView) $('count').textContent += ' · 看板公开可访问：公开仓默认开，私有仓默认关';
  $('previous').disabled = offset === 0; $('next').disabled = rows.length < 50; $('page-number').textContent = `第 ${offset / 50 + 1} 页`;
  rows.forEach(row => {
    const line = element('div', '', 'row'), content = element('div', '', 'row-content'), status=element('div','','row-state');line.setAttribute('role','listitem');line.dataset.key=String(row.id);rowSignatures.set(line,JSON.stringify(row));
    if (tab === 'events') {
      line.dataset.deliveryKey = String(row.delivery_id || ''); line.dataset.deliveryRecord = String(row.id);
      line.dataset.deliverySource = row.source?.reference || 'deliveries:' + row.id;
    }
    const name = taskTab ? `${row.kind === 'development.pr' ? '跟进 ' : ''}${objectLabel(row)} · ${row.full_name || '仓库 ' + row.repository_id}` : (tab==='events'?(row.full_name?row.full_name+' · '+row.route:row.route):row.full_name) || row.name || row.username || row.model_name || row.summary || row.route || '未知事件';
    content.append(element('strong', name));
    if (tab === 'projects' && !hiddenView && row.registered !== false) content.append(consoleLink(`#/projects/${row.id}/overview`, '项目总览', '查看工作进展与待处理事项'));
    if (tab === 'events') {
      // The delivery ID and the archive reference are the two handles a maintainer copies when checking GitHub's own log.
      content.append(element('p', `${timestamp(row.received_at)} · ${row.event || '未知事件'} · 来源 ${line.dataset.deliverySource}`));
      const delivery = element('code', String(row.delivery_id || '')); delivery.dataset.deliveryId = ''; delivery.title = 'GitHub delivery ID'; content.append(delivery);
      line.append(content);
      status.append(...['reception','signature','processing'].map(kind => deliveryFacet(kind, row)));
    } else {
      const detail = taskTab ? `${phaseLabels[row.phase] || row.phase} · ${row.head_sha ? '提交 ' + row.head_sha.slice(0,12) : '等待材料'} · 第 ${row.attempt} 次 · 更新于 ${timestamp(row.updated_at)}${row.error_code ? ' · '+faultSummary(row.error_code,row.error_cause) : ''}${tab === 'reviews' && Array.isArray(row.result?.findings) ? ` · ${row.result.findings.length} 条发现` : ''}`
        : installedView ? installedDetail(row) : `仓库 ID ${row.id}${row.model_id ? '' : ' · 未选模型'}`;
      content.append(element('p', detail)); line.append(content);
      if(listTabs.includes(tab))status.append(taskTab ? taskState(row) : state(row.status));
    }
    if(tab==='events'){
      for(const task of row.tasks||[])content.append(button(`${kindLabels[task.kind]||task.kind} #${task.object_number} · 查看任务`,()=>openTask(task.id),'quiet linkish'));
      // The Manager trace stays next to the outcome: what it did, or why the delivery never reached it.
      const managerRow=(row.dispatch||[])[0];
      if(managerRow)content.append(element('p','Manager 分派：'+dispatchCaption(managerRow)+(managerRow.reason?' · '+managerRow.reason:''),'muted'));
      else if(row.processing_result&&deliveryIgnoreReasons[row.processing_result])content.append(element('p','未交给 Manager：'+deliveryIgnoreReasons[row.processing_result],'muted'));
    }
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
        try { $('detail-title').textContent='投递详情'; $('detail-body').replaceChildren(...deliveryDetail(await api('/api/events/' + row.id))); $('detail').showModal(); } catch (err) { error(err); }
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
  const entries = tab === 'projects' ? groupProjectRows(rows, lines) : lines, shown = [...$('rows').children];
  if(quiet&&shown.length===entries.length&&shown.every((node,index)=>node.dataset.key===entries[index].dataset.key))
    shown.forEach((node,index)=>{if(rowSignatures.get(node)!==rowSignatures.get(entries[index]))node.replaceWith(entries[index]);});
  else $('rows').replaceChildren(...entries);
  if (tab === 'projects' && !installedView && !repositories.length && !rows.length) {
    const empty = consoleState('已登录，尚无可管理的项目', '可以先查看身份与权限；安装待同步或权限待核验时，按身份页提示重新验证，或联系管理员分配项目。', { retry: () => start().catch(error) });
    empty.append(consoleLink('#/identity', '查看身份与权限')); $('rows').replaceChildren(empty);
  }
  if(staleIntegrations)refreshStaleIntegrations();
  if(installedView&&!hiddenView&&rows.some(row=>row.permissions_stale))refreshStalePermissions();
}
// Group only the rows already loaded, preserving each owner's first position and the order within it.
function groupProjectRows(rows, lines) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const owner = String(row.owner_id);
    if (!groups.has(owner)) groups.set(owner, { rows: [], lines: [], login: '', name: '' });
    const group = groups.get(owner);
    group.rows.push(row); group.lines.push(lines[index]);
    group.login ||= row.owner_login;
    if (row.full_name?.includes('/')) group.name ||= row.full_name.split('/')[0];
  });
  return [...groups].map(([owner, group]) => {
    const section = element('div', '', 'project-owner-group'), title = group.login || group.name || `所有者 ${owner}`;
    section.setAttribute('role', 'listitem'); section.dataset.ownerId = owner; section.dataset.key = owner;
    const list = element('div', '', 'project-owner-rows'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', title);
    list.append(...group.lines); section.append(element('h2', title, 'project-owner-title'), list);
    rowSignatures.set(section, JSON.stringify(group.rows));
    return section;
  });
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
  try {
    const rows = (await api('/api/installations/permissions/check', 'POST', {})).repositories || [];
    updatePermissionBadges(rows);
    // The check answers with the same snapshot rows the navigation shows gaps from; leaving it out is how the bar and the
    // project header end up describing two different reads.
    if (typeof updateConsoleGaps === 'function') updateConsoleGaps(rows);
  } catch {}
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
function userDisplayName(user) { return user.github_login ? '@' + user.github_login : user.username; }
function userAccessLines(user) {
  const projects = user.access?.projects || [], lines = [element('p', projects.length ? `当前可见项目（${projects.length}）：` : '当前没有可访问的项目')];
  if (projects.length) {
    const list = element('ul', '', 'user-project-access');
    for (const project of projects) list.append(element('li', `${project.full_name} · ${project.can_configure ? '可配置' : '可查看'} · ${project.sources.map(source => source === 'github_derived' ? 'GitHub 继承权限' : 'Bot 显式委派').join('、')}`));
    lines.push(list);
  }
  if (user.access?.github_pending) lines.push(element('p', 'GitHub 权限待验证，未计入当前可见项目；用户可在「身份与权限」重新验证。', 'warning'));
  lines.push(element('p', grantSummary(user))); return lines;
}
function userLine(row) {
  return settingsRow(userDisplayName(row), `${row.role === 'super_admin' ? '超级管理员 · 管理全部项目' : '项目管理员'} · ID ${row.id}`, row.role === 'project_admin' ? userAccessLines(row) : [],
    [element('span', row.active ? '已启用' : '已停用', 'status' + (row.active ? ' status-success' : ''))],
    [...(row.role === 'project_admin' ? [button('修改仓库权限', () => editGrants(row))] : []), button('删除', () => deleteUser(row).catch(error), 'quiet destructive')]);
}
async function deleteUser(row) {
  const self = row.id === me.id, kept = '仓库和组织授权、个人看板设置一并去掉，登录名可以重新使用；操作审计保留。';
  const deleted = await askConfirm({ title: self ? `删除你自己的账号 ${userDisplayName(row)}？` : `删除用户 ${userDisplayName(row)}？`, action: '删除', danger: true,
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
// Removes the project's records, environment and notes without changing anything on GitHub.
async function deleteProjectRecord(row, after) {
  const deleted = await askConfirm({ title: `删除项目 ${row.full_name}？`, action: '删除', danger: true,
    body: ['只从本系统移除：项目环境、长期笔记、项目策略、成员分配、专属模型、公共配置记录、任务记录和安装列表里的这一行一并删除，操作审计保留。',
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
$('editor-form').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget, data = Object.fromEntries(new FormData(form));
  if (editorKind === 'accounts') { if (data.type === 'github_app') delete data.token; else { delete data.private_key; delete data.app_id; } }
  if (editorKind === 'users') { delete data.grants; if (data.role !== 'super_admin') Object.assign(data, chosenGrants(form)); }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try { if (editingUser) await api('/api/project-admin-assignments', 'PUT', { user_id: editingUser.id, ...chosenGrants(form) }); else await api('/api/' + editorKind, 'POST', data); $('editor').close(); form.reset(); await start(); } catch (err) { error(err); } finally { submit.disabled = false; }
});
$('cancel').addEventListener('click', () => { $('editor').close(); $('editor-form').reset(); });
$('close-detail').addEventListener('click', () => $('detail').close());
$('boot-retry').addEventListener('click', async () => {
  const retry = $('boot-retry'), message = $('boot-message');
  retry.disabled = true; retry.hidden = true;
  message.textContent = '正在载入…'; message.setAttribute('role', 'status'); message.classList.remove('view-error');
  try { await start(); } catch (err) { error(err); } finally { retry.disabled = false; }
});
let accessPending = false;
$('access-password-toggle').addEventListener('click', () => {
  const password = $('access-password'), shown = password.type === 'password'; password.type = shown ? 'text' : 'password';
  $('access-password-toggle').textContent = shown ? '隐藏密码' : '显示密码'; $('access-password-toggle').setAttribute('aria-pressed', String(shown));
});
$('github-login').addEventListener('click', event => { if (accessPending) event.preventDefault(); });
$('access-provider-retry').addEventListener('click', async () => {
  $('access-provider-retry').disabled = true; try { await start(); } catch (err) { error(err); } finally { $('access-provider-retry').disabled = false; }
});
$('access-form').addEventListener('submit', async event => {
  event.preventDefault(); if (accessPending) return;
  const form = event.currentTarget, data = Object.fromEntries(new FormData(form)), submit = $('access-submit'), initializing = setup;
  const controls = [...form.elements].map(control => [control, control.disabled]);
  accessPending = true; controls.forEach(([control]) => { control.disabled = true; }); form.setAttribute('aria-busy', 'true');
  submit.textContent = initializing ? '正在初始化…' : '正在登录…'; $('github-login').setAttribute('aria-disabled', 'true'); notice('message');
  try {
    await api(initializing ? '/api/setup' : '/api/auth/login', 'POST', data);
    form.reset(); $('message').setAttribute('role', 'status'); const url = new URL(location.href); url.searchParams.delete('auth_error'); history.replaceState(null, '', url);
    try { await start(); } catch (err) { showBootFailure(err); }
  } catch (err) {
    const text = /invalid_login/.test(err.message) ? '用户名或密码不正确，请检查后重试。' : /login_rate_limited/.test(err.message) ? '登录尝试过于频繁，请稍后再试。' : /already_initialized/.test(err.message) ? '系统已经初始化，请使用已有账号登录。' : err instanceof TypeError ? '网络连接失败，请检查连接后重试。已输入的内容仍保留在当前页面。' : err.message;
    if (/already_initialized/.test(err.message)) await start().catch(error);
    notice('message', text); $('message').setAttribute('role', 'alert');
  } finally {
    accessPending = false; controls.forEach(([control, disabled]) => { control.disabled = disabled; }); form.removeAttribute('aria-busy');
    submit.textContent = setup ? '初始化并登录' : '登录'; $('github-login').removeAttribute('aria-disabled');
  }
});
// Signing out returns to the default page, so whoever signs in next does not land on the previous user's page; the wizard
// keeps its address (onboarding.js resets it to the first step).
$('logout').addEventListener('click', async () => { try { await api('/api/auth/logout', 'POST', {}); renderVersion++; me = null; tab = 'projects'; if (!onboardingAddress.test(location.hash)) history.replaceState(null, '', location.pathname); repositories=[];accounts=[]; $('rows').replaceChildren();$('detail-body').replaceChildren(); await start(); } catch (err) { error(err); } });
// The address is written without waiting for hashchange, so the page switches in the same click; back and forward still
// fire hashchange and draw the page they return to.
$('tabs').addEventListener('click', event => { const name = event.target.dataset.tab; if (!name) return;
  if (name === 'management') { void openManagementPage(projectRoute()?.id || null).catch(error); return; }
  if (location.hash !== tabAddresses[name]) history.pushState(null, '', tabAddresses[name]); offset = 0; route().catch(error); });
$('refresh').addEventListener('click', () => start().catch(error));
// The onboarding dialog calls this once a run reaches a terminal state.
window.refreshIntegrations = () => api('/api/integrations/check', 'POST', {}).then(() => start()).catch(() => {});
$('sync').addEventListener('click', async () => {
  $('sync').disabled = true; $('message').textContent = '正在从 GitHub 同步安装列表…';
  try { const result = await api('/api/installations/sync', 'POST', {}); if (typeof forgetConsoleGaps === 'function') forgetConsoleGaps(); await start(); const conclusion = installationSyncNotice(result); notice('message', conclusion.text, conclusion.tone); }
  catch (err) { notice('message', '安装列表同步失败：' + err.message + '，还不能判断全部正常。'); } finally { $('sync').disabled = false; }
});
$('filters').addEventListener('submit', event => { event.preventDefault(); offset = 0; render().catch(error); });
$('hidden-filter').addEventListener('change', () => { offset = 0; render().catch(error); });
for (const [id, delta] of [['previous', -50], ['next', 50]]) $(id).addEventListener('click', () => { offset += delta; render().catch(error); });
document.addEventListener('DOMContentLoaded',()=>start().catch(error),{once:true});
setInterval(()=>{if(me&&tab==='projects'&&!$('hidden-filter').checked&&!projectRoute()&&!document.querySelector('dialog[open]'))refreshProjectActivity();},5000);
