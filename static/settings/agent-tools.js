// #740: the Agent CLI tool volume (#705's API) is what the containerised backends run from, and a fresh Compose
// deployment has it empty. This category is the super administrator's way in: what the volume holds, which versions are
// compatible, the manifest each CLI would execute, an install form and a prune form. It reads the three existing
// endpoints and changes no contract; every number it shows comes from the service's answer, never from what was typed.
const agentToolCliLabels = { claude_code: 'Claude Code', codex: 'Codex' };
const agentToolCliLabel = cli => agentToolCliLabels[cli] || cli;
// The service's reason codes, in the words the role page already uses (#109).
const agentToolReasonText = {
  cli_not_installed: '尚未安装任何版本',
  cli_version_incompatible: '已安装的版本都不在兼容范围',
  agent_tools_volume_missing: '工具卷未挂载',
  agent_tools_arch_unsupported: '架构不受支持',
  platform_arch_unsupported: '架构不受支持',
  agent_tool_invalid: '请求的参数不合法',
};

function agentToolsVolumeNodes(status) {
  const bounds = Array.isArray(status.retain_bounds) ? status.retain_bounds : [];
  const nodes = [facts([
    ['工具卷根目录', status.volume_root || '—'],
    ['容器内路径', status.container_root || '—'],
    ['架构', status.arch || '读不到架构'],
    ['Node 运行时', (status.node_versions || []).join('、') || '未安装'],
    ['保留版本数', `保留版本数 ${status.retain_count}（允许 ${bounds[0]}–${bounds[1]}）`],
  ])];
  // An unmounted volume or an unknown architecture makes every install fail with 503: say how to fix the deployment
  // instead of offering a form that cannot work (#740 review F3).
  if (!status.volume_present) nodes.push(element('p', '工具卷未挂载：在 compose.yaml 里给服务挂上 agent-tools 卷，或用 BOT_AGENT_TOOLS_DIR 指向一个可写目录，然后重启服务。挂上之前，安装和清理都不会成功。', 'view-error'));
  if (!status.arch) nodes.push(note('读不到架构：安装要按平台架构挑选 Node 运行时和二进制，这一项读不出来时不会尝试安装。'));
  return nodes;
}

function agentToolsCliNodes(view) {
  const manifests = view.installed_manifests || [];
  const nodes = [facts([
    ['兼容范围', view.compatible_range || '—'],
    ['状态', view.available ? `当前选用 ${view.selected_version}` : (agentToolReasonText[view.reason] || view.reason || '不可用')],
    ['已安装', manifests.length ? manifests.map(manifest => manifest.version).join('、') : '尚未安装'],
    ['兼容', (view.compatible_versions || []).join('、') || '无'],
    ['不兼容', (view.incompatible_versions || []).join('、') || '无'],
  ])];
  if (!view.available) nodes.push(note('装一个兼容范围内的版本后，这个 CLI 就可以被角色使用。'));
  // Each installed version names the files it would execute, so a hash in a report can be matched to a version here.
  for (const manifest of manifests) {
    nodes.push(element('p', `${manifest.version} · ${manifest.arch}${manifest.libc ? ' · ' + manifest.libc : ''} · 安装于 ${manifest.installed_at}`, 'muted'));
    const table = costTable(['产物', '来源', 'sha256', '字节']);
    for (const artifact of manifest.artifacts || []) {
      const row = document.createElement('tr');
      row.append(element('td', artifact.role), element('td', artifact.source_url), element('td', artifact.sha256), element('td', `${artifact.bytes} 字节`));
      table.body.append(row);
    }
    nodes.push(table.wrap);
  }
  return nodes;
}

