// Workflows page (#/projects/<id>/workflows). Every workflow, built-in or added here, has the same parts: triggers, a
// prompt (whose ```mermaid flowchart is drawn here), permissions and a model. A chat drafts the prompt and the
// permissions; nothing takes effect until the administrator saves the editor. Loaded after project.js.

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
  release_notes: '发行说明草稿：控制面核验来源完整且不重复', none: '不发布：结果只显示在控制台' };
const workflowPermissionNames = [['read', '读取工作区'], ['shell', '运行命令'], ['notes', '写项目笔记'], ['write', '修改工作区代码']];
const scopeNames = { contents: '代码', issues: 'Issue', pull_requests: 'PR', actions: 'Actions', checks: '检查', statuses: '提交状态', metadata: '元数据' };
const workflowModelName = workflow => {
  const model = current.models.find(entry => entry.id === (workflow.model.id || workflow.model.default_id));
  const name = model ? model.model_name : (workflow.model.id || workflow.model.default_id) ? `模型不可用（${workflow.model.id || workflow.model.default_id}）` : '未选择';
  return workflow.model.inherited ? `${name} · 继承项目默认` : name;
};
const workflowById = id => current.workflows?.workflows.find(workflow => workflow.id === id);
async function reloadWorkflows() { current.workflows = await api(`/api/repositories/${current.id}/workflows`); return current.workflows; }

// Where a workflow's prompt comes from, in the words of the table: the file that replaces it, the console, or built-in.
const promptLocation = workflow => workflow.prompt.source === 'repository' ? workflow.prompt.path : workflow.prompt.source === 'console' ? (workflow.prompt.path ? workflow.prompt.path + '（控制台）' : '控制台')
  : workflow.id === 'release.notes' ? 'release-notes-v1' : workflow.prompt.path || 'docs/prompts（内置）';
function workflowTable() {
  const { table, body } = projectTable(['工作流', '触发源', '流程', '状态', '提示词来源', '模型', '操作'], '工作流'); table.id = 'workflow-table';
  for (const workflow of current.workflows.workflows) {
    const row = document.createElement('tr'); row.dataset.workflow = workflow.id; row.dataset.overviewAnchor = workflow.id;
    const name = element('strong', workflow.name); name.title = workflow.description || '';
    tableCell(row, '工作流', name, element('code', workflow.id), badge(workflow.builtin ? '内置' : '自定义', workflow.builtin ? '' : 'info'));
    const on = workflow.triggers.filter(trigger => trigger.enabled);
    tableCell(row, '触发源', element('span', on.length ? on.map(trigger => trigger.title + (trigger.label ? `（${trigger.label}）` : '')).join('、') : '未打开任何触发源', on.length ? '' : 'muted'));
    tableCell(row, '流程', element('span', flowText(parseFlow(workflow.prompt.effective))[0] || '—', 'flow-path'));
    tableCell(row, '状态', workflow.object === 'release' ? badge(current.policy.enabled ? '按需执行' : '项目禁用', current.policy.enabled ? '' : 'warning') : badge(workflow.active ? '已开启' : '未开启', workflow.active ? 'success' : 'warning'));
    const source = badge(layerNames[workflow.prompt.source], workflow.prompt.source === 'repository' ? 'info' : workflow.prompt.source === 'console' ? 'success' : ''); source.dataset.promptSource = workflow.id;
    tableCell(row, '提示词来源', source, element('code', promptLocation(workflow)));
    tableCell(row, '模型', element('span', workflowModelName(workflow)));
    tableCell(row, '操作', button('编辑', () => openWorkflow(workflow.id), 'quiet'));
    body.append(row);
  }
  return table;
}
// After the default branch is read again, prompt sources change in place; an open editor keeps its draft.
async function refreshWorkflowTable() {
  if (current?.section !== 'workflows' || !$('workflow-table')) return;
  try { await reloadWorkflows(); $('workflow-table')?.replaceWith(workflowTable()); } catch { /* The next visit reloads the table. */ }
}
function workflowsSection() {
  const section = card('工作流'), toolbar = element('div', '', 'actions task-toolbar'), common = element('section', '', 'common-rules');
  section.append(note('每条工作流由触发源、提示词（其中的流程图画在编辑器里）、权限和模型组成。内置的六条和这里新增的工作流用同一个编辑器；默认分支上的 .bot/rules 规则文件整份替换对应内置工作流的提示词，优先于控制台保存的内容。'));
  if (!current.workflows) { section.append(element('p', '暂时读不到工作流配置，稍后刷新重试。', 'view-error')); return [section]; }
  common.append(element('h4', '通用准则'), commonRule('.bot/guide.md', '行为指南'), commonRule('.bot/rules/labels.md', '检视标签'));
  section.append(common, note('规则优先级：内置默认 → 项目控制台 → 默认分支仓库文件，后一层整份覆盖前一层。'), ruleSync());
  toolbar.append(button('新增工作流', () => openWorkflow(null), ''), button('用聊天新增', () => openWorkflow(null, { chat: true })));
  section.append(toolbar);
  section.append(workflowTable());
  const others = current.rules?.files.filter(file => file.path === '.bot/computer.yaml' || !ruleFiles.some(([path]) => path === file.path) && file.path !== releaseNotesSkill) || [];
  if (others.length) {
    const extra = projectTable(['文件', '作用', '规则来源', '操作'], '其他规则文件');
    for (const file of others) {
      const row = document.createElement('tr'), [, purpose, task, target] = ruleInfo(file.path); row.dataset.ruleFile = file.path;
      tableCell(row, '文件', element('strong', purpose)); tableCell(row, '作用', task); tableCell(row, '规则来源', ruleSource(file.path), element('code', file.path));
      if (target === 'machine') { const entry = element('a', '查看机器配置'); entry.href = `#/projects/${current.id}/machine`; tableCell(row, '操作', entry); }
      else tableCell(row, '操作', button('展开规则', () => openProjectRule(file.path), 'quiet'));
      extra.body.append(row);
    }
    section.append(element('h4', '其他规则文件'), extra.table);
  }
  const detail = element('section', '', 'project-inline-detail'); detail.id = 'project-detail'; detail.hidden = true; detail.setAttribute('role', 'region');
  section.append(detail);
  // Labels, gates and the merge queue are deterministic repository automation; Actions failure handling feeds reviews.
  const modules = card('控制面条件与确定性模块');
  modules.append(note('这些规则写在代码里，不随提示词改变：开发要求项目开发开关、由人加上的开发标签和无人指派，发布 PR 前再查一次；测试不通过不推分支、不开 PR；发行说明由控制面核验来源完整且不重复；标签规范、PR 门禁和合并队列按 config/repositories 下的仓库配置执行。'));
  return [section, modules, actionsFailureSettings()];
}

