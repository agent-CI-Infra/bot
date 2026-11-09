// The Manager role page: one complete prompt, event filters, decisions and task rule sources.

const managerErrors = {
  manager_revision_conflict: 'Manager 配置已被别人修改，请刷新页面后再保存。', unknown_manager_section: '章节 id 不认识：二级标题末尾反引号里的 id 要用下面列出的章节。',
  duplicate_manager_section: '同一个章节出现了两次。', invalid_bot_label: '章节里的标签声明不合法（最长 50 个字符，首尾不能有空白）。',
  invalid_work_writes: '写入不在这类工作可选的范围里，或开 PR 时没有同时允许修改代码。', invalid_event_filters: '事件开关或标签不合法（标签最长 50 个字符，最多 30 个）。',
  management_approval_required: '这次修改需要审批，已提交审批请求。'
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

// The Manager's latest decisions, newest first: what came in, what it decided and why, and the tasks it touched.
function dispatchCard() {
  const section = card('最近的分派'), list = element('ol', '', 'manager-dispatch'), more = element('div', '', 'actions'), id = current.id;
  section.dataset.overviewAnchor = 'manager-dispatch';
  section.append(note('每个事件只分派一次；失败的分派会自动重试，多次失败后停在这里等人重试。任务详情里也能看到它因哪个事件新建或续接。'), list, more);
  let offset = 0;
  const load = async () => {
    try {
      const page = await api(`/api/repositories/${id}/dispatch?limit=20&offset=${offset}`); if (current?.id !== id) return;
      if (!offset && !page.events.length) list.replaceChildren(element('li', '还没有事件交给 Manager。', 'muted'));
      for (const event of page.events) list.append(dispatchEntry(event, () => { offset = 0; list.replaceChildren(); void load(); }));
      offset += page.events.length; more.replaceChildren(...(page.has_more ? [button('更早的分派', () => void load())] : []));
    } catch (err) { list.replaceChildren(element('li', err.message, 'view-error')); }
  };
  void load(); return section;
}
function dispatchEntry(event, reload) {
  const item = element('li', '', 'manager-dispatch-entry'), head = element('div', '', 'manager-dispatch-head');
  const [decision, tone] = decisionNames[event.decision] || [];
  head.append(element('strong', dispatchEventNames[event.type] || event.type), event.state === 'decided' ? badge(decision, tone) : event.state === 'failed' ? badge('分派失败', 'danger') : badge('等待 Manager', 'warning'),
    element('span', timestamp(event.created_at), 'muted'));
  item.dataset.dispatchEvent = event.id; item.append(head, element('p', event.summary));
  if (event.reason) item.append(element('p', '理由：' + event.reason, 'muted'));
  if (event.brief?.goal) item.append(element('p', '简要说明：' + event.brief.goal + (event.brief.criteria?.length ? '（' + event.brief.criteria.join('；') + '）' : ''), 'muted'));
  const tasks = [...(event.result?.created || []).map(task => ['新建', task]), ...(event.result?.continued || []).map(task => ['续接', task])];
  if (tasks.length) { const links = element('div', '', 'actions'); for (const [caption, task] of tasks) links.append(button(`${caption}的任务 ${task.slice(0, 8)}`, () => openTask(task))); item.append(links); }
  if (event.error) item.append(element('p', `最近一次失败：${event.error.code}${event.error.detail ? '：' + event.error.detail : ''}`, event.state === 'failed' ? 'view-error' : 'muted'));
  if (event.state === 'failed') item.append(button('重试分派', async () => { try { await api(`/api/repositories/${current.id}/dispatch/${event.id}/retry`, 'POST', {}); reload(); } catch (err) { item.append(element('p', err.message, 'view-error')); } }));
  return item;
}

// Where the rule sections' text comes from: repository files on the default branch replace the console layer.
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
