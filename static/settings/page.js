async function renderSettings(request) {
  const route = settingsRoute(), section = route.section, nav = element('nav', '', 'project-nav'), content = element('div', '', 'project-content'), body = element('div', '', 'project-body settings-body');
  nav.setAttribute('aria-label', '全局设置类别');
  for (const [groupTitle, items] of visibleSettingsGroups()) {
    nav.append(element('p', groupTitle, 'console-nav-label'));
    for (const [key, caption] of items) { const item = element('a', caption); item.href = '#/settings/' + key; if (key === section) item.setAttribute('aria-current', 'page'); nav.append(item); }
  }
  // The categories are drawn at once; the chosen category's cards follow when their data arrives.
  $('count').textContent = ''; content.append(element('p', '正在加载…', 'muted')); body.append(nav, content); $('settings-panel').replaceChildren(body);
  if (typeof syncConsoleShell === 'function') syncConsoleShell();
  // The hash may only choose among the declared sections: never let a user-written name reach the prototype chain, and
  // never call anything that is not a declared loader. Anything else falls back to 工作电脑.
  const handler = Object.hasOwn(settingsCards, section) ? settingsCards[section] : settingsCards['work-computers'];
  if (typeof handler !== 'function') return;
  const cards = await handler(request, route.id);
  if (request !== renderVersion) return;
  content.replaceChildren(...cards);
}
// Each category loads only what its cards show.
const settingsCards = {
  async projects(request, id) { return globalProjectSettings(request, id); },
  // Group assistants' and the management assistant's computers (#457): their timers and limits, each computer's resources
  // (the counterpart of the work computers' default resources), and every HOME.
  async 'assistant-computers'(request) {
    const [{ settings }, overview] = await Promise.all([api('/api/settings'), api('/api/assistant-computers').catch(err => ({ error: err.message }))]);
    const view = { settings: settings.assistant_computers, overview };
    if (!view.settings) return [consoleState('助手电脑不可用', '这个部署没有挂载助手 HOME 卷或连不上 manager，群聊助手和管理助手的电脑工具不会提供。', { tone: 'error' })];
    const homes = liveCard('HOME 占用', redraw => assistantHomesBody(view, redraw, request));
    return [liveCard('助手电脑设置', redraw => assistantSettingsBody(view, redraw)).section, liveCard('每台电脑的资源', redraw => assistantResourcesBody(view, redraw)).section, homes.section];
  },
  async external(request) {
    const { settings } = await api('/api/external/settings'), section = card('外部执行兑换地址');
    const address = input('token_audience', settings.token_audience || '', { type: 'url' }), status = note(''); status.setAttribute('role', 'status');
    const form = element('form', '', 'project-form'), save = element('button', '保存兑换地址'); save.type = 'submit';
    form.append(field('兑换地址', address), note('填写执行端访问的 HTTPS /external/token 地址。此设置影响全部项目的签名 audience。'), status, save);
    form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true;
      try { await api('/api/external/settings', 'PUT', { token_audience: address.value.trim() }); if (request === renderVersion) status.textContent = '兑换地址已保存。'; }
      catch (err) { if (request === renderVersion) status.textContent = err.message; } finally { save.disabled = false; }
    }); section.append(form); return [section];
  },
  // Storage (#436): what each project keeps in trajectory files, records and blobs, read from counters kept when files
  // close and a background snapshot; platform administrators also see the databases, the disk and the migration, the
  // removal of the manager's copies and an alert for a disk below its reserve (#671).
  async storage() {
    const view = await api('/api/storage'), size = value => Number.isFinite(value) ? bytes(value) : '未知', count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知';
    const expiry = state => !state ? '读不到' : `保留 ${state.window_days} 天；` + (state.last_pass ? `最近一次 ${new Date(state.last_pass.finished_at).toLocaleString('zh-CN')} 删除 ${count(state.last_pass.files)} 个文件（${size(state.last_pass.bytes)}）` : '尚未运行')
      + (state.last_error ? `；最近一个错误：${state.last_error}` : '');
    const cards = [], intro = card('存储');
    intro.append(note(`轨迹文件按运行保存模型请求、工具调用和大日志的正文，数据库只留状态和定位。数字来自文件关闭时累加的计数，每 5 分钟在后台刷新一次；最近刷新：${view.refreshed_at ? new Date(view.refreshed_at).toLocaleString('zh-CN') : '尚未刷新'}。`));
    cards.push(intro);
    // A data disk below its reserve (#671): background writes pause, and tasks wait once the disk is all but full.
    if (view.alerts?.length) {
      const alert = card('磁盘空间告警'); alert.setAttribute('role', 'alert');
      for (const item of view.alerts) alert.append(element('p', `${item.where === 'manager' ? 'manager' : '控制面'}所在磁盘只剩 ${size(item.free_bytes)}（共 ${size(item.total_bytes)}），低于保留空间 ${size(item.reserve_bytes)}：后台迁移已暂停；剩余空间再少时任务会停在「等待环境」（disk_full），有空间后自动继续。请清理磁盘。`, 'view-error'));
      cards.push(alert);
    }
    if (view.totals) {
      const totals = card('数据库与磁盘'), side = value => value ? `${size(value.bytes)}，空闲页 ${count(value.free_pages)}（${size(value.free_bytes)}）` : '读不到';
      totals.append(facts([['控制面数据库 control.sqlite', side(view.totals.control?.database)], ['manager 账本 manager.sqlite', side(view.totals.manager?.database)],
        ['控制面所在磁盘剩余', view.totals.control?.disk ? `${size(view.totals.control.disk.free_bytes)} / ${size(view.totals.control.disk.total_bytes)}` : '读不到'],
        ['manager 所在磁盘剩余', view.totals.manager?.disk ? `${size(view.totals.manager.disk.free_bytes)} / ${size(view.totals.manager.disk.total_bytes)}` : '读不到'],
        ['manager 重复正文清理', expiry(view.totals.manager?.expiry)]]));
      totals.append(note('清空正文后数据库文件不会自己变小，空出的页会留给新数据复用；要回收磁盘需要在维护窗口做 VACUUM。'));
      totals.append(note('manager 的轨迹文件只在同一操作重复调用时用来重放结果，控制面另存了同样的请求和结果。关闭超过保留天数、且其中没有仍在运行的调用的文件会在后台删除；之后重复这些调用会得到明确的「结果已过期」，不会重新执行或返回别的结果。'));
      cards.push(totals);
      const migration = card('历史数据迁移'), table = costTable(['位置', '表', '已迁移', '跳过', '失败', '已搬出', '待检查（估计）', '完成时间']);
      for (const [where, state] of [['控制面', view.totals.control?.migration], ['manager', view.totals.manager?.migration]]) {
        for (const [name, phase] of Object.entries(state?.phases ?? {})) {
          const row = document.createElement('tr');
          for (const text of [where, name, count(phase.migrated), count(phase.skipped), count(phase.failed), size(phase.bytes), count(state.remaining?.[name]),
            phase.finished_at ? new Date(phase.finished_at).toLocaleString('zh-CN') : state.paused ? '磁盘空间不足，已暂停' : '进行中'])
            row.append(element('td', text));
          table.body.append(row);
        }
      }
      migration.append(table.wrap);
      const rates = [['控制面', view.totals.control?.migration], ['manager', view.totals.manager?.migration]].map(([where, state]) => `${where} ${state?.rate ?? 0} 条/秒`).join('，');
      migration.append(note(`当前速度：${rates}。` + [view.totals.control?.migration, view.totals.manager?.migration].flatMap(state => Object.values(state?.phases ?? {}).map(phase => phase.last_error).filter(Boolean)).slice(0, 1).map(error => `最近一个错误：${error}`).join('')));
      cards.push(migration);
    }
    const projects = card('按项目'), table = costTable(['项目', '轨迹文件', '模型请求/响应', '工具调用/结果', '日志', 'blob', 'manager 轨迹', '写入中的文件']);
    table.wrap.classList.add('storage-projects');
    for (const project of view.projects) {
      const row = document.createElement('tr'), record = (...types) => { const value = types.reduce((sum, type) => ({ count: sum.count + (project.records[type]?.count ?? 0), bytes: sum.bytes + (project.records[type]?.bytes ?? 0) }), { count: 0, bytes: 0 }); return `${count(value.count)} 条 · ${size(value.bytes)}`; };
      for (const text of [project.name || project.repository_id, `${count(project.files.count)} 个 · ${size(project.files.bytes)}`, record('model_request', 'model_response'), record('tool_call', 'tool_result'), record('log', 'event'),
        `${count(project.blobs.count)} 个 · ${size(project.blobs.bytes)}`, project.manager ? `${count(project.manager.files.count + project.manager.open.count)} 个 · ${size(project.manager.files.bytes + project.manager.open.bytes)}`
          + (project.manager.expired?.count ? `（已删除 ${count(project.manager.expired.count)} 个 · ${size(project.manager.expired.bytes)}）` : '') : '—', project.open.count ? `${count(project.open.count)} 个 · ${size(project.open.bytes)}` : '—'])
        row.append(element('td', text));
      table.body.append(row);
    }
    projects.append(view.projects.length ? table.wrap : note('还没有项目的轨迹数据。'));
    cards.push(projects);
    return cards;
  },
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
  // The computers the projects' work roles (Manager, Dev, QA, ...) run their tasks on, one per repository; the running
  // version closes the page, since those computers are created from this version's image.
  async 'work-computers'(request) {
    const { settings, version } = await api('/api/settings');
    const about = card('当前运行版本');
    about.append(version.image_tag ? facts([['镜像标签', version.image_tag]]) : note('源码运行：没有设置镜像标签（BOT_IMAGE_TAG），版本以部署所用的源码提交为准。'));
    const [min, max] = settings.task_concurrency_bounds, concurrency = card('同时运行的任务');
    const form = document.createElement('form'), value = input('task_concurrency', settings.task_concurrency, { type: 'number', min, max, step: 1, required: true });
    const message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', '保存');
    form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'alert'); actions.append(submit);
    form.append(field('每台电脑默认同时运行的任务数', value),
      note(`取 ${min}–${max}。工作电脑是项目里 Manager、Dev、QA 等工作角色执行任务的虚拟电脑，每个仓库一台；项目在「机器配置」里没有单独设置时使用这个值，超出的任务继续排队。同时运行的任务各用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限。`),
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
    return [concurrency, liveCard('默认资源', redraw => resourceDefaultsBody(resources, redraw)).section, about];
  },
  // Where GitHub's webhooks arrive: a self-hosted HTTPS address, or a Cloudflare Tunnel in front of it. The login
  // configuration is shown read-only beside them, so the address, its check, the tunnel and the login agree on one page.
  async access(request) {
    const view = settingsView = { request, onboarding: await api('/api/onboarding'), accounts: [], models: [] };
    view.address = liveCard('公网 HTTPS 地址', redraw => addressBody(view, redraw));
    view.tunnel = liveCard('Cloudflare Tunnel', redraw => tunnelBody(view, redraw));
    return [view.address.section, view.tunnel.section, loginAccessCard(view.onboarding.github_login)];
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
    return [settingsList('用户', '项目权限由 GitHub 当前权限和 Bot 内手动分配共同决定；下面显示当前可见项目及来源。管理员管理全部项目和全局设置。', users.map(userProfileLine), '还没有用户。', '新增用户', 'users')];
  },
};
