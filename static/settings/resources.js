// A computer's resources, chosen from common sizes inside the manager's bounds; CPU and memory sizes larger than the host
// are not offered and the current value is always an option. Work computers and assistant computers use the same fields;
// only an assistant computer has a working directory size limit of its own (ephemeral disk-backed volume).
const commonSizes = { cpus: [0.5, 1, 2, 4, 6, 8, 12, 16], memory_mb: [512, 1024, 2048, 4096, 8192, 12288, 16384, 32768, 65536],
  pids: [256, 512, 1024, 2048, 4096, 8192, 16384], tmp_mb: [256, 512, 1024, 2048, 4096, 8192, 16384, 20480, 32768, 65536] };
commonSizes.workspace_mb = commonSizes.tmp_mb;
const megabytes = value => value >= 1024 ? `${Number((value / 1024).toFixed(1))} GB` : `${value} MB`;
const resourceFields = [['cpus', 'CPU', value => `${value} 核`], ['memory_mb', '内存', megabytes], ['pids', '进程数上限', value => `${value} 个`], ['tmp_mb', '/tmp 大小', megabytes]];
const assistantResourceFields = [['cpus', 'CPU', value => `${value} 核`], ['memory_mb', '内存', megabytes], ['pids', '进程数上限', value => `${value} 个`], ['tmp_mb', '/tmp 大小（软限额）', megabytes], ['workspace_mb', '工作目录大小（软限额）', megabytes]];
// The selects of `fields` set to `values`; `marked` is the value labelled `mark` (the built-in default). changes() lists
// the fields whose choice differs from `values`.
function resourceSelects(fields, { values, bounds, host, hostMemoryCapMb = null, tmpMaxMb = null, marked, mark }) {
  const grid = element('div', '', 'field-grid'), controls = {};
  const hostLimit = { cpus: host?.cpus, memory_mb: hostMemoryCapMb ?? host?.memory_mb, ...(tmpMaxMb ? { tmp_mb: tmpMaxMb } : {}) };
  for (const [key, caption, label] of fields) {
    const select = controls[key] = document.createElement('select'); select.name = key;
    const sizes = [...new Set([...commonSizes[key].filter(size => size >= bounds[key][0] && size <= bounds[key][1] && !(hostLimit[key] && size > hostLimit[key])), values[key]])].sort((a, b) => a - b);
    for (const size of sizes) { const option = element('option', label(size) + (size === marked[key] ? mark : '')); option.value = String(size); select.append(option); }
    select.value = String(values[key]); grid.append(field(caption, select));
  }
  const changes = () => Object.fromEntries(fields.map(([key]) => [key, Number(controls[key].value)]).filter(([key, value]) => value !== values[key]));
  return { grid, changes };
}
let globalBuildTimer = null;
function resourceDefaultsBody(view, redraw) {
  clearTimeout(globalBuildTimer);
  if (!view.computer) return [note('暂时读不到 manager，无法显示虚拟电脑默认环境，稍后再试。')];
  const { defaults, configured_defaults: configuredDefaults, host_clamped: hostClamped, host_memory_cap_mb: hostMemoryCapMb, builtin, bounds, host, allocated, environment = {}, build, global_image: globalImage, toolchain } = view.computer;
  const { grid, changes: changed } = resourceSelects(resourceFields, { values: defaults, bounds, host, hostMemoryCapMb, tmpMaxMb: defaults.memory_mb, marked: builtin, mark: '（内置默认）' });
  const egressEnabled = environment.egress !== false;
  const egressWrap = checkbox('egress', egressEnabled, '默认允许访问外网（项目与助手电脑默认继承）');
  const egressInput = egressWrap.querySelector('input');
  const packagesInput = textarea('packages', packagesText(environment.packages || []), { rows: 2, spellcheck: false, placeholder: '全局预装 Debian 软件包，空格或换行分隔，例如 ripgrep jq shellcheck' });
  const scriptInput = textarea('setup_script', environment.setup_script || '', { rows: 5, spellcheck: false, className: 'code', placeholder: '以非特权用户（UID 10001）在构建期执行，安装到 /opt/preinstalled；管理助手、群助手与所有项目电脑共用此预编译镜像' });
  const envInput = textarea('env', envText(environment.env || {}), { rows: 3, spellcheck: false, placeholder: '每行 名称=值。管理助手、群助手与项目电脑默认继承，不要填写密钥' });
  const rebuildWrap = checkbox('rebuild', false, '保存后强制重新预编译全局镜像');
  const rebuildInput = rebuildWrap.querySelector('input');

  const nodes = [
    facts([
      ['这台主机', host ? `${host.cpus} CPU · ${megabytes(host.memory_mb)} 内存` : '读不到'],
      ['运行中的项目电脑', `${allocated.computers} 台，共分配 ${allocated.cpus} CPU · ${megabytes(allocated.memory_mb)} 内存`],
      ['当前全局预编译镜像', globalImage?.tag ? `${globalImage.tag}（${timestamp(globalImage.finished_at) || '已就绪'}）` : '基础镜像（无全局增量）'],
    ]),
    note('管理助手电脑、群助手电脑与所有项目电脑共用此全局默认环境（默认 CPU/内存/进程数、外网开关、预装软件包、非特权初始化脚本与环境变量）；各项目可在自己的「机器配置」页叠加项目专属包与脚本。单台容器内存受宿主机 75% 安全上限约束（预留 25% 给宿主机与控制面）；项目电脑的 /workspace 为持久化磁盘卷，/tmp 为内存型 tmpfs（默认 4 GB，计入并受限于容器生效内存上限，防止 OOM）；助手电脑的 /workspace 与 /tmp 则是独立的临时磁盘卷（默认 20 GB 软限额）。' + (toolchain ? ` 基础镜像已包含：${toolchain}。` : '')),
    ...(hostClamped ? [note(`当前主机总内存为 ${host ? megabytes(host.memory_mb) : '未知'}，单容器安全上限为 ${megabytes(hostClamped.host_cap_mb ?? defaults.memory_mb)}（预留 25% 给宿主机与控制面），低于已配置/内置默认内存（${megabytes(configuredDefaults?.memory_mb ?? builtin.memory_mb)}），实际生效上限已自动收紧至 ${megabytes(defaults.memory_mb)}。`)] : []),
  ];

  if (build && build.state && build.state !== 'none') {
    const stateMap = {
      queued: [`全局镜像排队中${build.queue_position ? `（第 ${build.queue_position} 位）` : ''}`, 'warning'],
      building: ['正在预编译全局默认镜像', 'info'],
      cancelling: ['正在停止全局构建', 'warning'],
      ready: ['全局预编译镜像已就绪', 'success'],
      failed: ['全局预编译构建失败', 'danger'],
      cancelled: ['全局构建已手动停止', 'warning'],
    }[build.state] || [build.state, ''];
    const bar = element('div', '', 'actions');
    bar.append(badge(...stateMap));
    if (build.can_cancel || ['queued', 'building'].includes(build.state)) {
      const stopBtn = button('停止全局构建', async event => {
        if (!await askConfirm({ title: '停止全局预编译镜像构建？', body: ['正在运行的管理助手、群助手与项目电脑会继续使用原镜像，不受影响。'], action: '停止构建', danger: true })) return;
        const btn = event.currentTarget; btn.disabled = true;
        try {
          const res = await api('/api/settings/computer-defaults/build/cancel', 'POST', {});
          if (res?.computer_defaults) view.computer = res.computer_defaults;
          redraw('已请求停止全局预编译构建');
        } catch (err) { btn.disabled = false; error(err); }
      }, 'danger');
      stopBtn.id = 'global-build-cancel';
      bar.append(stopBtn);
    }
    nodes.push(bar);
    if (build.output) nodes.push(collapsible('全局预编译输出', build.output, ['building', 'cancelling', 'failed', 'cancelled'].includes(build.state)));
    if (['queued', 'building', 'cancelling'].includes(build.state)) {
      globalBuildTimer = setTimeout(async () => {
        try {
          const fresh = await api('/api/settings');
          if (fresh?.settings?.computer_defaults) { view.computer = fresh.settings.computer_defaults; redraw(); }
        } catch {}
      }, 2500);
    }
  }

  nodes.push(actionForm([
    grid,
    egressWrap,
    field('全局预装系统软件包', packagesInput),
    field('全局初始化脚本（非特权 UID 10001，构建期预编译到 /opt/preinstalled）', scriptInput),
    field('全局默认环境变量', envInput),
    rebuildWrap,
    note('保存后若修改了软件包或初始化脚本，会在后台串行队列（并发=1，无超时）自动预编译并缓存全局镜像；构建完成前运行中的容器不受影响。'),
  ], '保存', async () => {
    const changes = changed();
    if (egressInput.checked !== egressEnabled) changes.egress = egressInput.checked;
    const nextPackages = [...new Set(packagesInput.value.split(/[\s,]+/).filter(Boolean))].sort();
    if (nextPackages.join(' ') !== [...(environment.packages || [])].sort().join(' ')) changes.packages = nextPackages;
    if (scriptInput.value !== (environment.setup_script || '')) changes.setup_script = scriptInput.value;
    const nextEnv = parseEnv(envInput.value);
    if (envText(nextEnv) !== envText(environment.env || {})) changes.env = nextEnv;
    if (rebuildInput.checked) changes.rebuild = true;
    if (!Object.keys(changes).length) { redraw('没有改动'); return; }
    view.computer = (await api('/api/settings', 'PATCH', { computer_defaults: changes })).settings.computer_defaults;
    const state = view.computer?.build?.state;
    redraw(state === 'queued' || state === 'building'
      ? '已保存：正在后台预编译全局镜像，管理助手、群助手与项目电脑构建完成后自动生效'
      : '已保存：新建的虚拟电脑立即使用，已有的在空闲时重建');
  }));
  return nodes;
}
