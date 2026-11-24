// Shared console components for Nightly Memory Consolidation (project, group assistant, personal assistant)
// and lightweight ~/memory/ file management for group & personal assistants.

function formatConsolidationActor(value) {
  if (!value) return null;
  if (String(value).startsWith('system:memory-consolidation')) return '夜间记忆整理';
  return null;
}

const consolidationErrorLabels = {
  model_unavailable: '所选模型不可用、未配置 Key 或未授权给当前范围（不会自动切换其他模型）。',
  consolidation_already_running: '当前范围已有一轮记忆整理正在运行。',
  consolidation_cancelled: '本轮记忆整理已被手动停止或因状态变更取消。',
  consolidation_interrupted: '上次运行因服务重启被中断。',
  channel_service_binding_disabled: '群聊助手已停用，无法执行整理。',
  channel_service_scope_paused: '群聊助手范围内暂无可访问的已启用仓库。',
  assistant_computers_unavailable: '未挂载助手 HOME 卷或无法连接 manager，无法访问 ~/memory/。',
  assistant_home_read_only: '助手 HOME 已超出容量上限，当前仅允许查看或删除文件。',
  memory_path_forbidden: '路径必须位于 ~/memory/ 目录内，且不能指向目录本身或越界路径。',
  memory_sensitive_path: '不允许将敏感凭据或密钥文件名写入 ~/memory/。',
  invalid_memory_path: '记忆文件路径格式无效。',
  invalid_memory_content: '记忆文件内容无效或超过 256 KiB 上限。',
  invalid_consolidation_window: '夜间整理时间窗口格式无效（须为 HH:MM，且开始与结束时间不能相同）。',
  invalid_consolidation_timezone: '时区无效，请输入有效的 IANA 时区名称（例如 Asia/Shanghai）。',
  invalid_consolidation_concurrency: '并发上限超出允许范围。',
  shared_model_required: '此处只能选择部署共享模型。',
};

function consolidationErrorText(codeOrErr, detail = '') {
  const code = typeof codeOrErr === 'string' ? codeOrErr : codeOrErr?.code || '';
  if (code && Object.hasOwn(consolidationErrorLabels, code)) {
    return consolidationErrorLabels[code];
  }
  if (typeof codeOrErr === 'string') return detail || codeOrErr;
  return readErrorText(codeOrErr);
}

function memoryFileSize(value) {
  if (value == null || !Number.isFinite(Number(value))) return '大小未知';
  const n = Number(value);
  return n < 1024 ? `${n} B` : bytes(n);
}

function consolidationStatusBadge(status) {
  const map = {
    running: ['整理中…', 'mc-badge mc-badge-info'],
    completed: ['已完成', 'mc-badge mc-badge-success'],
    failed: ['失败', 'mc-badge mc-badge-danger'],
    cancelled: ['已停止', 'mc-badge mc-badge-neutral'],
    skipped: ['已跳过', 'mc-badge mc-badge-warning'],
  };
  const [label, cls] = map[status] || [status || '未知', 'mc-badge mc-badge-neutral'];
  return element('span', label, cls);
}

function consolidationScopeKindLabel(kind) {
  return ({
    project: '项目知识',
    group_assistant: '群聊助手',
    personal_assistant: '个人管理助手',
  })[kind] || kind;
}

function consolidationDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return '';
  const ms = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const mins = Math.floor(seconds / 60), rem = seconds % 60;
  return rem ? `${mins} 分 ${rem} 秒` : `${mins} 分`;
}

function consolidationModelLabel(m) {
  if (!m) return '';
  const base = m.provider_name ? `${m.provider_name} / ${m.model_name}` : m.model_name;
  const scope = m.project_id ? '（项目专属）' : '（共享）';
  const key = m.key_configured === false ? '（未配置 Key）' : '';
  return base + scope + key;
}

