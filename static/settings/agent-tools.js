// #740 / #1260: the Agent tool volume holds all third-party container agents except built-in Pi
// (Claude Code, Codex, iCode, WorkSwarm). Every number and status shown comes from the service's answer.
const agentToolCliLabels = {
  claude_code: 'Claude Code',
  codex: 'Codex',
  icode: 'iCode',
  workswarm: 'WorkSwarm',
};
const agentToolCliLabel = cli => agentToolCliLabels[cli] || cli;

const agentToolReasonText = {
  cli_not_installed: '尚未安装任何版本',
  cli_version_incompatible: '已安装的版本都不在兼容范围',
  agent_tools_volume_missing: '工具卷未挂载',
  agent_tools_arch_unsupported: '架构不受支持',
  platform_arch_unsupported: '架构不受支持',
  agent_tool_invalid: '请求的参数不合法',
  agent_tool_removed: '已手动删除（重启不会自动重装）',
  agent_tool_version_in_use: '当前版本正在被任务或角色会话使用，无法修改或删除',
  agent_tool_version_unverified: '该产品仅支持平台已验签版本',
  agent_tool_isolated_installer_required: '缺少隔离安装容器（manager），拒绝在控制面构建 Python 依赖',
  agent_tool_download_failed: '上游下载失败',
  agent_tool_hash_mismatch: '下载产物 SHA-256 校验不匹配',
  agent_tool_archive_invalid: '安装包归档无效',
};

function agentToolsVolumeNodes(status) {
  const bounds = Array.isArray(status.retain_bounds) ? status.retain_bounds : [];
  const rows = [
    ['工具卷根目录', status.volume_root || '—'],
    ['容器内路径', status.container_root || '—'],
    ['架构', status.arch || '读不到架构'],
    ['Node 运行时', (status.node_versions || []).join('、') || '未安装'],
    ['uv 运行时', (status.uv_versions || []).join('、') || '未安装'],
    ['启动自动安装', status.auto_install_enabled === false ? '已关闭（BOT_AGENT_TOOLS_AUTO_INSTALL=0）' : '已开启'],
    ['保留版本数', `${status.retain_count}（允许 ${bounds[0]}–${bounds[1]}）`],
  ];
  const nodes = [facts(rows)];
  // An unmounted volume or an unknown architecture makes every install fail with 503: say how to fix the deployment
  // instead of offering a form that cannot work (#740 review F3).
  if (!status.volume_present) nodes.push(element('p', '工具卷未挂载：在 compose.yaml 里给服务挂上 agent-tools 卷，或用 BOT_AGENT_TOOLS_DIR 指向一个可写目录，然后重启服务。挂上之前，安装和清理都不会成功。', 'view-error'));
  if (!status.arch) nodes.push(note('读不到架构：安装要按平台架构挑选 Node/uv 运行时和二进制，这一项读不出来时不会尝试安装。'));
  nodes.push(note('Pi 内置在项目电脑镜像中，不占用工具卷。此处统一管理除 Pi 外的第三方容器 Agent；启动时若对应目录为空且未被手动删除，控制面会在后台自动安装默认版本。'));
  return nodes;
}

function agentToolStatusSummary(view) {
  if (view.auto_install_state === 'installing') return '自动安装中…';
  if (view.available) return `当前选用 ${view.selected_version}`;
  if (view.removed) return '已手动删除（重启不会自动重装）';
  if (view.last_error) return `安装失败（${agentToolReasonText[view.last_error] || view.last_error}）`;
  return agentToolReasonText[view.reason] || view.reason || '不可用';
}

