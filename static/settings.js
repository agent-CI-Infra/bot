// Global settings (super administrators only), laid out like a project page: categories on the left, one category on the
// right, each with its own address (#/settings/<section>) so a reload stays on it. Loaded after app.js, views.js and
// project.js and reuses their helpers; tunnelCredential comes from onboarding.js, which loads later but before any page is drawn.
// The wizard settings and models are saved through the wizard's and the model APIs; a card redraws only itself.
titles.settings = '全局设置';
// waiting_token with a saved token means this deployment has no tunnel status endpoint to read.
const tunnelStates = { waiting_token: '读不到状态', not_running: 'tunnel 服务未运行', connecting: '正在连接', connected: '已连接' };
const settingsSections = [['general', '常规'], ['onboarding', '接入向导'], ['feishu', '飞书连接'], ['access', '公网接入'], ['accounts', '机器人账号'], ['installations', '安装档案'], ['models', '模型'], ['service-roles', '服务角色'], ['users', '用户']];
// A settings address is a section and, for a detail page, one record inside it: #/settings/installations/<host>/<app>/<id>
// and #/settings/users/<id>. Unknown sections fall back to 常规, an unreadable id is handled by the page itself.
function settingsRoute() {
  if (/^#\/settings\/onboarding(?:\/|$)/.test(location.hash)) return { section: 'onboarding', id: null };
  if (/^#\/settings\/feishu(?:\/|$)/.test(location.hash)) return { section: 'feishu', id: null };
  const match = /^#\/settings\/([a-z-]+)(?:\/(.+))?$/.exec(location.hash), key = match?.[1];
  return { section: settingsSections.some(([name]) => name === key) ? key : 'general', id: match?.[2] ? decodeURIComponent(match[2]) : null };
}
// What the cards draw from; the model cards are redrawn together because deleting the default model clears it.
let settingsView = null;
async function renderSettings(request) {
  const route = settingsRoute(), section = route.section, nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content'), body = element('div', '', 'project-body settings-body');
  nav.setAttribute('aria-label', '全局设置类别');
  for (const [key, caption] of settingsSections) { const item = element('a', caption); item.href = '#/settings/' + key; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item); }
  // The categories are drawn at once; the chosen category's cards follow when their data arrives.
  $('count').textContent = ''; content.append(element('p', '正在加载…', 'muted')); body.append(nav, content); $('settings-panel').replaceChildren(body);
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  // The hash may only choose among the declared sections: never let a user-written name reach the prototype chain, and
  // never call anything that is not a declared loader. Anything else falls back to 常规.
  const handler = Object.hasOwn(settingsCards, section) ? settingsCards[section] : settingsCards.general;
  if (typeof handler !== 'function') return;
  const cards = await handler(request, route.id);
  if (request !== renderVersion) return;
  content.replaceChildren(...cards);
}
// Each category loads only what its cards show.
const settingsCards = {
  async feishu(request) {
    const panel = element('div', '', 'feishu-setup'); await renderFeishuSetup(panel, request); return [panel];
  },
  async onboarding(request) {
    const panel = element('div', ''); panel.id = 'onboarding-panel';
    try { await renderOnboarding(request, panel); }
    catch (err) { if (request === renderVersion) panel.replaceChildren(consoleState('接入状态读取失败', err.message, { tone: 'error', retry: () => render().catch(error) })); }
    return [panel];
  },
  async installations(request, ref) {
    if (ref) return installationDetail(request, ref);
    // The console already loaded the registered accounts at start (app.js), so the archive view adds no request of its own.
    const { installations } = await api('/api/installations/archive'), section = card('GitHub App 安装档案'),
      apps = new Map(accounts.filter(account => account.type === 'github_app').map(account => [String(account.app_id), account]));
    section.append(note('安装范围与控制台角色分别管理。事件触发者和申请者不代表当前有权管理的人。'));
    if (!installations.length) section.append(note('尚无安装档案。同步后也会保留零仓库安装和历史证据缺失标记。'));
    for (const installation of installations) {
      const item = card(`${installation.target.login || '目标待同步'} · 安装 ${installation.installation.installation_id}`), evidence = installation.evidence;
      const owner = apps.get(String(installation.installation.app_id)), granted = Object.entries(installation.permissions || {}).map(([name, level]) => `${permissionNames[name] || name}（${accessNames[level] || level}）`).join('、');
      const person = value => value ? `${value.login || '名称未知'}（${value.id}）` : '未知／未提供';
      item.append(facts([['所属账号', owner ? `${owner.name}（GitHub App · App ID ${owner.app_id}）` : '未匹配到已登记账号（App 已删除或凭据已撤销）'],
        ['授权来源', evidence.creation_event_id ? 'GitHub App 安装事件（签名验证）' : '历史证据缺失，授权来源未知'],
        ['安装授权（GitHub 返回）', granted || '未同步到权限，不能据此判断缺什么'],
        ['GitHub 目标 ID', installation.target.id || '待同步'], ['目标类型', installation.target.type || '待同步'],
        ['状态', ({ active: '有效', pending_sync: '等待同步', suspended: '已暂停', deleted: '已卸载' })[installation.status]],
        ['范围', installation.repository_selection === 'all' ? '全部仓库' : installation.repository_selection === 'selected' ? '指定仓库' : '待同步'],
        ['完整性', ({ complete: '完整', pending: '等待同步', stale: '待核实', error: '同步失败，保留最近成功快照' })[installation.completeness]],
        ['安装事件触发者', person(evidence.sender)], ['申请者', person(evidence.requester)], ['批准者', evidence.approval.label],
        ['历史证据', evidence.history_missing ? '历史证据缺失' : '已保留签名安装事件'],
        ['最近成功同步', installation.last_success_at ? timestamp(installation.last_success_at) : '尚未成功同步'],
        ['投影／范围／权限版本', `${installation.projection_version} / ${installation.scope_version} / ${installation.permissions_version}`]]));
      if (!evidence.requester) item.append(note('未提供申请者不等于从未申请。历史安装查询不能补齐完整批准历史。'));
      if (installation.error) item.append(note(`同步错误：${installation.error}`));
      // Missing permissions are checked against the App that owns this installation, when its credential still exists.
      if (owner?.credentials_configured) item.append(appPermissionCheck(owner));
      else if (owner) item.append(note('这个 App 的凭据已撤销，无法检查安装缺少哪些权限。'));
      // The detail page reads the same snapshot plus its repositories and events; the list stays a summary.
      item.append(settingsLink('#/settings/installations/' + [installation.installation.github_host, installation.installation.app_id, installation.installation.installation_id].join('/'), '查看安装详情'));
      section.append(item);
    }
    return [section];
  },
  async general(request) {
    const { settings, version } = await api('/api/settings');
    const about = card('当前运行版本');
    about.append(version.image_tag ? facts([['镜像标签', version.image_tag]]) : note('源码运行：没有设置镜像标签（BOT_IMAGE_TAG），版本以部署所用的源码提交为准。'));
    const [min, max] = settings.task_concurrency_bounds, concurrency = card('同时运行的任务');
    const form = document.createElement('form'), value = input('task_concurrency', settings.task_concurrency, { type: 'number', min, max, step: 1, required: true });
    const message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', '保存');
    form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert'); actions.append(submit);
    form.append(field('每台虚拟电脑默认同时运行的任务数', value),
      note(`取 ${min}–${max}。每个仓库一台虚拟电脑；项目在「机器配置」里没有单独设置时使用这个值，超出的任务继续排队。同时运行的任务各用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限。`),
      message, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); message.className = 'view-error'; message.textContent = '';
      if (!value.checkValidity()) { message.textContent = `需要 ${min}–${max} 之间的整数`; value.focus(); return; }
      submit.disabled = true;
      try {
        const saved = await api('/api/settings', 'PATCH', { task_concurrency: Number(value.value) });
        value.value = saved.settings.task_concurrency; message.className = 'view-success'; message.textContent = '已保存，新任务按这个并发数排队';
      } catch (err) { message.textContent = err.message; } finally { submit.disabled = false; }
    });
    concurrency.append(form);
    const resources = { computer: settings.computer_defaults };
    return [about, concurrency, liveCard('虚拟电脑默认资源', redraw => resourceDefaultsBody(resources, redraw)).section];
  },
  // Where GitHub's webhooks arrive: a self-hosted HTTPS address, or a Cloudflare Tunnel in front of it.
  async access(request) {
    const view = settingsView = { request, onboarding: await api('/api/onboarding'), accounts: [], models: [] };
    view.address = liveCard('公网 HTTPS 地址', redraw => addressBody(view, redraw));
    view.tunnel = liveCard('Cloudflare Tunnel', redraw => tunnelBody(view, redraw));
    return [view.address.section, view.tunnel.section];
  },
  // The App the wizard uses, then every registered account (GitHub Apps and bot tokens). One account has its own page;
  // that page does all of its own reading, so the list keeps the requests the console already made.
  async accounts(request, id) {
    if (id) return accountDetail(request, id);
    const [onboarding, { accounts: registered }, limits] = await Promise.all([api('/api/onboarding'), api('/api/accounts'), api('/api/github/rate-limits').catch(() => null)]);
    const view = settingsView = { request, onboarding, accounts: registered, models: [], limits };
    view.app = liveCard('接入向导使用的 GitHub App', redraw => appBody(view, redraw));
    return [view.app.section, settingsList('已登记的账号', '账号提供访问 GitHub 的凭据和接收 webhook 的入口；仓库经账号同步出现。凭据只保存，不会从读取接口返回。',
      registered.map(accountProfileLine), '还没有登记账号。', '新增账号', 'accounts'), liveCard('GitHub 请求额度', redraw => rateLimitBody(view, redraw)).section];
  },
  async models(request) {
    const [onboarding, { models }] = await Promise.all([api('/api/onboarding'), api('/api/models')]);
    const view = settingsView = { request, onboarding, accounts: [], models };
    view.defaultModel = liveCard('默认共享模型', redraw => defaultModelBody(view, redraw));
    view.sharedModels = liveCard('部署共享模型', () => sharedModelsBody(view));
    return [view.defaultModel.section, view.sharedModels.section];
  },
  // Platform assistants that are not bound to one project: a card per role, then the form for a new custom role.
  async 'service-roles'(request) {
    const [{ service_roles: roles, permission_items: items }, { models }] = await Promise.all([api('/api/service-roles'), api('/api/models')]);
    const view = { request, roles, items, models: models.filter(model => model.repository_id === null) };
    const intro = card('服务角色');
    intro.append(note('服务角色是平台级的助手：管理助手用于控制台管理对话和个人私聊，仓库问答助手是群聊的默认推荐角色。它们不属于某个项目，使用部署共享模型，用量按角色单独记录，不计入任何项目。项目里的 Manager、Dev、QA 等工作角色在各项目的「角色」页配置。'));
    return [intro, ...roles.map(role => serviceRoleCard(view, role)), serviceRoleCreate(view)];
  },
  async users(request, id) {
    const [{ users }, assigned] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    grants = assigned;
    if (id) return [userDetail(id, users)];
    return [settingsList('用户', '项目权限由 GitHub 当前权限和 Bot 内显式委派共同决定；下面显示当前可见项目及来源。超级管理员管理全部项目和全局设置。', users.map(userProfileLine), '还没有用户。', '新增用户', 'users')];
  },
};
// The resources a computer gets for every value its project does not set itself, chosen from common sizes inside the
// manager's bounds; CPU and memory sizes larger than the host are not offered. The current value is always an option.
const commonSizes = { cpus: [0.5, 1, 2, 4, 6, 8, 12, 16], memory_mb: [512, 1024, 2048, 4096, 8192, 12288, 16384, 32768, 65536],
  pids: [256, 512, 1024, 2048, 4096, 8192, 16384], tmp_mb: [256, 512, 1024, 2048, 4096, 8192, 16384] };