function consolidationEffectiveModelText(effective) {
  if (!effective) return '未解析';
  if (effective.id && effective.model_name) {
    const source = ({
      scope: '当前范围指定',
      global: '全局整理模型',
      inherited: '沿用主体模型',
    })[effective.source] || '';
    return source ? `${effective.model_name}（${source}）` : effective.model_name;
  }
  return '不可用：' + consolidationErrorText(effective.unavailable || 'model_unavailable', effective.detail || '');
}

function consolidationRunItem(run, { showScope = false, onOpenProjectFile = null } = {}) {
  const item = element('article', '', 'mc-run-item');
  const meta = element('div', '', 'mc-run-meta');
  meta.append(consolidationStatusBadge(run.status));
  meta.append(element('span', run.trigger === 'manual' ? '手动整理' : `夜间自动 · ${run.logical_day}`));
  if (showScope) {
    meta.append(element('span', `${consolidationScopeKindLabel(run.scope_kind)} · ${run.scope_label || run.scope_id}`, 'mc-run-scope'));
  }
  if (run.model_name) meta.append(element('span', `模型：${run.model_name}`));
  if (run.started_at) meta.append(element('span', timeText(run.started_at)));
  const dur = consolidationDuration(run.started_at, run.finished_at);
  if (dur) meta.append(element('span', `用时 ${dur}`));
  item.append(meta);

  if (run.summary) {
    item.append(element('p', run.summary, 'mc-run-summary'));
  }
  if (run.error_code) {
    const msg = consolidationErrorText(run.error_code, run.error_detail || '');
    item.append(element('p', run.error_detail && !msg.includes(run.error_detail) ? `${msg}（${run.error_detail}）` : msg, 'view-error'));
  }

  const changed = Array.isArray(run.changed_files) ? run.changed_files : [];
  const deleted = Array.isArray(run.deleted_files) ? run.deleted_files : [];
  if (changed.length || deleted.length) {
    const pills = element('div', '', 'mc-file-pills');
    const actionLabel = { created: '新建', updated: '更新', moved: '移动', deleted: '删除' };
    for (const file of [...changed, ...deleted]) {
      const isDeleted = file.action === 'deleted';
      const label = `${actionLabel[file.action] || '变更'}：${file.path}${file.revision ? ` (v${file.revision})` : ''}`;
      if (onOpenProjectFile && (file.id || file.path)) {
        const btn = button(label, () => onOpenProjectFile(file), 'quiet mc-file-pill' + (isDeleted ? ' mc-file-pill-deleted' : ''));
        btn.title = isDeleted ? '打开已删除文件的历史版本（支持一键恢复）' : '打开该文件的版本历史';
        pills.append(btn);
      } else {
        pills.append(element('span', label, 'mc-file-pill' + (isDeleted ? ' mc-file-pill-deleted' : '')));
      }
    }
    item.append(pills);
  }
  return item;
}

