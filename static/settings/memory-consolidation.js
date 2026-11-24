// Global Settings -> Nightly Memory Consolidation (#/settings/memory-consolidation)
async function memoryConsolidationSettingsPage(request) {
  const view = await api('/api/memory/consolidation/settings');
  if (request !== renderVersion) return [];

  const settingsSection = settingsCard('夜间自动记忆整理', 'h2');
  settingsSection.classList.add('mc-card');
  settingsSection.append(note('纯内部后台引擎，固定使用 Pi 后端，默认全平台开启：按夜间时间窗口自动整理所有已启用项目的 ../notes/、已绑定飞书群聊助手的 ~/memory/ 与有权限个人管理助手的 ~/memory/。不进入用户定时任务，也不发送飞书消息或 GitHub 评论。'));

  const s = view.settings;
  const form = element('form', '', 'project-form');

  const enabledInput = document.createElement('input');
  enabledInput.type = 'checkbox';
  enabledInput.name = 'enabled';
  enabledInput.checked = Boolean(s.enabled);
  const enabledLabel = element('label', '', 'check');
  enabledLabel.append(enabledInput, ' 启用全平台夜间自动记忆整理（未单独覆盖的项目、群聊助手与个人管理助手将继承此开关）');

  const grid = element('div', '', 'mc-form-grid');
  const startInput = input('window_start', s.window_start || '02:00', {
    placeholder: '02:00',
    maxLength: 5,
    required: true,
    pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$',
  });
  const endInput = input('window_end', s.window_end || '05:00', {
    placeholder: '05:00',
    maxLength: 5,
    required: true,
    pattern: '^([01]\\d|2[0-3]):([0-5]\\d)$',
  });
  const tzInput = input('timezone', s.timezone || 'Asia/Shanghai', {
    placeholder: 'Asia/Shanghai',
    maxLength: 100,
    required: true,
  });
  const tzListId = 'mc-tz-list';
  tzInput.setAttribute('list', tzListId);
  const tzList = document.createElement('datalist');
  tzList.id = tzListId;
  for (const tz of ['Asia/Shanghai', 'UTC', 'Asia/Tokyo', 'Asia/Singapore', 'Europe/London', 'America/New_York', 'America/Los_Angeles']) {
    const opt = document.createElement('option');
    opt.value = tz;
    tzList.append(opt);
  }
  const [minConc, maxConc] = view.bounds?.max_concurrency || [1, 8];
  const concInput = input('max_concurrency', s.max_concurrency ?? 2, {
    type: 'number',
    min: minConc,
    max: maxConc,
    step: 1,
    required: true,
  });

  const modelSelect = document.createElement('select');
  modelSelect.name = 'model_id';
  modelSelect.add(new Option('不单独指定（沿用各项目/群聊/管理助手自有模型）', ''));
  for (const m of view.models || []) {
    modelSelect.add(new Option(consolidationModelLabel(m), m.id));
  }
  if (s.model_id && !(view.models || []).some(m => m.id === s.model_id)) {
    modelSelect.add(new Option(`${s.model_id}（当前不可用）`, s.model_id));
  }
  modelSelect.value = s.model_id || '';

  grid.append(
    field('夜间窗口开始（HH:MM）', startInput),
    field('夜间窗口结束（HH:MM，支持跨零点）', endInput),
    field('时区（IANA 时区）', tzInput),
    field(`最大并发整理数（${minConc}–${maxConc}）`, concInput),
    field('全局默认整理模型（可选，仅共享模型）', modelSelect),
  );

  const status = note('');
  status.setAttribute('role', 'status');
  const save = element('button', '保存全局设置');
  save.type = 'submit';
  form.append(enabledLabel, grid, tzList, status, save);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api('/api/memory/consolidation/settings', 'PUT', {
        enabled: enabledInput.checked,
        window_start: startInput.value.trim(),
        window_end: endInput.value.trim(),
        timezone: tzInput.value.trim(),
        max_concurrency: Number(concInput.value),
        model_id: modelSelect.value || null,
      });
      if (request === renderVersion) announceSave(status, '夜间记忆整理全局设置已保存。', false);
    } catch (err) {
      if (request === renderVersion) announceSave(status, consolidationErrorText(err), true);
    } finally {
      save.disabled = false;
    }
  });
  settingsSection.append(form);

  const runsSection = settingsCard('全平台最近整理记录', 'h2');
  runsSection.classList.add('mc-card');
  const runsBody = element('div', '', 'mc-runs');
  const renderRuns = runs => {
    runsBody.replaceChildren();
    if (!runs.length) {
      runsBody.append(note('尚无夜间或手动记忆整理记录。'));
      return;
    }
    for (const run of runs) {
      runsBody.append(consolidationRunItem(run, { showScope: true }));
    }
  };
  renderRuns(view.recent_runs || []);
  const refreshBtn = button('刷新记录', async () => {
    refreshBtn.disabled = true;
    try {
      const fresh = await api('/api/memory/consolidation/runs?limit=30');
      if (runsSection.isConnected && request === renderVersion) renderRuns(fresh.runs || []);
    } finally {
      refreshBtn.disabled = false;
    }
  }, 'quiet');
  const runsActions = element('div', '', 'actions');
  runsActions.append(refreshBtn);
  runsSection.append(runsActions, runsBody);

  return [settingsSection, runsSection];
}