const megabytes = value => value >= 1024 ? `${Number((value / 1024).toFixed(1))} GB` : `${value} MB`;
const resourceFields = [['cpus', 'CPU', value => `${value} 核`], ['memory_mb', '内存', megabytes], ['pids', '进程数上限', value => `${value} 个`], ['tmp_mb', '/tmp 大小', megabytes]];
function resourceDefaultsBody(view, redraw) {
  if (!view.computer) return [note('暂时读不到 manager，无法显示默认资源，稍后再试。')];
  const { defaults, builtin, bounds, host, allocated } = view.computer, hostLimit = { cpus: host?.cpus, memory_mb: host?.memory_mb };
  const grid = element('div', '', 'field-grid'), controls = {};
  for (const [key, caption, label] of resourceFields) {
    const select = controls[key] = document.createElement('select'); select.name = key;
    const sizes = [...new Set([...commonSizes[key].filter(size => size >= bounds[key][0] && size <= bounds[key][1] && !(hostLimit[key] && size > hostLimit[key])), defaults[key]])].sort((a, b) => a - b);
    for (const size of sizes) { const option = element('option', label(size) + (size === builtin[key] ? '（内置默认）' : '')); option.value = String(size); select.append(option); }
    select.value = String(defaults[key]); grid.append(field(caption, select));
  }
  return [facts([['这台主机', host ? `${host.cpus} CPU · ${megabytes(host.memory_mb)} 内存` : '读不到'],
    ['运行中的虚拟电脑', `${allocated.computers} 台，共分配 ${allocated.cpus} CPU · ${megabytes(allocated.memory_mb)} 内存`]]),
    note('项目在「机器配置」里留空的资源使用这里的值。虚拟电脑共用这台主机，分配总量可以超过主机，同时满载时会互相争用。'),
    actionForm([grid, note('保存后新建的虚拟电脑立即使用新值；已有的虚拟电脑等到没有任务运行时按新值重建，工作卷和代次保留，运行中的任务不会被打断。')], '保存', async () => {
      const changes = Object.fromEntries(resourceFields.map(([key]) => [key, Number(controls[key].value)]).filter(([key, value]) => value !== defaults[key]));
      if (!Object.keys(changes).length) { redraw('没有改动'); return; }
      view.computer = (await api('/api/settings', 'PATCH', { computer_defaults: changes })).settings.computer_defaults;
      redraw('已保存：新建的虚拟电脑立即使用，已有的在空闲时重建');
    })];
}
// GitHub's hourly request windows per credential, grouped by account: the App's own (JWT), each installation (an
// organization or user, shared by every repository and task agent there) and a bot account's user.
const windowNames = { core: 'REST', graphql: 'GraphQL', search: '搜索' };
function rateLimitBody(view, redraw) {
  const nodes = [note('GitHub 按发出请求的身份分别计算每小时的请求额度。GitHub App 按安装计算：装在几个组织（或个人账号）上就有几份，每份由那个组织下所有仓库的检视、开发和任务 agent 的请求共用，一个组织用完不影响其他组织。Token 账号按 Token 所属的 GitHub 用户计算，只有一份，它处理的所有仓库和这个用户的其他 Token 共用。'),
    note('额度用完时，任务等到窗口重置再继续，不在窗口内重试。数据来自 GitHub 每次响应和每 10 分钟的同步；「探测」立即读取一次；读窗口不计入额度，App 签发临时令牌、Token 账号首次读取登录名会各用少量请求。App 自身（JWT）的请求只在 GitHub 报告额度时列出。')];
  if (!view.limits) { nodes.push(element('p', '暂时读不到请求额度。', 'view-error')); return nodes; }
  for (const account of view.accounts) {
    const recorded = view.limits.accounts.find(row => row.account_id === account.id), head = element('div', '', 'actions settings-list-head');
    const probe = button('探测', async () => {
      probe.disabled = true;
      try { view.limits = await api(`/api/accounts/${account.id}/rate-limits/probe`, 'POST', {}); redraw(`已读取 ${account.name} 的请求额度`); }
      catch (err) { probe.disabled = false; message.textContent = err.message; }
    }, ''), message = element('p', '', 'view-error');
    message.setAttribute('role', 'alert');
    head.append(element('h4', `${account.name}（${account.type === 'github_app' ? 'GitHub App' : 'Token 账号'}）`), probe); nodes.push(head, message);
    if (!recorded?.buckets.length) { nodes.push(note('还没有记录，点「探测」读取。')); continue; }
    const table = element('table', '', 'rule-table rate-table'), headRow = element('tr', '');
    for (const caption of ['对象', '额度', '已用', '剩余', '窗口重置', '状态']) headRow.append(element('th', caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(headRow); table.append(thead, body);
    for (const bucket of recorded.buckets) for (const window of bucket.windows) {
      const row = element('tr', ''), cell = (label, value) => { const td = element('td', ''); td.dataset.label = label; td.append(value); row.append(td); };
      const who = bucket.kind === 'app' ? 'App 自身（JWT）' : bucket.kind === 'user' ? `Token 用户 ${bucket.owner || '（登录名未读到）'}`
        : `${bucket.owner ? bucket.owner + ' 上的 ' : ''}App 安装（${bucket.installation_id}）`;
      const share = window.quota ? window.remaining / window.quota : 1, meter = element('span', '', 'rate-meter'), fill = element('span', '');
      fill.style.width = `${Math.round(Math.min(1, window.used / (window.quota || 1)) * 100)}%`; if (share < 0.1) fill.className = 'low'; meter.append(fill);
      const status = window.resource === 'core' && bucket.blocked_until ? badge(`流控中，${timestamp(new Date(bucket.blocked_until).toISOString()).slice(11, 19)} 后继续`, 'danger')
        : window.expired ? badge('窗口已重置', '') : share < 0.1 ? badge('将用完', 'warning') : badge('正常', 'success');
      const state = element('span', ''); state.append(status);
      if (window.resource === 'core' && bucket.waiting_tasks) state.append(' ', element('span', `${bucket.waiting_tasks} 个任务在等`, 'muted'));
      cell('对象', `${who} · ${windowNames[window.resource] || window.resource}`);
      cell('额度', String(window.quota)); const used = element('span', String(window.used)); used.append(' ', meter); cell('已用', used);
      cell('剩余', String(window.remaining)); cell('窗口重置', window.reset_at ? timestamp(new Date(window.reset_at).toISOString()) : '—'); cell('状态', state);
      body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); nodes.push(wrap);
    const observed = recorded.buckets.flatMap(b => b.windows.map(w => w.observed_at)).sort().at(-1);
    if (observed) nodes.push(note('最近一次读取：' + timestamp(observed)));
  }
  if (!view.accounts.length) nodes.push(note('还没有登记账号。'));
  return nodes;
}
// A card holding a list of records with one add button that opens the shared editor.
function settingsList(title, intro, lines, empty, caption, kind) {
  const section = card(title), list = element('div', '', 'rows settings-rows'), head = element('div', '', 'actions settings-list-head');
  list.setAttribute('role', 'list'); list.setAttribute('aria-label', title); list.append(...(lines.length ? lines : [element('p', empty, 'muted')]));
  head.append(note(intro), button(caption, () => openEditor(kind), ''));
  section.append(head, list); return section;
}
// In-console addresses are hash links, not external URLs: link() only builds absolute http(s) anchors.
function settingsLink(hash, text) { const a = element('a', text); a.href = hash; return a; }
// One installation: its archive snapshot, the repositories it grants and its recent deliveries. Evidence is shown as
// recorded: a missing history never becomes "no request", and an unverified signature is marked instead of trusted.
const installationStatusNames = { active: '有效', pending_sync: '等待同步', suspended: '已暂停', deleted: '已卸载' };
const installationCompletenessNames = { complete: '完整', pending: '等待同步', stale: '待核实', error: '同步失败，保留最近成功快照' };
async function installationDetail(request, ref) {
  const section = card('安装档案详情'), content = element('div', ''), back = settingsLink('#/settings/installations', '返回安装档案');
  section.append(back, content);
  const match = /^([^/]+)\/([1-9]\d*)\/([1-9]\d*)$/.exec(ref || '');
  if (!match) { content.append(note('安装地址不完整，请从安装档案列表打开。')); return [section]; }
  const base = `/api/installations/archive/${match[1]}/${match[2]}/${match[3]}`;
  // A notice carries the tone of its own outcome: a failed re-sync must not look like a success.
  const draw = async (notice, tone = 'view-success') => {
    content.replaceChildren(element('p', '正在加载…', 'muted'));
    try {
      const [record, repositories, deliveries] = await Promise.all([api(base), api(base + '/repositories'), api(base + '/events')]);
      content.replaceChildren(...(notice ? [element('p', notice, tone)] : []),
        ...installationDetailBody(base, record.installation, repositories.repositories || [], deliveries.events || [], draw));
    } catch (err) { content.replaceChildren(note('读不到这条安装：' + err.message)); }
  };
  await draw('');
  return [section];
}
function installationDetailBody(base, snapshot, repositories, deliveries, redraw) {
  const nodes = [], installation = snapshot.installation, evidence = snapshot.evidence || {};
  nodes.push(element('h4', `${snapshot.target.login || '目标待同步'} · 安装 ${installation.installation_id}`),
    facts([['状态', installationStatusNames[snapshot.status] || snapshot.status],
      ['范围', snapshot.repository_selection === 'all' ? '全部仓库' : snapshot.repository_selection === 'selected' ? '指定仓库' : '待同步'],
      ['完整性', installationCompletenessNames[snapshot.completeness] || snapshot.completeness],
      ['最近成功同步', snapshot.last_success_at ? timestamp(snapshot.last_success_at) : '尚未成功同步'],
      ['执行', snapshot.execution_blocked ? '已阻止：安装未生效或范围变更待确认' : '可以执行'],
      ['投影／范围／权限版本', `${snapshot.projection_version} / ${snapshot.scope_version} / ${snapshot.permissions_version}`]]));
  const permissions = Object.entries(snapshot.permissions || {}).map(([name, level]) => `${permissionNames[name] || name}（${accessNames[level] || level}）`);
  nodes.push(facts([['安装授权（GitHub 返回）', permissions.join('、') || '未同步到权限，不能据此判断缺什么']]));
  // A missing history is stated as missing; it is not evidence that nobody ever applied, nor an approver to show.
  if (evidence.history_missing) nodes.push(note('历史证据缺失：不能判断申请者与批准者，也不能据此认为没有申请。'));
  else {
    const person = value => value ? `${value.login || '名称未知'}（${value.id}）` : '未提供';
    nodes.push(facts([['安装事件触发者', person(evidence.sender)], ['申请者', person(evidence.requester)], ['批准者', evidence.approval?.label || '批准者未知']]));
  }
  const repoSection = element('section', ''); repoSection.append(element('h4', `仓库（${repositories.length}）`));
  if (!repositories.length) repoSection.append(element('p', '无仓库（零仓库安装也会保留；同步后新仓库会出现）', 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', '');
    for (const caption of ['仓库', '私有', '最近成功同步']) head.append(element('th', caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head); table.append(thead, body);
    for (const repository of repositories) {
      const row = element('tr', '');
      row.append(element('td', repository.full_name), element('td', repository.private ? '私有' : '公开'),
        element('td', repository.last_success_at ? timestamp(repository.last_success_at) : '尚未同步'));
      body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); repoSection.append(wrap);
  }
  nodes.push(repoSection);
  const eventSection = element('section', ''); eventSection.append(element('h4', `最近安装事件（${deliveries.length}）`));
  if (!deliveries.length) eventSection.append(element('p', '还没有记录到安装事件。', 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', '');
    for (const caption of ['时间', '事件', '动作', '发送者', '申请者', '证据类型', '签名']) head.append(element('th', caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head); table.append(thead, body);
    const person = value => value ? `${value.login || '名称未知'}（${value.id}）` : '未提供';
    for (const event of deliveries) {
      const row = element('tr', '');
      row.append(element('td', event.received_at ? timestamp(event.received_at) : '—'), element('td', event.event || '—'),
        element('td', event.action || '—'), element('td', person(event.sender)), element('td', person(event.requester)),
        element('td', event.evidence_type || '—'));
      const signature = element('td', ''); signature.append(event.signature_verified ? badge('签名已验证', 'success') : badge('签名未验证', 'danger'));
      row.append(signature); body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); eventSection.append(wrap);
  }
  nodes.push(eventSection);
  // Only this card redraws after the sync request; the other archive cards keep what they already showed.
  const sync = button('重新同步', async () => {
    sync.disabled = true;
    try { await api(base + '/sync', 'POST', {}); await redraw('已排队重新同步：完成后刷新这一页查看新状态。'); }
    catch (err) { await redraw('重新同步失败：' + err.message, 'view-error'); }
    finally { sync.disabled = false; }
  });
  const actions = element('div', '', 'actions'); actions.append(sync); nodes.push(actions);
  return nodes;
}
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
  content.append(element('p', `凭据来源：${source}${account.credentials_configured ? '' : ' · 已撤销，需要重新登记'}`));
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
  // Only registered projects are counted: an installation the account no longer lists is not a project of this console.
  const projectSection = element('section', ''); projectSection.append(element('h4', `使用项目（${projects.length}）`));
  if (!projects.length) projectSection.append(element('p', '这个账号还没有已登记的项目。', 'muted'));
  else for (const project of projects) projectSection.append(element('p', project.full_name));
  nodes.push(projectSection);
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
// Why a user change was refused, in words instead of the bare server code.
function userChangeMessage(err) {
  const code = err.code || String(err.message).replace(/^\d+\s*·\s*/, '');
  if (code === 'last_super_admin') return '这是最后一名活跃的超级管理员，不能停用。先启用或新增另一名超级管理员。';
  if (code === 'user_not_found') return '这个用户已经不存在，请刷新用户列表。';
  return err.message;
}
function userProfileLine(user) {
  const line = userLine(user), actions = line.querySelector('.actions');
  if (actions) actions.prepend(settingsLink('#/settings/users/' + encodeURIComponent(user.id), '详情'));
  return line;
}
// One user's access projection plus the enable/disable switch the API already offered but the console did not show.
function userDetail(id, users) {
  const section = card('用户详情'), content = element('div', ''), back = settingsLink('#/settings/users', '返回用户列表'),
    message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  section.append(back, content);
  const user = users.find(row => row.id === id);
  if (!user) { content.append(note('找不到这个用户，可能已被删除。')); return section; }
  let notice = '';
  const draw = () => {
    content.replaceChildren();
    if (notice) content.append(element('p', notice, 'view-success'));
    content.append(element('h4', userDisplayName(user)),
      facts([['角色', user.role === 'super_admin' ? '超级管理员 · 管理全部项目' : '项目管理员'], ['状态', user.active ? '已启用' : '已停用'],
        ['账号 ID', user.id], ['登录来源', user.github_login ? 'GitHub OAuth 已关联' : '本地账号']]));
    if (user.role === 'project_admin') content.append(...userAccessLines(user));
    else content.append(note('超级管理员管理全部项目和全局设置，不需要逐个仓库授权。'));
    const toggle = button(user.active ? '停用' : '启用', async () => {
      toggle.disabled = true; message.className = 'view-error'; message.textContent = '';
      try {
        const saved = await api('/api/users/' + encodeURIComponent(user.id), 'PATCH', { active: !user.active });
        user.active = saved.user.active;
        notice = user.active ? '已启用，该账号可以立即登录。' : '已停用，该账号的会话已立即失效。';
        draw();
      } catch (err) { message.textContent = userChangeMessage(err); }
      finally { toggle.disabled = false; }
    });
    const actions = element('div', '', 'actions'); actions.append(toggle);
    content.append(actions, message);
  };
  draw();
  return section;
}
// A card whose body `draw(redraw)` builds; `redraw(notice)` draws it again with the outcome of the last action on top.
function liveCard(title, draw) {
  const section = card(title), heading = section.children[0];
  const redraw = notice => {
    const nodes = draw(redraw);
    if (notice) { const flash = element('p', notice, 'view-success flash'); flash.setAttribute('role', 'status'); nodes.unshift(flash); }
    section.replaceChildren(heading, ...nodes);
  };
  redraw(); return { section, redraw };
}
// Fields, an error line and a submit button with optional extra buttons; an error thrown by `save` goes to the line.
function actionForm(nodes, caption, save, extra = []) {
  const form = element('form', '', 'project-form'), message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', caption);
  form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert'); actions.append(submit, ...extra); form.append(...nodes, message, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.textContent = ''; submit.disabled = true;
    try { await save(); } catch (err) { message.textContent = err.message; } finally { submit.disabled = false; }
  });
  return form;
}
function addressBody(view, redraw) {
  const saved = view.onboarding.public_address, origin = input('origin', saved?.origin || '', { type: 'url', placeholder: 'https://你的域名，不带路径' });
  return [saved ? facts([['已验证地址', saved.origin], ['检查时间', timestamp(saved.checked_at)]]) : note('还没有验证过的公网地址。'),
    note('这是 Bot 唯一的公网入口：GitHub 把 webhook 送到这里，用户也从这里登录控制台，都到达本机业务端口 8791。检查会核对当前实例的一次性凭证，拒绝重定向、其他实例和私网地址。改了地址后：到「机器人账号」点当前 App 的「重新检查」更新 webhook；在 GitHub App 设置里把 Callback URL 和 Setup URL 改到新地址；用户需要在新地址重新登录。'),
    actionForm([field('公网 HTTPS 地址', origin)], '检查并保存', async () => {
      if (!origin.value.trim()) throw new Error('先填写公网 HTTPS 地址');
      view.onboarding.public_address = (await api('/api/onboarding/address', 'POST', { origin: origin.value.trim() })).public_address;
      redraw('已检查并保存 ' + view.onboarding.public_address.origin); view.app?.redraw();
    })];
}
// The token is write-only: the page shows whether one is saved, never the token or the pasted command.
function tunnelBody(view, redraw) {
  const tunnel = view.onboarding.tunnel, configured = tunnel.token_configured;
  const credential = tunnelCredential(configured ? '已保存；粘贴新的 token 或命令来替换' : '粘贴 tunnel token 或 Cloudflare 完整命令');
  const revoke = button('撤销 token', async () => {
    if (!await askConfirm({ title: '撤销 Cloudflare Tunnel token？', body: ['删除保存的 token，tunnel 服务随之断开；经 tunnel 转发的 webhook 不再到达，直到重新保存 token。', '已验证的公网地址和 GitHub App 的 webhook 地址都不变。'], action: '撤销', danger: true })) return;
    revoke.disabled = true;
    try { view.onboarding.tunnel = (await api('/api/onboarding/tunnel', 'POST', { revoke: true })).tunnel; redraw('已撤销 tunnel token'); }
    catch (err) { revoke.disabled = false; error(err); }
  }, 'quiet destructive');
  const nodes = [facts([['Token', configured ? '已保存' : '未配置'], ['连接状态', configured ? tunnelStates[tunnel.state] || tunnel.state : null], ['Service URL', tunnel.origin]]),
    note('只用自建 HTTPS 中转时不需要 tunnel。可以粘贴原始 token，或包含它的完整 cloudflared 安装、运行命令；只保存其中的 token，页面和接口都不再显示它。Published application 的 Service URL 必须是 http://webhook:8791。')];
  if (!tunnel.available) nodes.push(note('这台部署没有配置 tunnel 服务，保存和撤销都会失败。'));
  nodes.push(actionForm([field('Tunnel token 或完整命令', credential)], '保存 token', async () => {
    if (!credential.value.trim()) throw new Error('先粘贴 tunnel token 或完整命令');
    view.onboarding.tunnel = (await api('/api/onboarding/tunnel', 'POST', { token: credential.value })).tunnel; redraw('已保存 tunnel token');
  }, configured ? [revoke] : []));
  return nodes;
}
// Only Apps registered in this system are offered. Creating an App and installing it stay one-time steps of the wizard.
function appBody(view, redraw) {
  const saved = view.onboarding.app, apps = view.accounts.filter(account => account.type === 'github_app'), origin = view.onboarding.public_address?.origin;
  const message = element('p', '', 'view-error'), list = element('ul', '', 'history'); message.setAttribute('role', 'alert');
  const nodes = [saved ? facts([['名称', apps.find(app => app.id === saved.account_id)?.name], ['Slug', saved.slug], ['App ID', saved.app_id], ['已确认安装数', saved.installations], ['Webhook 地址', saved.webhook_url]]) : note('还没有选择 GitHub App。')];
  if (saved?.webhook_url && origin && !saved.webhook_url.startsWith(origin + '/')) nodes.push(element('p', 'App 的 webhook 不在当前公网地址下。点当前 App 的「重新检查」，把它改到新地址。', 'endpoint-warning'));
  for (const app of apps) {
    const row = element('li', ''), selected = app.id === saved?.account_id, name = element('div', app.name);
    if (selected) name.append(' ', badge('当前', 'success'));
    name.append(element('p', 'App ID ' + app.app_id, 'muted'));
    const use = button(selected ? '重新检查' : '改用此 App', async () => {
      if (!selected && !await askConfirm({ title: `改用 ${app.name}？`, body: ['接入向导的安装和启用步骤改用这个 App；已启用的项目继续使用各自的账号。', `GitHub 上这个 App 的 webhook 会改为 ${origin} 下的地址。`], action: '改用' })) return;
      use.disabled = true; message.textContent = '';
      try { view.onboarding.app = (await api('/api/onboarding/use-app', 'POST', { account_id: app.id, update_webhook: true })).app; redraw(selected ? '已重新检查，webhook 指向当前公网地址' : `已改用 ${app.name}`); }
      catch (err) { use.disabled = false; message.textContent = err.message; }
    });
    use.disabled = !origin; row.append(name, use); list.append(row);
  }
  if (!apps.length) list.append(element('li', '本系统还没有登记 GitHub App。', 'muted'));
  nodes.push(list, message, note(origin ? '改用或重新检查时向 GitHub 核对 App 凭据和安装数，并把 App 的 webhook 设为上面已验证的公网地址。新建 App 和安装到账号在「接入向导」里完成。' : '先验证公网 HTTPS 地址，才能改用或重新检查 App。'));
  return nodes;
}
// The model the wizard's last step starts repositories with; projects keep their own choice.
function defaultModelBody(view, redraw) {
  const shared = view.models.filter(model => model.repository_id === null), chosen = shared.find(model => model.id === view.onboarding.model_id), usable = shared.filter(model => model.key_configured);
  const nodes = [facts([['当前默认', chosen ? `${chosen.model_name} · ${chosen.api_url}` : view.onboarding.model_id ? '已不可用，请重新选择' : '未设置']])];
  if (chosen && !chosen.key_configured) nodes.push(element('p', 'Key 已撤销：在下方供应商编辑中填写新 Key，或改选另一条模型。', 'endpoint-warning'));
  nodes.push(note('接入向导最后一步启用仓库时使用这个模型；已启用的项目在各自的「模型」页选择，不受影响。只能选 Key 仍在的部署共享模型。'));
  if (!usable.length) { nodes.push(note('还没有 Key 可用的部署共享模型，先在「部署共享模型」里添加。')); return nodes; }
  const select = document.createElement('select'), empty = element('option', '选择部署共享模型'); select.name = 'model_id'; empty.value = ''; select.append(empty);
  for (const model of usable) { const option = element('option', `${model.model_name} · ${hostOf(model.api_url)}`); option.value = model.id; select.append(option); }
  select.value = chosen?.key_configured ? chosen.id : '';
  nodes.push(actionForm([field('默认模型', select)], '设为默认', async () => {
    if (!select.value) throw new Error('先选择一条部署共享模型');
    view.onboarding.model_id = (await api('/api/onboarding/model', 'POST', { model_id: select.value })).model_id; redraw('已设为默认模型');
  }));
  return nodes;
}
// The same row actions and add form as the project page, refreshing only these two cards instead of a project.
function sharedModelsBody(view) {
  const shared = view.models.filter(row => row.repository_id === null), row = model => {
    const item = element('li', '', 'model-entry'), result = probeResult('wide-cell');
    item.append(modelLabel(model, model.id === view.onboarding.model_id ? [badge('默认', 'info')] : []), modelActions(model, result, refreshSettingsModels), result); return item;
  };
  const list = shared.length ? providerList(shared, row, refreshSettingsModels) : element('p', '还没有部署共享模型。', 'muted');
  return [note('不属于任何仓库、所有项目都能选用的模型。项目在「模型」页选用；服务角色也从这里选模型。删除后，选用它的项目和服务角色改回「不使用模型」，已有成本记录保留。'), list,
    providerCreate(null, refreshSettingsModels)];
}
async function refreshSettingsModels(notice) {
  const view = settingsView; if (!view) return;
  const [{ models }, { model_id }] = await Promise.all([api('/api/models'), api('/api/onboarding')]);
  if (view !== settingsView || view.request !== renderVersion) return;
  Object.assign(view, { models }); view.onboarding.model_id = model_id;
  view.defaultModel.redraw(); view.sharedModels.redraw(notice);
}
// One service role: its facts and usage, then the editor. Saving sends the revision it was drawn from, so an edit made
// elsewhere in the meantime is reported as a conflict instead of being overwritten.
const serviceRoleErrors = { service_role_revision_conflict: '这个角色已被其他操作修改，请刷新本页、核对当前配置后重新保存。',
  shared_model_required: '只能选择部署共享模型。', builtin_service_role_required: '内置角色不能停用或删除。', invalid_service_role_budget: '预算金额需要大于 0。' };
// The API's stable error codes, in words for the person who saved.
async function serviceRoleRequest(path, method, body) {
  try { return await api(path, method, body); }
  catch (err) { const code = /· (\w+)$/.exec(err.message)?.[1]; throw serviceRoleErrors[code] ? new Error(serviceRoleErrors[code]) : err; }
}
const serviceBudgetText = budget => budget ? money(budget.limit_amount, budget.currency) + '（累计）' : '不限额';
function serviceUsageText(usage) {
  if (!usage.requests) return '还没有模型请求';
  const parts = [`${metricNumber(usage.requests)} 次请求`, `输入 ${metricNumber(usage.input_tokens)} / 输出 ${metricNumber(usage.output_tokens)} tokens`];
  parts.push(usage.costs.length ? '费用 ' + usage.costs.map(cost => money(cost.amount, cost.currency)).join('，') : '费用未知');
  if (usage.unpriced_requests) parts.push(`${usage.unpriced_requests} 次未计价`);
  return parts.join(' · ');
}
function serviceRoleCard(view, initial) {
  let role = initial;
  const live = liveCard(role.name, redraw => {
    const kind = [role.builtin ? badge('内置', 'info') : badge('自定义', ''), role.enabled ? badge('已启用', 'success') : badge('已停用', 'warning')], head = element('p', '');
    head.append(...kind.flatMap(node => [node, ' ']));
    const model = role.model ? `${role.model.model_name} · ${hostOf(role.model.api_url)}${role.model.key_configured ? '' : '（Key 已撤销）'}` : '未配置';
    const permissions = role.permissions_inherited ? '继承当前用户自己的有效权限' : view.items.map(item => `${item.name}：${permissionModeLabels[role.permissions[item.id]] ?? role.permissions[item.id]}`).join('；');
    const nodes = [head, facts([['职责', role.responsibility || '—'], ['模型', model], ['权限', permissions], ['预算', serviceBudgetText(role.budget)],
      ['累计用量', serviceUsageText(role.usage)], ['最近请求', role.usage.last_requested_at ? timestamp(role.usage.last_requested_at) : null], ['配置版本', String(role.revision)]])];
    if (!role.model) nodes.push(element('p', '没有配置模型时，这个角色的对话会直接提示到这里配置，不会改用其他模型。', 'endpoint-warning'));
    const name = input('name', role.name, { maxLength: 80, required: true }), responsibility = textarea('responsibility', role.responsibility, { maxLength: 2000, rows: 2 });
    const prompt = textarea('prompt', role.prompt, { maxLength: 32000, rows: 4, placeholder: '附加在内置安全提示之后的说明；不能扩大工具或权限' });
    const modelSelect = document.createElement('select'), none = element('option', '不使用模型'); modelSelect.name = 'model_id'; none.value = ''; modelSelect.append(none);
    for (const shared of view.models) { const option = element('option', `${shared.model_name} · ${hostOf(shared.api_url)}${shared.key_configured ? '' : '（Key 已撤销）'}`); option.value = shared.id; modelSelect.append(option); }
    modelSelect.value = role.model_id ?? '';
    const currency = document.createElement('select'); currency.name = 'budget_currency';
    for (const value of ['USD', 'CNY']) { const option = element('option', value); option.value = value; currency.append(option); }
    currency.value = role.budget?.currency ?? 'USD';
    const amount = input('budget_limit', role.budget?.limit_amount ?? '', { type: 'number', min: 0, step: 'any', placeholder: '留空表示不限额' });
    const budget = element('div', '', 'field-grid'); budget.append(field('预算币种', currency), field('预算上限', amount));
    const permissionControls = {}, grid = element('div', '', 'field-grid');
    if (!role.permissions_inherited) for (const item of view.items) {
      const select = permissionControls[item.id] = roleSelect(item.name, role.permissions[item.id], item.modes.map(mode => [mode, permissionModeLabels[mode]]), () => {});
      const wrap = field(item.name, select); wrap.title = item.detail; grid.append(wrap);
    }
    const enabled = role.builtin ? null : checkbox('enabled', role.enabled, '启用');
    const remove = role.builtin ? null : button('删除角色', async () => {
      if (!await askConfirm({ title: `删除服务角色 ${role.name}？`, body: ['已记录的用量保留，仍按这个角色归属。'], action: '删除', danger: true })) return;
      remove.disabled = true;
      try { await serviceRoleRequest('/api/service-roles/' + role.id, 'DELETE', { expected_revision: role.revision }); live.section.replaceChildren(element('h3', role.name), element('p', '已删除', 'view-success')); }
      catch (err) { remove.disabled = false; error(err); }
    }, 'quiet destructive');
    nodes.push(actionForm([field('名称', name), field('职责说明', responsibility), field('提示词', prompt), field('模型（部署共享模型）', modelSelect),
      role.permissions_inherited ? note('权限固定继承当前用户自己的有效权限，不单独设置。') : grid,
      budget, ...(enabled ? [enabled] : [])], '保存', async () => {
      const limit = amount.value.trim();
      if (limit && !(Number(limit) > 0)) throw new Error('预算金额需要大于 0，留空表示不限额');
      const change = { expected_revision: role.revision, name: name.value, responsibility: responsibility.value, prompt: prompt.value, model_id: modelSelect.value || null,
        budget: limit ? { currency: currency.value, limit_amount: Number(limit) } : null };
      if (!role.permissions_inherited) change.permissions = Object.fromEntries(Object.entries(permissionControls).map(([id, select]) => [id, select.value]));
      if (enabled) change.enabled = enabled.querySelector('input').checked;
      role = (await serviceRoleRequest('/api/service-roles/' + role.id, 'PATCH', change)).service_role;
      live.section.querySelector('h3').textContent = role.name; redraw('已保存');
    }, remove ? [remove] : []));
    nodes.push(note('预算与项目管理预算的语义相同：累计用量达到上限即停止；存在无法计价的用量（模型没有价格、币种不同或请求结果未知）时也停止，不把未知费用当作零。'));
    return nodes;
  });
  return live.section;
}
function serviceRoleCreate(view) {
  const section = card('新建服务角色'), name = input('name', '', { maxLength: 80, required: true }), responsibility = textarea('responsibility', '', { maxLength: 2000, rows: 2 });
  section.append(note('新角色从仓库问答助手的权限开始：读当前会话记录和 GitHub，不访问其他角色的任务，不派活；保存后可以在它的卡片里修改。'),
    actionForm([field('名称', name), field('职责说明', responsibility)], '新建', async () => {
      if (!name.value.trim()) throw new Error('先填写名称');
      const created = (await serviceRoleRequest('/api/service-roles', 'POST', { name: name.value, responsibility: responsibility.value })).service_role;
      view.roles.push(created); section.before(serviceRoleCard(view, created)); name.value = ''; responsibility.value = '';
    }));
  return section;
}