function agentToolsCliNodes(cli, state, refreshAll) {
  const status = state.status;
  const view = status.clis?.[cli];
  if (!view) return [note('未读取到该 Agent 状态。')];
  const canOperate = Boolean(status.volume_present && status.arch);
  const manifests = view.installed_manifests || [];
  const defaultVer = view.default_version || view.tested_version || '';
  const allowCustom = view.allow_custom_version !== false && view.kind !== 'acp';
  const nodes = [facts([
    ['默认版本', defaultVer || '—'],
    ['兼容范围', view.compatible_range || '—'],
    ['状态', agentToolStatusSummary(view)],
    ['已安装', manifests.length ? manifests.map(manifest => manifest.version).join('、') : '尚未安装'],
    ['兼容', (view.compatible_versions || []).join('、') || '无'],
    ['不兼容', (view.incompatible_versions || []).join('、') || '无'],
  ])];

  if (view.last_error) {
    const detail = view.last_error_detail ? `：${view.last_error_detail}` : '';
    const when = view.last_attempt_at ? ` · 最近尝试 ${view.last_attempt_at}` : '';
    const retry = view.next_retry_at ? ` · 下次自动重试 ${view.next_retry_at}` : '';
    nodes.push(element('p', `最近错误（${view.last_error}）${detail}${when}${retry}`, 'view-error'));
  } else if (view.removed) {
    nodes.push(note('该 Agent 已被手动删除，控制面重启时不会自动重新安装；点击下方「安装」可重新启用。'));
  } else if (!view.available) {
    nodes.push(note('安装一个兼容版本后，这个 Agent 就可以被项目角色使用。'));
  }

  const feedback = element('p', state.actionFeedback?.[cli]?.text || '', state.actionFeedback?.[cli]?.error ? 'view-error' : 'view-success');
  feedback.classList.add('agent-tools-action-feedback');
  feedback.setAttribute('role', 'status');
  if (!feedback.textContent) feedback.hidden = true;

  const setFeedback = (text, isError = false) => {
    state.actionFeedback[cli] = { text, error: isError };
    feedback.className = (isError ? 'view-error' : 'view-success') + ' agent-tools-action-feedback';
    feedback.textContent = text;
    feedback.hidden = !text;
  };

  const actions = element('div', '', 'actions agent-tools-actions');
  const upgradeInput = allowCustom ? input(`upgrade_version_${cli}`, '', {
    autocomplete: 'off',
    placeholder: view.selected_version ? `高于 ${view.selected_version} 的版本` : `例如 ${defaultVer}`,
    'aria-label': `${agentToolCliLabel(cli)} 升级版本`,
  }) : null;

  const runAction = async (btn, work) => {
    btn.disabled = true;
    try {
      await work();
    } catch (err) {
      setFeedback(readErrorText(err), true);
      btn.disabled = false;
    }
  };

  const installBtn = button('安装', () => runAction(installBtn, async () => {
    setFeedback(`正在安装 ${agentToolCliLabel(cli)} ${defaultVer}…`, false);
    const answer = await api('/api/agent-tools/install', 'POST', { cli, ...(defaultVer ? { version: defaultVer } : {}) });
    state.status = answer.status; state.pruneResult = null;
    state.actionFeedback[cli] = { text: `已安装 ${agentToolCliLabel(cli)} ${answer.installed?.version || defaultVer}`, error: false };
    refreshAll();
  }));
  installBtn.dataset.action = 'install';
  installBtn.disabled = !canOperate;

  const upgradeBtn = button('升级', () => runAction(upgradeBtn, async () => {
    const targetVersion = upgradeInput ? (upgradeInput.value.trim() || defaultVer) : defaultVer;
    if (!targetVersion) { setFeedback('请先填写要升级的精确版本号', true); upgradeBtn.disabled = false; return; }
    setFeedback(`正在升级 ${agentToolCliLabel(cli)} 到 ${targetVersion}…`, false);
    const answer = await api('/api/agent-tools/upgrade', 'POST', { cli, version: targetVersion });
    state.status = answer.status; state.pruneResult = null;
    state.actionFeedback[cli] = { text: `已升级 ${agentToolCliLabel(cli)} 到 ${answer.installed?.version || targetVersion}`, error: false };
    refreshAll();
  }), 'quiet');
  upgradeBtn.dataset.action = 'upgrade';
  upgradeBtn.disabled = !canOperate;

  const removeBtn = button('删除', () => runAction(removeBtn, async () => {
    if (typeof askConfirm === 'function') {
      const ok = await askConfirm({
        title: `删除 ${agentToolCliLabel(cli)}？`,
        body: [
          `将从工具卷删除 ${agentToolCliLabel(cli)} 的全部已安装版本，并标记为已手动删除。`,
          '控制面重启时不会再自动安装，后续可随时点击「安装」恢复。若有任务或角色会话正在使用其中某个版本，操作会被拒绝。',
        ],
        action: '删除',
        danger: true,
      });
      if (!ok) { removeBtn.disabled = false; return; }
    }
    const answer = await api('/api/agent-tools/remove', 'POST', { cli });
    state.status = answer.status; state.pruneResult = null;
    const removedList = (answer.removed || []).join('、');
    state.actionFeedback[cli] = {
      text: removedList ? `已删除 ${agentToolCliLabel(cli)}（${removedList}），重启不再自动安装` : `已标记 ${agentToolCliLabel(cli)} 为已删除，重启不再自动安装`,
      error: false,
    };
    refreshAll();
  }), 'quiet destructive');
  removeBtn.dataset.action = 'remove';
  removeBtn.disabled = !canOperate || (!manifests.length && Boolean(view.removed));

  actions.append(installBtn);
  if (upgradeInput) actions.append(upgradeInput);
  actions.append(upgradeBtn, removeBtn);
  nodes.push(actions, feedback);

  // Each installed version names the files it would execute, plus a single-version delete button.
  for (const manifest of manifests) {
    const rowHead = element('div', '', 'actions agent-tools-version-head');
    rowHead.append(element('p', `${manifest.version} · ${manifest.arch}${manifest.libc ? ' · ' + manifest.libc : ''} · 安装于 ${manifest.installed_at}`, 'muted'));
    const delVer = button(`删除 ${manifest.version}`, () => runAction(delVer, async () => {
      const answer = await api('/api/agent-tools/remove', 'POST', { cli, version: manifest.version });
      state.status = answer.status; state.pruneResult = null;
      state.actionFeedback[cli] = {
        text: `已删除 ${agentToolCliLabel(cli)} ${manifest.version}` + (answer.removed_agent ? '（最后一个版本，已标记为手动删除）' : ''),
        error: false,
      };
      refreshAll();
    }), 'quiet destructive');
    delVer.dataset.action = 'remove-version';
    delVer.dataset.version = manifest.version;
    delVer.disabled = !canOperate;
    rowHead.append(delVer);
    nodes.push(rowHead);

    const table = costTable(['产物', '来源', 'sha256', '字节']);
    table.wrap.classList.add('agent-tools-manifest');
    for (const artifact of manifest.artifacts || []) {
      const source = element('td', artifact.source_url), sha = element('td', artifact.sha256);
      // A URL and a hash are long single tokens: the table's nowrap rule would otherwise push the hash and the size out
      // of view at every width, which defeats the point of listing them (#740 review).
      for (const cell of [source, sha]) { cell.style.whiteSpace = 'normal'; cell.style.overflowWrap = 'anywhere'; }
      const row = document.createElement('tr');
      row.append(element('td', artifact.role), source, sha, element('td', `${artifact.bytes} 字节`));
      table.body.append(row);
    }
    nodes.push(table.wrap);
  }
  return nodes;
}

