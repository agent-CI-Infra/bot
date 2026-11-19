// The Manager role page: its prompt, standing rules, model, decisions and the repository's skills. Project listeners live in triggers.js.

const managerErrors = {
  invalid_standing_rules: '常设规则格式不对：每条要有唯一的 id、已知的 event 和 action，新建类规则需要 role（或兼容的 work），还要写 reason。', standing_rule_development: '常设规则不能启动开发：开发要 Manager 针对具体 Issue 写明依据。',
  invalid_dispatch_filter: '分派筛选无效，请检查时间范围、状态或事件类型。', invalid_dispatch_cursor: '当前分页位置已失效，请重新读取分派。', dispatch_event_not_found: '未找到本项目中的这条分派记录。',
  manager_revision_conflict: 'Manager 配置已被别人修改，请刷新页面后再保存。', invalid_event_filters: '事件开关或标签不合法（标签最长 50 个字符，最多 30 个）。'
};
// api() reports "<status> · <code>"; a known code gets its explanation.
const managerError = err => { const code = /· (\w+)$/.exec(err.message)?.[1] ?? err.message; return managerErrors[code] ? `${managerErrors[code]}（${code}）` : readErrorText(err); };
const dispatchEventNames = { 'issue.opened': 'Issue 打开', 'issue.updated': 'Issue 更新', 'issue.mention': 'Issue 提及', 'issue.labeled': 'Issue 加标签', 'pull_request.opened': 'PR 打开',
  'pull_request.synchronize': 'PR 推送', 'pull_request.updated': 'PR 讨论', 'pull_request.mention': 'PR 提及', 'pull_request.labeled': 'PR 加标签', 'review.published': '检视发布', 'development.stopped': '开发停下',
  'release.manual': '发版本', 'actions.run_failed': 'Actions 失败', 'schedule.due': '定时检查' };
const decisionNames = { create: ['新建任务', 'success'], continue: ['续接任务', 'info'], ignore: ['不分派任务', ''] };
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
    } catch (err) { message.textContent = readErrorText(err); }
  };
  void refresh(); return [holder, message];
}
function managerCards(manager, roles, refresh, notice) {
  const behavior = card('项目 Manager 设置');
  behavior.append(note('每个 Issue 或独立 PR 维持单一持久 Manager 线程，按事件需要直接执行授权操作、新建通用任务（指派 reviewer / test / dev 等角色并授予写入权限）或续接已有任务。Manager 的模型与 Agent 后端在下方「Manager 设置」表单中配置。'), consoleLink(`#/projects/${current.id}/triggers`, '监听与触发设置', '项目整体的事件来源与自动处理范围'));
  return [...(notice ? [Object.assign(element('p', notice, 'view-success flash'), { role: 'status' })] : []), behavior, managerPromptCard(manager, refresh), standingRulesCard(manager, refresh),
    dispatchCard(), repositorySkillsCard(), ...(manager.migration ? [migrationCard(manager.migration)] : []), ...(current.rules?.imported?.imported_at ? [ruleImportCard(current.rules.imported)] : [])];
}

