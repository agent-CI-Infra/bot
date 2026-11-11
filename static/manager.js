// The Manager role page: one complete prompt, event filters, decisions and task rule sources.

const managerErrors = {
  invalid_dispatch_filter: '分派筛选无效，请检查时间范围、状态或事件类型。', invalid_dispatch_cursor: '当前分页位置已失效，请重新读取分派。', dispatch_event_not_found: '未找到本项目中的这条分派记录。',
  manager_revision_conflict: 'Manager 配置已被别人修改，请刷新页面后再保存。', unknown_manager_section: '章节 id 不认识：二级标题末尾反引号里的 id 要用下面列出的章节。',
  duplicate_manager_section: '同一个章节出现了两次。', invalid_bot_label: '章节里的标签声明不合法（最长 50 个字符，首尾不能有空白）。',
  invalid_work_writes: '写入不在这类工作可选的范围里，或开 PR 时没有同时允许修改代码。', invalid_event_filters: '事件开关或标签不合法（标签最长 50 个字符，最多 30 个）。'
};
// api() reports "<status> · <code>"; a known code gets its explanation.
const managerError = err => { const code = /· (\w+)$/.exec(err.message)?.[1] ?? err.message; return managerErrors[code] ? `${managerErrors[code]}（${code}）` : err.message; };
const eventCaptions = [['actions.run_failed', '接收默认分支的 Actions 失败事件'], ['issue.opened', 'Issue 打开'], ['issue.updated', 'Issue 修改或可信评论'], ['issue.mention', 'Issue 评论提到 bot'], ['issue.development_label', '有人加上开发标签'],
  ['pull_request.opened', 'PR 打开或 Ready for review'], ['pull_request.synchronize', 'PR 推送新提交'], ['pull_request.updated', 'PR 修改、讨论或检视'], ['pull_request.mention', 'PR 评论提到 bot'],
  ['review.published.issue', 'Issue 检视发布（可能开始开发）'], ['review.published.pr', 'bot PR 检视发布（可能修订 PR）']];
const dispatchEventNames = { 'issue.opened': 'Issue 打开', 'issue.updated': 'Issue 更新', 'issue.mention': 'Issue 提及', 'issue.labeled': 'Issue 加标签', 'pull_request.opened': 'PR 打开',
  'pull_request.synchronize': 'PR 推送', 'pull_request.updated': 'PR 讨论', 'pull_request.mention': 'PR 提及', 'pull_request.labeled': 'PR 加标签', 'review.published': '检视发布',
  'release.manual': '发版本', 'actions.run_failed': 'Actions 失败', 'gate.manual': '接入门禁', 'schedule.due': '定时检查' };
const decisionNames = { create: ['新建任务', 'success'], continue: ['续接任务', 'info'], ignore: ['不处理', ''] };
function managerSection(roles) {
  const id = current.id, holder = element('div', '', 'manager-page'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert'); holder.append(note('正在读取 Manager 配置…'));
  const refresh = async notice => {
    try {
      const { manager } = await api(`/api/repositories/${id}/manager`);
      if (current?.id !== id || current.section !== 'roles') return;
      current.manager = manager; holder.replaceChildren(...managerCards(manager, roles, refresh, notice));
      // An older address (the workflows page, its rule pages) scrolls to its card once the cards are drawn.
      current.managerAnchor?.(); current.managerAnchor = null;
    } catch (err) { message.textContent = err.message; }
  };
  void refresh(); return [holder, message];
}
// Saves part of the configuration at the revision this page read; a conflict asks for a refresh instead of overwriting.
const saveManagerChange = change => api(`/api/repositories/${current.id}/manager`, 'PUT', { expected_revision: current.manager.prompt.revision, ...change });
function managerCards(manager, roles, refresh, notice) {
  return [...(notice ? [Object.assign(element('p', notice, 'view-success flash'), { role: 'status' })] : []), managerPromptCard(manager, refresh), taskModelEditor('manager', 'Manager 分派', current.policy, current.models),
    eventFiltersCard(manager, refresh), dispatchCard(), managerRulesCard(), ...(manager.migration ? [migrationCard(manager.migration)] : [])];
}

function managerPromptCard(manager, refresh) {
  const section = card('Manager 提示词'), form = document.createElement('form'), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'manager-prompt'; form.className = 'project-form'; message.setAttribute('role', 'alert');
  const draft = current.managerDraft?.dirty ? current.managerDraft : { value: manager.prompt.content, revision: manager.prompt.revision, dirty: false };
  current.managerDraft = draft;
  const editor = textarea('prompt', draft.value, { rows: 24, spellcheck: false });
  editor.addEventListener('input', () => { draft.value = editor.value; draft.dirty = true; });
  editor.setAttribute('aria-label', 'Manager 提示词');
  section.append(note('这是 Manager 实际读取的完整分派提示词。直接编辑整份内容，无需章节编号或特殊格式。它决定新建任务、续接任务或不处理；修改提示词不会增加工具或写入权限。'));
  current.managerEditor = { editor, initial: manager.prompt.content };
  const submit = element('button', '保存 Manager 提示词'); submit.type = 'submit';
  form.append(field('完整提示词', editor), message, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true;
    try { await api(`/api/repositories/${current.id}/manager`, 'PUT', { expected_revision: draft.revision, prompt: editor.value }); current.managerDraft = null; await refresh('已保存 Manager 提示词'); }
    catch (err) { message.textContent = managerError(err); submit.disabled = false; }
  });
  form.append(button('重新读取已保存提示词', async () => {
    if (draft.dirty && !await askConfirm({ title: '放弃未保存的 Manager 提示词？', body: ['将重新读取服务器上的完整提示词。'], action: '放弃并刷新' })) return;
    current.managerDraft = null; await refresh();
  }));
  section.append(form); return section;
}

