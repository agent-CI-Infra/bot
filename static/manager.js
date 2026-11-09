// The Manager half of the project's 「Manager 与角色」 page (#/projects/<id>/roles): the Manager prompt, the project's
// only flow definition; the work types with their switch and writes; which events reach the Manager; its latest
// decisions; and where the rule sections' text comes from. Loaded after project.js and reuses its helpers.
// Nothing here grants anything by text: writes come only from the work type table, and the control plane performs them.

const managerErrors = {
  manager_revision_conflict: 'Manager 配置已被别人修改，请刷新页面后再保存。', unknown_manager_section: '章节 id 不认识：二级标题末尾反引号里的 id 要用下面列出的章节。',
  duplicate_manager_section: '同一个章节出现了两次。', invalid_bot_label: '章节里的标签声明不合法（最长 50 个字符，首尾不能有空白）。',
  invalid_work_writes: '写入不在这类工作可选的范围里，或开 PR 时没有同时允许修改代码。', invalid_event_filters: '事件开关或标签不合法（标签最长 50 个字符，最多 30 个）。',
  management_approval_required: '这次修改需要审批，已提交审批请求。'
};
// api() reports "<status> · <code>"; a known code gets its explanation.
const managerError = err => { const code = /· (\w+)$/.exec(err.message)?.[1] ?? err.message; return managerErrors[code] ? `${managerErrors[code]}（${code}）` : err.message; };
const eventCaptions = [['issue.opened', 'Issue 打开'], ['issue.updated', 'Issue 修改或可信评论'], ['issue.mention', 'Issue 评论提到 bot'], ['issue.development_label', '有人加上开发标签'],
  ['pull_request.opened', 'PR 打开或 Ready for review'], ['pull_request.synchronize', 'PR 推送新提交'], ['pull_request.updated', 'PR 修改、讨论或检视'], ['pull_request.mention', 'PR 评论提到 bot'],
  ['review.published.issue', 'Issue 检视发布（可能开始开发）'], ['review.published.pr', 'bot PR 检视发布（可能修订 PR）']];
const dispatchEventNames = { 'issue.opened': 'Issue 打开', 'issue.updated': 'Issue 更新', 'issue.mention': 'Issue 提及', 'issue.labeled': 'Issue 加标签', 'pull_request.opened': 'PR 打开',
  'pull_request.synchronize': 'PR 推送', 'pull_request.updated': 'PR 讨论', 'pull_request.mention': 'PR 提及', 'pull_request.labeled': 'PR 加标签', 'review.published': '检视发布',
  'release.manual': '发版本', 'actions.run_failed': 'Actions 失败', 'gate.manual': '接入门禁', 'schedule.due': '定时检查' };
const decisionNames = { create: ['新建任务', 'success'], continue: ['续接任务', 'info'], ignore: ['不处理', ''] };
// The role coordination entry of a work type; other work types always keep their executor.
const workEntries = { 'review.issue': 'review', 'review.pr': 'review', 'development.issue': 'development', 'development.pr': 'development', 'actions.failures': 'actions', 'task.request': 'request' };

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
  return [...(notice ? [Object.assign(element('p', notice, 'view-success flash'), { role: 'status' })] : []), managerPromptCard(manager, refresh), workTypesCard(manager, roles, refresh),
    eventFiltersCard(manager, refresh), dispatchCard(), managerRulesCard(), ...(manager.migration ? [migrationCard(manager.migration)] : [])];
}

