// Workflows page (#/projects/<id>/workflows/<item>). Every workflow, built-in or added here, has the same parts: a name, a
// switch, triggers, a prompt (whose ```mermaid flowchart is drawn here, with the triggers on its left), writes and a
// model. Reading is open to every workflow; each write is a platform tool the agent may call, chosen here. The page lists
// the workflows on the left and edits the selected one on the right, in tabs; a floating assistant drafts triggers, prompt
// and writes, and nothing takes effect until the administrator saves. Unsaved edits and assistant conversations are kept in this browser
// per project and workflow, so leaving the page loses neither. Loaded after project.js.

// The first ```mermaid flowchart block of a prompt: nodes in order of appearance, and every edge with its label.
// Only what a step diagram needs is read: `id[label]` (also `(label)`, `{label}`), chains of `-->`, `==>`, `-.->`,
// `---`, and labels written `-->|label|` or `-- label -->`.
function parseFlow(text) {
  const block = /```mermaid[^\n]*\n([\s\S]*?)```/.exec(String(text || ''));
  if (!block) return null;
  const lines = block[1].split(/\n|;/).map(line => line.replace(/%%.*$/, '').trim()).filter(Boolean);
  if (!lines.length || !/^(flowchart|graph)\b/.test(lines[0])) return null;
  const nodes = new Map(), edges = [];
  const node = token => {
    const match = /^([\wÀ-￿-]+)\s*(?:\[\(?"?([^\]"]*?)"?\)?\]|\(\(?"?([^)"]*?)"?\)?\)|\{"?([^}"]*?)"?\})?$/.exec(token.trim());
    if (!match) return null;
    const [, id, square, round, curly] = match, label = (square ?? round ?? curly ?? '').trim();
    if (!nodes.has(id)) nodes.set(id, { id, label: label || id }); else if (label) nodes.get(id).label = label;
    return id;
  };
  for (const line of lines.slice(1)) {
    if (/^(subgraph|end|classDef|class|style|linkStyle|click|direction)\b/.test(line)) continue;
    const parts = line.split(/\s*(--\s[^-]+?\s-->|-->\|[^|]*\||==>\|[^|]*\||-\.->\|[^|]*\||-->|==>|-\.->|---)\s*/);
    if (parts.length < 3) { node(line); continue; }
    let previous = node(parts[0]);
    for (let index = 1; index + 1 < parts.length; index += 2) {
      const arrow = parts[index], label = (/\|([^|]*)\|/.exec(arrow)?.[1] ?? /^--\s(.+?)\s-->$/.exec(arrow)?.[1] ?? '').trim();
      const next = node(parts[index + 1]);
      if (previous && next) edges.push({ from: previous, to: next, label });
      previous = next;
    }
  }
  return nodes.size ? { nodes: [...nodes.values()], edges } : null;
}
// The flow in words: the main path through consecutive steps, then every other edge with its label.
function flowText(flow) {
  if (!flow) return [];
  const order = flow.nodes.map(node => node.id), name = id => flow.nodes.find(node => node.id === id)?.label || id;
  const path = [order[0]], main = new Set();
  for (let index = 0; index + 1 < order.length; index++) {
    const edge = flow.edges.find(candidate => candidate.from === order[index] && candidate.to === order[index + 1]);
    if (!edge) break; path.push(order[index + 1]); main.add(edge);
  }
  return [path.map(name).join(' → '), ...flow.edges.filter(edge => !main.has(edge)).map(edge => `${name(edge.from)} → ${name(edge.to)}${edge.label ? '：' + edge.label : ''}`)];
}
let flowFigures = 0;
// Steps left to right; an edge to the next step is a straight arrow, an edge back (a review or test sending work back)
// arcs below the row and a jump forward arcs above it. The words of flowText are the figure's caption.
// `triggers` (the names of the workflow's triggers) are drawn as a column on the left feeding the first step: they come
// from the workflow's trigger list, not from the prompt, so they never appear in its mermaid block. A prompt without a
// flowchart still shows its triggers, feeding one step.
function flowFigure(flow, title = '流程图', triggers = null) {
  const figure = element('figure', '', 'workflow-flow'), missing = '这份提示词里没有流程图。在提示词里加一个 ```mermaid 代码块（以 flowchart LR 开头）即可在这里显示。';
  if (!flow && !triggers) { figure.append(element('p', missing, 'muted')); return figure; }
  const steps = flow || { nodes: [{ id: 'prompt', label: '按提示词执行' }], edges: [] };
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), marker = 'flow-arrow-' + (++flowFigures);
  const make = (tag, attributes, text) => { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
  const measure = (label, wide, narrow, pad) => [...label].reduce((sum, char) => sum + (/[⺀-￿]/.test(char) ? wide : narrow), 0) + pad;
  const width = label => Math.max(72, measure(label, 14, 7.6, 30));
  const index = new Map(steps.nodes.map((node, at) => [node.id, at])), boxes = [], gap = 48, height = 40;
  const edges = steps.edges.filter(edge => index.has(edge.from) && index.has(edge.to) && edge.from !== edge.to);
  const span = edge => index.get(edge.to) - index.get(edge.from), above = edges.filter(edge => span(edge) > 1), below = edges.filter(edge => span(edge) < 0);
  // The trigger column: pills stacked beside the row, with the caption 触发源 above them.
  const sources = triggers ? (triggers.length ? triggers : ['没有触发源']) : [], pill = 28, pillGap = 8;
  const pillWidth = sources.length ? Math.max(64, ...sources.map(label => measure(label, 12.5, 6.8, 24))) : 0, column = sources.length * pill + Math.max(0, sources.length - 1) * pillGap;
  const lift = above.length ? 34 + 20 * above.length : 12, top = sources.length ? Math.max(lift, 26) : lift, drop = below.length ? 40 + 24 * below.length : 12;
  const band = Math.max(height, column), rowY = top + (band - height) / 2, centre = rowY + height / 2, pillTop = top + (band - column) / 2;
  let x = sources.length ? 8 + pillWidth + 56 : 8;
  for (const node of steps.nodes) { const w = width(node.label); boxes.push({ x, w }); x += w + gap; }
  const total = x - gap + 8, tall = Math.max(top + band + 12, rowY + height + drop);
  svg.setAttribute('viewBox', `0 0 ${total} ${tall}`); svg.setAttribute('width', String(total)); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title + '：' + (triggers ? '触发源 ' + sources.join('、') + '；' : '') + (flow ? flowText(flow).join('；') : missing));
  const defs = make('defs', {}), head = make('marker', { id: marker, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  head.append(make('path', { d: 'M0,0 L10,5 L0,10 z', class: 'flow-arrowhead' })); defs.append(head); svg.append(defs);
  const label = (text, at, y) => { if (text) svg.append(make('text', { x: at, y, 'text-anchor': 'middle', class: 'flow-edge-label' }, text)); };
  if (sources.length) {
    svg.append(make('text', { x: 8 + pillWidth / 2, y: pillTop - 8, 'text-anchor': 'middle', class: 'flow-trigger-caption' }, '触发源'));
    sources.forEach((source, at) => {
      const y = pillTop + at * (pill + pillGap), none = !triggers.length;
      if (!none) svg.append(make('path', { d: `M${8 + pillWidth},${y + pill / 2} C${8 + pillWidth + 28},${y + pill / 2} ${boxes[0].x - 28},${centre} ${boxes[0].x - 2},${centre}`, class: 'flow-edge flow-trigger-edge', 'marker-end': `url(#${marker})` }));
      svg.append(make('rect', { x: 8, y, width: pillWidth, height: pill, rx: pill / 2, class: 'flow-trigger' + (none ? ' flow-trigger-none' : '') }));
      svg.append(make('text', { x: 8 + pillWidth / 2, y: y + pill / 2 + 4, 'text-anchor': 'middle', class: 'flow-trigger-label' }, source));
    });
  }
  edges.forEach(edge => {
    const from = boxes[index.get(edge.from)], to = boxes[index.get(edge.to)], step = span(edge);
    if (step === 1) {
      svg.append(make('line', { x1: from.x + from.w, y1: centre, x2: to.x - 2, y2: centre, class: 'flow-edge', 'marker-end': `url(#${marker})` }));
      label(edge.label, (from.x + from.w + to.x) / 2, centre - 8);
    } else {
      // A cubic whose control points sit at depth peaks three quarters of the way there; arcs of the same kind fan out.
      const back = step < 0, rank = (back ? below : above).indexOf(edge) + 1, depth = back ? rowY + height + 14 + 24 * rank : rowY - 14 - 20 * rank;
      const shift = (rank - 1) * 10 * (back ? 1 : -1), x1 = from.x + from.w / 2 + shift, x2 = to.x + to.w / 2 - shift, y = back ? rowY + height : rowY;
      svg.append(make('path', { d: `M${x1},${y} C${x1},${depth} ${x2},${depth} ${x2},${y + (back ? 2 : -2)}`, class: 'flow-edge' + (back ? ' flow-back' : ''), 'marker-end': `url(#${marker})` }));
      const apex = y + (depth - y) * 0.75;
      label(edge.label, (x1 + x2) / 2, back ? apex + 13 : apex - 5);
    }
  });
  steps.nodes.forEach((node, at) => {
    const box = boxes[at];
    svg.append(make('rect', { x: box.x, y: rowY, width: box.w, height, rx: 8, class: 'flow-node' + (flow ? '' : ' flow-node-missing') }));
    svg.append(make('text', { x: box.x + box.w / 2, y: centre + 5, 'text-anchor': 'middle', class: 'flow-node-label' }, node.label));
  });
  const scroll = element('div', '', 'workflow-flow-canvas'); scroll.append(svg);
  const caption = element('figcaption', ''), lines = flowText(flow);
  caption.append(element('strong', title + '：'), ...(triggers ? [element('span', '触发源 ' + sources.join('、') + ' →', 'flow-triggers')] : []), element('span', flow ? lines[0] : missing, 'flow-path'));
  for (const line of lines.slice(1)) caption.append(element('span', line, 'flow-loop'));
  figure.append(scroll, caption); return figure;
}

// What every workflow may read: all of them run in the project computer, on a checkout of the commit concerned.
const workflowReads = () => ['读取工作区', '运行命令', '写项目笔记', '启动独立 agent', '读取 GitHub'];
const githubReadScope = '代码、Issue、PR、Actions、检查和提交状态';
const workflowTabs = [['overview', '概览'], ['prompt', '提示词与流程'], ['access', '权限与模型']];
const workflowModelName = workflow => {
  const model = current.models.find(entry => entry.id === (workflow.model.id || workflow.model.default_id));
  const name = model ? model.model_name : (workflow.model.id || workflow.model.default_id) ? `模型不可用（${workflow.model.id || workflow.model.default_id}）` : '未选择';
  return workflow.model.inherited ? `${name} · 继承项目默认` : name;
};
const workflowById = id => current.workflows?.workflows.find(workflow => workflow.id === id);
async function reloadWorkflows() { current.workflows = await api(`/api/repositories/${current.id}/workflows`); return current.workflows; }
// Where a workflow's prompt comes from: the file that replaces it, the console, or built-in.
const promptLocation = workflow => workflow.prompt.source === 'repository' ? workflow.prompt.path : workflow.prompt.source === 'console' ? (workflow.prompt.path ? workflow.prompt.path + '（控制台）' : '控制台')
  : workflow.id === 'release.notes' ? 'release-notes-v1' : workflow.prompt.path || 'docs/prompts（内置）';
const workflowState = workflow => workflow.active ? badge('运行中', 'success') : !workflow.enabled ? badge('已关闭', 'warning')
  : badge(workflow.project_switch && !workflow.project_switch.on ? workflow.project_switch.title + '已关' : '项目已禁用', 'warning');
// A trigger as the flowchart names it: its short name, with the label of a label trigger.
const triggerName = (options, trigger) => { const option = options.find(entry => entry.id === trigger.id); return (option?.short || option?.title || trigger.id) + (trigger.label ? '：' + trigger.label : option?.fixed_label ? '：' + option.fixed_label : ''); };
// The selected item: a workflow id, 'new' for a workflow being added, or one of the shared rule pages.
const sharedItems = [['rules.guide', '行为指南', '.bot/guide.md'], ['rules.labels', '检视标签', '.bot/rules/labels.md'], ['rules.files', '其他规则文件', null]];
function workflowItem() {
  const item = current.workflowItem;
  return item === 'new' || sharedItems.some(([id]) => id === item) || workflowById(item) ? item : current.workflows.workflows[0].id;
}
// Selecting an item redraws only this page; the address changes so it can be shared and reloaded.
function selectWorkflowItem(item, options = {}) {
  current.workflowItem = item; current.workflowTab = options.tab || 'overview';
  history.pushState(null, '', `#/projects/${current.id}/workflows/${item}`);
  drawWorkflowPage(options);
  // On a narrow screen the list sits above the editor: bring the chosen item into view.
  if (matchMedia('(max-width: 820px)').matches) $('workflow-detail')?.scrollIntoView({ block: 'start' });
}
function workflowsSection() {
  const page = element('div', '', 'workflow-page'); page.id = 'workflow-page';
  if (!current.workflows) { page.append(element('p', '暂时读不到工作流配置，稍后刷新重试。', 'view-error')); return [page]; }
  fillWorkflowPage(page); return [page];
}
const drawWorkflowPage = (options = {}) => { const page = $('workflow-page'); if (page) fillWorkflowPage(page, options); };
function fillWorkflowPage(page, options = {}) {
  const detail = element('section', '', 'workflow-detail'); detail.id = 'workflow-detail';
  page.replaceChildren(workflowSidebar(workflowItem()), detail); fillWorkflowDetail(detail, options);
}
function fillWorkflowDetail(detail, { notice = '', chat = false } = {}) {
  const item = workflowItem(), workflow = workflowById(item), shared = sharedItems.find(([id]) => id === item);
  detail.setAttribute('aria-label', shared ? shared[1] : workflow ? '工作流：' + workflow.name : '新增工作流');
  detail.replaceChildren(...(shared ? sharedDetail(shared) : workflowEditor(workflow, { notice })));
  if (chat && !shared) openWorkflowAssistant(item);
  // The Actions failure status (subscription, pause reasons) keeps refreshing while its editor is open.
  if (item === 'actions.failures' && current.policy.actions_failures_enabled) { clearTimeout(projectTimer); const token = renderToken; projectTimer = setTimeout(() => refreshActionsFailureStatus(token), 5000); }
}
// A workflow is an entry point: when it runs, which prompt and model it uses, which writes it may make. What one task
// must achieve, who works on it and how it is accepted belong to the task and the 角色 page, so the list does not invite
// a new workflow per task; adding one stays available, below the list, for a new trigger.
function workflowSidebar(selected) {
  const side = element('aside', '', 'workflow-sidebar'), head = element('div', '', 'workflow-sidebar-head');
  side.setAttribute('aria-label', '工作流列表');
  head.append(element('h2', '工作流'), note('每条工作流只决定什么时候运行、用哪份提示词和模型、允许哪些写入。任务的目标、分工和验收记在任务里，不需要为单个任务新写工作流。'));
  const add = element('div', '', 'workflow-add'), actions = element('div', '', 'actions');
  actions.append(button('新增工作流', () => selectWorkflowItem('new')), button('用聊天新增', () => selectWorkflowItem('new', { chat: true })));
  add.append(element('h3', '新的触发入口'), note('只有现有工作流接不住的新触发条件（例如另一个标签或事件）才需要新增。'), actions);
  side.append(head, workflowLists(selected), add, ruleSync());
  return side;
}
// The workflows and the shared rules; redrawn in place when the default branch is read again.
function workflowLists(selected) {
  const lists = element('div', '', 'workflow-lists'), list = element('ul', '', 'workflow-list');
  const entry = (item, title, ...extra) => {
    const li = element('li'), link = element('a', ''); link.href = `#/projects/${current.id}/workflows/${item}`; link.dataset.workflowItem = item;
    link.append(element('strong', title), ...extra); if (item === selected) link.setAttribute('aria-current', 'page');
    link.addEventListener('click', event => { event.preventDefault(); selectWorkflowItem(item); });
    li.append(link); return li;
  };
  for (const workflow of current.workflows.workflows) {
    const flow = flowText(parseFlow(workflow.prompt.effective))[0], meta = element('span', '', 'workflow-list-meta');
    meta.append(workflowState(workflow), ...(workflow.builtin ? [] : [badge('自定义', 'info')]), ...(storedEditor(current.id, workflow.id) ? [badge('未保存', 'warning')] : []));
    list.append(entry(workflow.id, workflow.name, meta, element('span', flow || '没有流程图', 'flow-path')));
  }
  // A workflow being added stays in the list while it has unsaved contents, so leaving the page does not lose it.
  const added = storedEditor(current.id, 'new');
  if (selected === 'new' || added) list.append(entry('new', added?.name?.trim() || '新工作流', element('span', added ? '未保存的草稿' : '尚未保存', 'muted')));
  const rules = element('ul', '', 'workflow-list shared');
  for (const [item, title, path] of sharedItems) rules.append(entry(item, title, ...(path ? [ruleSource(path)] : [])));
  lists.append(list, element('h3', '共用规则'), rules);
  return lists;
}
// The shared rule files: the behavior guide for every workflow, the labels of both reviews, and the other files.
function sharedDetail([item, title, path]) {
  const head = element('div', '', 'workflow-detail-head'); head.append(element('h2', title));
  if (path) return [head, note(path === '.bot/guide.md' ? '每条工作流的 agent 都先读这份行为指南。' : '两条检视工作流选分类标签、加检视标签时使用。'), ruleCard(path)];
  const others = current.rules?.files.filter(file => file.path === '.bot/computer.yaml' || !ruleFiles.some(([rule]) => rule === file.path) && file.path !== releaseNotesSkill) || [];
  const { table, body } = projectTable(['文件', '作用', '规则来源', '操作'], '其他规则文件');
  for (const file of others) {
    const row = document.createElement('tr'), [, purpose, task, target] = ruleInfo(file.path); row.dataset.ruleFile = file.path;
    tableCell(row, '文件', element('strong', purpose)); tableCell(row, '作用', task); tableCell(row, '规则来源', ruleSource(file.path), element('code', file.path));
    if (target === 'machine') { const link = element('a', '查看机器配置'); link.href = `#/projects/${current.id}/machine`; tableCell(row, '操作', link); }
    else tableCell(row, '操作', button('展开规则', () => openProjectRule(file.path), 'quiet'));
    body.append(row);
  }
  const detail = element('section', '', 'project-inline-detail'); detail.id = 'project-detail'; detail.hidden = true; detail.setAttribute('role', 'region');
  return [head, note('虚拟电脑配置和仓库 skill 来自默认分支；规则优先级是内置默认 → 项目控制台 → 默认分支仓库文件。'), others.length ? table : note('默认分支上没有其他规则文件。'), detail];
}
// After the default branch is read again, prompt sources change in place; an open editor keeps its draft.
async function refreshWorkflowTable() {
  if (current?.section !== 'workflows' || !$('workflow-page')) return;
  try {
    await reloadWorkflows();
    document.querySelector('.workflow-sidebar .workflow-lists')?.replaceWith(workflowLists(workflowItem()));
    // A workflow editor nobody has touched shows the new sources; one with unsaved changes keeps them and only updates its
    // source line. A shared rule card redraws itself after its own save, so it is left alone here.
    const detail = $('workflow-detail'), form = detail?.querySelector('form.workflow-editor');
    if (!workflowById(workflowItem())) return;
    if (detail && !form?.dataset.dirty) { fillWorkflowDetail(detail); return; }
    const workflow = workflowById(workflowItem()), meta = detail?.querySelector('[data-prompt-meta]');
    if (workflow && meta) meta.replaceChildren(...promptMeta(workflow));
  } catch { /* The next visit reloads the page. */ }
}
// After the default branch is read again, a shared rule card that is only being read shows the new text.
function redrawSharedRule() {
  const shared = sharedItems.find(([id]) => id === current?.workflowItem), card = $('workflow-detail')?.querySelector('.rule-card');
  if (current?.section === 'workflows' && shared?.[2] && card && !card.querySelector('form')) card.replaceWith(ruleCard(shared[2]));
}
const promptMeta = workflow => [badge('生效：' + layerNames[workflow.prompt.source], workflow.prompt.source === 'builtin' ? '' : 'info'), element('code', promptLocation(workflow))];

// One editor for every workflow, in tabs; the chat opens beside it. A built-in workflow writes each part where it always
// lived; a custom one is one record.
function workflowEditor(workflow, { chat, notice }) {
  const custom = !workflow?.builtin, catalog = current.workflows.triggers;
  const options = workflow?.trigger_options || catalog.filter(entry => ['issue', 'pr', 'any'].includes(entry.object)).map(({ id, title, short, label, note }) => ({ id, title, short, label: !!label, ...(note ? { note } : {}) }));
  // A new workflow starts with the custom workflows' default writes.
  const writeChoices = workflow?.write_options || current.workflows.custom_write_options, savedWrites = workflow?.permissions.writes || current.workflows.custom_writes;
  const form = document.createElement('form'), message = element('p', '', 'view-error'), shell = element('div', '', 'workflow-shell');
  form.className = 'project-form workflow-editor'; form.noValidate = true; form.setAttribute('aria-label', workflow ? `工作流 ${workflow.name}` : '新工作流'); message.setAttribute('role', 'alert');
  // Header: what it is and whether it runs, with the actions that apply to the whole form.
  const head = element('div', '', 'workflow-detail-head'), title = element('div', '', 'title-group'), actions = element('div', '', 'actions');
  title.append(element('h2', workflow ? workflow.name : '新增工作流'), ...(workflow ? [element('code', workflow.id), badge(workflow.builtin ? '内置' : '自定义', workflow.builtin ? '' : 'info'), workflowState(workflow)] : []));
  const submit = element('button', '保存'); submit.type = 'submit';
  const item = workflow ? workflow.id : 'new', repo = current.id;
  actions.append(button('用聊天编写', () => openWorkflowAssistant(item)), submit);
  if (workflow && custom) actions.append(button('删除', async () => {
    if (!await askConfirm({ title: `删除工作流「${workflow.name}」？`, body: ['尚未完成的任务会取消，已完成的任务和日志保留。'], action: '删除', danger: true })) return;
    try { await api(`/api/repositories/${current.id}/workflows/${encodeURIComponent(workflow.id)}`, 'DELETE', {}); await reloadWorkflows(); selectWorkflowItem(current.workflows.workflows[0].id, { notice: '已删除工作流' }); }
    catch (err) { message.textContent = workflowError(err.message); }
  }, 'quiet destructive'));
  head.append(title, actions);
  // Tabs: each part of the workflow on its own, so the page stays short.
  const tabs = element('div', '', 'workflow-tabs'), panels = new Map(); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', '工作流设置');
  const show = key => { current.workflowTab = key; for (const [id, [tab, panel]] of panels) { const on = id === key; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; panel.hidden = !on; } };
  for (const [key, caption] of workflowTabs) {
    const tab = element('button', caption, 'workflow-tab'), panel = element('div', '', 'workflow-panel'); tab.type = 'button'; tab.setAttribute('role', 'tab');
    tab.id = 'workflow-tab-' + key; panel.id = 'workflow-panel-' + key; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); tab.setAttribute('aria-controls', panel.id);
    tab.addEventListener('click', () => show(key));
    tab.addEventListener('keydown', event => { if (!['ArrowRight', 'ArrowLeft'].includes(event.key)) return; const keys = workflowTabs.map(([id]) => id), next = keys[(keys.indexOf(key) + (event.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length]; show(next); panels.get(next)[0].focus(); });
    tabs.append(tab); panels.set(key, [tab, panel]);
  }
  const panel = key => panels.get(key)[1];
  // Overview: name, description, switch, then the workflow drawn with its triggers, and the triggers to choose from.
  const switchBox = workflow?.id === 'actions.failures' ? checkbox('enabled', workflow.enabled, '启用这条工作流（默认关闭；首次开启不补报之前已完成的运行）') : checkbox('enabled', workflow ? workflow.enabled : true, '启用这条工作流');
  panel('overview').append(field('名称', input('name', workflow?.name || '', { required: true })), field('说明', textarea('description', workflow?.description || '', { rows: 2 })), switchBox);
  if (workflow?.project_switch && !workflow.project_switch.on) panel('overview').append(element('p', `${workflow.project_switch.title}已关闭，这条工作流现在不会运行；在项目列表打开${workflow.project_switch.title.replace('项目的', '')}后生效。`, 'endpoint-warning'));
  if (workflow?.status !== undefined) panel('overview').append(actionsStatusLine(workflow));
  // What the saved workflow does, in four answers plus who executes it.
  if (workflow) panel('overview').append(element('h3', '这条工作流'), workflowSummary(workflow));
  // Every chart of this workflow shows the triggers ticked below, saved or not, so a change is seen at once.
  const charts = [], chart = (text, title) => { const box = element('div', '', 'workflow-chart'); charts.push([box, text, title]); return box; };
  const drawCharts = () => { const names = chosenTriggers().map(trigger => triggerName(options, trigger)); for (const [box, text, title] of charts) box.replaceChildren(flowFigure(parseFlow(text()), title, names)); drawPreview(); };
  // A saved workflow shows what runs now; a new one shows the prompt being written.
  panel('overview').append(chart(() => workflow ? workflow.prompt.effective : editor.value, '流程图'), note(flowBoundary));
  // Triggers: the same catalog for every workflow; the conditions the control plane checks stay whatever is chosen.
  const triggerBox = element('div', '', 'workflow-triggers'), chosen = workflow?.triggers || [];
  for (const option of options) {
    const saved = chosen.find(trigger => trigger.id === option.id), row = element('div', '', 'workflow-trigger');
    row.append(checkbox('trigger:' + option.id, !!saved, option.title));
    if (option.label) { const name = input('trigger-label:' + option.id, saved?.label || '', { placeholder: '标签名' }); name.setAttribute('aria-label', option.title + '：标签名'); row.append(name); }
    if (option.fixed_label) row.append(element('code', option.fixed_label));
    if (option.note) row.append(element('span', option.note, 'muted'));
    triggerBox.append(row);
  }
  panel('overview').append(element('h3', '触发源'), triggerBox, note(triggerRules(workflow)));
  triggerBox.addEventListener('change', drawCharts); triggerBox.addEventListener('input', drawCharts);
  // Prompt: the effective text and its flowchart, then the console layer being edited with a live flowchart.
  const prompt = workflow?.prompt, consoleLayer = prompt?.layers.find(layer => layer.source === 'console');
  const startText = custom ? prompt?.effective || '' : consoleLayer?.content ?? (workflow.id === 'release.notes' ? '' : prompt.layers[0].content);
  const editor = textarea('prompt', startText, { rows: 18, spellcheck: false, className: 'code' }); editor.setAttribute('aria-label', custom ? '提示词' : '控制台提示词');
  if (workflow?.id === 'release.notes') editor.placeholder = '留空时使用内置 release-notes-v1：只列出已核验的提交和合并 PR。写入后按这里的要求整理分组，来源仍由控制面核验。';
  // The chart of the text being edited, while it differs from the effective prompt.
  const preview = element('div', '', 'workflow-flow-preview'), drawPreview = () => preview.replaceChildren(...(!editor.value.trim() || workflow && editor.value === prompt.effective ? [] : [flowFigure(parseFlow(editor.value), '编辑中的流程图', chosenTriggers().map(trigger => triggerName(options, trigger)))]));
  let timer = null; editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(drawCharts, 200); });
  {
    if (workflow) {
      const meta = element('div', '', 'rule-meta'); meta.dataset.promptMeta = ''; meta.append(...promptMeta(workflow)); panel('prompt').append(meta);
      if (prompt.source === 'repository') panel('prompt').append(element('p', `默认分支的仓库文件 ${prompt.path} 整份替换这里的提示词；下面保存的控制台内容要等仓库删除这个文件后才生效。`, 'endpoint-warning'));
      if (prompt.shared_with?.length) panel('prompt').append(note(`这份提示词同时用于：${prompt.shared_with.map(id => workflowById(id)?.name || id).join('、')}。`));
    }
    const columns = element('div', '', 'workflow-prompt-columns'), left = element('div'), right = element('div');
    left.append(field(custom ? '提示词' : '控制台提示词', editor));
    if (!custom && consoleLayer) left.append(checkbox('clear_prompt', false, '清除控制台提示词，回到' + (prompt.layers.some(layer => layer.source === 'repository') ? '仓库文件' : '内置默认')));
    right.append(...(workflow ? [chart(() => prompt.effective, '生效的流程图')] : []), preview, ...(workflow ? [collapsible(`当前生效内容（${prompt.effective.split('\n').length} 行）`, prompt.effective)] : []));
    columns.append(left, right); panel('prompt').append(columns);
  }
  // Permissions are not configured: reading is open to every workflow, writing follows the workflow's type.
  const reads = element('div', '', 'workflow-permissions');
  reads.append(element('p', workflowReads(workflow).join('、') + '：所有工作流都允许，不需要配置。'),
    note(`所有工作流都在项目电脑里运行，检出相关提交（Issue、PR、发版本的提交或失败的 Actions 运行）。GitHub 用只读令牌读取仓库的${githubReadScope}，令牌由执行器保管、任务结束即撤销。`),
    note('独立 agent（start_agent）有自己的会话，权限不超过主 agent，启动时还可以再收窄；它不能发布，也不能再启动 agent。'));
  // Writes are chosen here: each is a platform tool the agent calls when it needs it; the control plane performs it.
  const writes = element('div', '', 'workflow-writes');
  for (const option of writeChoices) {
    const box = checkbox('write:' + option.id, savedWrites.includes(option.id), option.title), input = box.querySelector('input');
    if (option.locked) { input.disabled = true; input.checked = true; box.title = '这条工作流以这项写入结束任务，不能去掉'; }
    const row = element('div', '', 'workflow-write'); row.append(box, element('code', option.tool), element('span', option.detail, 'muted'));
    writes.append(row);
  }
  // Opening a PR needs the code write; ticking one ticks the other.
  writes.addEventListener('change', event => {
    const code = writes.querySelector('[name="write:code"]'), pr = writes.querySelector('[name="write:pull_request"]');
    if (event.target === pr && pr.checked && code) code.checked = true;
    if (event.target === code && !code.checked && pr && !pr.disabled) pr.checked = false;
  });
  writes.append(note('写入由控制面用 GitHub App 安装令牌（或登记的机器人账号）完成：先核对对象、head 和条件，再经发布队列写入，结果不明时先对账、不重复写。agent 只拿得到只读令牌，不能在命令里推送、评论、加标签或合并。'));
  panel('access').append(element('h3', '读取（不限制）'), reads, element('h3', '写入（按需勾选）'), writes);
  const model = document.createElement('select'); model.name = 'model_id';
  {
    const defaultModel = current.models.find(entry => entry.id === current.policy.model_id);
    modelOptions(model, current.models, workflow?.model && !workflow.model.inherited ? workflow.model.id : '', `继承项目默认${defaultModel ? `（${defaultModel.model_name}）` : '（未选择）'}`);
    panel('access').append(element('h3', '模型'), field('模型', model), note('失效的模型不会自动换成其他模型，任务会等待配置。'));
  }
  if (workflow?.settings && 'review_language' in workflow.settings) {
    const language = document.createElement('select'); language.name = 'review_language';
    for (const [value, caption] of [['auto', '跟随 Issue／PR 的语言'], ['zh', '简体中文'], ['en', 'English']]) modelOption(language, value, caption);
    language.value = workflow.settings.review_language; panel('access').append(element('h3', '设置'), field('评论语言', language), note('两条检视工作流共用评论语言。'));
  }
  if (workflow?.settings && 'test_command' in workflow.settings) panel('access').append(element('h3', '设置'),
    field('测试命令', input('test_command', workflow.settings.test_command, { maxLength: 2048, placeholder: '如 npm test；留空时使用模型给出的命令' })),
    field('bot PR 自动修订轮数', input('max_revisions', workflow.settings.max_revisions, { type: 'number', min: 0, max: 10, step: 1 })),
    note('两条开发工作流共用这些设置。控制面在发布前运行测试命令，测试失败不推分支、不开 PR。'));
  const main = element('div', '', 'workflow-main');
  main.append(tabs, ...[...panels.values()].map(([, element]) => element));
  function chosenTriggers() {
    const elements = triggerBox.querySelectorAll('input');
    const value = name => [...elements].find(input => input.name === name);
    return options.filter(option => value('trigger:' + option.id)?.checked).map(option => ({ id: option.id, ...(option.label ? { label: value('trigger-label:' + option.id).value.trim() } : {}) }));
  }
  const values = () => {
    const elements = form.elements;
    return { name: elements.name.value, description: elements.description.value, enabled: elements.enabled.checked, prompt: editor.value, triggers: chosenTriggers(),
      writes: writeChoices.filter(option => elements['write:' + option.id]?.checked).map(option => option.id), model_id: model.value || null };
  };
  // A chat draft fills the editor; it is saved only with 保存.
  const apply = draft => {
    const elements = form.elements;
    if (draft.name !== undefined) elements.name.value = draft.name;
    if (draft.description !== undefined) elements.description.value = draft.description;
    if (typeof draft.enabled === 'boolean') elements.enabled.checked = draft.enabled;
    if (draft.model_id !== undefined) model.value = draft.model_id || '';
    if (typeof draft.prompt === 'string') editor.value = draft.prompt;
    if (Array.isArray(draft.writes)) for (const option of writeChoices) { const box = elements['write:' + option.id]; if (box && !box.disabled) box.checked = draft.writes.includes(option.id); }
    if (Array.isArray(draft.triggers)) { for (const option of options) {
      const picked = draft.triggers.find(trigger => trigger.id === option.id); elements['trigger:' + option.id].checked = !!picked;
      if (option.label) elements['trigger-label:' + option.id].value = picked?.label || '';
    } }
    drawCharts(); form.dataset.dirty = '1'; keep();
    if (!restoring) { show('prompt'); message.className = 'view-progress'; message.textContent = '草稿已填入编辑器，检查后点「保存」才会生效。'; }
  };
  // Every change is kept in this browser until it is saved or discarded; the assistant's window lives outside the page.
  // Written at once (a few kilobytes), so leaving the page right after a change never loses it.
  let restoring = false;
  const keep = () => storeEditor(repo, item, values());
  form.addEventListener('input', event => { if (event.target.name === 'chat') return; form.dataset.dirty = '1'; keep(); });
  form.addEventListener('change', () => { form.dataset.dirty = '1'; keep(); });
  workflowEditorHooks.set(repo + ':' + item, { values, apply, form });
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.className = 'view-error'; message.textContent = ''; submit.disabled = true;
    const value = values(), trigger = list => JSON.stringify(list.map(entry => entry.id + ':' + (entry.label || '').toLowerCase()).sort());
    try {
      let body;
      if (custom) body = { name: value.name, description: value.description, enabled: value.enabled, triggers: value.triggers, prompt: value.prompt, writes: value.writes, model_id: value.model_id, ...(workflow ? { version: workflow.version } : {}) };
      else {
        // Only what changed is written, so untouched parts keep following their defaults.
        body = { version: workflow.version };
        if (value.name !== workflow.name) body.name = value.name;
        if (value.description !== workflow.description) body.description = value.description;
        if (value.enabled !== workflow.enabled) body.enabled = value.enabled;
        if (trigger(value.triggers) !== trigger(workflow.triggers)) body.triggers = value.triggers;
        if ([...value.writes].sort().join() !== [...workflow.permissions.writes].sort().join()) body.writes = value.writes;
        {
          if (form.elements.clear_prompt?.checked) body.prompt = null; else if (value.prompt !== startText) body.prompt = value.prompt;
          if ((value.model_id || null) !== (workflow.model.inherited ? null : workflow.model.id)) body.model_id = value.model_id;
        }
        const settings = {};
        if (form.elements.review_language && form.elements.review_language.value !== workflow.settings.review_language) settings.review_language = form.elements.review_language.value;
        if (form.elements.test_command && form.elements.test_command.value !== workflow.settings.test_command) settings.test_command = form.elements.test_command.value;
        if (form.elements.max_revisions && Number(form.elements.max_revisions.value) !== workflow.settings.max_revisions) settings.max_revisions = Number(form.elements.max_revisions.value);
        if (Object.keys(settings).length) body.settings = settings;
      }
      const url = workflow ? `/api/repositories/${current.id}/workflows/${encodeURIComponent(workflow.id)}` : `/api/repositories/${current.id}/workflows`;
      const saved = await api(url, workflow ? 'PUT' : 'POST', body), tab = current.workflowTab;
      storeEditor(repo, item, null);
      // The project policy changes with some saves (switches, settings); the page reloads it with the workflows.
      await loadProject(current.id, 'workflows'); current.workflowItem = saved.workflow.id;
      history.replaceState(null, '', `#/projects/${current.id}/workflows/${saved.workflow.id}`);
      current.workflowTab = tab; drawWorkflowPage({ notice: '已保存工作流' });
    } catch (err) { message.className = 'view-error'; message.textContent = workflowError(err.message); submit.disabled = false; }
  });
  shell.append(main);
  form.append(head, ...(notice ? [Object.assign(element('p', notice, 'view-success flash'), { role: 'status' })] : []), message, shell);
  // Unsaved contents from an earlier visit (or a draft the assistant filled in from another page) come back here, once the
  // fields are in the form.
  const stored = storedEditor(repo, item);
  if (stored) {
    restoring = true; apply(stored); restoring = false;
    const restored = element('div', '', 'workflow-restored');
    restored.append(element('span', '这里显示的是未保存的修改：保存后才生效。'), button('丢弃未保存的修改', () => { storeEditor(repo, item, null); drawWorkflowPage(); }, 'quiet'));
    message.before(restored);
  }
  drawCharts(); show(panels.has(current.workflowTab) ? current.workflowTab : 'overview');
  return [form];
}
// What a trigger list means for this workflow, beyond the filters every trigger keeps.
function triggerRules(workflow) {
  const base = workflow?.base;
  const rules = base === 'development' ? '无论选哪些触发源，控制面都要求：项目开发开关打开、检视结论要求改代码并有原文依据、开发标签由人（不是 App）加上、Issue 没有指派人；发布 PR 前再查一次。'
    : base === 'release.notes' || base === 'release.observe' ? '关掉这个触发源或这条工作流后，发版本页不再调用模型：CI 观察不可用，发行说明按内置规则直接列出已核验的来源。'
    : base === 'actions' ? '只处理默认分支（以及默认分支上的版本标签）里失败的运行；需要 App 订阅 workflow_run 事件。'
    : base === 'gate' ? '只在项目的「接入门禁」对话里运行：每次开始或回复是一轮任务，在项目电脑里检出默认分支分析并试跑命令；方案只回到对话里，人确认后才由控制面开门禁 PR。关掉后接入门禁不可用。'
    : '草稿 PR、已关闭的 Issue／PR、bot 自己写的内容和仓库外人员的评论不会触发；按标签触发时，标签必须由人（不是 App）加上。';
  return rules + (base === 'review' ? ' 同一对象上还在排队的检视会合并后来的更新，不重复检视。' : '');
}
// The flowchart is the prompt's own step list for the agent; the page must not let it read as roles or permissions.
const flowBoundary = '流程图来自提示词，只说明 agent 按什么步骤做。它不会按节点创建角色，也不授予写入；写入以「权限与模型」里勾选的为准。';
function workflowSummary(workflow) {
  const list = element('dl', '', 'workflow-summary'), row = (term, ...value) => { const dd = element('dd', ''); dd.append(...value); list.append(element('dt', term), dd); };
  const options = workflow.trigger_options || [], title = trigger => { const option = options.find(entry => entry.id === trigger.id); return (option?.title || trigger.id) + (trigger.label ? '：' + trigger.label : option?.fixed_label ? '：' + option.fixed_label : ''); };
  row('何时触发', workflow.triggers.length ? workflow.triggers.map(title).join('、') : '没有触发源，不会运行');
  row('提示词', `${layerNames[workflow.prompt.source]} · ${promptLocation(workflow)}`);
  row('模型', workflowModelName(workflow));
  row('允许的写入', workflow.permissions.writes.length ? workflow.write_options.filter(option => workflow.permissions.writes.includes(option.id)).map(option => option.title).join('、') : '不写 GitHub');
  const runs = workflowExecution(workflow); if (runs) row('谁来执行', ...runs);
  return list;
}
// The role coordination entry a workflow belongs to; workflows outside these always keep their executor.
const workflowEntries = { development: 'development', review: 'review', actions: 'actions' };
// Who executes this workflow's tasks now, from the project's role configuration (read with the workflows page).
function workflowExecution(workflow) {
  const config = current.roleConfig; if (!config) return null;
  const entry = workflowEntries[workflow.base], coordinated = !!entry && config.enabled && config.controller.entries[entry] === true;
  const roles = element('a', '查看角色'); roles.href = `#/projects/${current.id}/roles`;
  if (!coordinated) return [`原来的执行器：项目电脑里的 Pi 进程${entry ? '（这个入口没有接入主控）' : ''}。完成前由独立 QA 验收。`, ' ', roles];
  const controller = config.roles.find(role => role.role_id === config.controller.role), executor = controller ? roleExecutor(controller, config) : null;
  const manager = `主控 Manager（${executor ? executor.name + (executor.legacy ? '，旧配置沿用' : '') : '未配置'}）`;
  // Each entry offers its own workers: development the enabled writer and observer roles, review and Actions only Dev,
  // which keeps this workflow's tools and workspace and runs on Dev's backend (Pi for older V2 configurations).
  return [entry === 'development' ? `${manager}按需委派已启用的 ${workerNames(entryWorkers(config, entry))}。候选由主控提名后交给独立 QA 验收。`
    : `${manager}${entryDevText(config)}；这个入口不委派 Test、Reviewer、UX。候选由主控提名后交给独立 QA 验收。`, ' ', roles];
}
function actionsStatusLine(workflow) {
  // A switched-off workflow reports nothing else: an old scan error no longer matters.
  const status = workflow.enabled ? workflow.status : null, line = element('p', '', status?.error ? 'endpoint-warning' : 'muted'); line.dataset.actionsStatus = ''; line.setAttribute('role', 'status');
  line.textContent = status?.error ? status.error === 'actions_workflow_run_subscription_missing'
    ? '配置错误：此仓库使用的 App 安装未订阅 workflow_run。本功能已停止写入，请 App 管理员添加事件订阅。'
    : /^model_/.test(status.error) ? `Actions 失败分析在等模型：${status.error}。请在「权限与模型」里选择可用的模型，或检查项目默认模型。`
    : `Actions 失败处理已暂停：${status.error}。请检查账号授权或日志读取状态。`
    : workflow.enabled ? status ? '配置检查通过后每分钟扫描；重复事件和人工重跑共用原运行的一次自动重试预算。' : '等待检查 App 事件订阅。' : '未开启。';
  return line;
}
const workflowErrors = { workflow_version_conflict: '工作流已被别人修改，请刷新页面后再保存。', invalid_workflow_trigger_label: '按标签触发时需要填写标签名。',
  invalid_workflow_writes: '写入能力不在这条工作流可选的范围里，或开 PR 时没有同时允许修改代码。', invalid_workflow_name: '请填写工作流名称。', invalid_workflow_prompt: '请填写提示词。', invalid_bot_label: '提示词里的标签声明不合法（最长 50 个字符，首尾不能有空白）。', model_not_configured: '项目还没有可用的模型，请先在「模型」页选择项目默认模型。',
  model_not_available: '选择的模型不可用于这个项目。', assistant_reply_invalid: '助手没有返回可用的草稿，请换个说法再试。', duplicate_workflow_trigger: '同一个触发源只能选一次。' };