function agentToolsGenericAcpCard() {
  const section = settingsCard('容器内 ACP（通用）');
  section.dataset.cli = 'container_acp';
  section.classList.add('agent-tools-generic-acp');
  section.append(
    facts([
      ['管理方式', '由部署环境声明（只读说明）'],
      ['配置入口', 'BOT_ACP_PRODUCT / 离线安装脚本'],
    ]),
    note('通用「容器内 ACP」后端不对应固定上游发行包，不参与自动安装，也不在此提供安装、升级或删除操作。如需接入自定义 ACP 产品，请按部署文档预先安装到工具卷并通过环境变量声明。'),
  );
  return section;
}

function agentToolsInstallNodes(state, redraw, refresh) {
  const status = state.status, bounds = Array.isArray(status.retain_bounds) ? status.retain_bounds : [];
  const cli = document.createElement('select'); cli.name = 'cli';
  for (const name of Object.keys(status.clis || {})) { const option = document.createElement('option'); option.value = name; option.textContent = agentToolCliLabel(name); cli.append(option); }
  // A select opens on its first entry, as a browser's does; without this the native hash field would start hidden.
  cli.value = Object.keys(status.clis || {})[0] || '';
  const version = input('version', '', { autocomplete: 'off', placeholder: '精确版本，例如 2.1.319（留空安装默认版本）' });
  const sha256 = input('sha256', '', { autocomplete: 'off', placeholder: '可选：下载包的 sha256' });
  const nativeSha256 = input('native_sha256', '', { autocomplete: 'off', placeholder: '可选：原生二进制的 sha256' });
  const retain = input('retain_count', String(status.retain_count), { type: 'number', min: bounds[0], max: bounds[1], step: 1 });
  // Claude Code's package and its native binary are two downloads: the second hash is asked for only where it applies.
  const nativeField = field('原生二进制 SHA-256（仅 Claude Code）', nativeSha256), nativeSlot = element('div', '', 'agent-tools-native');
  nativeSlot.append(nativeField);
  const pinnedNote = note('');
  const syncFields = () => {
    const info = status.clis?.[cli.value];
    if (cli.value === 'claude_code') { if (!nativeField.parentElement) nativeSlot.append(nativeField); } else nativeField.remove();
    if (info?.kind === 'acp') {
      const supported = (info.supported_versions || []).join('、') || info.default_version || '平台固定版本';
      pinnedNote.textContent = `${agentToolCliLabel(cli.value)} 仅允许平台已验签版本：${supported}；留空即安装默认版本。`;
      pinnedNote.hidden = false;
    } else {
      pinnedNote.textContent = '';
      pinnedNote.hidden = true;
    }
  };
  cli.addEventListener('change', syncFields); syncFields();
  const nodes = [field('Agent', cli), field('精确版本', version), pinnedNote, field('SHA-256（可选）', sha256), nativeSlot,
    field('本次安装后的保留版本数（安装成功即保存为默认值）', retain),
    note('安装成功后，这里填的数会存成新的默认值：之后的安装和清理没填这一项时也用它。'),
    note('安装时会从官方来源下载并校验 sha256（WorkSwarm 在 manager 隔离容器内构建 Python 环境）。正在运行的任务或角色用着的版本（含 Node/uv 运行时）会被拒绝（agent_tool_version_in_use），工具卷不会被改动。'),
    note('不拉取「最新版本」列表：这里只安装你填写的精确 semver 或该 Agent 的平台默认版本。')];
  const form = actionForm(nodes, '安装', async () => {
    const body = { cli: cli.value };
    if (version.value.trim()) body.version = version.value.trim();
    if (sha256.value.trim()) body.sha256 = sha256.value.trim();
    if (cli.value === 'claude_code' && nativeSha256.value.trim()) body.native_sha256 = nativeSha256.value.trim();
    if (retain.value !== '') body.retain_count = Number(retain.value);
    const answer = await api('/api/agent-tools/install', 'POST', body);
    // The answer already carries the new status: redraw from it instead of assuming the typed retain count won (#740 F2).
    state.status = answer.status; state.pruneResult = null; refresh();
    const installedVer = answer.installed?.version || body.version || status.clis?.[body.cli]?.default_version || '';
    // An install that carried retain_count also saved it as the default, so say so instead of leaving the admin to wonder.
    redraw(`已安装 ${agentToolCliLabel(body.cli)} ${installedVer}` + (body.retain_count === undefined ? '' : `，保留版本数默认值改为 ${answer.status.retain_count}`));
  });
  // `querySelectorAll` answers a NodeList, which has no `.find`; a broken deployment (no volume, unknown arch) is
  // exactly the case this branch serves, so a crash here would take the whole console down (#740 review).
  if (!status.volume_present || !status.arch) { const submit = Array.from(form.querySelectorAll('button')).find(node => node.type === 'submit'); if (submit) submit.disabled = true; }
  return [form];
}