// Task rule edits advance the shared configuration revision. Refresh a pristine dispatch editor without replacing its draft object.
async function managerChanged() {
  const id = current?.id; if (!id || current.section !== 'roles' || !current.manager) return;
  try {
    const { manager } = await api(`/api/repositories/${id}/manager`); if (current?.id !== id) return;
    current.manager = manager; const held = current.managerEditor;
    if (held && held.editor.value === held.initial) { held.editor.value = manager.prompt.content; held.initial = manager.prompt.content; Object.assign(current.managerDraft, { value: manager.prompt.content, revision: manager.prompt.revision, dirty: false }); }
  } catch { /* The next visit reads it again. */ }
}
function eventFiltersCard(manager, refresh) {
  const section = card('交给 Manager 的事件'), form = document.createElement('form'), message = element('p', '', 'view-error'), events = manager.events;
  section.dataset.overviewAnchor = 'manager-events'; form.className = 'project-form'; message.setAttribute('role', 'alert');
  section.append(note(`草稿、已关闭的对象、bot 自己写的内容和仓库外人员的评论始终不会交给 Manager。这里关掉的事件同样不会到达 Manager，也不会产生分派调用；开着的事件每个都调用一次 Manager 模型。提到 bot 指评论里写了 ${manager.mention_names.map(name => '@' + name).join('、') || '（部署关闭了提及）'}。`));
  const boxes = element('div', '', 'manager-events');
  for (const [key, caption] of eventCaptions) boxes.append(checkbox('event:' + key, events[key], caption));
  const labels = (key, caption) => field(caption, input(key, events[key].join(', '), { placeholder: '逗号分隔；留空表示加标签不交给 Manager' }));
  const submit = element('button', '保存事件开关'), buttons = element('div', '', 'actions form-actions'); submit.type = 'submit'; buttons.append(submit);
  const status = element('p', '', 'muted'); status.dataset.actionsStatus = '';
  if (current.policy.actions_failures_enabled) showActionsFailureStatus(status, current.actionsFailures); else status.textContent = '未开启。';
  form.append(boxes, status, labels('issue.labels', '有人给 Issue 加上这些标签时'), labels('pull_request.labels', '有人给 PR 加上这些标签时'), message, buttons);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; message.textContent = '';
    const list = key => form.elements[key].value.split(',').map(label => label.trim()).filter(Boolean);
    // Every switch is saved, so each stands on its own afterwards.
    const value = Object.fromEntries(eventCaptions.map(([key]) => [key, form.elements['event:' + key].checked]));
    try { await saveManagerChange({ events: { ...value, 'issue.labels': list('issue.labels'), 'pull_request.labels': list('pull_request.labels') } }); await reloadWith('已保存事件开关'); }
    catch (err) { message.textContent = managerError(err); submit.disabled = false; }
  });
  section.append(form); return section;
}