function managerPromptCard(manager, refresh) {
  const section = card('Manager 提示词'), prompt = manager.prompt, form = document.createElement('form'), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'manager-prompt'; form.className = 'project-form manager-prompt'; message.setAttribute('role', 'alert');
  section.append(note('这是项目唯一的流程定义：每个事件交给 Manager 时，它按「分派」章节决定新建任务、续接已有任务还是不处理；各类工作的任务按自己的章节执行。提示词只描述流程，不能授予写入，写入只看下面的工作类型配置。'),
    facts([['版本', prompt.revision ? `第 ${prompt.revision} 版` : '还没有保存过（全部使用内置文本）'], ['保存时间', prompt.updated_at ? timestamp(prompt.updated_at) : null],
      ['来源', prompt.source === 'migration' ? '升级迁移（原工作流配置）' : prompt.source === 'rules' ? '规则文件接口' : prompt.source ? '控制台' : null]]));
  const editor = textarea('content', prompt.content, { rows: 18, spellcheck: false, className: 'code' });
  editor.setAttribute('aria-label', 'Manager 提示词'); current.managerEditor = { editor, initial: prompt.content };
  // Each section starts with a level-2 heading that ends with its id in backticks; an unwritten section uses its built-in text.
  const list = element('ul', '', 'manager-sections');
  for (const entry of manager.sections) {
    const item = element('li', ''), head = element('div', '', 'manager-section-head');
    head.append(element('strong', entry.title), element('code', entry.id), badge({ repository: '仓库文件', console: '项目已写', builtin: '内置文本' }[entry.effective_source], entry.effective_source === 'builtin' ? '' : 'info'));
    if (entry.path) head.append(element('span', entry.path, 'muted'));
    item.dataset.managerSection = entry.id; item.append(head);
    if (entry.effective_source === 'repository') item.append(note('默认分支的仓库文件整份替换这一章，项目写的内容在仓库删掉该文件后才生效。'));
    if (entry.builtin) item.append(collapsible(entry.written ? '内置文本（已被项目覆盖）' : '内置文本（当前生效）', entry.builtin));
    if (!entry.written) item.append(button('插入这一章开始改写', () => {
      const text = `## ${entry.title} \`${entry.id}\`\n\n${entry.builtin || ''}`.trimEnd() + '\n';
      editor.value = (editor.value.trimEnd() ? editor.value.trimEnd() + '\n\n' : '') + text; editor.focus(); editor.scrollTop = editor.scrollHeight;
    }));
    list.append(item);
  }
  const submit = element('button', '保存提示词'), actions = element('div', '', 'actions form-actions'); submit.type = 'submit'; actions.append(submit);
  form.append(field('提示词（Markdown）', editor), message, actions);
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; message.textContent = '';
    try { await saveManagerChange({ content: editor.value }); await refresh('已保存 Manager 提示词，之后的分派和新任务使用新版本'); }
    catch (err) { message.textContent = managerError(err); submit.disabled = false; }
  });
  // The sections fold away; the prompt above stays the place where the text is edited.
  const written = manager.sections.filter(entry => entry.written).length, details = element('details', '', 'manager-section-list'), summary = element('summary', `章节与内置文本（${manager.sections.length} 章，项目已写 ${written} 章）`);
  details.append(summary, note('二级标题末尾用反引号写章节 id，例如 ## 检视 Issue `review.issue`；没写的章节使用内置文本。检视、开发、标签和行为指南几章是对应 .bot 规则文件的控制台层。'), list);
  section.append(form, details);
  return section;
}