function managerPromptCard(manager, refresh) {
  const section = card('Manager 提示词'), form = document.createElement('form'), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'manager-prompt'; form.className = 'project-form'; message.setAttribute('role', 'alert');
  const draft = current.managerDraft?.dirty ? current.managerDraft : { value: manager.prompt.content, revision: manager.prompt.revision, dirty: false };
  current.managerDraft = draft;
  const editor = textarea('prompt', draft.value, { rows: 24, spellcheck: false });
  editor.addEventListener('input', () => { draft.value = editor.value; draft.dirty = true; });
  editor.setAttribute('aria-label', 'Manager 提示词');
  section.append(note('这是 Manager 实际读取的完整分派提示词。直接编辑整份内容，无需章节编号或特殊格式。它决定新建任务、续接任务或不再分派；分派中可使用角色已授权的工具，修改提示词不会增加权限。'));
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

// Standing rules (#815): routine events they settle never reach the Manager's model. They are saved whole, with the
// Manager's revision; an empty list sends every event to the Manager.
const ruleActionNames = { create: '新建', continue: '续接（含已结束的检视）', continue_active: '只续接还在进行的任务', continue_or_create: '续接，没有就新建', ignore: '不处理' };
function standingRulesCard(manager, refresh) {
  const section = card('常设规则'), standing = manager.standing_rules, message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'standing-rules'; message.setAttribute('role', 'alert');
  section.append(note(standing.source === 'builtin' ? '现在用内置规则：例行事件按规则分派，不调用 Manager 模型；规则没覆盖的事件（提到 bot、开发标签、检视发布等）仍交给 Manager。保存后改用项目自己的规则。'
    : `项目规则，随 Manager 配置第 ${standing.revision} 版保存。规则没覆盖的事件交给 Manager；规则从不启动开发，新建的工作和 Manager 新建的一样受控制面检查。`));
  const list = element('ul', '', 'history');
  for (const rule of standing.rules) {
    const targetDesc = rule.role ? `角色 ${rule.role}${rule.writes?.length ? `（写入：${rule.writes.join('、')}）` : ''}` : rule.work ? rule.work : '';
    list.append(element('li', `${rule.enabled === false ? '（停用）' : ''}${dispatchEventNames[rule.event] || rule.event} → ${ruleActionNames[rule.action] || rule.action}${targetDesc ? ' · ' + targetDesc : ''}${rule.when?.labels_any ? ' · 带标签 ' + rule.when.labels_any.join('、') : ''}${rule.when?.labels_none ? ' · 不带标签 ' + rule.when.labels_none.join('、') : ''} · ${rule.reason}`));
  }
  if (!standing.rules.length) list.append(element('li', '没有规则：所有事件都交给 Manager。'));
  const form = document.createElement('form'), editor = textarea('standing_rules', JSON.stringify(standing.rules, null, 2), { rows: 12, spellcheck: false });
  form.className = 'project-form'; editor.setAttribute('aria-label', '常设规则（JSON）');
  const submit = element('button', '保存常设规则'); submit.type = 'submit';
  form.append(field('规则（JSON 数组：id、event、action、role、writes、reason，可选 when.labels_any／labels_none、enabled）', editor), message, submit);
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.textContent = '';
    let rules; try { rules = JSON.parse(editor.value); } catch { message.textContent = '规则不是有效的 JSON。'; return; }
    submit.disabled = true;
    try { await api(`/api/repositories/${current.id}/manager`, 'PUT', { expected_revision: manager.prompt.revision, standing_rules: rules }); await refresh('已保存常设规则'); }
    catch (err) { message.textContent = managerError(err); submit.disabled = false; }
  });
  section.append(list, form); return section;
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
  choose('state', '分派状态', [['', '全部状态'], ['pending', '等待或自动重试'], ['dispatching', 'Manager 处理中'], ['failed', '等待人工重试'], ['decided', '已决定'], ['filtered', '被过滤（未交给 Manager）']]);
  choose('decision', '分派结果', [['', '全部结果'], ['create', '新建任务'], ['continue', '续接任务'], ['ignore', '不分派任务']]);
  const type = input('type', filters.type, { placeholder: '例如 issue.opened', maxLength: 80 }); form.append(field('事件类型', type));
  for (const [key, label] of [['from', '开始时间（含）'], ['until', '结束时间（不含）']]) {
    let value = ''; if (filters[key] && Number.isFinite(Date.parse(filters[key]))) { const d = new Date(filters[key]); value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    form.append(field(label, input(key, value, { type: 'datetime-local' })));
  }
  const apply = element('button', '应用分派筛选'); apply.type = 'submit';
  const refresh = button('重新读取分派', () => void load(false)), more = button('更早的分派', () => void load(true)), count = note('尚未读取，分派状态未知。'); more.hidden = true;
  form.append(apply);
  section.append(note('筛选事件收到的时间；时间按本机时区 ' + Intl.DateTimeFormat().resolvedOptions().timeZone + ' 输入。这里显示最终任务分派，工具操作需结合已保存理由核对。等待或读取失败时，最终决定仍未知。'), form, element('div', '', 'actions'), message, count, list, more);
  form.nextElementSibling.append(refresh);
  const dialog = document.createElement('dialog'); dialog.className = 'dispatch-detail'; dialog.setAttribute('aria-label', '分派详情');
  const detailStatus = element('p', '', 'muted'); detailStatus.setAttribute('role', 'status');
  const detailMessage = element('p', '', 'view-error'), body = element('div', '', 'dispatch-detail-body'), footer = element('div', '', 'actions'); detailMessage.setAttribute('role', 'alert');
  const close = button('关闭分派详情', () => dialog.close()), read = button('刷新当前结果', () => void readDetail(selected)), retry = button('重试这条分派', () => void retrySelected());
  footer.append(close, read, retry); dialog.append(element('h2', '分派详情'), detailStatus, detailMessage, body, footer); section.append(dialog);
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
    revoked = true; request++; detailRequest++; loading = false; detailBusy = false; rows = []; detail = null; selected = null; detailStatus.textContent = ''; list.replaceChildren(); body.replaceChildren();
    if (dialog.open) dialog.close(); address(); more.hidden = true; count.textContent = '当前身份无法读取分派，已清空旧记录。'; controls(); return true;
  };
  const canRetry = event => event && event.error?.terminal!==true && event.error?.code!=='dispatch_cancelled' && (event.state === 'failed' || event.state === 'pending' && event.error && event.next_run_at > 0);
  const controls = () => { apply.disabled = refresh.disabled = more.disabled = loading; read.disabled = detailBusy; retry.disabled = detailBusy; retry.hidden = !canRetry(detail?.event) || revoked; };
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
    opener = document.activeElement; selected = eventId; detail = null; detailStatus.textContent = ''; body.replaceChildren(note('正在读取这条分派…')); detailMessage.textContent = ''; controls(); address();
    if (!dialog.open) dialog.showModal(); void readDetail(eventId);
  }
  dialog.addEventListener('close', () => { selected = null; detail = null; detailRequest++; detailStatus.textContent = ''; body.replaceChildren(); address(); if (live() && !opener?.isConnected) refresh.focus(); });
  function drawDetail(value) {
    const event = value.event, position = dialog.scrollTop; body.replaceChildren();
    const group = (title, ...children) => { const el = element('section'); el.append(element('h3', title), ...children); body.append(el); return el; };
    group('触发事件', facts([['事件编号', event.id], ['事件类型', dispatchEventNames[event.type] || event.type], ['来源', event.source], ['收到时间', timestamp(event.created_at)], ['对象', event.object_number ? `${event.object_type} #${event.object_number}` : '未记录对象'], ['投递编号', event.delivery_id || '未记录']]), element('p', event.summary));
    // A filtered event never reached the Manager: nothing was decided, no model ran, no attempt was made (#815).
    const judged = event.state === 'filtered' ? [['状态', dispatchState(event)], ['原因代码', event.result?.filtered || '未记录'], ['记录时间', timestamp(event.decided_at || event.created_at)]]
      : [['状态', dispatchState(event)], ['决定时间', event.decided_at ? timestamp(event.decided_at) : event.state === 'decided' ? '未记录决定时间' : '尚未决定'], ['记录的模型名称', event.model || '未记录；不能用当前配置推断历史模型'], ['累计尝试次数', String(event.attempts)]];
    group(event.state === 'filtered' ? '控制面过滤（没有交给 Manager）' : 'Manager 判断', facts(judged), element('p', event.reason || '尚无已保存的决定理由。'));
    if (event.brief?.goal) body.lastChild.append(element('p', '任务目标：' + event.brief.goal), note((event.brief.criteria || []).join('；')));
    if (event.error) body.lastChild.append(element('p', '最近失败：' + event.error.code + (event.error.detail ? ' · ' + event.error.detail : ''), 'view-error'));
    if (event.rule) body.lastChild.append(note(`按常设规则 ${event.rule.id}（第 ${event.rule.revision} 版）分派，没有调用 Manager 模型。`));
    // What the control plane refused when the Manager tried to create work (#815), with the reason it was given.
    if (event.refusals?.length) {
      const list = element('ul', '', 'history');
      for (const refusal of event.refusals) list.append(element('li', `${timestamp(refusal.at)} · ${refusal.work} · ${refusal.code}：${refusal.reason}`));
      group('控制面拒绝', note('Manager 选的这些工作没有建出来；拒绝原因也返回给了 Manager，它可以据此回复提出请求的人。'), list);
    }
    if (event.state === 'pending' && event.next_run_at) body.lastChild.append(note('下次允许自动尝试：' + timestamp(new Date(event.next_run_at).toISOString())));
    const tasks = group('关联任务');
    if (!value.tasks.length) tasks.append(note(event.state === 'decided' && event.decision === 'ignore' ? '本次没有关联的新建或续接任务。工具操作应结合已保存理由与实际记录核对。' : '当前没有可读取的关联任务；分派结果不等于任务已完成。'));
    for (const task of value.tasks) tasks.append(button(`${task.relation === 'created' ? '新建' : '续接'} · ${task.kind} · ${task.id.slice(0, 8)} · ${task.status}`, () => { dialog.close(); if (live()) openTask(task.id).catch(error); }));
    if (value.recovery?.failures.length) {
      const recovery = group('自动恢复记录', note('重复失败只触发提醒与退避；尚未决定分派结果。'));
      for (const record of value.recovery.failures) recovery.append(element('p', `第 ${record.attempt} 次 · ${record.error.code}${record.error.detail ? ' · ' + record.error.detail : ''}${record.report ? ' · 已记录重复失败提醒' : ''}`));
      if (value.recovery.next_before_attempt) recovery.append(button('读取更早的恢复记录', () => void readDetail(selected, value.recovery.next_before_attempt), 'quiet'));
    }
    const history = group('人工重试记录' , note('重试沿用同一事件编号，原决定的幂等约束继续生效；失败状态或正在退避的分派可请求立即重试；累计次数和故障证据保留。这里显示最近 50 条人工重试，不表示任务一定成功。'));
    if (!value.retries.length) history.append(note('没有人工重试记录。'));
    for (const record of value.retries) history.append(element('p', `${timestamp(record.requested_at)} · 原轮尝试 ${record.previous_attempts} 次 · ${record.previous_error?.code || '未记录错误码'}${record.previous_error?.detail ? ' · ' + record.previous_error.detail : ''}`));
    dialog.scrollTop = position;
  }
  async function readDetail(eventId, before) {
    if (!live() || !eventId) return;
    const own = ++detailRequest; detailBusy = true; detailMessage.textContent = ''; controls();
    try {
      const value = await api(`/api/repositories/${id}/dispatch/${encodeURIComponent(eventId)}` + (before ? `?failure_before=${before}` : ''));
      if (!live() || own !== detailRequest || selected !== eventId) return;
      detail = value; drawDetail(value);
    } catch (err) {
      if (!live() || own !== detailRequest || selected !== eventId) return;
      if (!forbidden(err)) detailMessage.textContent = managerError(err) + (detail ? ' · 保留上次结果，请重新读取。' : ' · 当前结果未知，请重新读取。');
      else message.textContent = managerError(err);
    } finally { if (live() && own === detailRequest) { detailBusy = false; controls(); } }
  }
  async function retrySelected() {
    if (!live() || detailBusy || !canRetry(detail?.event)) return;
    const eventId = selected, own = ++detailRequest; detailBusy = true; detailStatus.textContent = ''; detailMessage.textContent = ''; controls();
    try {
      await api(`/api/repositories/${id}/dispatch/${encodeURIComponent(eventId)}/retry`, 'POST', {});
      if (!live() || own !== detailRequest || selected !== eventId) return;
      detailStatus.textContent = '已请求重试，仍使用同一条分派记录。'; detail = null; detailBusy = false; controls(); await readDetail(eventId); void load(false);
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
  return event.state === 'filtered' ? '被过滤' : event.state === 'decided' ? decisionNames[event.decision]?.[0] || '已决定，结果未识别' : event.state === 'failed' ? '等待人工重试' : event.state === 'dispatching' ? 'Manager 处理中' : event.state === 'pending' ? '等待或自动重试' : '未识别的分派状态';
}
function dispatchEntry(event, open) {
  const item = element('li', '', 'manager-dispatch-entry'), head = element('div', '', 'manager-dispatch-head');
  head.append(element('strong', dispatchEventNames[event.type] || event.type), badge(dispatchState(event), event.state === 'failed' ? 'danger' : event.state === 'decided' ? 'success' : 'warning'), element('span', timestamp(event.created_at), 'muted'));
  item.dataset.dispatchEvent = event.id; item.append(head, element('p', event.summary));
  if (event.reason) item.append(note('理由：' + event.reason));
  if (event.error) item.append(note('最近失败：' + event.error.code));
  if (event.refusals?.length) item.append(note(`控制面拒绝 ${event.refusals.length} 次：` + event.refusals.at(-1).reason));
  if (event.rule) item.append(note(`按常设规则 ${event.rule.id}（第 ${event.rule.revision} 版）分派，没有调用模型`));
  item.append(button('查看分派详情', () => open(event), 'quiet')); return item;
}

// The repository's skills, the only files the bot reads from the repository (#935). The rule texts are the prompt's
// sections above, the labels are project settings; a repository that still has .bot/ files is told they can go.
function repositorySkillsCard() {
  const section = card('仓库 skill');
  section.dataset.overviewAnchor = 'rule-sources';
  const draw = flash => {
    const skills = (current.rules?.files || []).filter(file => file.path.startsWith('.agents/skills/')), message = element('p', flash || '', flash ? 'view-success flash' : '');
    if (flash) message.setAttribute('role', 'status');
    const nodes = [note('检视、开发等职责规则在各角色的提示词里维护，分派规则在上面 Manager 提示词里维护；检视和开发标签的名字在「项目设置 → 基本」里修改。每个任务读取默认分支 .agents/skills/ 下的 skill：skill 只指导本仓库的工作，不能放宽权限或改变平台规则。'), ruleSync(), ...(flash ? [message] : [])];
    if (current.rules?.retired_files?.length) nodes.push(retiredRulesNotice());
    if (!skills.length) nodes.push(note(!current.rules ? '暂时读不到仓库 skill。' : !current.rules.sha ? '尚未读取默认分支，还不知道有哪些 skill。' : '默认分支没有 .agents/skills/ 下的 skill。'));
    else {
      const { table, body } = projectTable(['skill', '文件', '操作'], '仓库 skill');
      for (const { path } of skills) {
        const row = document.createElement('tr'); row.dataset.ruleFile = path;
        tableCell(row, 'skill', element('strong', path.replace(/^\.agents\/skills\/|\/SKILL\.md$/g, ''))); tableCell(row, '文件', element('code', path));
        tableCell(row, '操作', button('查看内容', () => openProjectRule(path), 'quiet')); body.append(row);
      }
      nodes.push(table);
    }
    const detail = element('section', '', 'project-inline-detail'); detail.id = 'project-detail'; detail.hidden = true; detail.setAttribute('role', 'region');
    nodes.push(detail);
    section.replaceChildren(section.firstChild, ...nodes);
  };
  section.redraw = draw; draw(); return section;
}
// What the upgrade that retired the .bot/ files imported into this project (#935), and what it could not.
function ruleImportCard(imported) {
  const section = card('.bot/ 规则文件导入记录');
  section.dataset.overviewAnchor = 'rule-import';
  const labels = imported.labels || {};
  section.append(note(imported.files?.length ? `升级时（${timestamp(imported.imported_at)}）把默认分支提交 ${String(imported.sha || '').slice(0, 12)} 上的仓库规则文件迁入了角色配置，导入前后行为相同。` : `升级时（${timestamp(imported.imported_at)}）仓库没有要导入的 .bot/ 规则文件；原有的控制台规则保留在 Manager 提示词里。`),
    facts([['导入的文件', (imported.files || []).join('、') || '无'], ['写入的 Manager 章节', (imported.sections || []).join('、') || '无'],
      ['检视标签', labels.review_label || '不加标签'], ['开发标签', labels.development_label || '—'], ['机器配置字段', (imported.computer || []).join('、') || '无']]));
  if (imported.warnings?.length) { const list = element('ul', '', 'history'); for (const warning of imported.warnings) list.append(element('li', warning)); section.append(element('h4', '需要留意'), list); }
  return section;
}

function migrationCard(migration) {
  const section = card('升级迁移记录'), report = migration.report || {};
  section.dataset.overviewAnchor = 'manager-migration';
  if (report.issue === 1122) {
    const mapped = Object.entries(report.mapped_models || {}).map(([roleId, m]) => `${roleId} ← ${m.from}`).join('、') || '无';
    section.append(
      note(`升级时（${timestamp(migration.migrated_at)}）已退役固定工作类型配置，并将原有的自定义规则与模型映射至对应角色配置；原始快照保存在迁移档案里。`),
      facts([
        ['已迁移规则章节', (report.migrated_sections || []).join('、') || '无额外自定义覆盖'],
        ['已映射角色模型', mapped],
        ['已归档工作类型开关', (report.retired_work_settings || []).join('、') || '无'],
      ]),
    );
  } else {
    section.append(note(`升级时（${timestamp(migration.migrated_at)}）原来的工作流配置迁入了 Manager 提示词第 ${report.manager_revision || 1} 版和项目配置；原工作流记录保存在迁移档案里。`),
      facts([['保留的任务规则', (report.sections || []).join('、') || '无额外覆盖'], ['原自定义工作流', (report.custom_workflows || []).map(w => `${w.name}（${w.enabled ? '开' : '关'}）`).join('、') || '无']]));
  }
  if (report.warnings?.length) { const list = element('ul', '', 'history'); for (const warning of report.warnings) list.append(element('li', warning)); section.append(element('h4', '需要留意'), list); }
  return section;
}