function renderConsolidationSection({
  apiBase,
  title = '夜间自动记忆整理',
  headingLevel = 'h2',
  description = '',
  onOpenProjectFile = null,
  onRunCompleted = null,
  compact = false,
}) {
  const root = compact ? element('div', '', 'mc-card') : card(title, headingLevel);
  if (!compact) root.classList.add('mc-card');
  const body = element('div', '', 'mc-card');
  root.append(body);

  let data = null;
  let pollTimer = null;
  let wasRunning = false;
  let feedbackText = '';
  let feedbackIsError = false;

  const setFeedback = (text, isError = false) => {
    feedbackText = text;
    feedbackIsError = isError;
  };

  const stopPolling = () => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  };

  const schedulePoll = () => {
    stopPolling();
    if (!root.isConnected || !data?.running_run) return;
    pollTimer = setTimeout(() => { void load({ quiet: true }); }, 2500);
  };

  const draw = () => {
    if (!root.isConnected) { stopPolling(); return; }
    body.replaceChildren();
    if (!data) {
      body.append(note('正在读取记忆整理状态…'));
      return;
    }

    if (description) body.append(note(description));

    if (data.eligible === false) {
      body.append(note('当前账号暂未获得个人管理助手使用权限；具备项目写权限或管理员权限后将自动启用夜间整理。'));
      return;
    }

    const head = element('div', '', 'mc-head');
    const headTitle = element('div', '', 'mc-head-title');
    if (compact && title) headTitle.append(element(headingLevel, title));
    const override = data.state?.enabled_override;
    const stateText = data.running_run
      ? ['整理中…', 'mc-badge mc-badge-info']
      : data.effective_enabled
        ? [override === null ? '已开启（继承全局）' : '已开启（单独启用）', 'mc-badge mc-badge-success']
        : [override === null ? '已关闭（全局关闭）' : '已关闭（单独关闭）', 'mc-badge mc-badge-neutral'];
    headTitle.append(element('span', stateText[0], stateText[1]));

    const actions = element('div', '', 'actions');
    const feedback = feedbackText ? note('') : null;
    if (feedback) {
      feedback.setAttribute('role', 'status');
      announceSave(feedback, feedbackText, feedbackIsError);
    }

    if (data.can_manage) {
      if (data.running_run) {
        const stopBtn = button('停止整理', async () => {
          stopBtn.disabled = true;
          try {
            data = await api(apiBase + '/stop', 'POST', {});
            wasRunning = Boolean(data.running_run);
            setFeedback('已发送停止请求。', false);
            draw();
          } catch (err) {
            stopBtn.disabled = false;
            setFeedback(consolidationErrorText(err), true);
            draw();
          }
        }, 'btn-danger');
        actions.append(stopBtn);
      } else {
        const runBtn = button('立即整理', async () => {
          runBtn.disabled = true;
          try {
            const res = await api(apiBase + '/run', 'POST', {});
            data = res;
            wasRunning = Boolean(data.running_run);
            if (res.run?.status === 'skipped') {
              setFeedback(consolidationErrorText(res.run.error_code || 'model_unavailable', res.run.error_detail || ''), true);
            } else {
              setFeedback('已开始记忆整理（Pi 后端），完成后会自动刷新结果。', false);
            }
            draw();
            if (data.running_run) schedulePoll();
          } catch (err) {
            runBtn.disabled = false;
            setFeedback(consolidationErrorText(err), true);
            draw();
          }
        }, '');
        if (data.binding_enabled === false || data.available === false) runBtn.disabled = true;
        actions.append(runBtn);
      }
    }
    actions.append(button('刷新记录', () => void load(), 'quiet'));
    head.append(headTitle, actions);
    body.append(head);

    if (data.binding_enabled === false) {
      body.append(note('该群聊助手当前已停用；启用后将按夜间窗口自动整理。'));
    }

    const g = data.global_settings || {};
    body.append(facts([
      ['夜间窗口', `${g.window_start || '02:00'}–${g.window_end || '05:00'}（${g.timezone || 'Asia/Shanghai'}） · 固定 Pi 后端`],
      ['生效模型', consolidationEffectiveModelText(data.effective_model)],
      ['最近完成', data.state?.last_completed_at ? timeText(data.state.last_completed_at) : '尚未完成过整理'],
    ]));

    if (data.can_manage) {
      const form = element('form', '', 'project-form');
      const grid = element('div', '', 'mc-form-grid');

      const enabledSelect = document.createElement('select');
      enabledSelect.name = 'enabled_override';
      enabledSelect.add(new Option(`跟随全局（当前：${g.enabled ? '开启' : '关闭'}）`, 'inherit'));
      enabledSelect.add(new Option('开启（覆盖全局）', 'on'));
      enabledSelect.add(new Option('关闭（覆盖全局）', 'off'));
      enabledSelect.value = override === null ? 'inherit' : override ? 'on' : 'off';

      const modelSelect = document.createElement('select');
      modelSelect.name = 'model_id';
      modelSelect.add(new Option('不单独指定（沿用全局默认或主体模型）', ''));
      const available = Array.isArray(data.available_models) ? data.available_models : [];
      for (const m of available) {
        modelSelect.add(new Option(consolidationModelLabel(m), m.id));
      }
      if (data.state?.model_id && !available.some(m => m.id === data.state.model_id)) {
        modelSelect.add(new Option(`${data.state.model_id}（当前不可用）`, data.state.model_id));
      }
      modelSelect.value = data.state?.model_id || '';

      grid.append(
        field('本范围开关', enabledSelect),
        field('专用整理模型（可选）', modelSelect),
      );
      const saveBtn = element('button', '保存整理设置', 'btn-secondary');
      saveBtn.type = 'submit';
      form.append(grid);
      if (feedback) form.append(feedback);
      form.append(saveBtn);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        saveBtn.disabled = true;
        try {
          const nextOverride = enabledSelect.value === 'inherit' ? null : enabledSelect.value === 'on';
          const nextModel = modelSelect.value || null;
          data = await api(apiBase, 'PUT', { enabled_override: nextOverride, model_id: nextModel });
          setFeedback('记忆整理设置已保存。', false);
          draw();
        } catch (err) {
          setFeedback(consolidationErrorText(err), true);
          draw();
        } finally {
          saveBtn.disabled = false;
        }
      });
      body.append(form);
    } else if (feedback) {
      body.append(feedback);
    }

    const runsWrap = element('div', '', 'mc-runs');
    runsWrap.append(element('h3', '最近整理记录', 'mc-runs-heading'));
    const runs = Array.isArray(data.runs) ? data.runs : [];
    if (!runs.length) {
      runsWrap.append(note('尚无夜间或手动记忆整理记录。'));
    } else {
      for (const run of runs) {
        runsWrap.append(consolidationRunItem(run, { onOpenProjectFile }));
      }
    }
    body.append(runsWrap);

    if (data.running_run) schedulePoll();
    else stopPolling();
  };

  async function load({ quiet = false } = {}) {
    if (!quiet) setFeedback('');
    if (!quiet && !data) draw();
    try {
      const next = await api(apiBase);
      if (!root.isConnected) return;
      const finishedNow = wasRunning && !next.running_run;
      wasRunning = Boolean(next.running_run);
      if (finishedNow) setFeedback('记忆整理已完成。', false);
      data = next;
      draw();
      if (finishedNow) onRunCompleted?.(next);
    } catch (err) {
      if (!root.isConnected) return;
      body.replaceChildren(consoleState('无法读取记忆整理状态', consolidationErrorText(err), { tone: 'error', retry: () => void load() }));
    }
  }

  root._reloadConsolidation = () => void load();
  void load();
  return root;
}