// A rule file saved on this page (its card below) writes a section of the prompt: the editor takes the new text unless the
// person has started editing it, and later saves use the new revision.
async function managerChanged() {
  const id = current?.id; if (!id || current.section !== 'roles' || !current.manager) return;
  try {
    const { manager } = await api(`/api/repositories/${id}/manager`); if (current?.id !== id) return;
    current.manager = manager; const held = current.managerEditor;
    if (held && held.editor.value === held.initial) { held.editor.value = manager.prompt.content; held.initial = manager.prompt.content; }
  } catch { /* The next visit reads it again. */ }
}
// Who executes a work type's tasks now, from the project's role configuration.
function workExecution(work, roles) {
  const config = roles?.configuration; if (!config) return '';
  const entry = workEntries[work.id], coordinated = !!entry && config.enabled && config.controller.entries[entry] === true;
  if (!coordinated) return `原来的执行器：项目电脑里的 Pi 进程${entry ? '（这个入口没有接入主控）' : ''}。完成前由独立 QA 验收。`;
  const controller = config.roles.find(role => role.role_id === config.controller.role), executor = controller ? roleExecutor(controller, config) : null;
  const head = `主控 Manager（${executor ? executor.name + (executor.legacy ? '，旧配置沿用' : '') : '未配置'}）`;
  return ['development', 'request'].includes(entry) ? `${head}按需委派已启用的 ${workerNames(entryWorkers(config, entry))}。候选由主控提名后交给独立 QA 验收。`
    : `${head}${entryDevText(config)}；这个入口不委派 Test、Reviewer、UX。候选由主控提名后交给独立 QA 验收。`;
}
function workModelName(work) {
  const id = work.model.id || work.model.default_id, model = current.models.find(entry => entry.id === id);
  const name = model ? model.model_name : id ? `模型不可用（${id}）` : '未选择';
  return work.model.inherited ? `${name} · 继承项目默认` : name;
}
function workTypesCard(manager, roles, refresh) {
  const section = card('工作类型：开关、写入与设置'), form = document.createElement('form'), message = element('p', '', 'view-error'), policy = current.policy;
  section.dataset.overviewAnchor = 'work-types'; form.className = 'project-form'; message.setAttribute('role', 'alert');
  section.append(note('Manager 只能新建这里开着的工作，任务能做的写入以这里勾选的为准；Manager 可以为单个任务再收窄，但不能扩大。所有写入都由控制面用 App 令牌完成，agent 只拿得到只读令牌。读取（工作区、命令、项目笔记、独立 agent、GitHub 只读）不限制。'));
  const { table, body } = projectTable(['工作类型', '开关', '允许的写入', '模型与执行'], '工作类型');
  for (const work of manager.work) {
    const row = document.createElement('tr'); row.dataset.workType = work.id;
    const state = work.active ? badge('运行中', 'success') : !work.enabled ? badge('已关闭', 'warning') : badge(work.project_switch && !work.project_switch.on ? work.project_switch.title + '已关' : '项目已禁用', 'warning');
    tableCell(row, '工作类型', element('strong', work.name), element('code', work.id), state, element('p', work.description, 'muted'));
    const switches = element('div', '', 'manager-writes'); switches.append(checkbox('enabled:' + work.id, work.enabled, '开启'));
    // A restriction the upgrade kept from the old trigger lists: lifting it offers this work on every event that reaches the Manager.
    if (work.events) switches.append(checkbox('events:' + work.id, true, '只在这些事件上提供：' + work.events.map(type => dispatchEventNames[type] || type).join('、')));
    tableCell(row, '开关', switches);
    const writes = element('div', '', 'manager-writes');
    if (!work.write_options.length) writes.append(element('span', '不写 GitHub', 'muted'));
    for (const option of work.write_options) {
      const box = checkbox(`write:${work.id}:${option.id}`, work.writes.includes(option.id), option.title + (option.locked ? '（固定）' : ''));
      box.querySelector('input').disabled = option.locked; box.title = `${option.tool}：${option.detail}`; writes.append(box);
    }
    const models = element('a', '改模型'); models.href = `#/projects/${current.id}/model`;
    tableCell(row, '允许的写入', writes);
    tableCell(row, '模型与执行', element('span', workModelName(work)), ' ', models, element('p', workExecution(work, roles), 'muted'));
    body.append(row);
  }
  // Settings that belong to a family of work types live beside them, as they did in the workflows' editor.
  const language = document.createElement('select'); language.name = 'review_language';
  for (const [value, caption] of [['auto', '跟随 Issue／PR 的语言'], ['zh', '简体中文'], ['en', 'English']]) modelOption(language, value, caption);
  language.value = policy.review_language || 'auto';
  const actions = element('p', '', 'muted'); actions.dataset.actionsStatus = ''; actions.setAttribute('role', 'status');
  // A switched-off Actions failure handling reports nothing else: an old scan error no longer matters.
  if (policy.actions_failures_enabled) showActionsFailureStatus(actions, current.actionsFailures); else actions.textContent = '未开启。';
  const submit = element('button', '保存工作类型'), buttons = element('div', '', 'actions form-actions'); submit.type = 'submit'; buttons.append(submit);
  form.append(table, element('h4', '检视'), field('评论语言', language), element('h4', '开发'),
    field('测试命令', input('test_command', policy.test_command || '', { maxLength: 2048, placeholder: '如 npm test；留空时使用模型给出的命令' })),
    field('bot PR 自动修订轮数', input('max_revisions', policy.max_revisions, { type: 'number', min: 0, max: 10, step: 1 })),
    note('控制面在发布前运行测试命令，测试失败不推分支、不开 PR。开发标签、Issue 无人指派、发布前复核这些条件由控制面检查，提示词关不掉。'),
    element('h4', 'Actions 失败处理'), actions, message, buttons);
  // Opening a PR needs the code write: ticking it brings code along, unticking code drops it.
  form.addEventListener('change', event => {
    const match = /^write:(.+):(code|pull_request)$/.exec(event.target.name || ''); if (!match) return;
    const pr = form.elements[`write:${match[1]}:pull_request`], code = form.elements[`write:${match[1]}:code`];
    if (match[2] === 'pull_request' && pr.checked && code && !code.disabled) code.checked = true;
    if (match[2] === 'code' && !code.checked && pr && !pr.disabled) pr.checked = false;
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); submit.disabled = true; message.textContent = '';
    try {
      const work = {};
      for (const type of manager.work) {
        const enabled = form.elements['enabled:' + type.id].checked, writes = type.write_options.filter(option => form.elements[`write:${type.id}:${option.id}`].checked).map(option => option.id);
        const delta = {};
        if (enabled !== type.enabled) delta.enabled = enabled;
        if ([...writes].sort().join() !== [...type.writes].sort().join()) delta.writes = writes;
        if (type.events && !form.elements['events:' + type.id].checked) delta.events = null;
        if (Object.keys(delta).length) work[type.id] = delta;
      }
      if (Object.keys(work).length) await saveManagerChange({ work });
      const settings = changed({ review_language: language.value, test_command: form.elements.test_command.value, max_revisions: Number(form.elements.max_revisions.value) },
        { review_language: policy.review_language || 'auto', test_command: policy.test_command || '', max_revisions: policy.max_revisions });
      if (Object.keys(settings).length) await patchPolicy(settings);
      // Switches change the project policy (Actions failure handling) and its status polling, so the page loads again.
      await reloadWith('已保存工作类型');
    } catch (err) { message.textContent = managerError(err); submit.disabled = false; }
  });
  section.append(form); return section;
}