function agentToolsPruneNodes(state, redraw, refresh) {
  const status = state.status, bounds = Array.isArray(status.retain_bounds) ? status.retain_bounds : [];
  const cli = document.createElement('select'); cli.name = 'cli';
  const all = document.createElement('option'); all.value = ''; all.textContent = '全部 Agent'; cli.append(all);
  for (const name of Object.keys(status.clis || {})) { const option = document.createElement('option'); option.value = name; option.textContent = agentToolCliLabel(name); cli.append(option); }
  const retain = input('retain_count', String(status.retain_count), { type: 'number', min: bounds[0], max: bounds[1], step: 1 });
  const nodes = [field('Agent', cli), field('保留版本数（保存为默认值）', retain),
    note('只保留最新的这几个版本。正在运行的 task_runs.cli_version、角色会话的 role_conversation_turns.cli_version 以及 ACP 当前选用版本不会被删除；清单读不到的残留平时会被清理，只有正在运行或刚安装的版本仍指向的目录会保留，并在下面单独列出。')];
  const result = state.pruneResult;
  if (result) {
    const lines = [];
    for (const [name, versions] of Object.entries(result.pruned || {})) if (versions && versions.length) lines.push(`已清理 ${agentToolCliLabel(name)} ${versions.join('、')}`);
    if (!lines.length) lines.push('本次没有删除任何版本');
    for (const [name, versions] of Object.entries(result.protected_invalid || {})) if (versions && versions.length) lines.push(`受保护且清单读不到（正在运行或刚安装）${agentToolCliLabel(name)} ${versions.join('、')}`);
    const box = element('p', lines.join('；'), 'view-success'); box.setAttribute('role', 'status');
    nodes.unshift(box);
  }
  const form = actionForm(nodes, '清理', async () => {
    // An emptied number field is not "zero": 0 is outside the allowlist bounds and would be refused. Leaving it out
    // makes the service keep the saved default, which is what the field opens with (#740 review).
    const body = {};
    if (retain.value.trim() !== '') body.retain_count = Number(retain.value);
    if (cli.value) body.cli = cli.value;
    const answer = await api('/api/agent-tools/prune', 'POST', body);
    state.status = answer.status; state.pruneResult = answer; refresh(); redraw('清理完成');
  });
  if (!status.volume_present || !status.arch) { const submit = Array.from(form.querySelectorAll('button')).find(node => node.type === 'submit'); if (submit) submit.disabled = true; }
  return [form];
}

