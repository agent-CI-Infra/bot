const storageKinds = [
  ['database', '管理数据库', '#3868be'], ['trajectories', '轨迹', '#008975'], ['knowledge', '知识库', '#d08524'],
  ['workspaces', '工作区', '#8857aa'], ['other', '其他文件', '#698092'],
];
function storageSize(value) {
  if (!Number.isFinite(value)) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let n = value, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toLocaleString('zh-CN', { maximumFractionDigits: i ? 2 : 0 }) + ' ' + units[i];
}
function storageSvg(tag, attrs) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}
function storageDot(color) {
  const mark = storageSvg('svg', { width: 12, height: 12, 'aria-hidden': true });
  mark.append(storageSvg('circle', { cx: 6, cy: 6, r: 5, fill: color }));
  return mark;
}
function storageBar(section, parts) {
  const sum = parts.reduce((n, p) => n + (p.bytes ?? 0), 0);
  const bar = storageSvg('svg', { viewBox: '0 0 1000 16', preserveAspectRatio: 'none', class: 'storage-bar', 'aria-hidden': true });
  let x = 0;
  const legend = element('ul', '', 'storage-legend');
  for (const part of parts) {
    if (sum && part.bytes > 0) {
      const width = part.bytes / sum * 1000;
      bar.append(storageSvg('rect', { x, y: 0, width, height: 16, fill: part.color })); x += width;
    }
    const item = element('li');
    item.append(storageDot(part.color), element('span', part.name), element('strong', part.partial && !part.bytes ? '尚未测得' :
      storageSize(part.bytes) + (part.partial ? '（部分）' : '')));
    legend.append(item);
  }
  section.append(bar, legend);
}
function storageCapacity(view, host, time) {
  const section = settingsCard('整机磁盘'), machine = view.machine, disk = host?.disk;
  const title = element('p', '', 'storage-number');
  if (machine) {
    title.append(element('strong', storageSize(machine.used)), element('span', '已用，共 ' + storageSize(machine.total)));
    section.append(title);
    const parts = machine.launchpad === null ? [{ name: '已用（归属待核对）', bytes: machine.used, color: '#738398' }] : [
      { name: 'Launchpad 已核实', bytes: machine.launchpad, color: '#3868be' },
      { name: '其他已用（含未归类）', bytes: machine.other, color: '#8998ac' }];
    storageBar(section, [...parts, { name: '空闲', bytes: machine.free, color: '#dce3ec' }]);
    section.append(note('主机采样于 ' + time(machine.measured_at) + '，覆盖 ' + machine.filesystems + ' 个已挂载本地磁盘文件系统。'));
  } else {
    section.append(note('整机容量未知。尚无有效的宿主机采样。'));
    if (disk && Number.isFinite(disk.used_bytes) && disk.total_bytes > 0 && disk.used_bytes <= disk.total_bytes) {
      title.append(element('strong', storageSize(disk.total_bytes)), element('span', '控制面所在文件系统'));
      section.append(title);
      storageBar(section, [{ name: '数据盘已用', bytes: disk.used_bytes, color: '#8998ac' },
        { name: '数据盘空闲', bytes: disk.total_bytes - disk.used_bytes, color: '#dce3ec' }]);
    }
  }
  const app = settingsCard('Launchpad 用量'), subtotal = element('p', '', 'storage-number');
  subtotal.append(element('strong', storageSize(view.total)), element('span', '已测文件占用'));
  app.append(subtotal);
  storageBar(app, storageKinds.map(([key, name, color]) => ({ name, color, bytes: view.amounts[key], partial: view.missing.includes(key) })));
  app.append(note('管理数据库含 WAL 和库内知识记录。知识库统计独立知识文件，工作区统计项目工作卷。共享 blob 计入轨迹一次，Docker 镜像与构建缓存另见明细。'));
  app.append(note('目录采样 · 控制面 ' + (view.control_at ? time(view.control_at) : '未采集') + '，manager ' + (view.manager_at ? time(view.manager_at) : '未采集') + '。'));
  return [section, app];
}
function storageProjects(view) {
  const section = settingsCard('项目空间占比'), body = element('div', '', 'storage-shares');
  // Both representations consume exactly these rows, including shared data and measured zeroes.
  const rows = [...view.rows, { id: null, name: '公共或未归属', bytes: view.shared }];
  const table = costTable(['项目', '已测容量', '占比']);
  table.wrap.classList.add('storage-share-table');
  const pie = storageSvg('svg', { viewBox: '0 0 100 100', class: 'storage-pie', 'aria-hidden': true });
  let start = -Math.PI / 2;
  for (const [i, row] of rows.entries()) {
    const ratio = view.total > 0 ? row.bytes / view.total : null;
    const color = row.id === null ? '#8998ac' : storageKinds[i]?.[2] ?? 'hsl(' + Math.round(i * 137.508 % 360) + ',55%,46%)';
    const tr = element('tr'), name = element('td'), key = element('span', '', 'storage-share-name');
    key.append(storageDot(color), element('span', row.name)); name.append(key);
    const percent = ratio === null ? '—' : ratio > 0 && ratio < 0.001 ? '<0.1%' : (ratio * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 }) + '%';
    tr.append(name, element('td', storageSize(row.bytes)), element('td', percent)); table.body.append(tr);
    if (ratio === 1) pie.append(storageSvg('circle', { cx: 50, cy: 50, r: 48, fill: color }));
    else if (ratio > 0) {
      const point = angle => (50 + 48 * Math.cos(angle)) + ' ' + (50 + 48 * Math.sin(angle));
      const end = start + ratio * Math.PI * 2;
      pie.append(storageSvg('path', { d: 'M50 50 L' + point(start) + ' A48 48 0 ' + (ratio > .5 ? 1 : 0) + ' 1 ' + point(end) + ' Z', fill: color }));
      start = end;
    }
  }
  section.append(note('分母为 Launchpad 已测用量 ' + storageSize(view.total) + '。公共或未归属包含数据库、共享文件及无法归到现有项目的占用。'));
  if (view.missing.length) section.append(note('采集尚不完整，容量和占比仅覆盖已测部分。'));
  if (view.total) body.append(pie); else section.append(note('暂无已测用量，占比待统计。'));
  body.append(table.wrap); section.append(body);
  return section;
}