function renderKnowledgeConsolidationBar({ repoId, onOpenProjectFile, onRefreshFiles }) {
  const apiBase = `/api/repositories/${repoId}/memory-consolidation`;
  const wrap = element('div', '', 'mc-knowledge-wrap');
  const bar = element('div', '', 'mc-knowledge-bar');
  const drawer = element('div', '', 'mc-knowledge-drawer');
  drawer.hidden = true;
  wrap.append(bar, drawer);

  let summaryData = null;
  let drawerSection = null;
  let pollTimer = null;
  let wasRunning = false;

  const stopPoll = () => { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } };

  const renderBar = () => {
    if (!wrap.isConnected) { stopPoll(); return; }
    bar.replaceChildren();
    const info = element('div', '', 'mc-knowledge-bar-info');
    info.append(element('span', '夜间自动记忆整理', 'mc-knowledge-bar-title'));
    if (!summaryData) {
      info.append(element('span', '读取状态中…', 'mc-knowledge-bar-meta'));
    } else {
      const running = Boolean(summaryData.running_run);
      const badge = running
        ? ['整理中…', 'mc-badge mc-badge-info']
        : summaryData.effective_enabled
          ? ['已开启', 'mc-badge mc-badge-success']
          : ['已关闭', 'mc-badge mc-badge-neutral'];
      info.append(element('span', badge[0], badge[1]));
      const g = summaryData.global_settings || {};
      const metaParts = [`窗口 ${g.window_start || '02:00'}–${g.window_end || '05:00'}`];
      if (summaryData.state?.last_completed_at) metaParts.push(`上次完成 ${timeText(summaryData.state.last_completed_at)}`);
      else metaParts.push('尚未运行');
      info.append(element('span', metaParts.join(' · '), 'mc-knowledge-bar-meta'));
    }

    const actions = element('div', '', 'actions');
    if (summaryData?.can_manage && drawer.hidden) {
      if (summaryData.running_run) {
        const stopBtn = button('停止整理', async () => {
          stopBtn.disabled = true;
          try {
            summaryData = await api(apiBase + '/stop', 'POST', {});
            wasRunning = Boolean(summaryData.running_run);
            renderBar();
            drawerSection?._reloadConsolidation?.();
          } catch (err) {
            stopBtn.disabled = false;
            bar.append(element('p', consolidationErrorText(err), 'view-error'));
          }
        }, 'btn-danger');
        actions.append(stopBtn);
      } else {
        const runBtn = button('立即整理', async () => {
          runBtn.disabled = true;
          try {
            summaryData = await api(apiBase + '/run', 'POST', {});
            wasRunning = Boolean(summaryData.running_run);
            renderBar();
            drawerSection?._reloadConsolidation?.();
            if (summaryData.running_run) schedulePoll();
            else if (summaryData.run?.status === 'skipped') {
              drawer.hidden = false;
              ensureDrawer();
            }
          } catch (err) {
            runBtn.disabled = false;
            bar.append(element('p', consolidationErrorText(err), 'view-error'));
          }
        }, 'btn-secondary');
        actions.append(runBtn);
      }
    }

    const toggleBtn = button(drawer.hidden ? '整理设置与记录' : '收起整理面板', () => {
      drawer.hidden = !drawer.hidden;
      if (!drawer.hidden) ensureDrawer();
      renderBar();
    }, 'quiet');
    toggleBtn.setAttribute('aria-expanded', String(!drawer.hidden));
    actions.append(toggleBtn);
    bar.append(info, actions);
  };

  const ensureDrawer = () => {
    if (drawerSection) {
      drawerSection._reloadConsolidation?.();
      return;
    }
    drawerSection = renderConsolidationSection({
      apiBase,
      title: '项目记忆整理设置与记录',
      headingLevel: 'h3',
      description: '夜间窗口内使用 Pi 后端整理本项目 ../notes/ 知识文件（不检出默认分支代码，保留多分支说明，删除与变更均可从历史版本一键恢复）。',
      onOpenProjectFile,
      onRunCompleted: next => {
        summaryData = next;
        renderBar();
        onRefreshFiles?.();
      },
      compact: true,
    });
    drawer.replaceChildren(drawerSection);
  };

  const schedulePoll = () => {
    stopPoll();
    if (!wrap.isConnected || !summaryData?.running_run) return;
    pollTimer = setTimeout(() => { void loadSummary(); }, 2500);
  };

  async function loadSummary() {
    try {
      const next = await api(apiBase);
      if (!wrap.isConnected) return;
      const finishedNow = wasRunning && !next.running_run;
      wasRunning = Boolean(next.running_run);
      summaryData = next;
      renderBar();
      if (summaryData.running_run) schedulePoll();
      if (finishedNow) {
        drawerSection?._reloadConsolidation?.();
        onRefreshFiles?.();
      }
    } catch {
      if (!wrap.isConnected) return;
      bar.replaceChildren(note('暂时无法读取项目夜间记忆整理状态。'));
    }
  }

  renderBar();
  void loadSummary();
  return wrap;
}

