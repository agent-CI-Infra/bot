// Global settings (super administrators only), laid out like a project page: categories on the left, one category on the
// right, each with its own address (#/settings/<section>) so a reload stays on it. Loaded after app.js, views.js and
// project.js and reuses their helpers; tunnelCredential comes from onboarding.js, which loads later but before any page is drawn.
// The wizard settings and models are saved through the wizard's and the model APIs; a card redraws only itself.
titles.settings = '全局设置';
// waiting_token with a saved token means this deployment has no tunnel status endpoint to read.
const tunnelStates = { waiting_token: '读不到状态', not_running: 'tunnel 服务未运行', connecting: '正在连接', connected: '已连接' };
const settingsSections = [['general', '常规'], ['onboarding', '接入向导'], ['access', '公网接入'], ['accounts', '机器人账号'], ['installations', '安装档案'], ['models', '模型'], ['users', '用户']];
function settingsSection() { if(/^#\/settings\/onboarding(?:\/|$)/.test(location.hash)) return 'onboarding'; const key = /^#\/settings\/([a-z]+)$/.exec(location.hash)?.[1]; return settingsSections.some(([name]) => name === key) ? key : 'general'; }
// What the cards draw from; the model cards are redrawn together because deleting the default model clears it.
let settingsView = null;
async function renderSettings(request) {
  const section = settingsSection(), nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content'), body = element('div', '', 'project-body settings-body');
  nav.setAttribute('aria-label', '全局设置类别');
  for (const [key, caption] of settingsSections) { const item = element('a', caption); item.href = '#/settings/' + key; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item); }
  // The categories are drawn at once; the chosen category's cards follow when their data arrives.
  $('count').textContent = ''; content.append(element('p', '正在加载…', 'muted')); body.append(nav, content); $('settings-panel').replaceChildren(body);
  const cards = await settingsCards[section](request);
  if (request !== renderVersion) return;
  content.replaceChildren(...cards);
}
// Each category loads only what its cards show.
const settingsCards = {
  async onboarding(request) {
    const panel = element('div', ''); panel.id = 'onboarding-panel';
    await renderOnboarding(request, panel); return [panel];
  },
  async installations() {
    const { installations } = await api('/api/installations/archive'), section = card('GitHub App 安装档案');
    section.append(note('安装范围与控制台角色分别管理。事件触发者和申请者不代表当前有权管理的人。'));
    if (!installations.length) section.append(note('尚无安装档案。同步后也会保留零仓库安装和历史证据缺失标记。'));
    for (const installation of installations) {
      const item = card(`${installation.target.login || '目标待同步'} · 安装 ${installation.installation.installation_id}`), evidence = installation.evidence;
      const person = value => value ? `${value.login || '名称未知'}（${value.id}）` : '未知／未提供';
      item.append(facts([['GitHub 目标 ID', installation.target.id || '待同步'], ['目标类型', installation.target.type || '待同步'],
        ['状态', ({ active: '有效', pending_sync: '等待同步', suspended: '已暂停', deleted: '已卸载' })[installation.status]],
        ['范围', installation.repository_selection === 'all' ? '全部仓库' : installation.repository_selection === 'selected' ? '指定仓库' : '待同步'],
        ['完整性', ({ complete: '完整', pending: '等待同步', stale: '待核实', error: '同步失败，保留最近成功快照' })[installation.completeness]],
        ['安装事件触发者', person(evidence.sender)], ['申请者', person(evidence.requester)], ['批准者', evidence.approval.label],
        ['历史证据', evidence.history_missing ? '历史证据缺失' : '已保留签名安装事件'],
        ['最近成功同步', installation.last_success_at ? timestamp(installation.last_success_at) : '尚未成功同步'],
        ['投影／范围／权限版本', `${installation.projection_version} / ${installation.scope_version} / ${installation.permissions_version}`]]));
      if (!evidence.requester) item.append(note('未提供申请者不等于从未申请。历史安装查询不能补齐完整批准历史。'));
      if (installation.error) item.append(note(`同步错误：${installation.error}`));
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
  // The App the wizard uses, then every registered account (GitHub Apps and bot tokens).
  async accounts(request) {
    const [onboarding, { accounts: registered }, limits] = await Promise.all([api('/api/onboarding'), api('/api/accounts'), api('/api/github/rate-limits').catch(() => null)]);
    const view = settingsView = { request, onboarding, accounts: registered, models: [], limits };
    view.app = liveCard('接入向导使用的 GitHub App', redraw => appBody(view, redraw));
    return [view.app.section, settingsList('已登记的账号', '账号提供访问 GitHub 的凭据和接收 webhook 的入口；仓库经账号同步出现。凭据只保存，不会从读取接口返回。',
      registered.map(accountLine), '还没有登记账号。', '新增账号', 'accounts'), liveCard('GitHub 请求额度', redraw => rateLimitBody(view, redraw)).section];
  },
  async models(request) {
    const [onboarding, { models }] = await Promise.all([api('/api/onboarding'), api('/api/models')]);
    const view = settingsView = { request, onboarding, accounts: [], models };
    view.defaultModel = liveCard('默认共享模型', redraw => defaultModelBody(view, redraw));
    view.sharedModels = liveCard('部署共享模型', () => sharedModelsBody(view));
    return [view.defaultModel.section, view.sharedModels.section];
  },
  async users(request) {
    const [{ users }, assigned] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    grants = assigned;
    return [settingsList('用户', '超级管理员管理全部项目和这里的设置；项目管理员只看到分配给自己的组织和仓库。', users.map(userLine), '还没有用户。', '新增用户', 'users')];
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
    note('GitHub 把 webhook 送到这个地址。它只能连到 webhook 8791，检查会拒绝管理页面和其他实例。改了地址后，到「机器人账号」里点当前 App 的「重新检查」，把 App 的 webhook 改到新地址。'),
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
  return [note('不属于任何仓库、所有项目都能选用的模型。项目在「模型」页选用；删除后，选用它的项目改回「不使用模型」，已有成本记录保留。'), list,
    providerCreate(null, refreshSettingsModels)];
}
async function refreshSettingsModels(notice) {
  const view = settingsView; if (!view) return;
  const [{ models }, { model_id }] = await Promise.all([api('/api/models'), api('/api/onboarding')]);
  if (view !== settingsView || view.request !== renderVersion) return;
  Object.assign(view, { models }); view.onboarding.model_id = model_id;
  view.defaultModel.redraw(); view.sharedModels.redraw(notice);
}