// This reader belongs to one mounted project page; a newer permission error invalidates every older response.
function dispatchCard() {
  const target = current, token = renderToken, id = target.id, section = card('最近的分派');
  section.dataset.overviewAnchor = 'manager-dispatch'; section.classList.add('dispatch-reader'); section.setAttribute('aria-label', 'Manager 分派记录');
  const live = () => current === target && renderToken === token && current.section === 'roles' && section.isConnected;
  const initial = new URLSearchParams(location.hash.split('?')[1] || ''), filters = {};
  for (const key of ['state', 'decision', 'type', 'from', 'until']) filters[key] = initial.get('dispatch_' + key) || '';
  const form = element('form', '', 'dispatch-filters'), list = element('ol', '', 'manager-dispatch'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  const choose = (name, label, entries) => {
    const control = document.createElement('select'); control.name = name;
    for (const [value, caption] of entries) { const option = element('option', caption); option.value = value; control.append(option); }
    control.value = filters[name]; form.append(field(label, control)); return control;
  };
  choose('state', '分派状态', [['', '全部状态'], ['pending', '等待或自动重试'], ['dispatching', 'Manager 处理中'], ['failed', '等待人工重试'], ['decided', '已决定']]);
  choose('decision', '分派结果', [['', '全部结果'], ['create', '新建任务'], ['continue', '续接任务'], ['ignore', '不处理']]);
  const type = input('type', filters.type, { placeholder: '例如 issue.opened', maxLength: 80 }); form.append(field('事件类型', type));
  for (const [key, label] of [['from', '开始时间（含）'], ['until', '结束时间（不含）']]) {
    let value = ''; if (filters[key] && Number.isFinite(Date.parse(filters[key]))) { const d = new Date(filters[key]); value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    form.append(field(label, input(key, value, { type: 'datetime-local' })));
  }
  const apply = element('button', '应用分派筛选'); apply.type = 'submit';
  const refresh = button('重新读取分派', () => void load(false)), more = button('更早的分派', () => void load(true)), count = note('尚未读取，分派状态未知。'); more.hidden = true;
  form.append(apply);
  section.append(note('筛选事件收到的时间；时间按本机时区 ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ' 输入。等待和读取失败不能当作不处理。'), form, element('div', '', 'actions'), message, count, list, more);
  form.nextElementSibling.append(refresh);
  const dialog = document.createElement('dialog'); dialog.className = 'dispatch-detail'; dialog.setAttribute('aria-label', '分派详情');
  const detailMessage = element('p', '', 'view-error'), body = element('div', '', 'dispatch-detail-body'), footer = element('div', '', 'actions'); detailMessage.setAttribute('role', 'alert');
  const close = button('关闭分派详情', () => dialog.close()), read = button('刷新当前结果', () => void readDetail(selected)), retry = button('重试这条分派', () => void retrySelected());
  footer.append(close, read, retry); dialog.append(element('h2', '分派详情'), detailMessage, body, footer); section.append(dialog);
  let request = 0, detailRequest = 0, cursor = null, loaded = false, loading = false, detailBusy = false, selected = null, detail = null, revoked = false, rows = [], opener;
  const address = () => {
    if (!live()) return;
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    for (const [key, value] of Object.entries(filters)) { if (value) params.set('dispatch_' + key, value); else params.delete('dispatch_' + key); }
    if (selected) params.set('dispatch', selected); else params.delete('dispatch');
    history.replaceState(null, '', location.hash.split('?')[0] + (params.size ? '?' + params : ''));
  };
  const forbidden = err => {
    if (![401, 403].includes(err.status)) return false;
    revoked = true; request++; detailRequest++; loading = false; detailBusy = false; rows = []; detail = null; selected = null; list.replaceChildren(); body.replaceChildren();
    if (dialog.open) dialog.close(); address(); more.hidden = true; count.textContent = '当前身份无法读取分派，已清空旧记录。'; controls(); return true;
  };
  const controls = () => { apply.disabled = refresh.disabled = more.disabled = loading; read.disabled = detailBusy; retry.disabled = detailBusy; retry.hidden = !detail || detail.event.state !== 'failed' || revoked; };
  async function load(append) {
    if (!live() || loading) return;
    const own = ++request; loading = true; message.textContent = ''; controls();
    const params = new URLSearchParams({ limit: '20' });
    for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
    if (append && cursor) params.set('cursor', cursor);
    try {
      const page = await api(`/api/repositories/${id}/dispatch?` + params);
      if (!live() || own !== request) return;
      revoked = false; const seen = new Set(append ? rows.map(row => row.id) : []);
      rows = [...(append ? rows : []), ...page.events.filter(row => !seen.has(row.id))]; cursor = page.next_cursor; loaded = true;
      list.replaceChildren(...rows.map(row => dispatchEntry(row, event => openDetail(event.id))));
      count.textContent = rows.length ? `已读取 ${rows.length} 条分派，按事件收到时间倒序。` : '当前筛选没有分派记录。';
      more.hidden = !page.has_more; address();
    } catch (err) {
      if (!live() || own !== request) return;
      if (!forbidden(err)) count.textContent = loaded ? '读取失败，保留上次读取的记录，可能不属于新的筛选范围。' : '读取失败，分派状态未知。';
      message.textContent = managerError(err);
    } finally { if (live() && own === request) { loading = false; controls(); } }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (loading) return;
    const next = {};
    for (const key of ['state', 'decision', 'type', 'from', 'until']) { const value = form.elements[key].value; next[key] = key === 'from' || key === 'until' ? value ? new Date(value).toISOString() : '' : value.trim(); }
    if (next.from && next.until && next.from >= next.until) { message.textContent = '结束时间必须晚于开始时间。'; form.elements.until.focus(); return; }
    if (next.type && !/^[a-z][a-z0-9_.-]{0,79}$/.test(next.type)) { message.textContent = '事件类型应使用小写字母、数字、点、下划线或连字符，最多 80 个字符。'; form.elements.type.focus(); return; }
    Object.assign(filters, next); address(); void load(false);
  });
  function openDetail(eventId) {
    if (!live()) return;
    opener = document.activeElement; selected = eventId; detail = null; body.replaceChildren(note('正在读取这条分派…')); detailMessage.textContent = ''; controls(); address();
    if (!dialog.open) dialog.showModal(); void readDetail(eventId);
  }
  dialog.addEventListener('close', () => { selected = null; detail = null; detailRequest++; body.replaceChildren(); address(); if (live() && !opener?.isConnected) refresh.focus(); });
  function drawDetail(value) {
    const event = value.event, position = dialog.scrollTop; body.replaceChildren();
    const group = (title, ...children) => { const el = element('section'); el.append(element('h3', title), ...children); body.append(el); return el; };
    group('触发事件', facts([['事件编号', event.id], ['事件类型', dispatchEventNames[event.type] || event.type], ['来源', event.source], ['收到时间', timestamp(event.created_at)], ['对象', event.object_number ? `${event.object_type} #${event.object_number}` : '未记录对象'], ['投递编号', event.delivery_id || '未记录']]), element('p', event.summary));
    group('Manager 判断', facts([['状态', dispatchState(event)], ['决定时间', event.decided_at ? timestamp(event.decided_at) : event.state === 'decided' ? '未记录决定时间' : '尚未决定'], ['记录的模型名称', event.model || '未记录；不能用当前配置推断历史模型'], ['当前轮尝试次数', String(event.attempts)]]), element('p', event.reason || '尚无已保存的决定理由。'));
    if (event.brief?.goal) body.lastChild.append(element('p', '任务目标：' + event.brief.goal), note((event.brief.criteria || []).join('；')));
    if (event.error) body.lastChild.append(element('p', '最近失败：' + event.error.code + (event.error.detail ? ' · ' + event.error.detail : ''), 'view-error'));
    if (event.state === 'pending' && event.next_run_at) body.lastChild.append(note('下次允许自动尝试：' + timestamp(new Date(event.next_run_at).toISOString())));
    const tasks = group('关联任务');
    if (!value.tasks.length) tasks.append(note(event.state === 'decided' && event.decision === 'ignore' ? 'Manager 决定不处理，没有关联任务。' : '当前没有可读取的关联任务；分派结果不等于任务已完成。'));
    for (const task of value.tasks) tasks.append(button(`${task.relation === 'created' ? '新建' : '续接'} · ${task.kind} · ${task.id.slice(0, 8)} · ${task.status}`, () => { dialog.close(); if (live()) openTask(task.id); }));
    const history = group('人工重试记录', note('重试沿用同一事件编号，原决定的幂等约束继续生效；只有失败状态可以请求人工重试。这里显示最近 50 条人工重试，不表示任务一定成功。'));
    if (!value.retries.length) history.append(note('没有人工重试记录。'));
    for (const record of value.retries) history.append(element('p', `${timestamp(record.requested_at)} · 原轮尝试 ${record.previous_attempts} 次 · ${record.previous_error?.code || '未记录错误码'}${record.previous_error?.detail ? ' · ' + record.previous_error.detail : ''}`));
    dialog.scrollTop = position;
  }
  async function readDetail(eventId) {
    if (!live() || !eventId) return;
    const own = ++detailRequest; detailBusy = true; detailMessage.textContent = ''; controls();
    try {
      const value = await api(`/api/repositories/${id}/dispatch/${encodeURIComponent(eventId)}`);
      if (!live() || own !== detailRequest || selected !== eventId) return;
      detail = value; drawDetail(value);
    } catch (err) {
      if (!live() || own !== detailRequest || selected !== eventId) return;
      if (!forbidden(err)) detailMessage.textContent = managerError(err) + (detail ? ' · 保留上次结果，请重新读取。' : ' · 当前结果未知，请重新读取。');
      else message.textContent = managerError(err);
    } finally { if (live() && own === detailRequest) { detailBusy = false; controls(); } }
  }
  async function retrySelected() {
    if (!live() || detailBusy || detail?.event.state !== 'failed') return;
    const eventId = selected, own = ++detailRequest; detailBusy = true; detailMessage.textContent = ''; controls();
    try {
      await api(`/api/repositories/${id}/dispatch/${encodeURIComponent(eventId)}/retry`, 'POST', {});
      if (!live() || own !== detailRequest || selected !== eventId) return;
      detailMessage.textContent = '已请求重试，仍使用同一条分派记录。'; detail = null; detailBusy = false; controls(); await readDetail(eventId); void load(false);
    } catch (err) {
      if (!live() || own !== detailRequest || selected !== eventId) return;
      if (!forbidden(err)) detailMessage.textContent = managerError(err) + ' · 写入结果可能已变化，请先刷新当前结果再决定是否重试。';
      else message.textContent = managerError(err);
    } finally { if (live() && own === detailRequest) { detailBusy = false; controls(); } }
  }
  // The enclosing Manager cards are attached after this constructor returns.
  queueMicrotask(() => { if (live()) { void load(false); const selectedAddress = initial.get('dispatch'); if (selectedAddress) openDetail(selectedAddress); } });
  return section;
}
function dispatchState(event) {
  return event.state === 'decided' ? decisionNames[event.decision]?.[0] || '已决定，结果未识别' : event.state === 'failed' ? '等待人工重试' : event.state === 'dispatching' ? 'Manager 处理中' : event.state === 'pending' ? '等待或自动重试' : '未识别的分派状态';
}
function dispatchEntry(event, open) {
  const item = element('li', '', 'manager-dispatch-entry'), head = element('div', '', 'manager-dispatch-head');
  head.append(element('strong', dispatchEventNames[event.type] || event.type), badge(dispatchState(event), event.state === 'failed' ? 'danger' : event.state === 'decided' ? 'success' : 'warning'), element('span', timestamp(event.created_at), 'muted'));
  item.dataset.dispatchEvent = event.id; item.append(head, element('p', event.summary));
  if (event.reason) item.append(note('理由：' + event.reason));
  if (event.error) item.append(note('最近失败：' + event.error.code));
  item.append(button('查看分派详情', () => open(event), 'quiet')); return item;
}

function managerRulesCard() {
  const section = card('规则文件来源');
  // Include repository skills here as well: the complete prompt editor has no separate per-section source list.
  const paths = [...ruleFiles.map(([rule]) => rule), ...(current.rules?.files || []).map(file => file.path).filter(path => !ruleFiles.some(([rule]) => rule === path))];
  section.dataset.overviewAnchor = 'rule-sources';
  section.append(note('任务规则的优先级是内置默认 → 项目控制台覆盖 → 默认分支仓库文件，每层整份替换。仓库 skill 和虚拟电脑配置也来自默认分支。'), ruleSync());
  const { table, body } = projectTable(['文件', '作用', '规则来源', '操作'], '规则文件');
  for (const path of paths) {
    const row = document.createElement('tr'), [, purpose, task, target] = ruleInfo(path); row.dataset.ruleFile = path;
    tableCell(row, '文件', element('strong', purpose)); tableCell(row, '作用', task); tableCell(row, '规则来源', ruleSource(path), element('code', path));
    if (target === 'machine') { const link = element('a', '查看机器配置'); link.href = `#/projects/${current.id}/machine`; tableCell(row, '操作', link); }
    else tableCell(row, '操作', button('展开规则', () => openProjectRule(path), 'quiet'));
    body.append(row);
  }
  const detail = element('section', '', 'project-inline-detail'); detail.id = 'project-detail'; detail.hidden = true; detail.setAttribute('role', 'region');
  section.append(table, detail); return section;
}

function migrationCard(migration) {
  const section = card('升级迁移记录'), report = migration.report || {};
  section.dataset.overviewAnchor = 'manager-migration';
  section.append(note(`升级时（${timestamp(migration.migrated_at)}）原来的工作流配置迁入了 Manager 提示词第 ${report.manager_revision || 1} 版和项目配置；原工作流记录保存在迁移档案里。`),
    facts([['保留的任务规则', (report.sections || []).join('、') || '无额外覆盖'], ['原自定义工作流', (report.custom_workflows || []).map(w => `${w.name}（${w.enabled ? '开' : '关'}）`).join('、') || '无']]));
  if (report.warnings?.length) { const list = element('ul', '', 'history'); for (const warning of report.warnings) list.append(element('li', warning)); section.append(element('h4', '需要留意'), list); }
  return section;
}