function renderAssistantMemoryBrowser({
  apiBase,
  title = '助手私有记忆（~/memory/）',
  headingLevel = 'h2',
  description = '',
}) {
  const section = card(title, headingLevel);
  section.classList.add('mc-browser');
  const body = element('div', '', 'mc-browser');
  section.append(body);

  let listData = null;
  let selectedPath = null;
  let selectedFile = null;
  let mode = 'view'; // 'view' | 'edit' | 'create'
  let noticeText = '';
  let noticeIsError = false;

  const setNotice = (text, isError = false) => {
    noticeText = text;
    noticeIsError = isError;
  };

  const render = () => {
    if (!section.isConnected) return;
    body.replaceChildren();
    if (description) body.append(note(description));

    if (!listData) {
      body.append(note('正在读取 ~/memory/ 文件列表…'));
      return;
    }

    if (listData.eligible === false) {
      body.append(note('当前账号暂未获得个人管理助手权限，没有可管理的私有记忆目录。'));
      return;
    }

    if (!listData.available) {
      const msg = listData.reason === 'binding_disabled'
        ? '该群聊助手当前已停用；重新启用后可查看和管理其 ~/memory/ 私有记忆。'
        : '此部署未挂载助手 HOME 卷，暂不可通过控制台浏览 ~/memory/ 文件。';
      body.append(note(msg));
      return;
    }

    if (listData.read_only) {
      body.append(element('p', '助手 HOME 已超出容量上限，当前处于只读保护模式（仅可查看或删除不需要的文件以释放空间）。', 'endpoint-warning'));
    }

    const statusLine = noticeText ? note('') : null;
    if (statusLine) {
      statusLine.setAttribute('role', 'status');
      announceSave(statusLine, noticeText, noticeIsError);
    }

    const grid = element('div', '', 'mc-browser-grid');
    const listPane = element('div', '', 'mc-browser-list-pane');
    const listActions = element('div', '', 'actions');
    if (listData.can_write) {
      listActions.append(button('新建文件', () => {
        mode = 'create';
        selectedPath = null;
        selectedFile = null;
        setNotice('');
        render();
      }, 'btn-secondary'));
    }
    listActions.append(button('刷新文件', () => void loadList(), 'quiet'));
    listPane.append(listActions);

    const files = Array.isArray(listData.files) ? listData.files : [];
    if (!files.length) {
      listPane.append(note('~/memory/ 目录下暂无记忆文件。'));
    } else {
      const ul = element('ul', '', 'mc-browser-files');
      ul.setAttribute('aria-label', '~/memory/ 文件列表');
      for (const f of files) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'quiet mc-browser-file-btn';
        if (selectedPath === f.path && mode !== 'create') btn.setAttribute('aria-current', 'page');
        btn.append(
          element('span', f.path, 'mc-browser-file-name'),
          element('span', `${memoryFileSize(f.size)}${f.modified_at ? ' · ' + timeText(f.modified_at) : ''}`, 'mc-browser-file-meta'),
        );
        btn.addEventListener('click', () => void openMemoryFile(f.path));
        li.append(btn);
        ul.append(li);
      }
      listPane.append(ul);
    }

    const detailPane = element('div', '', 'mc-browser-detail-pane');
    if (mode === 'create' || (mode === 'edit' && selectedFile)) {
      const isCreate = mode === 'create';
      const form = element('form', '', 'mc-browser-editor');
      const pathInput = input('memory_path', isCreate ? '' : selectedFile.path, {
        required: true,
        placeholder: '例如 INDEX.md 或 notes/preferences.md',
      });
      pathInput.readOnly = !isCreate;
      const contentArea = textarea('memory_content', isCreate ? '' : (selectedFile.content || ''), {
        rows: 14,
        spellcheck: false,
        className: 'code',
      });
      const saveBtn = element('button', '保存文件', '');
      saveBtn.type = 'submit';
      const cancelBtn = button('取消', () => {
        mode = 'view';
        render();
      }, 'quiet');
      const formActions = element('div', '', 'actions');
      formActions.append(saveBtn, cancelBtn);
      form.append(
        element('h3', isCreate ? '新建 ~/memory/ 记忆文件' : `编辑 ~/memory/${selectedFile.path}`),
        field('相对路径（位于 ~/memory/ 下）', pathInput),
        field('内容（写入时自动脱敏已知密钥与凭据）', contentArea),
        formActions,
      );
      form.addEventListener('submit', async event => {
        event.preventDefault();
        saveBtn.disabled = true;
        try {
          const targetPath = pathInput.value.trim();
          await api(apiBase + '/content', 'PUT', { path: targetPath, content: contentArea.value });
          mode = 'view';
          setNotice(`已保存 ~/memory/${targetPath.replace(/^~?\/?memory\//, '')}。`, false);
          await loadList({ openPath: targetPath.replace(/^~?\/?memory\//, '') });
        } catch (err) {
          saveBtn.disabled = false;
          setNotice(consolidationErrorText(err), true);
          render();
        }
      });
      detailPane.append(form);
    } else if (selectedFile) {
      const head = element('div', '', 'mc-head');
      const titleWrap = element('div', '', 'mc-head-title');
      titleWrap.append(element('strong', selectedFile.display_path || `~/memory/${selectedFile.path}`));
      const detailActions = element('div', '', 'actions');
      if (listData.can_write) {
        detailActions.append(button('编辑', () => {
          mode = 'edit';
          setNotice('');
          render();
        }, 'btn-secondary'));
      }
      if (listData.can_delete) {
        detailActions.append(button('删除', async () => {
          const ok = await askConfirm({
            title: `删除 ~/memory/${selectedFile.path}？`,
            body: ['删除后会立即从该助手的私有记忆目录移除此文件。'],
            action: '删除文件',
            danger: true,
          });
          if (!ok) return;
          try {
            const removedPath = selectedFile.path;
            await api(apiBase + '/content', 'DELETE', { path: removedPath });
            selectedPath = null;
            selectedFile = null;
            setNotice(`已删除 ~/memory/${removedPath}。`, false);
            await loadList();
          } catch (err) {
            setNotice(consolidationErrorText(err), true);
            render();
          }
        }, 'btn-danger'));
      }
      head.append(titleWrap, detailActions);
      detailPane.append(head);
      detailPane.append(note(`大小：${memoryFileSize(selectedFile.size)}${selectedFile.truncated ? '（仅预览前 256 KiB）' : ''}`));
      const preview = element('div', '', 'mc-browser-preview');
      if (!selectedFile.content) {
        preview.append(note('这是一个空文件。'));
      } else if (/\.md$/i.test(selectedFile.path) && typeof renderManagementMarkdown === 'function') {
        renderManagementMarkdown(preview, selectedFile.content);
      } else {
        preview.append(element('pre', selectedFile.content));
      }
      detailPane.append(preview);
    } else {
      detailPane.append(note(files.length ? '在左侧选择一个记忆文件进行预览或编辑。' : '点击「新建文件」创建第一条私有记忆，或等待夜间整理自动生成。'));
    }

    grid.append(listPane, detailPane);
    if (statusLine) body.append(statusLine);
    body.append(grid);
  };

  async function openMemoryFile(path) {
    selectedPath = path;
    mode = 'view';
    setNotice('');
    render();
    try {
      const data = await api(`${apiBase}/content?path=${encodeURIComponent(path)}`);
      if (!section.isConnected) return;
      selectedFile = data;
      selectedPath = data.path;
      render();
    } catch (err) {
      if (!section.isConnected) return;
      selectedFile = null;
      setNotice(consolidationErrorText(err), true);
      render();
    }
  }

  async function loadList({ openPath = null } = {}) {
    try {
      const next = await api(apiBase);
      if (!section.isConnected) return;
      listData = next;
      const target = openPath || (selectedPath && next.files?.some(f => f.path === selectedPath) ? selectedPath : null);
      if (target) {
        await openMemoryFile(target);
        return;
      }
      selectedPath = null;
      selectedFile = null;
      render();
    } catch (err) {
      if (!section.isConnected) return;
      body.replaceChildren(consoleState('无法读取 ~/memory/ 记忆文件', consolidationErrorText(err), { tone: 'error', retry: () => void loadList() }));
    }
  }

  section._reloadMemoryBrowser = () => void loadList();
  render();
  void loadList();
  return section;
}