function eventFiltersCard(manager, refresh) {
  const section = card('交给 Manager 的事件'), form = document.createElement('form'), message = element('p', '', 'view-error'), events = manager.events;
  section.dataset.overviewAnchor = 'manager-events'; form.className = 'project-form'; message.setAttribute('role', 'alert');
  section.append(note(`草稿、已关闭的对象、bot 自己写的内容和仓库外人员的评论始终不会交给 Manager。这里关掉的事件同样不会到达 Manager，也不会产生分派调用；开着的事件每个都调用一次 Manager 模型。提到 bot 指评论里写了 ${manager.mention_names.map(name => '@' + name).join('、') || '（部署关闭了提及）'}。`));
  const boxes = element('div', '', 'manager-events');
  for (const [key, caption] of eventCaptions) boxes.append(checkbox('event:' + key, events[key], caption));
  const labels = (key, caption) => field(caption, input(key, events[key].join(', '), { placeholder: '逗号分隔；留空表示加标签不交给 Manager' }));
  const submit = element('button', '保存事件开关'), buttons = element('div', '', 'actions form-actions'); submit.type = 'submit'; buttons.append(submit);
  form.append(boxes, labels('issue.labels', '有人给 Issue 加上这些标签时'), labels('pull_request.labels', '有人给 PR 加上这些标签时'), message, buttons);
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
  // The known rule files first, then the repository's other files (its skills), except the release notes Skill of its own page.
  const paths = [...ruleFiles.map(([rule]) => rule), ...(current.rules?.files || []).map(file => file.path).filter(path => !ruleFiles.some(([rule]) => rule === path) && path !== releaseNotesSkill)];
  section.dataset.overviewAnchor = 'rule-sources';
  section.append(note('优先级是内置文本 → Manager 提示词里的章节 → 默认分支仓库文件，每层整份替换。仓库 skill 和虚拟电脑配置也来自默认分支。'), ruleSync());
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
    facts([['迁入的章节', (report.sections || []).join('、') || '无（全部使用内置文本）'], ['原自定义工作流', (report.custom_workflows || []).map(w => `${w.name}（${w.enabled ? '开' : '关'}）`).join('、') || '无']]));
  if (report.warnings?.length) { const list = element('ul', '', 'history'); for (const warning of report.warnings) list.append(element('li', warning)); section.append(element('h4', '需要留意'), list); }
  return section;
}