const workflowError = code => workflowErrors[code] || code;
// Unsaved editor contents and assistant conversations, per project and workflow, in this browser.
const workflowEditorHooks = new Map();
const browserStore = (key, value) => {
  try { if (value === undefined) return JSON.parse(localStorage.getItem(key) || 'null'); if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(value)); }
  catch { return null; }
};
const storedEditor = (repo, item) => browserStore(`workflow-editor:${repo}:${item}`);
const storeEditor = (repo, item, value) => browserStore(`workflow-editor:${repo}:${item}`, value);
const assistantKey = (repo, item) => `workflow-assistant:${repo}:${item}`;

// The workflow assistant: a floating window that can be moved and resized, stays open while you browse other pages, and
// shows the agent's work as it streams: its text, its reasoning, each tool call with its result, and the drafts it proposes.
const assistant = { repo: null, item: null, history: null, controller: null };
function openWorkflowAssistant(item, repo = current.id) {
  assistant.repo = repo; assistant.item = item;
  assistant.history = browserStore(assistantKey(repo, item)) || { messages: [], turns: [] };
  const window = assistantWindow(); window.hidden = false;
  window.querySelector('.assistant-title span').textContent = ' · ' + (workflowById(item)?.name || storedEditor(repo, 'new')?.name?.trim() || '新工作流');
  drawAssistantLog(); window.querySelector('textarea').focus();
}
function assistantWindow() {
  let box = $('workflow-assistant'); if (box) return box;
  box = element('section', '', 'assistant-window'); box.id = 'workflow-assistant'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', '工作流助手'); box.hidden = true;
  const head = element('header', '', 'assistant-head'), title = element('strong', '工作流助手', 'assistant-title'); title.append(element('span', ''));
  const tools = element('div', '', 'actions');
  tools.append(button('清空对话', () => { if (assistant.controller) return; assistant.history = { messages: [], turns: [] }; saveAssistant(); drawAssistantLog(); }, 'quiet'),
    button('收起', () => { box.hidden = true; }, 'quiet'));
  head.append(title, tools);
  const log = element('ol', '', 'assistant-log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-label', '对话记录');
  const form = document.createElement('form'), question = textarea('assistant', '', { rows: 3 }), send = element('button', '发送'), halt = button('停止', () => assistant.controller?.abort(), 'quiet');
  form.className = 'assistant-input'; question.setAttribute('aria-label', '告诉助手你想要的流程'); question.placeholder = '描述你想要的流程，Ctrl+Enter 发送'; send.type = 'submit'; halt.hidden = true;
  question.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); form.requestSubmit(); } });
  form.addEventListener('submit', event => { event.preventDefault(); const text = question.value.trim(); if (!text || assistant.controller) return; question.value = ''; askAssistant(text); });
  const actions = element('div', '', 'actions'); actions.append(halt, send); form.append(question, actions);
  box.append(head, log, form); document.body.append(box);
  // Where and how big the window is survives reloads; the header moves it, the corner resizes it.
  const geometry = browserStore('workflow-assistant-geometry');
  if (geometry) Object.assign(box.style, { left: geometry.left, top: geometry.top, right: 'auto', bottom: 'auto', width: geometry.width, height: geometry.height });
  const remember = () => browserStore('workflow-assistant-geometry', { left: box.style.left || '', top: box.style.top || '', width: box.offsetWidth + 'px', height: box.offsetHeight + 'px' });
  head.addEventListener('pointerdown', event => {
    if (event.target.closest('button')) return;
    const start = box.getBoundingClientRect(), x = event.clientX, y = event.clientY; head.setPointerCapture(event.pointerId);
    const move = moved => {
      const left = Math.min(Math.max(0, start.left + moved.clientX - x), innerWidth - 80), top = Math.min(Math.max(0, start.top + moved.clientY - y), innerHeight - 40);
      Object.assign(box.style, { left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); remember(); };
    head.addEventListener('pointermove', move); head.addEventListener('pointerup', up);
  });
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => { if (!box.hidden) remember(); }).observe(box);
  return box;
}
const saveAssistant = () => { if (assistant.repo) browserStore(assistantKey(assistant.repo, assistant.item), assistant.history); };
// One turn on screen: the person's message, or the assistant's parts in the order they streamed.
function assistantTurn(turn) {
  const item = element('li', '', 'assistant-turn turn-' + turn.role);
  item.append(element('strong', turn.role === 'user' ? '你' : '助手'));
  if (turn.role === 'user') { item.append(element('p', turn.text)); return item; }
  for (const part of turn.parts) {
    if (part.type === 'text') item.append(element('p', part.text, 'assistant-text'));
    else if (part.type === 'reasoning') { const box = collapsible('思考过程', part.text); box.classList.add('assistant-reasoning'); item.append(box); }
    else if (part.type === 'tool') {
      const call = element('details', '', 'assistant-tool' + (part.result === undefined ? ' running' : '')), summary = element('summary', '');
      summary.append(element('code', part.name), element('span', part.result === undefined ? '执行中…' : '完成', 'muted'));
      call.append(summary, element('pre', '参数：' + JSON.stringify(part.arguments ?? {}, null, 2)), ...(part.result !== undefined ? [element('pre', '结果：' + part.result)] : []));
      item.append(call);
    } else if (part.type === 'draft') {
      const draft = part.draft, card = element('div', '', 'workflow-draft');
      const options = workflowById(assistant.item)?.trigger_options || current?.workflows?.triggers || [];
      const choices = workflowById(assistant.item)?.write_options || current?.workflows?.custom_write_options || [];
      card.append(flowFigure(parseFlow(draft.prompt), '草稿流程图', (draft.triggers || []).map(trigger => triggerName(options, trigger))), ...(part.warnings || []).map(warning => element('p', warning, 'endpoint-warning')),
        ...(Array.isArray(draft.writes) ? [element('p', '草稿写入：' + (draft.writes.length ? choices.filter(option => draft.writes.includes(option.id)).map(option => option.title).join('、') : '不写 GitHub'), 'muted')] : []),
        collapsible('草稿提示词', draft.prompt || ''), button('填入编辑器', () => fillFromAssistant(draft), ''));
      item.append(card);
    } else if (part.type === 'error') item.append(element('p', part.text, 'view-error'));
  }
  if (turn.pending) item.append(element('p', '助手正在工作…', 'muted assistant-pending'));
  return item;
}
function drawAssistantLog() {
  const log = $('workflow-assistant')?.querySelector('.assistant-log'); if (!log) return;
  const turns = assistant.history.turns;
  log.replaceChildren(...(turns.length ? turns.map(assistantTurn) : [element('li', '描述你想要的流程：助手会先看现有工作流和仓库，再起草触发源、提示词（含流程图）和写入能力。草稿填入编辑器后要点「保存」才会生效。', 'muted assistant-empty')]));
  log.scrollTop = log.scrollHeight;
  const box = $('workflow-assistant'), running = !!assistant.controller;
  box.querySelector('.assistant-input button[type=submit]').disabled = running; box.querySelector('.assistant-input .actions button:not([type=submit])').hidden = !running;
}
// A draft fills the editor of its workflow; when that editor is not on screen it is kept as the unsaved contents and shown.
function fillFromAssistant(draft) {
  const { repo, item } = assistant, hook = workflowEditorHooks.get(repo + ':' + item);
  if (hook && document.body.contains(hook.form)) { hook.apply(draft); return; }
  storeEditor(repo, item, { ...(storedEditor(repo, item) || {}), ...draft });
  location.hash = `#/projects/${repo}/workflows/${item}`;
}
async function askAssistant(text) {
  const { repo, item } = assistant, history = assistant.history, hook = workflowEditorHooks.get(repo + ':' + item);
  const editor = hook && document.body.contains(hook.form) ? hook.values() : storedEditor(repo, item);
  // The assistant's own last draft goes back with the conversation, whether or not it was filled into the editor.
  const proposed = history.turns.flatMap(turn => turn.parts || []).filter(part => part.type === 'draft').at(-1)?.draft;
  history.messages.push({ role: 'user', content: text }); history.turns.push({ role: 'user', text });
  const turn = { role: 'assistant', parts: [], pending: true }; history.turns.push(turn);
  const controller = assistant.controller = new AbortController(); drawAssistantLog();
  const last = type => { const part = turn.parts.at(-1); if (part?.type === type) return part; const created = { type, text: '' }; turn.parts.push(created); return created; };
  // This conversation is saved under its own workflow even if the window switches to another one meanwhile.
  const persist = () => browserStore(assistantKey(repo, item), history);
  let redraw = null; const later = () => { if (!redraw) redraw = setTimeout(() => { redraw = null; if (assistant.history === history) drawAssistantLog(); persist(); }, 60); };
  try {
    const response = await fetch(`/api/repositories/${repo}/workflows/assistant?stream=1`, { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf_token }, body: JSON.stringify({ ...(item === 'new' ? {} : { workflow_id: item }), ...(editor ? { draft: editor } : {}), ...(proposed ? { proposed } : {}), messages: history.messages }) });
    if (!response.ok) { const value = await response.json().catch(() => ({})); throw new Error(value.error || String(response.status)); }
    const reader = response.body.getReader(), decoder = new TextDecoder(); let pending = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end; while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'text') last('text').text += event.delta;
        else if (event.type === 'reasoning') last('reasoning').text += event.delta;
        else if (event.type === 'turn') turn.parts.push({ type: 'gap' });
        else if (event.type === 'tool_call') turn.parts.push({ type: 'tool', id: event.id, name: event.name, arguments: event.arguments });
        else if (event.type === 'tool_result') { const call = turn.parts.find(part => part.type === 'tool' && part.id === event.id); if (call) call.result = event.result; }
        else if (event.type === 'draft') turn.parts.push({ type: 'draft', draft: event.draft, warnings: event.warnings });
        else if (event.type === 'done') history.messages.push({ role: 'assistant', content: event.reply || turn.parts.filter(part => part.type === 'text').map(part => part.text).join('\n') || '（已起草）' });
        else if (event.type === 'error') throw new Error(event.error);
        later();
      }
    }
  } catch (err) {
    turn.parts.push({ type: 'error', text: err.name === 'AbortError' ? '已停止。' : workflowError(err.message) });
    if (history.messages.at(-1)?.role === 'user') history.messages.pop();
  } finally {
    turn.pending = false; turn.parts = turn.parts.filter(part => part.type !== 'gap' && !(part.type === 'text' && !part.text));
    if (assistant.controller === controller) assistant.controller = null;
    clearTimeout(redraw); redraw = null; persist(); if (assistant.history === history) drawAssistantLog();
  }
}
// The model page lists custom workflows next to the built-in ones; their model is saved on the workflow.
function customWorkflowModelEditor(workflow) {
  const section = element('section', '', 'task-model-editor'), select = document.createElement('select'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  const defaultModel = current.models.find(model => model.id === current.policy.model_id);
  modelOptions(select, current.models, workflow.model.inherited ? '' : workflow.model.id, `继承项目默认${defaultModel ? `（${defaultModel.model_name}）` : '（未选择）'}`);
  const save = button('保存模型', async () => {
    save.disabled = true; message.textContent = '';
    try { await api(`/api/repositories/${current.id}/workflows/${encodeURIComponent(workflow.id)}`, 'PUT', { model_id: select.value || null, version: workflow.version }); current.focusAnchor = workflow.id; await reloadWith(`已保存${workflow.name}的模型`); }
    catch (err) { message.textContent = workflowError(err.message); save.disabled = false; }
  }, '');
  const actions = element('div', '', 'actions form-actions'); actions.append(save);
  section.append(element('p', workflowModelName(workflow), 'muted'), field('模型', select), message, actions); return section;
}
