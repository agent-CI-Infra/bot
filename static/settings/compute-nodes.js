// Distributed Linux Docker compute nodes management (#1380): super-administrator settings page (#/settings/compute-nodes).
// Displays built-in local node and paired remote node-agent hosts, resource watermarks, hosted containers,
// one-time pairing token issuance, label editing, graceful drain/undrain, and permanent revocation.

const computeNodeStatusLabels = {
  pending: ['待配对', ''],
  pending_pair: ['待配对', ''],
  online: ['在线', 'success'],
  draining: ['排水中', 'warning'],
  offline: ['离线', 'danger'],
  revoked: ['已撤销', 'danger'],
};

const computeNodeTransportLabels = {
  local: '本机直连',
  websocket: 'WebSocket 反向长连',
  long_poll: 'HTTPS 长轮询回退',
  direct: '内网直连',
};

const computeNodeErrorText = err => {
  const code = String(err?.message || '');
  const map = {
    node_id_exists: '该节点 ID 已存在，请更换其他 ID。',
    invalid_node_id: '节点 ID 仅支持小写字母、数字、点、横线和下划线（不超过 64 字符）。',
    invalid_node_name: '请填写有效的节点名称（1–100 字符）。',
    invalid_node_labels: '标签格式无效：请使用 键=值 格式，多个标签用逗号或换行分隔。',
    invalid_pairing_ttl: '令牌有效期超出范围（1 分钟至 7 天）。',
    cannot_revoke_local_node: '内置本机节点（local）不可撤销。',
    node_has_bound_projects: '该节点仍绑定有项目，请先将项目改绑到其他节点，或确认强制下线。',
    node_revoked: '该节点已撤销，无法再操作。',
    node_draining: '目标节点正在排水中，暂不接收新绑定或新任务。',
    target_node_not_online: '目标节点当前不在线，请先确保节点在线再切换绑定。',
    host_driver_not_implemented: '宿主机直跑驱动（host）尚未实现，目前仅支持 Linux Docker（docker）。',
  };
  return map[code] || readErrorText(err);
};

function parseComputeNodeLabelsInput(raw) {
  const out = {};
  const text = String(raw || '').trim();
  if (!text) return out;
  for (const part of text.split(/[\n,]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0 || eq === trimmed.length - 1) throw new Error('invalid_node_labels');
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed.slice(eq + 1).trim();
    if (!k || !v) throw new Error('invalid_node_labels');
    out[k] = v;
  }
  return out;
}

function formatComputeNodeLabels(labels) {
  if (!labels || typeof labels !== 'object') return '';
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
}

function formatNodeBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toLocaleString('zh-CN', { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
}

function formatNodeMetricsSummary(metrics) {
  if (!metrics || typeof metrics !== 'object' || !Object.keys(metrics).length) {
    return '等待节点上报心跳水位';
  }
  const parts = [];
  const cpus = Number.isFinite(metrics.cpu_count) ? metrics.cpu_count : metrics.cpus;
  const load1m = Number.isFinite(metrics.cpu_load_1m) ? metrics.cpu_load_1m : metrics.loadavg_1m;
  if (Number.isFinite(cpus)) {
    const load = Number.isFinite(load1m) ? `（1m 负载 ${load1m}）` : '';
    parts.push(`CPU ${cpus} 核${load}`);
  }
  if (Number.isFinite(metrics.memory_total_mb) && metrics.memory_total_mb > 0) {
    const usedMb = Number.isFinite(metrics.memory_used_mb)
      ? metrics.memory_used_mb
      : Number.isFinite(metrics.memory_free_mb)
        ? Math.max(0, metrics.memory_total_mb - metrics.memory_free_mb)
        : null;
    const usedPct = Number.isFinite(metrics.memory_used_pct)
      ? metrics.memory_used_pct
      : usedMb != null
        ? Math.round((usedMb / metrics.memory_total_mb) * 100)
        : null;
    const used = usedPct != null ? `${usedPct}%` : '—';
    const free = Number.isFinite(metrics.memory_free_mb) ? `剩余 ${metrics.memory_free_mb} MB` : '';
    parts.push(`内存 ${used}（总 ${metrics.memory_total_mb} MB${free ? '，' + free : ''}）`);
  }
  if (Number.isFinite(metrics.disk_free_bytes) && Number.isFinite(metrics.disk_total_bytes) && metrics.disk_total_bytes > 0) {
    const diskPct = Number.isFinite(metrics.disk_used_pct)
      ? metrics.disk_used_pct
      : Math.round(((metrics.disk_total_bytes - metrics.disk_free_bytes) / metrics.disk_total_bytes) * 100);
    const pct = Number.isFinite(diskPct) ? `已用 ${diskPct}%，` : '';
    parts.push(`磁盘 ${pct}剩余 ${formatNodeBytes(metrics.disk_free_bytes)} / ${formatNodeBytes(metrics.disk_total_bytes)}`);
  }
  return parts.length ? parts.join(' · ') : '等待节点上报心跳水位';
}

function renderPairingTokenBox(target, issued) {
  if (!issued || !issued.pairing_token) {
    target.replaceChildren();
    target.hidden = true;
    return;
  }
  target.hidden = false;
  const heading = element('h3', `一次性接入令牌已签发：${issued.node?.name || issued.node?.id || ''}`);
  const warn = note('该令牌仅展示一次，节点首次配对成功后会自动换发 Ed25519 公钥身份并失效。请勿提交到仓库或公开日志。');
  const tokenLine = element('pre', issued.pairing_token, 'code compute-node-command');
  const commandText = issued.join_command || '';
  const cmdPre = element('pre', commandText, 'code compute-node-command');
  const copyStatus = note('');
  copyStatus.setAttribute('role', 'status');
  const actions = element('div', '', 'actions');
  if (commandText) {
    actions.append(button('复制接入命令', async () => {
      try {
        await navigator.clipboard.writeText(commandText);
        announceSave(copyStatus, '已复制接入命令到剪贴板。', false);
      } catch {
        announceSave(copyStatus, '浏览器未授予剪贴板权限，请手动全选下方命令复制。', true);
      }
    }, 'quiet'));
  }
  actions.append(button('收起令牌提示', () => {
    target.replaceChildren();
    target.hidden = true;
  }, 'quiet'));
  target.replaceChildren(
    heading,
    warn,
    facts([
      ['节点 ID', issued.node?.id || '—'],
      ['令牌有效期至', issued.pairing_expires_at ? timeText(issued.pairing_expires_at) : '—'],
    ]),
    element('p', '一次性配对令牌（BOT_NODE_PAIRING_TOKEN）：', 'muted'),
    tokenLine,
    ...(commandText ? [element('p', '在目标 Linux Docker 主机运行：', 'muted'), cmdPre] : []),
    actions,
    copyStatus,
  );
}

async function computeNodesSettingsPage(request) {
  let state = await api('/api/nodes');
  let issuedBannerData = null;

  const overviewCard = settingsCard('计算节点总览', 'h2');
  overviewCard.dataset.testid = 'compute-nodes-overview';
  const overviewHost = element('div', '');
  const overviewStatus = element('p', '', 'view-error');
  overviewStatus.setAttribute('role', 'status');
  overviewCard.append(overviewHost, overviewStatus);

  const createCard = settingsCard('接入远端 Linux Docker 节点', 'h2');
  createCard.dataset.testid = 'compute-nodes-create';
  const createForm = element('form', '', 'project-form');
  createForm.noValidate = true;
  const nameInput = input('name', '', { placeholder: '例如：linux-worker-01', required: true });
  const idInput = input('id', '', { placeholder: '留空自动生成，如 worker-01' });
  const labelsInput = input('labels', '', { placeholder: '例如：region=cn-east,gpu=true' });
  const ttlInput = input('ttl_minutes', '60', { type: 'number', min: 1, max: 10080, step: 1 });
  const createGrid = element('div', '', 'field-grid');
  createGrid.append(
    field('节点名称', nameInput),
    field('节点 ID（可选）', idInput),
    field('调度标签（可选，键=值 逗号分隔）', labelsInput),
    field('配对令牌有效期（分钟）', ttlInput),
  );
  const createStatus = element('p', '', 'view-error');
  createStatus.setAttribute('role', 'status');
  const createSubmit = element('button', '签发节点接入令牌');
  createSubmit.type = 'submit';
  const createActions = element('div', '', 'actions form-actions');
  createActions.append(createSubmit);
  const pairingBox = element('div', '', 'compute-node-pairing-box');
  pairingBox.dataset.testid = 'compute-node-pairing-result';
  pairingBox.hidden = true;
  createForm.append(
    note('支持接入运行本地 Docker 守护进程的 Linux 主机。节点通过 node-agent 主动反向连接控制面（优先 WebSocket，自动回退 ≤25 秒 HTTPS 长轮询），不暴露 Docker TCP 端口。arch 与 gpu 仅作为调度标签，不包含容器 GPU 设备直通。'),
    createGrid,
    createStatus,
    createActions,
  );
  createCard.append(createForm, pairingBox);

  const listCard = settingsCard('已注册计算节点', 'h2');
  listCard.dataset.testid = 'compute-nodes-list';
  const listHost = element('div', '', 'compute-node-list');
  const listStatus = element('p', '', 'view-error');
  listStatus.setAttribute('role', 'status');
  listCard.append(listStatus, listHost);

  const refreshAll = async () => {
    const fresh = await api('/api/nodes');
    if (request !== renderVersion) return;
    state = fresh;
    renderAll();
  };

  const renderAll = () => {
    const nodes = Array.isArray(state?.nodes) ? state.nodes : [];
    const onlineCount = nodes.filter(n => n.status === 'online').length;
    const drainingCount = nodes.filter(n => n.status === 'draining').length;
    const offlineCount = nodes.filter(n => n.status === 'offline' || n.status === 'pending' || n.status === 'pending_pair').length;

    const refreshBtn = button('刷新节点状态', async () => {
      refreshBtn.disabled = true;
      announceSave(overviewStatus, '', false);
      try {
        await refreshAll();
      } catch (err) {
        overviewStatus.className = 'view-error';
        announceSave(overviewStatus, '刷新节点状态失败：' + computeNodeErrorText(err), true);
      } finally {
        refreshBtn.disabled = false;
      }
    }, 'quiet');
    const overviewActions = element('div', '', 'actions');
    overviewActions.append(refreshBtn);

    overviewHost.replaceChildren(
      note('单机部署默认内置 local 节点，开箱即用；接入多个 Linux Docker 节点后，可在各项目「机器配置」页切换项目绑定的计算节点，助手电脑将由控制面按租约自动调度且保证单写者。'),
      facts([
        ['已注册节点', `${nodes.length} 台`],
        ['在线 / 排水中 / 离线或待配对', `${onlineCount} / ${drainingCount} / ${offlineCount}`],
        ['控制面节点协议版本', `v${state?.protocol_version ?? 1}`],
      ]),
      overviewActions,
    );

    renderPairingTokenBox(pairingBox, issuedBannerData);

    listHost.replaceChildren();
    if (!nodes.length) {
      listHost.append(note('暂无已注册的计算节点。'));
      return;
    }

    for (const node of nodes) {
      const item = element('article', '', 'compute-node-item');
      item.dataset.nodeId = node.id;
      const head = element('div', '', 'compute-node-head');
      const titleWrap = element('div', '', 'compute-node-title');
      const [statusLabel, statusTone] = computeNodeStatusLabels[node.status] || [String(node.status || '未知'), ''];
      titleWrap.append(
        element('h3', node.name),
        element('code', node.id, 'compute-node-id'),
        badge(statusLabel, statusTone),
        badge(node.kind === 'local' ? '内置本机' : '远端节点', node.kind === 'local' ? 'info' : ''),
        ...(node.drained ? [badge('已排空', 'warning')] : []),
      );
      head.append(titleWrap);

      const boundProjects = Array.isArray(node.bound_projects) ? node.bound_projects : [];
      const placements = Array.isArray(node.assistant_placements) ? node.assistant_placements : [];
      const projectsSummary = boundProjects.length
        ? boundProjects.map(p => `${p.full_name}（${p.state}）`).join('、')
        : '无绑定项目';
      const labelsDisplay = formatComputeNodeLabels(node.labels) || '无';

      const detailFacts = facts([
        ['驱动与架构', `${node.driver || 'docker'} · ${node.os || 'linux'}/${node.arch || 'amd64'}`],
        ['连接与协议', `${computeNodeTransportLabels[node.transport] || node.transport} · 协议 ${node.protocol_version ? 'v' + node.protocol_version : '未握手'}${node.agent_version ? ' · ' + node.agent_version : ''}`],
        ['调度标签', labelsDisplay],
        ['资源水位', formatNodeMetricsSummary(node.metrics)],
        ['托管负载', `项目电脑 ${boundProjects.length} 台（运行任务 ${node.active_tasks ?? 0} 个） · 助手电脑 ${placements.length} 台（忙碌 ${node.busy_assistants ?? 0} 个）`],
        ['绑定项目', projectsSummary],
        ['最近心跳', node.last_heartbeat_at ? timeText(node.last_heartbeat_at) : '尚未连接'],
      ]);

      const itemStatus = element('p', '', 'view-error');
      itemStatus.setAttribute('role', 'status');

      // Inline label & name editor (compact <details>)
      const editDetails = element('details', '', 'fold compute-node-edit');
      editDetails.append(element('summary', '编辑节点名称与调度标签'));
      const editForm = element('form', '', 'project-form');
      const editName = input('name', node.name, { required: true });
      const editLabels = input('labels', formatComputeNodeLabels(node.labels), { placeholder: '键=值，逗号分隔' });
      const editGrid = element('div', '', 'field-grid');
      editGrid.append(field('节点名称', editName), field('调度标签', editLabels));
      const editSave = element('button', '保存节点属性');
      editSave.type = 'submit';
      editForm.append(editGrid, editSave);
      editForm.addEventListener('submit', async event => {
        event.preventDefault();
        itemStatus.className = 'view-error';
        announceSave(itemStatus, '', false);
        editSave.disabled = true;
        try {
          const parsedLabels = parseComputeNodeLabelsInput(editLabels.value);
          await api(`/api/nodes/${encodeURIComponent(node.id)}`, 'PATCH', {
            name: editName.value.trim(),
            labels: parsedLabels,
          });
          await refreshAll();
        } catch (err) {
          itemStatus.className = 'view-error';
          announceSave(itemStatus, computeNodeErrorText(err), true);
        } finally {
          editSave.disabled = false;
        }
      });
      editDetails.append(editForm);

      const actions = element('div', '', 'actions compute-node-actions');
      if (node.status !== 'draining' && node.status !== 'revoked') {
        actions.append(button('开始排水', async () => {
          const ok = await askConfirm({
            title: `开始排水节点「${node.name}」？`,
            body: [
              '排水后该节点将立即停止接收新任务认领与新助手电脑分配。',
              '当前正在运行的任务不会被强行中断，待在跑任务结束或达到排水超时后，节点会自动停止容器。',
            ],
            action: '开始排水',
          });
          if (!ok) return;
          itemStatus.className = 'view-error';
          announceSave(itemStatus, '', false);
          try {
            await api(`/api/nodes/${encodeURIComponent(node.id)}/drain`, 'POST', {});
            await refreshAll();
          } catch (err) {
            itemStatus.className = 'view-error';
            announceSave(itemStatus, computeNodeErrorText(err), true);
          }
        }, 'quiet'));
      } else if (node.status === 'draining') {
        actions.append(button('恢复上线', async () => {
          itemStatus.className = 'view-error';
          announceSave(itemStatus, '', false);
          try {
            await api(`/api/nodes/${encodeURIComponent(node.id)}/undrain`, 'POST', {});
            await refreshAll();
          } catch (err) {
            itemStatus.className = 'view-error';
            announceSave(itemStatus, computeNodeErrorText(err), true);
          }
        }, 'quiet'));
      }

      if (node.kind === 'remote' && node.status !== 'revoked') {
        actions.append(button('重签接入令牌', async () => {
          const ok = await askConfirm({
            title: `为节点「${node.name}」重签接入令牌？`,
            body: ['将签发新的一次性配对令牌（有效期 60 分钟），可用于该主机重新配对接入。'],
            action: '重签令牌',
          });
          if (!ok) return;
          itemStatus.className = 'view-error';
          announceSave(itemStatus, '', false);
          try {
            const reissued = await api(`/api/nodes/${encodeURIComponent(node.id)}/token`, 'POST', { ttl_minutes: 60 });
            issuedBannerData = reissued;
            await refreshAll();
          } catch (err) {
            itemStatus.className = 'view-error';
            announceSave(itemStatus, computeNodeErrorText(err), true);
          }
        }, 'quiet'));

        actions.append(button('下线撤销', async () => {
          const boundCount = boundProjects.length;
          const ok = await askConfirm({
            title: `永久撤销节点「${node.name}」？`,
            body: [
              '撤销后会立即断开节点连接、作废其会话与文件同步令牌，并尝试停止清理该节点上的容器。此操作不可逆。',
              ...(boundCount > 0 ? [`注意：当前仍有 ${boundCount} 个项目绑定在该节点上；建议先在各项目「机器配置」中改绑后再撤销，或继续执行强制撤销。`] : []),
            ],
            action: boundCount > 0 ? '强制撤销节点' : '撤销节点',
            tone: 'danger',
          });
          if (!ok) return;
          itemStatus.className = 'view-error';
          announceSave(itemStatus, '', false);
          try {
            await api(`/api/nodes/${encodeURIComponent(node.id)}/revoke`, 'POST', { confirm: true, force: boundCount > 0 });
            if (issuedBannerData?.node?.id === node.id) issuedBannerData = null;
            await refreshAll();
          } catch (err) {
            itemStatus.className = 'view-error';
            announceSave(itemStatus, computeNodeErrorText(err), true);
          }
        }, 'quiet destructive'));
      }

      item.append(head, detailFacts, editDetails, actions, itemStatus);
      listHost.append(item);
    }
  };

  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    createStatus.className = 'view-error';
    announceSave(createStatus, '', false);
    const name = nameInput.value.trim();
    if (!name) {
      announceSave(createStatus, '请填写节点名称。', true);
      nameInput.focus();
      return;
    }
    let parsedLabels;
    try {
      parsedLabels = parseComputeNodeLabelsInput(labelsInput.value);
    } catch (err) {
      announceSave(createStatus, computeNodeErrorText(err), true);
      labelsInput.focus();
      return;
    }
    const ttlMinutes = Number(ttlInput.value || 60);
    if (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 10080) {
      announceSave(createStatus, '令牌有效期需为 1–10080 之间的整数（分钟）。', true);
      ttlInput.focus();
      return;
    }
    createSubmit.disabled = true;
    try {
      const payload = {
        name,
        labels: parsedLabels,
        ttl_minutes: ttlMinutes,
        ...(idInput.value.trim() ? { id: idInput.value.trim() } : {}),
      };
      const created = await api('/api/nodes', 'POST', payload);
      issuedBannerData = created;
      nameInput.value = '';
      idInput.value = '';
      labelsInput.value = '';
      createStatus.className = 'view-success';
      announceSave(createStatus, `已创建节点「${created.node?.name}」并签发一次性接入令牌。`, false);
      await refreshAll();
    } catch (err) {
      createStatus.className = 'view-error';
      announceSave(createStatus, computeNodeErrorText(err), true);
    } finally {
      createSubmit.disabled = false;
    }
  });

  renderAll();
  return [overviewCard, createCard, listCard];
}
