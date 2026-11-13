// A computer's resources, chosen from common sizes inside the manager's bounds; CPU and memory sizes larger than the host
// are not offered and the current value is always an option. Work computers and assistant computers use the same fields;
// only an assistant computer has a working directory of its own size (a tmpfs, where a work computer has a volume).
const commonSizes = { cpus: [0.5, 1, 2, 4, 6, 8, 12, 16], memory_mb: [512, 1024, 2048, 4096, 8192, 12288, 16384, 32768, 65536],
  pids: [256, 512, 1024, 2048, 4096, 8192, 16384], tmp_mb: [256, 512, 1024, 2048, 4096, 8192, 16384] };
commonSizes.workspace_mb = commonSizes.tmp_mb;
const megabytes = value => value >= 1024 ? `${Number((value / 1024).toFixed(1))} GB` : `${value} MB`;
const resourceFields = [['cpus', 'CPU', value => `${value} 核`], ['memory_mb', '内存', megabytes], ['pids', '进程数上限', value => `${value} 个`], ['tmp_mb', '/tmp 大小', megabytes]];
const assistantResourceFields = [...resourceFields, ['workspace_mb', '工作目录大小', megabytes]];
// The selects of `fields` set to `values`; `marked` is the value labelled `mark` (the built-in default). changes() lists
// the fields whose choice differs from `values`.
function resourceSelects(fields, { values, bounds, host, marked, mark }) {
  const grid = element('div', '', 'field-grid'), controls = {}, hostLimit = { cpus: host?.cpus, memory_mb: host?.memory_mb };
  for (const [key, caption, label] of fields) {
    const select = controls[key] = document.createElement('select'); select.name = key;
    const sizes = [...new Set([...commonSizes[key].filter(size => size >= bounds[key][0] && size <= bounds[key][1] && !(hostLimit[key] && size > hostLimit[key])), values[key]])].sort((a, b) => a - b);
    for (const size of sizes) { const option = element('option', label(size) + (size === marked[key] ? mark : '')); option.value = String(size); select.append(option); }
    select.value = String(values[key]); grid.append(field(caption, select));
  }
  const changes = () => Object.fromEntries(fields.map(([key]) => [key, Number(controls[key].value)]).filter(([key, value]) => value !== values[key]));
  return { grid, changes };
}
function resourceDefaultsBody(view, redraw) {
  if (!view.computer) return [note('暂时读不到 manager，无法显示默认资源，稍后再试。')];
  const { defaults, builtin, bounds, host, allocated } = view.computer;
  const { grid, changes: changed } = resourceSelects(resourceFields, { values: defaults, bounds, host, marked: builtin, mark: '（内置默认）' });
  return [facts([['这台主机', host ? `${host.cpus} CPU · ${megabytes(host.memory_mb)} 内存` : '读不到'],
    ['运行中的虚拟电脑', `${allocated.computers} 台，共分配 ${allocated.cpus} CPU · ${megabytes(allocated.memory_mb)} 内存`]]),
    note('项目在「机器配置」里留空的资源使用这里的值。虚拟电脑共用这台主机，分配总量可以超过主机，同时满载时会互相争用。'),
    actionForm([grid, note('保存后新建的虚拟电脑立即使用新值；已有的虚拟电脑等到没有任务运行时按新值重建，工作卷和代次保留，运行中的任务不会被打断。')], '保存', async () => {
      const changes = changed();
      if (!Object.keys(changes).length) { redraw('没有改动'); return; }
      view.computer = (await api('/api/settings', 'PATCH', { computer_defaults: changes })).settings.computer_defaults;
      redraw('已保存：新建的虚拟电脑立即使用，已有的在空闲时重建');
    })];
}