function agentToolsInstallNodes(state, redraw, refresh) {
  const status = state.status, bounds = Array.isArray(status.retain_bounds) ? status.retain_bounds : [];
  const cli = document.createElement('select'); cli.name = 'cli';
  for (const name of Object.keys(status.clis || {})) { const option = document.createElement('option'); option.value = name; option.textContent = agentToolCliLabel(name); cli.append(option); }
  // A select opens on its first entry, as a browser's does; without this the native hash field would start hidden.
  cli.value = Object.keys(status.clis || {})[0] || '';
  const version = input('version', '', { autocomplete: 'off', placeholder: '精确版本，例如 2.1.319' });
  const sha256 = input('sha256', '', { autocomplete: 'off', placeholder: '可选：下载包的 sha256' });
  const nativeSha256 = input('native_sha256', '', { autocomplete: 'off', placeholder: '可选：原生二进制的 sha256' });
  const retain = input('retain_count', String(status.retain_count), { type: 'number', min: bounds[0], max: bounds[1], step: 1 });
  // Claude Code's package and its native binary are two downloads: the second hash is asked for only where it applies.
  const nativeField = field('原生二进制 SHA-256（仅 Claude Code）', nativeSha256), nativeSlot = element('div', '', 'agent-tools-native');
  nativeSlot.append(nativeField);
  const syncNative = () => { if (cli.value === 'claude_code') { if (!nativeField.parentElement) nativeSlot.append(nativeField); } else nativeField.remove(); };
  cli.addEventListener('change', syncNative); syncNative();
  const nodes = [field('CLI', cli), field('精确版本', version), field('SHA-256（可选）', sha256), nativeSlot,
    field('本次安装后保留的版本数（不改变默认值）', retain),
    note('这里只保留「本次安装」，不会改变清理表单保存的默认值。'),
    note('安装时会从官方来源下载并校验 sha256，最长等 300 秒；重装正在运行的版本会替换目录（见 #735）。'),
    note('不拉取「最新版本」列表：这里只安装你填写的精确 semver。')];
  const form = actionForm(nodes, '安装', async () => {
    const body = { cli: cli.value, version: version.value.trim() };
    if (sha256.value.trim()) body.sha256 = sha256.value.trim();
    if (cli.value === 'claude_code' && nativeSha256.value.trim()) body.native_sha256 = nativeSha256.value.trim();
    if (retain.value !== '') body.retain_count = Number(retain.value);
    const answer = await api('/api/agent-tools/install', 'POST', body);
    // The answer already carries the new status: redraw from it instead of assuming the typed retain count won (#740 F2).
    state.status = answer.status; refresh(); redraw(`已安装 ${agentToolCliLabel(body.cli)} ${body.version}`);
  });
  if (!status.volume_present || !status.arch) { const submit = form.querySelectorAll('button').find(node => node.type === 'submit'); if (submit) submit.disabled = true; }
  return [form];
}

function agentToolsPruneNodes(state, redraw, refresh) {
  const status = state.status, bounds = Array.isArray(status.retain_bounds) ? status.retain_bounds : [];
  const cli = document.createElement('select'); cli.name = 'cli';
  const all = document.createElement('option'); all.value = ''; all.textContent = '全部 CLI'; cli.append(all);
  for (const name of Object.keys(status.clis || {})) { const option = document.createElement('option'); option.value = name; option.textContent = agentToolCliLabel(name); cli.append(option); }
  const retain = input('retain_count', String(status.retain_count), { type: 'number', min: bounds[0], max: bounds[1], step: 1 });
  const nodes = [field('CLI', cli), field('保留版本数（保存为默认值）', retain),
    note('只保留最新的这几个版本。正在运行的 task_runs.cli_version 不会被删除；清单读不到的版本也会保留，并在下面单独列出。')];
  const result = state.pruneResult;
  if (result) {
    const lines = [];
    for (const [name, versions] of Object.entries(result.pruned || {})) if (versions && versions.length) lines.push(`已清理 ${agentToolCliLabel(name)} ${versions.join('、')}`);
    if (!lines.length) lines.push('本次没有删除任何版本');
    for (const [name, versions] of Object.entries(result.protected_invalid || {})) if (versions && versions.length) lines.push(`受保护（正在运行或清单读不到）${agentToolCliLabel(name)} ${versions.join('、')}`);
    const box = element('p', lines.join('；'), 'view-success'); box.setAttribute('role', 'status');
    nodes.unshift(box);
  }
  const form = actionForm(nodes, '清理', async () => {
    const body = { retain_count: Number(retain.value) };
    if (cli.value) body.cli = cli.value;
    const answer = await api('/api/agent-tools/prune', 'POST', body);
    state.status = answer.status; state.pruneResult = answer; refresh(); redraw('清理完成');
  });
  if (!status.volume_present || !status.arch) { const submit = form.querySelectorAll('button').find(node => node.type === 'submit'); if (submit) submit.disabled = true; }
  return [form];
}

async function agentToolsCards(request) {
  const state = { status: await api('/api/agent-tools'), pruneResult: null };
  if (request !== renderVersion) return [];
  const volume = liveCard('工具卷', () => agentToolsVolumeNodes(state.status));
  volume.section.classList.add('agent-tools-volume');
  const clis = Object.keys(state.status.clis || {}).map(cli => {
    const section = liveCard(agentToolCliLabel(cli), () => agentToolsCliNodes(state.status.clis[cli]));
    section.section.dataset.cli = cli; section.section.classList.add('agent-tools-cli');
    return section;
  });
  const redrawClis = () => { volume.redraw(); for (const card of clis) card.redraw(); };
  const prune = liveCard('清理旧版本', redraw => agentToolsPruneNodes(state, redraw, redrawClis));
  prune.section.classList.add('agent-tools-prune');
  const install = liveCard('安装版本', redraw => agentToolsInstallNodes(state, redraw, () => { redrawClis(); prune.redraw(); }));
  install.section.classList.add('agent-tools-install');
  return [volume.section, ...clis.map(card => card.section), install.section, prune.section];
}
settingsCards['agent-tools'] = agentToolsCards;
