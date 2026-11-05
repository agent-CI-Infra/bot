// Workflows page (#/projects/<id>/workflows/<item>). Every workflow, built-in or added here, has the same parts: a name, a
// switch, triggers, a prompt (whose ```mermaid flowchart is drawn here), permissions and a model. The page lists them on
// the left and edits the selected one on the right, in tabs; a chat beside the editor drafts prompt and permissions, and
// nothing takes effect until the administrator saves. Loaded after project.js.

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
function flowFigure(flow, title = '流程图') {
  const figure = element('figure', '', 'workflow-flow');
  if (!flow) { figure.append(element('p', '这份提示词里没有流程图。在提示词里加一个 ```mermaid 代码块（以 flowchart LR 开头）即可在这里显示。', 'muted')); return figure; }
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg'), marker = 'flow-arrow-' + (++flowFigures);
  const make = (tag, attributes, text) => { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
  const width = label => Math.max(72, [...label].reduce((sum, char) => sum + (/[⺀-￿]/.test(char) ? 14 : 7.6), 0) + 30);
  const index = new Map(flow.nodes.map((node, at) => [node.id, at])), boxes = [], gap = 48, height = 40;
  const edges = flow.edges.filter(edge => index.has(edge.from) && index.has(edge.to) && edge.from !== edge.to);
  const span = edge => index.get(edge.to) - index.get(edge.from), above = edges.filter(edge => span(edge) > 1), below = edges.filter(edge => span(edge) < 0);
  const lift = above.length ? 34 + 20 * above.length : 12, top = lift, drop = below.length ? 40 + 24 * below.length : 12;
  let x = 8;
  for (const node of flow.nodes) { const w = width(node.label); boxes.push({ x, w }); x += w + gap; }
  const total = x - gap + 8, rowY = top, centre = rowY + height / 2;
  svg.setAttribute('viewBox', `0 0 ${total} ${top + height + drop}`); svg.setAttribute('width', String(total)); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', title + '：' + flowText(flow).join('；'));
  const defs = make('defs', {}), head = make('marker', { id: marker, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  head.append(make('path', { d: 'M0,0 L10,5 L0,10 z', class: 'flow-arrowhead' })); defs.append(head); svg.append(defs);
  const label = (text, at, y) => { if (text) svg.append(make('text', { x: at, y, 'text-anchor': 'middle', class: 'flow-edge-label' }, text)); };
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
  flow.nodes.forEach((node, at) => {
    const box = boxes[at];
    svg.append(make('rect', { x: box.x, y: rowY, width: box.w, height, rx: 8, class: 'flow-node' }));
    svg.append(make('text', { x: box.x + box.w / 2, y: centre + 5, 'text-anchor': 'middle', class: 'flow-node-label' }, node.label));
  });
  const scroll = element('div', '', 'workflow-flow-canvas'); scroll.append(svg);
  const caption = element('figcaption', ''), lines = flowText(flow);
  caption.append(element('strong', title + '：'), element('span', lines[0], 'flow-path'));
  for (const line of lines.slice(1)) caption.append(element('span', line, 'flow-loop'));
  figure.append(scroll, caption); return figure;
}

const publicationNames = { reply: '回复：控制面发布一条评论（PR 上可附 COMMENT 行内检视）', pull_request: 'bot 分支与 PR：控制面在测试通过并复核开发条件后发布',
  release_notes: '发行说明草稿：控制面核验来源完整且不重复', actions: '重跑原运行一次或提报 Issue：控制面按固定分类规则执行', none: '不发布：结果只显示在控制台' };
const workflowPermissionNames = [['read', '读取工作区'], ['shell', '运行命令'], ['notes', '写项目笔记'], ['write', '修改工作区代码']];
const scopeNames = { contents: '代码', issues: 'Issue', pull_requests: 'PR', actions: 'Actions', checks: '检查', statuses: '提交状态', metadata: '元数据' };
const workflowTabs = [['overview', '概览'], ['triggers', '触发源'], ['prompt', '提示词与流程'], ['access', '权限与模型']];
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
const triggerTitle = (workflow, trigger) => { const option = workflow.trigger_options.find(entry => entry.id === trigger.id); return (option?.title || trigger.id) + (trigger.label ? `（${trigger.label}）` : option?.fixed_label ? `（${option.fixed_label}）` : ''); };
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
  detail.replaceChildren(...(shared ? sharedDetail(shared) : workflowEditor(workflow, { chat, notice })));
  // The Actions failure status (subscription, pause reasons) keeps refreshing while its editor is open.
  if (item === 'actions.failures' && current.policy.actions_failures_enabled) { clearTimeout(projectTimer); const token = renderToken; projectTimer = setTimeout(() => refreshActionsFailureStatus(token), 5000); }
}
function workflowSidebar(selected) {
  const side = element('aside', '', 'workflow-sidebar'), head = element('div', '', 'workflow-sidebar-head');
  side.setAttribute('aria-label', '工作流列表');
  const add = element('div', '', 'actions'); add.append(button('新增工作流', () => selectWorkflowItem('new'), ''), button('用聊天新增', () => selectWorkflowItem('new', { chat: true })));
  head.append(element('h2', '工作流'), add);
  side.append(head, workflowLists(selected), ruleSync());
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
    meta.append(workflowState(workflow), ...(workflow.builtin ? [] : [badge('自定义', 'info')]));
    list.append(entry(workflow.id, workflow.name, meta, element('span', flow || '没有流程图', 'flow-path')));
  }
  if (selected === 'new') list.append(entry('new', '新工作流', element('span', '尚未保存', 'muted')));
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
  const custom = !workflow?.builtin, catalog = current.workflows.triggers, scopes = current.workflows.github_scopes;
  const options = workflow?.trigger_options || catalog.filter(entry => ['issue', 'pr', 'any'].includes(entry.object)).map(({ id, title, label, note }) => ({ id, title, label: !!label, ...(note ? { note } : {}) }));
  const ceiling = workflow?.ceiling || { workspace: { read: true, write: false, notes: true, shell: true }, github: scopes, agents: true, publication: 'reply' };
  const permissions = workflow?.permissions || { workspace: { read: true, write: false, notes: true, shell: true }, github: scopes.filter(scope => scope !== 'statuses'), agents: false, publication: 'reply' };
  const form = document.createElement('form'), message = element('p', '', 'view-error'), shell = element('div', '', 'workflow-shell');
  form.className = 'project-form workflow-editor'; form.noValidate = true; form.setAttribute('aria-label', workflow ? `工作流 ${workflow.name}` : '新工作流'); message.setAttribute('role', 'alert');
  // Header: what it is and whether it runs, with the actions that apply to the whole form.
  const head = element('div', '', 'workflow-detail-head'), title = element('div', '', 'title-group'), actions = element('div', '', 'actions');
  title.append(element('h2', workflow ? workflow.name : '新增工作流'), ...(workflow ? [element('code', workflow.id), badge(workflow.builtin ? '内置' : '自定义', workflow.builtin ? '' : 'info'), workflowState(workflow)] : []));
  const submit = element('button', '保存'); submit.type = 'submit';
  const chatToggle = button('用聊天编写', () => { const open = shell.classList.toggle('with-chat'); chatToggle.setAttribute('aria-expanded', String(open)); if (open) shell.querySelector('.workflow-chat textarea')?.focus(); });
  chatToggle.setAttribute('aria-expanded', String(!!chat));
  actions.append(chatToggle, submit);
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
  // Overview: name, description, switch and the flowchart of the effective prompt.
  const switchBox = workflow?.id === 'actions.failures' ? checkbox('enabled', workflow.enabled, '启用这条工作流（默认关闭；首次开启不补报之前已完成的运行）') : checkbox('enabled', workflow ? workflow.enabled : true, '启用这条工作流');
  panel('overview').append(field('名称', input('name', workflow?.name || '', { required: true })), field('说明', textarea('description', workflow?.description || '', { rows: 2 })), switchBox);
  if (workflow?.project_switch && !workflow.project_switch.on) panel('overview').append(element('p', `${workflow.project_switch.title}已关闭，这条工作流现在不会运行；在项目列表打开${workflow.project_switch.title.replace('项目的', '')}后生效。`, 'endpoint-warning'));
  if (workflow?.status !== undefined) panel('overview').append(actionsStatusLine(workflow));
  if (workflow) panel('overview').append(flowFigure(parseFlow(workflow.prompt.effective), '流程图'), workflowSummary(workflow));
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
  panel('triggers').append(triggerBox, note(triggerRules(workflow)));
  // Prompt: the effective text and its flowchart, then the console layer being edited with a live flowchart.
  const prompt = workflow?.prompt, consoleLayer = prompt?.layers.find(layer => layer.source === 'console');
  const startText = custom ? prompt?.effective || '' : consoleLayer?.content ?? (workflow.id === 'release.notes' ? '' : prompt.layers[0].content);
  const editor = textarea('prompt', startText, { rows: 18, spellcheck: false, className: 'code' }); editor.setAttribute('aria-label', custom ? '提示词' : '控制台提示词');
  if (workflow?.id === 'release.notes') editor.placeholder = '留空时使用内置 release-notes-v1：只列出已核验的提交和合并 PR。写入后按这里的要求整理分组，来源仍由控制面核验。';
  // The chart of the text being edited, while it differs from the effective prompt.
  const preview = element('div', '', 'workflow-flow-preview'), drawPreview = () => preview.replaceChildren(...(!editor.value.trim() || workflow && editor.value === prompt.effective ? [] : [flowFigure(parseFlow(editor.value), '编辑中的流程图')]));
  let timer = null; editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(drawPreview, 200); }); drawPreview();
  {
    if (workflow) {
      const meta = element('div', '', 'rule-meta'); meta.dataset.promptMeta = ''; meta.append(...promptMeta(workflow)); panel('prompt').append(meta);
      if (prompt.source === 'repository') panel('prompt').append(element('p', `默认分支的仓库文件 ${prompt.path} 整份替换这里的提示词；下面保存的控制台内容要等仓库删除这个文件后才生效。`, 'endpoint-warning'));
      if (prompt.shared_with?.length) panel('prompt').append(note(`这份提示词同时用于：${prompt.shared_with.map(id => workflowById(id)?.name || id).join('、')}。`));
    }
    const columns = element('div', '', 'workflow-prompt-columns'), left = element('div'), right = element('div');
    left.append(field(custom ? '提示词' : '控制台提示词', editor));
    if (!custom && consoleLayer) left.append(checkbox('clear_prompt', false, '清除控制台提示词，回到' + (prompt.layers.some(layer => layer.source === 'repository') ? '仓库文件' : '内置默认')));
    right.append(...(workflow ? [flowFigure(parseFlow(prompt.effective), '生效的流程图')] : []), preview, ...(workflow ? [collapsible(`当前生效内容（${prompt.effective.split('\n').length} 行）`, prompt.effective)] : []));
    columns.append(left, right); panel('prompt').append(columns);
  }
  // Permissions and model: never above the ceiling; publication follows the workflow.
  const permissionBox = element('div', '', 'workflow-permissions');
  {
    for (const [key, caption] of workflowPermissionNames) {
      const box = checkbox('permission:' + key, permissions.workspace[key], caption); box.querySelector('input').disabled = !ceiling.workspace[key];
      if (!ceiling.workspace[key]) box.title = '这条工作流不能打开这项权限'; permissionBox.append(box);
    }
    const agents = checkbox('permission:agents', permissions.agents, '启动独立 agent（start_agent：独立会话，权限不超过本工作流）'); agents.querySelector('input').disabled = !ceiling.agents; permissionBox.append(agents);
    const scopeBox = element('div', '', 'workflow-scopes'); scopeBox.append(element('span', 'GitHub 只读范围：', 'muted'));
    for (const scope of scopes) { const box = checkbox('scope:' + scope, permissions.github.includes(scope), scopeNames[scope] || scope); box.querySelector('input').disabled = !ceiling.github.includes(scope); scopeBox.append(box); }
    permissionBox.append(scopeBox);
  }
  permissionBox.append(note('发布：' + publicationNames[ceiling.publication]), note('运行中的模型和仓库内容都不能改这些权限；子 agent 只能在这里保存的范围内再收窄。'));
  panel('access').append(element('h3', '权限'), permissionBox);
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
  const values = () => {
    const elements = form.elements, permission = key => !!elements['permission:' + key]?.checked;
    return { name: elements.name.value, description: elements.description.value, enabled: elements.enabled.checked, prompt: editor.value,
      triggers: options.filter(option => elements['trigger:' + option.id].checked).map(option => ({ id: option.id, ...(option.label ? { label: elements['trigger-label:' + option.id].value.trim() } : {}) })),
      permissions: { workspace: Object.fromEntries(workflowPermissionNames.map(([key]) => [key, permission(key)])), github: scopes.filter(scope => elements['scope:' + scope]?.checked), agents: permission('agents') },
      model_id: model.value || null };
  };
  // A chat draft fills the editor; it is saved only with 保存.
  const apply = draft => {
    const elements = form.elements;
    if (draft.name !== undefined) elements.name.value = draft.name;
    if (draft.description !== undefined) elements.description.value = draft.description;
    if (typeof draft.prompt === 'string') { editor.value = draft.prompt; drawPreview(); }
    if (Array.isArray(draft.triggers)) for (const option of options) {
      const picked = draft.triggers.find(trigger => trigger.id === option.id); elements['trigger:' + option.id].checked = !!picked;
      if (option.label) elements['trigger-label:' + option.id].value = picked?.label || '';
    }
    if (draft.permissions) {
      for (const [key] of workflowPermissionNames) if (elements['permission:' + key] && !elements['permission:' + key].disabled) elements['permission:' + key].checked = !!draft.permissions.workspace?.[key];
      if (elements['permission:agents'] && !elements['permission:agents'].disabled) elements['permission:agents'].checked = !!draft.permissions.agents;
      for (const scope of scopes) if (elements['scope:' + scope] && !elements['scope:' + scope].disabled) elements['scope:' + scope].checked = (draft.permissions.github || []).includes(scope);
    }
    show('prompt'); message.className = 'view-progress'; message.textContent = '草稿已填入编辑器，检查后点「保存」才会生效。';
  };
  form.addEventListener('input', () => { form.dataset.dirty = '1'; });
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.className = 'view-error'; message.textContent = ''; submit.disabled = true;
    const value = values(), trigger = list => JSON.stringify(list.map(entry => entry.id + ':' + (entry.label || '').toLowerCase()).sort());
    try {
      let body;
      if (custom) body = { name: value.name, description: value.description, enabled: value.enabled, triggers: value.triggers, prompt: value.prompt, permissions: value.permissions, model_id: value.model_id, ...(workflow ? { version: workflow.version } : {}) };
      else {
        // Only what changed is written, so untouched parts keep following their defaults.
        body = { version: workflow.version };
        if (value.name !== workflow.name) body.name = value.name;
        if (value.description !== workflow.description) body.description = value.description;
        if (value.enabled !== workflow.enabled) body.enabled = value.enabled;
        if (trigger(value.triggers) !== trigger(workflow.triggers)) body.triggers = value.triggers;
        {
          if (form.elements.clear_prompt?.checked) body.prompt = null; else if (value.prompt !== startText) body.prompt = value.prompt;
          const canonical = permissions => JSON.stringify([workflowPermissionNames.map(([key]) => !!permissions.workspace[key]), [...permissions.github].sort(), !!permissions.agents]);
          if (canonical(value.permissions) !== canonical(workflow.permissions)) body.permissions = value.permissions;
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
      // The project policy changes with some saves (switches, settings); the page reloads it with the workflows.
      await loadProject(current.id, 'workflows'); current.workflowItem = saved.workflow.id;
      history.replaceState(null, '', `#/projects/${current.id}/workflows/${saved.workflow.id}`);
      current.workflowTab = tab; drawWorkflowPage({ notice: '已保存工作流' });
    } catch (err) { message.className = 'view-error'; message.textContent = workflowError(err.message); submit.disabled = false; }
  });
  shell.append(main, workflowChat(workflow, values, apply, chat));
  if (chat) shell.classList.add('with-chat');
  form.append(head, ...(notice ? [Object.assign(element('p', notice, 'view-success flash'), { role: 'status' })] : []), message, shell);
  show(panels.has(current.workflowTab) ? current.workflowTab : 'overview');
  return [form];
}
// What a trigger list means for this workflow, beyond the filters every trigger keeps.
function triggerRules(workflow) {
  const base = workflow?.base;
  const rules = base === 'development' ? '无论选哪些触发源，控制面都要求：项目开发开关打开、检视结论要求改代码并有原文依据、开发标签由人（不是 App）加上、Issue 没有指派人；发布 PR 前再查一次。'
    : base === 'release.notes' || base === 'release.observe' ? '关掉这个触发源或这条工作流后，发版本页不再调用模型：CI 观察不可用，发行说明按内置规则直接列出已核验的来源。'
    : base === 'actions' ? '只处理默认分支（以及默认分支上的版本标签）里失败的运行；需要 App 订阅 workflow_run 事件。'
    : '草稿 PR、已关闭的 Issue／PR、bot 自己写的内容和仓库外人员的评论不会触发；按标签触发时，标签必须由人（不是 App）加上。';
  return rules + (base === 'review' ? ' 同一对象上还在排队的检视会合并后来的更新，不重复检视。' : '');
}
function workflowSummary(workflow) {
  const list = element('dl', '', 'workflow-summary'), row = (term, value) => list.append(element('dt', term), element('dd', value));
  row('触发源', workflow.triggers.length ? workflow.triggers.map(trigger => triggerTitle(workflow, trigger)).join('、') : '没有触发源，不会运行');
  row('提示词', `${layerNames[workflow.prompt.source]} · ${promptLocation(workflow)}`);
  row('权限', [...workflowPermissionNames.filter(([key]) => workflow.permissions.workspace[key]).map(([, caption]) => caption), ...(workflow.permissions.agents ? ['启动独立 agent'] : []),
    workflow.permissions.github.length ? 'GitHub 只读 ' + workflow.permissions.github.map(scope => scopeNames[scope] || scope).join('、') : '不读 GitHub'].join('、'));
  row('发布', publicationNames[workflow.ceiling.publication]);
  row('模型', workflowModelName(workflow));
  return list;
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
const workflowErrors = { workflow_version_conflict: '工作流已被别人修改，请刷新页面后再保存。', invalid_workflow_permissions: '权限超出了这条工作流允许的范围。', invalid_workflow_trigger_label: '按标签触发时需要填写标签名。',
  invalid_workflow_name: '请填写工作流名称。', invalid_workflow_prompt: '请填写提示词。', invalid_bot_label: '提示词里的标签声明不合法（最长 50 个字符，首尾不能有空白）。', model_not_configured: '项目还没有可用的模型，请先在「模型」页选择项目默认模型。',
  model_not_available: '选择的模型不可用于这个项目。', assistant_reply_invalid: '助手没有返回可用的草稿，请换个说法再试。', duplicate_workflow_trigger: '同一个触发源只能选一次。' };
const workflowError = code => workflowErrors[code] || code;
// The chat sends the conversation and the editor's current values; the reply is a draft shown with its flowchart.
function workflowChat(workflow, values, apply, focus) {
  const box = element('aside', '', 'workflow-chat'), log = element('ol', '', 'workflow-chat-log'), question = textarea('chat', '', { rows: 3 }), status = element('p', '', 'muted');
  box.setAttribute('aria-label', '用聊天编写'); question.setAttribute('aria-label', '告诉助手你想要的流程'); log.setAttribute('aria-live', 'polite');
  question.placeholder = workflow ? '例如：检视之后如果发现安全问题，再启动一个独立 agent 复核' : '例如：PR 改到 docs/ 时，检查文档链接和示例命令，回复发现的问题';
  const messages = [];
  const say = (role, text) => { const item = element('li', '', 'chat-' + role); item.append(element('strong', role === 'user' ? '你' : '助手'), element('p', text)); log.append(item); return item; };
  const send = button('发送', async () => {
    const text = question.value.trim(); if (!text) return;
    messages.push({ role: 'user', content: text }); say('user', text); question.value = ''; send.disabled = true; status.textContent = '助手正在起草…';
    try {
      const value = values(), reply = await api(`/api/repositories/${current.id}/workflows/assistant`, 'POST', { ...(workflow ? { workflow_id: workflow.id } : {}),
        draft: { name: value.name, description: value.description, triggers: value.triggers, prompt: value.prompt, permissions: value.permissions }, messages });
      messages.push({ role: 'assistant', content: reply.reply });
      const item = say('assistant', reply.reply), draft = element('div', '', 'workflow-draft');
      draft.append(flowFigure(parseFlow(reply.draft.prompt), '草稿流程图'), ...reply.warnings.map(warning => element('p', warning, 'endpoint-warning')),
        element('p', '草稿权限：' + [...workflowPermissionNames.filter(([key]) => reply.draft.permissions.workspace[key]).map(([, caption]) => caption), ...(reply.draft.permissions.agents ? ['启动独立 agent'] : []),
          reply.draft.permissions.github.length ? 'GitHub 只读 ' + reply.draft.permissions.github.map(scope => scopeNames[scope] || scope).join('、') : '不读 GitHub'].join('、'), 'muted'),
        collapsible('草稿提示词', reply.draft.prompt), button('填入编辑器', () => apply(reply.draft), ''));
      item.append(draft); status.textContent = '';
    } catch (err) { messages.pop(); status.textContent = workflowError(err.message); }
    finally { send.disabled = false; }
  }, '');
  box.append(element('h4', '用聊天编写'), note('描述你想要的流程，助手起草提示词（含流程图）和权限。草稿填入编辑器后要点「保存」才会生效；保存的人是控制台管理员。'), log, field('你的要求', question), send, status);
  if (focus) setTimeout(() => question.focus(), 0);
  return box;
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
