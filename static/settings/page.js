const settingsCards = {
  async projects(request, id) { return globalProjectSettings(request, id); },
  // Group assistants' and the management assistant's computers (#457): their timers and limits, each computer's resources
  // (the counterpart of the work computers' default resources), and every HOME.
  async 'assistant-computers'(request) {
    const [{ settings }, overview] = await Promise.all([api('/api/settings'), api('/api/assistant-computers').catch(err => ({ error: readErrorText(err) }))]);
    const view = { settings: settings.assistant_computers, overview };
    if (!view.settings) return [consoleState('助手电脑不可用', '这个部署没有挂载助手 HOME 卷或连不上 manager，群聊助手和管理助手的电脑工具不会提供。', { tone: 'error' })];
    const homes = liveCard('HOME 占用', redraw => assistantHomesBody(view, redraw, request));
    return [liveCard('助手电脑设置', redraw => assistantSettingsBody(view, redraw)).section, liveCard('每台电脑的资源', redraw => assistantResourcesBody(view, redraw)).section, homes.section];
  },
  async external(request) {
    const { settings } = await api('/api/external/settings'), section = settingsCard('外部执行兑换地址');
    const address = input('token_audience', settings.token_audience || '', { type: 'url' }), status = note(''); status.setAttribute('role', 'status');
    const form = element('form', '', 'project-form'), save = element('button', '保存兑换地址'); save.type = 'submit';
    form.append(field('兑换地址', address), note('填写执行端访问的 HTTPS /external/token 地址。此设置影响全部项目的签名 audience。'), status, save);
    form.addEventListener('submit', async event => { event.preventDefault(); save.disabled = true;
      try { await api('/api/external/settings', 'PUT', { token_audience: address.value.trim() }); if (request === renderVersion) announceSave(status, '兑换地址已保存。', false); }
      catch (err) { if (request === renderVersion) announceSave(status, readErrorText(err), true); } finally { save.disabled = false; }
    }); section.append(form); return [section];
  },
  // Storage (#436, #671): what each project keeps in trajectory files, records and blobs and on its project computer, read
  // from counters kept when files close and a background snapshot; platform administrators also see the data disk with
  // everything known on it and "other", what can be reclaimed, the databases, the migration, the removal of the manager's
  // copies and an alert for a disk below its reserve.
  async storage(request, _id, retained) {
    const view = await api('/api/storage'), size = storageSize, count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '未知';
    const reasons = { disk_space: '剩余空间不够放下一份实际数据', few_free_pages: '空闲页不多，不需要', incremental: '已压缩，由后台增量回收', database_busy: '数据库正被占用', wal_not_empty: 'WAL 没能并入数据库',
      integrity_check: '新文件没通过完整性检查，旧文件保留', error: '出错，数据库保持原样', no_database: '还没有数据库' };
    const compacted = state => !state ? '尚未记录' : state.action === 'compacted' ? `${time(state.at)} 由 ${size(state.before?.bytes)} 压缩到 ${size(state.after_bytes)}，用时 ${Math.round(state.duration_ms / 1000)} 秒`
      : `${time(state.at)} ${state.action === 'not_needed' ? '未压缩' : state.action === 'skipped' ? '跳过，下次启动再试' : '失败，下次启动再试'}：${reasons[state.reason] ?? state.reason}`
        + (state.reason === 'disk_space' ? `（需要 ${size(state.required_bytes)}，剩余 ${size(state.disk_free_bytes)}）` : '');
    const vacuumed = state => !state ? '读不到' : state.auto_vacuum !== 2 ? '未启用（压缩后启用）' : state.last ? `最近 ${time(state.last.finished_at)} 归还 ${size(state.last.bytes)}` : '已启用，暂无可归还的页';
    const expiry = state => !state ? '读不到' : `保留 ${state.window_days} 天；` + (state.last_pass ? `最近一次 ${timeText(state.last_pass.finished_at)} 删除 ${count(state.last_pass.files)} 个文件（${size(state.last_pass.bytes)}）` : '尚未运行')
      + (state.last_error ? `；最近一个错误：${state.last_error}` : '');
    const time = value => value ? timeText(value) : '—', row = (table, cells) => { const tr = document.createElement('tr'); for (const text of cells) tr.append(element('td', text)); table.body.append(tr); };
    const cards = [], intro = view.overview ? element('div', '', 'storage-updated') : settingsCard('存储', 'h2');
    intro.append(note(`这里统计已采集的文件与项目工作卷。后台快照每 5 分钟更新一次，目录按小时测量，工作卷每 6 小时扫描。最近刷新 ${view.refreshed_at ? time(view.refreshed_at) : '尚未刷新'}。`
      // A failed manager read keeps the numbers it gave last (#793), so the page says which read they come from.
      + (view.manager_error ? view.manager_read_at
        ? `上次读取于 ${time(view.manager_read_at)}；本次 manager 读取失败（${view.manager_error}），manager 的数字保留上次结果，可能过期。`
        : `本次 manager 读取失败（${view.manager_error}），还没有读到过 manager 的数字。`
        : '')));
    cards.push(intro);
    // A data disk below its reserve (#671): background writes pause, and tasks wait once the disk is all but full.
    if (view.alerts?.length) {
      const alert = settingsCard('磁盘空间告警', 'h2'); alert.setAttribute('role', 'alert');
      for (const item of view.alerts) alert.append(element('p', `${item.where === 'manager' ? 'manager' : '控制面'}所在磁盘只剩 ${size(item.free_bytes)}（共 ${size(item.total_bytes)}），低于保留空间 ${size(item.reserve_bytes)}：后台迁移已暂停；剩余空间再少时任务会停在「等待环境」（disk_full），有空间后自动继续。请清理磁盘。`
        + (item.stale ? '（上次已知状态，可能已过期：本次 manager 读取失败。）' : ''), 'view-error'));
      cards.push(alert);
    }
    if (view.overview) cards.push(...storageCapacity(view.overview, view.host, time), storageProjects(view.overview));
    if (view.totals) cards.push(retained ?? await retentionCard(size, count, time, async section => {
      const next = await settingsCards.storage(request, null, section);
      if (section.isConnected && request === renderVersion) section.parentElement.replaceChildren(...next);
    }));
    if (view.totals) {
      const precompiled = await api('/api/storage/precompiled-images').catch(() => null);
      if (precompiled) {
        const cacheCard = settingsCard('预编译镜像缓存', 'h2');
        const list = Array.isArray(precompiled.images) ? precompiled.images : [];
        const totalBytes = list.reduce((sum, item) => sum + (Number(item.size_bytes) || 0), 0);
        const unreferenced = list.filter(item => !item.protected);
        cacheCard.append(facts([
          ['已缓存镜像', `${count(list.length)} 个（总计 ${size(totalBytes)}）`],
          ['当前构建队列', precompiled.active_build ? `构建中（${precompiled.active_build.kind === 'global' ? '全局' : '项目'}），排队 ${count(precompiled.queue_length)} 个` : `空闲（排队 ${count(precompiled.queue_length)} 个）`],
          ['可清理的无引用镜像', `${count(unreferenced.length)} 个`],
        ]));
        if (list.length) {
          const tbl = costTable(['镜像标签', '层级', '状态', '大小', '保护状态', '最近使用']);
          for (const item of list) {
            row(tbl, [item.tag, item.kind === 'global' ? '全局基座' : '项目增量', item.state, item.size_bytes != null ? size(item.size_bytes) : '—',
              item.protected ? '使用中（受保护）' : '无引用', time(item.last_used_at)]);
          }
          cacheCard.append(tbl.wrap);
        } else {
          cacheCard.append(note('尚无预编译镜像缓存。配置全局或项目软件包/初始化脚本后会自动预编译并缓存在此。'));
        }
        const pruneStatus = note(''); pruneStatus.setAttribute('role', 'status');
        const pruneBtn = button('清理无引用预编译镜像', async event => {
          const btn = event.currentTarget; btn.disabled = true;
          try {
            const res = await api('/api/storage/precompiled-images/prune', 'POST', {});
            announceSave(pruneStatus, `已清理 ${count(res.removed?.length ?? 0)} 个无引用预编译镜像，保留 ${count(res.kept ?? 0)} 个受保护镜像。`, false);
          } catch (err) { btn.disabled = false; announceSave(pruneStatus, readErrorText(err), true); }
        });
        pruneBtn.disabled = unreferenced.length === 0;
        cacheCard.append(pruneBtn, pruneStatus);
        cards.push(cacheCard);
      }
    }
    const detailStart = cards.length;
    if (view.host) {
      const host = settingsCard('采集明细', 'h2'), known = view.host.known ?? {};
      const table = costTable(['占用', '大小']);
      for (const [key, label] of [['control_database', '控制面数据库 control.sqlite（含 WAL）'], ['control_trajectories', '控制面轨迹文件与 blob'], ['git_cache', 'git 缓存 git-cache'], ['public_boards', '公开看板 public-boards'], ['browser_evidence', '浏览器截图证据 browser-evidence'], ['channel_resources', '飞书附件存储 channel-resources'],
        ['manager_database', 'manager 账本 manager.sqlite（含 WAL）'], ['manager_trajectories', 'manager 轨迹文件'], ['computers', '项目电脑工作卷'], ['docker_images', 'Docker 镜像'], ['docker_containers', 'Docker 容器可写层'], ['docker_build_cache', 'Docker 构建缓存'],
        ['docker_volumes', 'Docker 卷（未被计入的部分）'], ['assistant_homes', '助手电脑 HOME（assistant-homes 卷）']])
        row(table, [label, known[key] === null || known[key] === undefined ? '尚未测量' : size(known[key]) + ((view.host.unmeasured ?? []).includes(key) ? '（部分电脑未扫完）' : '')]);
      host.append(table.wrap, note('各项取自控制面、manager、项目卷或 Docker，各自的采集范围和时间不同。Docker 数字覆盖整个引擎。'));
      cards.push(host);
      const reclaim = settingsCard('可回收与最近清理', 'h2'), list = costTable(['类别', '可回收', '怎么回收']);
      // A database already compacted returns its free pages in the background; one not yet compacted at its next start.
      const pages = database => database?.auto_vacuum === 2 ? '后台逐步归还磁盘' : '下次启动时压缩（空闲页超过 30% 且超过 1 GB、剩余空间够时）';
      const how = { control_free_pages: ['control.sqlite 空闲页', pages(view.totals?.control?.database)], manager_free_pages: ['manager.sqlite 空闲页', pages(view.totals?.manager?.database)],
        expiring_workspaces: ['待删除的任务工作区', '后台按任务工作区保留规则到期删除'], docker_build_cache: ['Docker 构建缓存（未使用）', '在主机上执行 docker builder prune'],
        docker_unused_images: ['没有容器使用的 Docker 镜像', '在主机上确认后执行 docker image prune'] };
      for (const item of view.reclaimable ?? []) row(list, [how[item.key]?.[0] ?? item.key, item.bytes === null ? '尚未测量' : size(item.bytes) + (Number.isFinite(item.count) ? `（${count(item.count)} 个）` : ''), how[item.key]?.[1] ?? '']);
      reclaim.append(list.wrap);
      const freed = { manager_expiry: ['最近一次 manager 重复正文清理', item => `${time(item.at)} 删除 ${count(item.count)} 个（${size(item.bytes)}）`],
        workspace_cleanup: ['任务工作区清理（各项目最近一次之和）', item => `删除 ${count(item.count)} 个（${size(item.bytes)}），最近一次在 ${time(item.at)}`] };
      reclaim.append(facts((view.freed ?? []).map(item => [freed[item.key]?.[0] ?? item.key, item.at ? (freed[item.key]?.[1] ?? (() => size(item.bytes)))(item) : '尚未运行'])));
      cards.push(reclaim);
    }
    if (view.totals) {
      const totals = settingsCard('数据库与磁盘', 'h2'), side = value => value ? `文件 ${size(value.bytes)}：实际数据 ${size(value.bytes - value.free_bytes)}，空闲页 ${count(value.free_pages)}（${size(value.free_bytes)}）；WAL ${size(value.wal_bytes)}` : '读不到';
      totals.append(facts([['控制面数据库 control.sqlite', side(view.totals.control?.database)], ['manager 账本 manager.sqlite', side(view.totals.manager?.database)],
        ['控制面所在磁盘剩余', view.totals.control?.disk ? `${size(view.totals.control.disk.free_bytes)} / ${size(view.totals.control.disk.total_bytes)}` : '读不到'],
        ['manager 所在磁盘剩余', view.totals.manager?.disk ? `${size(view.totals.manager.disk.free_bytes)} / ${size(view.totals.manager.disk.total_bytes)}` : '读不到'],
        ['control.sqlite 启动时压缩', compacted(view.totals.control?.compaction)], ['manager.sqlite 启动时压缩', compacted(view.totals.manager?.compaction)],
        ['数据库增量回收', [['控制面', view.totals.control?.vacuum], ['manager', view.totals.manager?.vacuum]].map(([where, state]) => `${where}：${vacuumed(state)}`).join('；')],
        ['manager 重复正文清理', expiry(view.totals.manager?.expiry)]]));
      totals.append(note('清空正文后数据库文件不会自己变小，空出的页会留给新数据复用。空闲页超过 30% 且超过 1 GB、磁盘剩余足够放下一份实际数据时，服务在下次启动、开始服务之前把数据库重写一遍（压缩），校验通过后才删除旧文件；压缩后的数据库会在后台把之后清理出的空间逐步还给磁盘。'));
      totals.append(note('manager 的轨迹文件只在同一操作重复调用时用来重放结果，控制面另存了同样的请求和结果。关闭超过保留天数、且其中没有仍在运行的调用的文件会在后台删除；之后重复这些调用会得到明确的「结果已过期」，不会重新执行或返回别的结果。'));
      cards.push(totals);
      const migration = settingsCard('历史数据迁移', 'h2'), table = costTable(['位置', '表', '已迁移', '跳过', '失败', '已搬出', '待检查（估计）', '完成时间']);
      for (const [where, state] of [['控制面', view.totals.control?.migration], ['manager', view.totals.manager?.migration]]) {
        for (const [name, phase] of Object.entries(state?.phases ?? {})) {
          const row = document.createElement('tr');
          for (const text of [where, name, count(phase.migrated), count(phase.skipped), count(phase.failed), size(phase.bytes), count(state.remaining?.[name]),
            phase.finished_at ? timeText(phase.finished_at) : state.paused ? '磁盘空间不足，已暂停' : '进行中'])
            row.append(element('td', text));
          table.body.append(row);
        }
      }
      migration.append(table.wrap);
      const rates = [['控制面', view.totals.control?.migration], ['manager', view.totals.manager?.migration]].map(([where, state]) => `${where} ${state?.rate ?? 0} 条/秒`).join('，');
      migration.append(note(`当前速度：${rates}。` + [view.totals.control?.migration, view.totals.manager?.migration].flatMap(state => Object.values(state?.phases ?? {}).map(phase => phase.last_error).filter(Boolean)).slice(0, 1).map(error => `最近一个错误：${error}`).join('')));
      cards.push(migration);
    }
    const projects = settingsCard('按项目', 'h2'), table = costTable(['项目', '轨迹文件', '模型请求/响应', '工具调用/结果', '日志', ['文件块', 'blob'], ['管理过程记录', 'manager 轨迹'], '写入中的文件']);
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
    // Each project computer's work volume, from its last background scan.
    const computers = settingsCard('项目电脑', 'h2'), volumes = costTable(['项目', '卷合计', '运行中的工作区', '为 PR 保留', '待删除', ['运行日志', 'runner journal'], ['Git 仓库缓存', 'git 存储'], ['工作目录缓存', 'HOME 缓存'], '其他', '扫描时间']);
    volumes.wrap.classList.add('storage-projects');
    const share = value => value ? `${count(value.count)} 个 · ${size(value.bytes)}` : '—', top = entries => (entries ?? []).slice(0, 3).map(entry => `${entry.name} ${size(entry.bytes)}`).join('、');
    const scanned = view.projects.filter(project => project.computer);
    for (const project of scanned) {
      const c = project.computer;
      if (c.error) { row(volumes, [project.name || project.repository_id, `扫描失败：${c.error}`, '', '', '', '', '', '', '', time(c.scanned_at)]); continue; }
      // A scan lists the 5000 largest task directories; the classes then cover only those.
      const classified = ['active', 'pull_request', 'expiring'].reduce((total, key) => total + (c.workspaces?.[key]?.count ?? 0), 0), capped = c.task_count > classified;
      row(volumes, [project.name || project.repository_id, size(c.total_bytes) + (c.complete === false ? '（未扫完）' : '') + (capped ? `（共 ${count(c.task_count)} 个工作区，${size(c.tasks_bytes)}；分类只含最大的 ${count(classified)} 个）` : ''),
        share(c.workspaces?.active), share(c.workspaces?.pull_request), share(c.workspaces?.expiring),
        size(c.journal_bytes), size(c.store_bytes), size(c.home_bytes) + (top(c.home_entries) ? `（${top(c.home_entries)}）` : ''),
        size((c.other_bytes ?? 0) + (c.tmp_bytes ?? 0)) + (top(c.other_entries) ? `（${top(c.other_entries)}）` : ''), time(c.scanned_at)]);
    }
    computers.append(scanned.length ? volumes.wrap : note('还没有项目电脑的扫描结果：电脑运行后会在后台扫描。'));
    computers.append(note('任务工作区按保留规则分类：运行中（任务未结束或有后续任务）、为 PR 保留（对应的 PR 仍打开）、待删除（已结束，到期后由后台清理删除）。「其他」含 /workspace/tmp 和卷根目录下的其他文件；项目笔记是单独的卷，不计入。'));
    cards.push(computers);
    if (view.overview) {
      const details = element('details', '', 'storage-diagnostics');
      details.append(element('summary', '查看采集、回收与项目明细'), ...cards.splice(detailStart));
      cards.push(details);
    }
    return cards;
  },
  async feishu(request) {
    const panel = element('div', '', 'feishu-setup'); await renderFeishuSetup(panel, request); return [panel];
  },
  async onboarding(request) {
    const panel = element('div', ''); panel.id = 'onboarding-panel';
    try { await renderOnboarding(request, panel); }
    catch (err) { if (request === renderVersion) panel.replaceChildren(consoleState('接入状态读取失败', readErrorText(err), { tone: 'error', retry: () => render().catch(error) })); }
    return [panel];
  },
  async installations(request, ref) {
    if (ref) return installationDetail(request, ref);
    // The console already loaded the registered accounts at start (app.js), so the archive view adds no request of its own.
    const { installations } = await api('/api/installations/archive'), section = settingsCard(t('settings.installations.list_title'), 'h2'),
      apps = new Map(accounts.filter(account => account.type === 'github_app').map(account => [String(account.app_id), account]));
    section.append(note(t('settings.installations.list_note')));
    if (!installations.length) section.append(note(t('settings.installations.list_empty')));
    for (const installation of installations) {
      const item = settingsCard(t('settings.installations.item_title', { login: installation.target.login || t('settings.installations.target_pending'), id: installation.installation.installation_id })), evidence = installation.evidence;
      const owner = apps.get(String(installation.installation.app_id)), granted = installationGrantText(installation.permissions);
      const person = value => installationPerson(value, 'person_unknown');
      item.append(facts([[t('settings.installations.fact_account'), owner ? t('settings.installations.account_app', { name: owner.name, app: owner.app_id }) : t('settings.installations.account_unmatched')],
        [t('settings.installations.fact_source'), evidence.creation_event_id ? t('settings.installations.source_event') : t('settings.installations.source_missing')],
        [t('settings.installations.fact_granted'), granted || t('settings.installations.permissions_missing')],
        [t('settings.installations.fact_target_id'), installation.target.id || t('settings.installations.scope_pending')],
        [t('settings.installations.fact_target_type'), installation.target.type || t('settings.installations.scope_pending')],
        [t('settings.installations.fact_status'), installationStatusName(installation.status)],
        [t('settings.installations.fact_scope'), installationScopeName(installation.repository_selection)],
        [t('settings.installations.fact_completeness'), installationCompletenessName(installation.completeness)],
        [t('settings.installations.fact_sender'), person(evidence.sender)], [t('settings.installations.fact_requester'), person(evidence.requester)],
        [t('settings.installations.fact_approver'), evidence.approval.label],
        [t('settings.installations.fact_evidence'), evidence.history_missing ? t('settings.installations.evidence_missing') : t('settings.installations.evidence_kept')],
        [t('settings.installations.fact_last_sync'), installation.last_success_at ? timestamp(installation.last_success_at) : t('settings.installations.never_synced')],
        [t('settings.installations.fact_versions'), t('settings.installations.versions_value', {
          projection: installation.projection_version, scope: installation.scope_version, permissions: installation.permissions_version })]]));
      if (!evidence.requester) item.append(note(t('settings.installations.requester_note')));
      if (installation.error) item.append(note(t('settings.installations.sync_error', { message: installation.error })));
      // Missing permissions are checked against the App that owns this installation, when its credential still exists.
      if (owner?.credentials_configured) item.append(appPermissionCheck(owner));
      else if (owner) item.append(note(t('settings.installations.credential_revoked_list')));
      // The detail page reads the same snapshot plus its repositories and events; the list stays a summary.
      item.append(settingsLink('#/settings/installations/' + [installation.installation.github_host, installation.installation.app_id, installation.installation.installation_id].join('/'), t('settings.installations.view_detail')));
      section.append(item);
    }
    return [section];
  },
  // The computers the projects' work roles (Manager, Dev, QA, ...) run their tasks on, one per repository; the running
  // version closes the page, since those computers are created from this version's image.
  async 'work-computers'(request) {
    const { settings, version } = await api('/api/settings');
    const about = settingsCard('当前运行版本');
    about.append(version.image_tag ? facts([['镜像标签', version.image_tag]]) : note('源码运行：没有设置镜像标签（BOT_IMAGE_TAG），版本以部署所用的源码提交为准。'));
    const [min, max] = settings.task_concurrency_bounds, concurrency = settingsCard('同时运行的任务');
    const form = document.createElement('form'), value = input('task_concurrency', settings.task_concurrency, { type: 'number', min, max, step: 1, required: true });
    const message = element('p', '', 'view-error'), actions = element('div', '', 'actions form-actions'), submit = element('button', '保存');
    form.className = 'project-form'; form.noValidate = true; submit.type = 'submit'; message.setAttribute('role', 'status'); actions.append(submit);
    form.append(field('每台电脑默认同时运行的任务数', value),
      note(`取 ${min}–${max}。工作电脑是项目里 Manager、Dev、QA 等工作角色执行任务的虚拟电脑，每个仓库一台；项目在「机器配置」里没有单独设置时使用这个值，超出的任务继续排队。同时运行的任务各用自己的工作目录，共用这台电脑的 CPU、内存和进程数上限。`),
      message, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); message.className = 'view-error'; announceSave(message, '', false);
      if (!value.checkValidity()) { announceSave(message, `需要 ${min}–${max} 之间的整数`, true); value.focus(); return; }
      submit.disabled = true;
      try {
        const saved = await api('/api/settings', 'PATCH', { task_concurrency: Number(value.value) });
        value.value = saved.settings.task_concurrency; message.className = 'view-success'; announceSave(message, '已保存，新任务按这个并发数排队', false);
      } catch (err) { message.className = 'view-error'; announceSave(message, readErrorText(err), true); } finally { submit.disabled = false; }
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
    view.app = liveCard('系统初始化使用的 GitHub App', redraw => appBody(view, redraw), 'h2');
    return [view.app.section, settingsList('已登记的账号', '账号提供访问 GitHub 的凭据和接收 webhook 的入口；仓库经账号同步出现。凭据只保存，不会从读取接口返回。',
      registered.map(accountProfileLine), '还没有登记账号。', '新增账号', 'accounts', 'h2'), liveCard('GitHub 请求额度', redraw => rateLimitBody(view, redraw), 'h2').section];
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
    // Roles owned by a project are maintained with its group bindings (#849); this page keeps the global templates.
    const view = { request, roles: roles.filter(role => !role.project), items, models: models.filter(model => model.repository_id === null) };
    const intro = settingsCard('服务角色');
    intro.append(note('服务角色是平台级的助手：管理助手服务于控制台页面和个人私聊，仓库问答助手是群聊的默认推荐角色。它们不属于某个项目，使用部署共享模型，用量按角色单独记录，不计入任何项目。群聊助手角色只决定提示词和模型，群能做什么由每个群绑定的权限档位决定。这里维护全局模板；项目管理员为自己项目建的群助手角色在「个人设置 → 飞书绑定」维护。项目里的 Manager、Dev、QA 等工作角色在各项目的「角色」页配置。'));
    return [intro, ...view.roles.map(role => serviceRoleCard(view, role, 'h2')), serviceRoleCreate(view, 'h2')];
  },
  async users(request, id) {
    const [{ users }, assigned] = await Promise.all([api('/api/users'), api('/api/project-admin-assignments')]);
    grants = assigned;
    if (id) return [userDetail(id, users)];
    return [userTable(users, '项目权限由 GitHub 当前权限和 Bot 内手动分配共同决定；下面显示当前可见项目及来源。管理员管理全部项目和全局设置。')];
  },
};
