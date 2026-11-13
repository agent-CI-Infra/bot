// Assistant computers (#457): the manager's container timers and the control plane's HOME limits, saved together.
const gigabytes = bytes => bytes == null ? '未统计' : bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
const assistantFields = [['idle_minutes', '空闲回收（分钟）', 'computers'], ['max_containers', '同时存活的电脑上限（台）', 'computers'], ['max_lifetime_minutes', '最长存活（分钟）', 'computers'],
  ['home_limit_gb', '每个 HOME 上限（GB）', 'homes'], ['retention_days', '不活跃数据保留（天）', 'homes'], ['total_alert_gb', 'HOME 总量告警（GB）', 'homes']];
function assistantSettingsBody(view, redraw) {
  const { computers, homes } = view.settings;
  if (!computers) return [note('暂时读不到 manager，无法显示助手电脑设置，稍后再试。')];
  const grid = element('div', '', 'field-grid'), controls = {};
  for (const [key, caption, part] of assistantFields) {
    const source = part === 'computers' ? computers : homes, [min, max] = source.bounds[key];
    controls[key] = input(key, String(source.settings[key]), { type: 'number', min, max, step: 1, required: true });
    grid.append(field(caption, controls[key]));
  }
  const { usage } = computers;
  return [facts([['当前电脑', `${usage.computers} 台（使用中 ${usage.busy} 台，排队 ${usage.waiting} 个）`]]),
    note('群按群、私信按人各有一台电脑，回合第一次用到时创建；最终回复交出后开始空闲计时，到时删除，/tmp 和工作目录随之清空。HOME 持久保存：超过上限后下一回合只读，不活跃满保留期后删除；所有 HOME 合计没有硬上限，超过告警值时这里和日志提示。'),
    actionForm([grid], '保存', async () => {
      const changes = {};
      for (const [key, , part] of assistantFields) { const value = Number(controls[key].value); if (!Number.isInteger(value)) throw new Error('请填写整数'); if (value !== (part === 'computers' ? computers : homes).settings[key]) changes[key] = value; }
      if (!Object.keys(changes).length) { redraw('没有改动'); return; }
      view.settings = (await api('/api/settings', 'PATCH', { assistant_computers: changes })).settings.assistant_computers;
      redraw('已保存：计时与上限立即按新值执行');
    })];
}
// Every assistant computer gets the same resources; unlike a work computer there is no per-project value over them.
function assistantResourcesBody(view, redraw) {
  const { computers } = view.settings;
  if (!computers) return [note('暂时读不到 manager，无法显示助手电脑的资源，稍后再试。')];
  const { settings, defaults, bounds, host } = computers;
  const { grid, changes: changed } = resourceSelects(assistantResourceFields, { values: settings, bounds, host, marked: defaults, mark: '（默认）' });
  return [facts([['这台主机', host ? `${host.cpus} CPU · ${megabytes(host.memory_mb)} 内存` : '读不到'], ['网络', '无']]),
    note('/tmp 和工作目录放在内存里，写进去的文件计入内存上限；写满时命令收到“磁盘已满”，不影响别的电脑。电脑共用这台主机，分配总量可以超过主机。'),
    actionForm([grid, note('保存后新建的电脑立即使用新值；已有的电脑在它的下一个回合开始时按新值重建，HOME 保留，/tmp 和工作目录清空，进行中的回合不受影响。')], '保存', async () => {
      const changes = changed();
      if (!Object.keys(changes).length) { redraw('没有改动'); return; }
      view.settings = (await api('/api/settings', 'PATCH', { assistant_computers: changes })).settings.assistant_computers;
      redraw('已保存：新建的电脑立即使用，已有的在下一个回合重建');
    })];
}
function assistantHomesBody(view, redraw, request) {
  const overview = view.overview;
  if (overview.error) return [element('p', '读不到 HOME 占用：' + overview.error, 'view-error')];
  const { totals, disk, homes } = overview, message = element('p', '', 'view-error'), nodes = [message];
  message.setAttribute('role', 'alert');
  if (totals.alert) { const alert = element('p', `所有 HOME 合计 ${gigabytes(totals.bytes)}，超过告警值 ${gigabytes(totals.alert_bytes)}。请清理不需要的 HOME，或检查数据盘剩余空间。`, 'view-error'); alert.setAttribute('role', 'alert'); nodes.push(alert); }
  nodes.push(facts([['HOME 合计', `${gigabytes(totals.bytes)}（告警值 ${gigabytes(totals.alert_bytes)}）`], ['数据盘', disk ? `剩余 ${gigabytes(disk.free_bytes)} / 共 ${gigabytes(disk.total_bytes)}` : '读不到']]));
  if (!homes.length) { nodes.push(note('还没有群或个人用过助手电脑。')); return nodes; }
  const captions = ['归属', '占用', '文件数', '最后活跃', '状态', ''];
  const table = element('table', '', 'rule-table assistant-homes'), head = element('tr', ''), thead = document.createElement('thead'), body = document.createElement('tbody');
  for (const caption of captions) head.append(element('th', caption));
  thead.append(head); table.append(thead, body);
  for (const home of homes) {
    const row = element('tr', ''), cell = (index, value) => { const td = element('td'); td.dataset.label = captions[index]; td.append(value); return td; };
    const owner = (home.kind === 'group' ? '群 ' : '个人 ') + (home.name || home.subject);
    const sealed = home.sealed.length ? `；封存 ${home.sealed.length} 代（${gigabytes(home.sealed.reduce((sum, s) => sum + (s.bytes || 0), 0))}）` : '';
    const state = (home.read_only ? '超过上限，只读' : '可写') + (home.computer ? (home.computer === 'busy' ? ' · 电脑使用中' : ' · 电脑空闲') : '') + sealed;
    const clear = button('清空', async () => {
      if (!await askConfirm({ title: `清空${owner}的 HOME？`, body: ['删除这个 HOME 的全部文件（包括封存的旧代次），并删除它正在运行的电脑；正在进行的回合中的命令会被中断。', '这一操作不能撤销。'], action: '清空', danger: true })) return;
      clear.disabled = true;
      try { await api(`/api/assistant-computers/${home.owner}/clear`, 'POST', {}); view.overview = await api('/api/assistant-computers'); if (request === renderVersion) redraw(`已清空${owner}的 HOME`); }
      catch (err) { clear.disabled = false; message.textContent = err.message; }
    });
    row.append(cell(0, owner), cell(1, gigabytes(home.bytes)), cell(2, home.files == null ? '未统计' : String(home.files)), cell(3, timestamp(home.active_at)), cell(4, state), cell(5, clear));
    body.append(row);
  }
  const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); nodes.push(wrap);
  return nodes;
}