// One editor for every workflow. A built-in workflow writes each part where it always lived; a custom one is one record.
function openWorkflow(id, { chat = false, notice = '' } = {}) {
  const workflow = id ? workflowById(id) : null;
  const redraw = showProjectDetails(workflow ? `编辑工作流：${workflow.name}` : '新增工作流', () => workflowEditor(workflow, { chat, done: async (savedId, text) => {
    await reloadWorkflows(); if (current?.section !== 'workflows') return;
    renderProject({ id: current.id, section: current.section }).then(() => openWorkflow(savedId, { notice: text }));
  } }));
  if (notice) redraw(notice);
}
function workflowEditor(workflow, { chat, done }) {
  const custom = !workflow?.builtin, catalog = current.workflows.triggers, scopes = current.workflows.github_scopes;
  const ceiling = workflow?.ceiling || { workspace: { read: true, write: false, notes: true, shell: true }, github: scopes, agents: true, publication: 'reply' };
  const permissions = workflow?.permissions || { workspace: { read: true, write: false, notes: true, shell: true }, github: scopes.filter(scope => scope !== 'statuses'), agents: false, publication: 'reply' };
  const form = document.createElement('form'), message = element('p', '', 'view-error'), layout = element('div', '', 'workflow-layout'), main = element('div', '', 'workflow-main');
  form.className = 'project-form workflow-editor'; form.noValidate = true; form.setAttribute('aria-label', workflow ? `工作流 ${workflow.name}` : '新工作流'); message.setAttribute('role', 'alert');
  const group = (title, ...nodes) => { const set = element('fieldset', '', 'workflow-group'); set.append(element('legend', title), ...nodes); return set; };
  // Basics
  const basics = [];
  if (custom) basics.push(field('名称', input('name', workflow?.name || '', { required: true })), field('说明', textarea('description', workflow?.description || '', { rows: 2 })));
  else basics.push(element('p', workflow.description, 'muted'));
  if (workflow?.enabled_editable !== false) basics.push(checkbox('enabled', workflow ? workflow.enabled : true, '启用这条工作流'));
  if (workflow?.enabled_note) basics.push(note(workflow.enabled_note));
  main.append(group('基本信息', ...basics));
  // Triggers
  const triggerBox = element('div', '', 'workflow-triggers');
  if (custom) {
    for (const definition of catalog) {
      const saved = workflow?.triggers.find(trigger => trigger.id === definition.id), row = element('div', '', 'workflow-trigger');
      row.append(checkbox('trigger:' + definition.id, !!saved, definition.title));
      if (definition.label) { const name = input('trigger-label:' + definition.id, saved?.label || '', { placeholder: '标签名' }); name.setAttribute('aria-label', definition.title + '：标签名'); row.append(name); }
      triggerBox.append(row);
    }
    triggerBox.append(note('草稿 PR、已关闭的 Issue／PR、bot 自己写的内容，以及仓库外人员的评论都不会触发；标签必须由人（不是 App）加上。'));
  } else {
    for (const trigger of workflow.triggers) {
      const row = element('div', '', 'workflow-trigger');
      if (trigger.configurable) row.append(checkbox('trigger:' + trigger.id, trigger.enabled, trigger.title));
      else row.append(badge('固定', ''), element('span', trigger.title + (trigger.label ? `（${trigger.label}）` : '')));
      if (trigger.note) row.append(element('span', trigger.note, 'muted'));
      triggerBox.append(row);
    }
  }
  main.append(group('触发源', triggerBox));
  // Prompt: the effective text and its flowchart, then the console layer being edited with a live flowchart.
  const prompt = workflow?.prompt, consoleLayer = prompt?.layers.find(layer => layer.source === 'console');
  const startText = custom ? prompt?.effective || '' : consoleLayer?.content ?? (workflow.id === 'release.notes' ? '' : prompt.layers[0].content);
  const editor = textarea('prompt', startText, { rows: 14, spellcheck: false, className: 'code' }); editor.setAttribute('aria-label', custom ? '提示词' : '控制台提示词');
  if (workflow?.id === 'release.notes') editor.placeholder = '留空时使用内置 release-notes-v1：只列出已核验的提交和合并 PR。写入后按这里的要求整理分组，来源仍由控制面核验。';
  const preview = element('div', '', 'workflow-flow-preview'), drawPreview = () => preview.replaceChildren(...(workflow && editor.value === prompt.effective ? [] : [flowFigure(parseFlow(editor.value), '编辑中的流程图')]));
  let timer = null; editor.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(drawPreview, 200); }); drawPreview();
  const promptNodes = [];
  if (workflow) {
    promptNodes.push(flowFigure(parseFlow(prompt.effective), '生效的流程图'));
    const meta = element('div', '', 'rule-meta'); meta.append(badge('生效：' + layerNames[prompt.source], prompt.source === 'builtin' ? '' : 'info'), element('code', promptLocation(workflow)));
    promptNodes.push(meta);
    if (prompt.source === 'repository') promptNodes.push(element('p', `默认分支的仓库文件 ${prompt.path} 整份替换这里的提示词；下面保存的控制台内容要等仓库删除这个文件后才生效。`, 'endpoint-warning'));
    if (prompt.shared_with?.length) promptNodes.push(note(`这份提示词同时用于：${prompt.shared_with.map(id => workflowById(id)?.name || id).join('、')}。`));
    promptNodes.push(collapsible(`当前生效内容（${prompt.effective.split('\n').length} 行）`, prompt.effective));
  }
  promptNodes.push(field(custom ? '提示词' : '控制台提示词', editor), preview);
  if (!custom && consoleLayer) promptNodes.push(checkbox('clear_prompt', false, '清除控制台提示词，回到' + (prompt.layers.some(layer => layer.source === 'repository') ? '仓库文件' : '内置默认')));
  main.append(group('提示词', ...promptNodes));
  // Permissions: never above the ceiling; publication follows the workflow.
  const permissionBox = element('div', '', 'workflow-permissions');
  for (const [key, caption] of workflowPermissionNames) {
    const box = checkbox('permission:' + key, permissions.workspace[key], caption); box.querySelector('input').disabled = !ceiling.workspace[key];
    if (!ceiling.workspace[key]) box.title = '这条工作流不能打开这项权限'; permissionBox.append(box);
  }
  const agents = checkbox('permission:agents', permissions.agents, '启动独立 agent（start_agent：独立会话，权限不超过本工作流）'); agents.querySelector('input').disabled = !ceiling.agents; permissionBox.append(agents);
  const scopeBox = element('div', '', 'workflow-scopes'); scopeBox.append(element('span', 'GitHub 只读范围：', 'muted'));
  for (const scope of scopes) { const box = checkbox('scope:' + scope, permissions.github.includes(scope), scopeNames[scope] || scope); box.querySelector('input').disabled = !ceiling.github.includes(scope); scopeBox.append(box); }
  permissionBox.append(scopeBox, note('发布：' + publicationNames[ceiling.publication]), note('运行中的模型和仓库内容都不能改这些权限；子 agent 只能在这里保存的范围内再收窄。'));
  main.append(group('权限', permissionBox));
  // Model
  const model = document.createElement('select'); model.name = 'model_id';
  const defaultModel = current.models.find(entry => entry.id === current.policy.model_id);
  modelOptions(model, current.models, workflow?.model.inherited === false ? workflow.model.id : '', `继承项目默认${defaultModel ? `（${defaultModel.model_name}）` : '（未选择）'}`);
  main.append(group('模型', field('模型', model), note('失效的模型不会自动换成其他模型，任务会等待配置。')));
  // Workflow settings that already existed for the built-in workflows.
  if (workflow?.settings && 'review_language' in workflow.settings) {
    const language = document.createElement('select'); language.name = 'review_language';
    for (const [value, caption] of [['auto', '跟随 Issue／PR 的语言'], ['zh', '简体中文'], ['en', 'English']]) modelOption(language, value, caption);
    language.value = workflow.settings.review_language; main.append(group('设置', field('评论语言', language), note('两条检视工作流共用评论语言。')));
  }
  if (workflow?.settings && 'test_command' in workflow.settings) main.append(group('设置',
    field('测试命令', input('test_command', workflow.settings.test_command, { maxLength: 2048, placeholder: '如 npm test；留空时使用模型给出的命令' })),
    field('bot PR 自动修订轮数', input('max_revisions', workflow.settings.max_revisions, { type: 'number', min: 0, max: 10, step: 1 })),
    note('两条开发工作流共用这些设置。控制面在发布前运行测试命令，测试失败不推分支、不开 PR。')));
  const submit = element('button', '保存'), actions = element('div', '', 'actions form-actions'); submit.type = 'submit'; actions.append(submit);
  if (workflow && custom) actions.append(button('删除工作流', async () => {
    if (!await askConfirm({ title: `删除工作流「${workflow.name}」？`, body: ['尚未完成的任务会取消，已完成的任务和日志保留。'], action: '删除', danger: true })) return;
    try { await api(`/api/repositories/${current.id}/workflows/${encodeURIComponent(workflow.id)}`, 'DELETE', {}); await reloadWorkflows(); current.flash = '已删除工作流'; renderProject({ id: current.id, section: current.section }); }
    catch (err) { message.textContent = err.message; }
  }, 'quiet destructive'));
  main.append(message, actions); layout.append(main);
  const values = () => {
    const elements = form.elements, permission = key => !!elements['permission:' + key]?.checked;
    return { name: elements.name?.value, description: elements.description?.value, enabled: elements.enabled ? elements.enabled.checked : undefined, prompt: editor.value,
      triggers: custom ? catalog.filter(definition => elements['trigger:' + definition.id].checked).map(definition => ({ id: definition.id, ...(definition.label ? { label: elements['trigger-label:' + definition.id].value.trim() } : {}) }))
        : Object.fromEntries(workflow.triggers.filter(trigger => trigger.configurable).map(trigger => [trigger.id, elements['trigger:' + trigger.id].checked])),
      permissions: { workspace: Object.fromEntries(workflowPermissionNames.map(([key]) => [key, permission(key)])), github: scopes.filter(scope => elements['scope:' + scope]?.checked), agents: permission('agents') },
      model_id: model.value || null };
  };
  // A chat draft fills the editor; it is saved only with the button below.
  const apply = draft => {
    const elements = form.elements;
    if (custom && draft.name !== undefined && elements.name) elements.name.value = draft.name;
    if (custom && draft.description !== undefined && elements.description) elements.description.value = draft.description;
    if (typeof draft.prompt === 'string') { editor.value = draft.prompt; drawPreview(); }
    if (custom && Array.isArray(draft.triggers)) for (const definition of catalog) {
      const chosen = draft.triggers.find(trigger => trigger.id === definition.id); elements['trigger:' + definition.id].checked = !!chosen;
      if (definition.label) elements['trigger-label:' + definition.id].value = chosen?.label || '';
    }
    if (!custom && draft.triggers && typeof draft.triggers === 'object') for (const [id, on] of Object.entries(draft.triggers)) if (elements['trigger:' + id]) elements['trigger:' + id].checked = !!on;
    if (draft.permissions) {
      for (const [key] of workflowPermissionNames) if (elements['permission:' + key] && !elements['permission:' + key].disabled) elements['permission:' + key].checked = !!draft.permissions.workspace?.[key];
      if (!elements['permission:agents'].disabled) elements['permission:agents'].checked = !!draft.permissions.agents;
      for (const scope of scopes) if (elements['scope:' + scope] && !elements['scope:' + scope].disabled) elements['scope:' + scope].checked = (draft.permissions.github || []).includes(scope);
    }
    message.className = 'view-progress'; message.textContent = '草稿已填入编辑器，检查后点「保存」才会生效。';
  };
  form.addEventListener('submit', async event => {
    event.preventDefault(); message.className = 'view-error'; message.textContent = ''; submit.disabled = true;
    const value = values();
    try {
      let body, saved;
      if (custom) {
        body = { name: value.name, description: value.description, enabled: value.enabled, triggers: value.triggers, prompt: value.prompt, permissions: value.permissions, model_id: value.model_id, ...(workflow ? { version: workflow.version } : {}) };
        saved = workflow ? await api(`/api/repositories/${current.id}/workflows/${encodeURIComponent(workflow.id)}`, 'PUT', body) : await api(`/api/repositories/${current.id}/workflows`, 'POST', body);
      } else {
        // Only what changed is written, so an untouched prompt keeps following the built-in text.
        body = { version: workflow.version };
        if (value.enabled !== undefined && value.enabled !== workflow.enabled) body.enabled = value.enabled;
        if (Object.entries(value.triggers).some(([id, on]) => workflow.triggers.find(trigger => trigger.id === id).enabled !== on)) body.triggers = value.triggers;
        if (form.elements.clear_prompt?.checked) body.prompt = null; else if (value.prompt !== startText) body.prompt = value.prompt;
        // Unchanged permissions are not written, so a built-in workflow keeps following its default.
        const canonical = permissions => JSON.stringify([workflowPermissionNames.map(([key]) => !!permissions.workspace[key]), [...permissions.github].sort(), !!permissions.agents]);
        if (canonical(value.permissions) !== canonical(workflow.permissions)) body.permissions = value.permissions;
        if ((value.model_id || null) !== (workflow.model.inherited ? null : workflow.model.id)) body.model_id = value.model_id;
        const settings = {};
        if (form.elements.review_language && form.elements.review_language.value !== workflow.settings.review_language) settings.review_language = form.elements.review_language.value;
        if (form.elements.test_command && form.elements.test_command.value !== workflow.settings.test_command) settings.test_command = form.elements.test_command.value;
        if (form.elements.max_revisions && Number(form.elements.max_revisions.value) !== workflow.settings.max_revisions) settings.max_revisions = Number(form.elements.max_revisions.value);
        if (Object.keys(settings).length) body.settings = settings;
        saved = await api(`/api/repositories/${current.id}/workflows/${encodeURIComponent(workflow.id)}`, 'PUT', body);
      }
      await done(saved.workflow.id, '已保存工作流');
    } catch (err) { message.className = 'view-error'; message.textContent = workflowError(err.message); submit.disabled = false; }
  });
  form.append(layout); layout.append(workflowChat(workflow, values, apply, chat));
  return [form];
}
const workflowErrors = { workflow_version_conflict: '工作流已被别人修改，请收起后重新打开再保存。', invalid_workflow_permissions: '权限超出了这条工作流允许的范围。', invalid_workflow_trigger_label: '按标签触发时需要填写标签名。',
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