async function agentToolsCards(request) {
  const state = { status: await api('/api/agent-tools'), pruneResult: null, actionFeedback: {} };
  if (request !== renderVersion) return [];
  const volume = liveCard('工具卷', () => agentToolsVolumeNodes(state.status));
  volume.section.classList.add('agent-tools-volume');
  let redrawAll = () => {};
  const clis = Object.keys(state.status.clis || {}).map(cli => {
    const section = liveCard(agentToolCliLabel(cli), () => agentToolsCliNodes(cli, state, () => redrawAll()));
    section.section.dataset.cli = cli; section.section.classList.add('agent-tools-cli');
    return section;
  });
  const genericAcp = agentToolsGenericAcpCard();
  const redrawClis = () => { volume.redraw(); for (const card of clis) card.redraw(); };
  const prune = liveCard('清理旧版本', redraw => agentToolsPruneNodes(state, redraw, redrawClis));
  prune.section.classList.add('agent-tools-prune');
  const install = liveCard('安装版本', redraw => agentToolsInstallNodes(state, redraw, () => { redrawClis(); prune.redraw(); }));
  install.section.classList.add('agent-tools-install');
  redrawAll = () => { redrawClis(); install.redraw(); prune.redraw(); };
  return [volume.section, ...clis.map(card => card.section), genericAcp, install.section, prune.section];
}
settingsCards['agent-tools'] = agentToolsCards;
