function activitySection() { const box = element('div', '', 'status-grid'); box.id = 'activity-status'; box.append(...activityCards()); return [box, auditSection()]; }
// #357: the audit table is the platform's own record of who did what, when, to which object. It has no outcome column, so
// the card states that boundary once instead of implying a result, and a row links out only where the row itself proves the
// target: a management action's object is its receipt id, and two actions name a task as their object.
// The name map belongs to one signed-in account: the console clears `me` on sign-out without reloading the document, so a
// map kept across identities would show a project administrator names it is not allowed to read (and the reverse).
let auditNamesCache = null;
const auditTaskObjects = ['roles.apply', 'task.merge.authorized'];
function auditActor(row, names) {
  if (row.user_id === me.id) return element('span', '你');
  const name = names.get(row.user_id); if (name) return element('span', name);
  const id = element('code', row.user_id.slice(0, 12)); id.title = row.user_id; return id;
}
function auditObject(row) {
  if (row.action.startsWith('management.')) { const link = element('a', '打开回执', 'linkish'); link.href = '#/management/commands/' + encodeURIComponent(row.resource_id); return link; }
  if (auditTaskObjects.includes(row.action)) return button('打开任务', () => openTask(row.resource_id), 'quiet linkish');
  return null;
}
async function auditNames() {
  if (!me) return new Map();
  if (auditNamesCache?.owner === me.id) return auditNamesCache.names;
  // Account names are a platform-level read, so a project administrator keeps the account id the audit recorded.
  if (me.role !== 'super_admin') return (auditNamesCache = { owner: me.id, names: new Map() }).names;
  try { const { users } = await api('/api/users'); return (auditNamesCache = { owner: me.id, names: new Map(users.map(user => [user.id, user.username])) }).names; }
  // A failed read is not remembered: the card's own retry has to be able to fill the names for this sign-in.
  catch { return new Map(); }
}
const AUDIT_PAGE = 20;
function auditSection() {
  const section = card('操作记录（审计）'), id = current.id, body = element('div', ''); section.id = 'project-audit';
  section.append(note('这张表记录谁在什么时候、对哪个对象做了什么：账号、项目、动作、对象、时间；它不记录结果——成功与否要看对应的任务、配置差异或管理回执。最多显示最近 100 条。'), body);
  // #357 acceptance 5: one answer, two read-only controls. The filter chips and the "load more" step both work on the
  // rows this card already read — no cursor, no second request — so a long audit list stops being one undifferentiated
  // wall, and the count printed under the chips always describes exactly the rows on screen.
  const load = async () => {
    body.replaceChildren(note('正在读取操作记录'));
    try {
      const [{ audit }, names] = await Promise.all([api(`/api/audit?repository_id=${encodeURIComponent(id)}`), auditNames()]);
      // A late answer must not repaint a project the reader already left.
      if (!current || current.id !== id || !section.isConnected) return;
      if (!audit.length) { body.replaceChildren(note('这个项目还没有操作记录。')); return; }
      const rows = audit.map(row => {
        const item = element('li', ''), left = element('div', ''); item.dataset.auditRow = row.action;
        left.append(element('code', row.action), document.createTextNode(' '), auditActor(row, names));
        // Say the object cannot be opened instead of guessing a target this row does not prove.
        left.append(document.createTextNode(' '), auditObject(row) || element('span', '无法关联', 'muted'));
        item.append(left, element('span', timestamp(row.created_at), 'muted'), element('code', row.resource_id, 'muted wide-cell'));
        return item;
      });
      const counts = new Map();
      for (const row of audit) counts.set(row.action, (counts.get(row.action) || 0) + 1);
      const actions = [...counts.keys()].sort();
      let filter = '*', shown = AUDIT_PAGE;
      const filters = element('div', '', 'audit-filters');
      filters.setAttribute('role', 'group'); filters.setAttribute('aria-label', '按动作筛选操作记录');
      const count = element('p', '', 'muted'); count.setAttribute('aria-live', 'polite'); count.dataset.auditCount = '';
      const list = element('ul', '', 'history');
      const more = button('', () => { shown += AUDIT_PAGE; paint(); });
      const chips = [['*', `全部动作 ${audit.length}`]].concat(actions.map(action => [action, `${action} ${counts.get(action)}`]));
      const chipEls = chips.map(([key, caption]) => {
        const chip = button(caption, () => { filter = key; shown = AUDIT_PAGE; paint(); });
        chip.dataset.auditFilter = key; return chip;
      });
      filters.append(...chipEls);
      const paint = () => {
        const matching = filter === '*' ? rows : rows.filter((_, index) => audit[index].action === filter);
        const visible = matching.slice(0, shown), rest = matching.length - visible.length;
        list.replaceChildren(...visible);
        for (const [index, chip] of chipEls.entries()) chip.setAttribute('aria-pressed', chips[index][0] === filter ? 'true' : 'false');
        if (rest > 0) { more.textContent = `加载更多（还有 ${rest} 条）`; if (!more.isConnected) body.append(more); }
        else more.remove();
        count.textContent = filter === '*' && !rest ? `已显示全部 ${audit.length} 条` : `已显示 ${visible.length} / ${audit.length} 条`;
      };
      body.replaceChildren(filters, count, list);
      paint();
    } catch (err) {
      body.replaceChildren(consoleState('操作记录读取失败', err.status === 403 ? '需要本项目的配置权限才能读这张表。' : err.message, { tone: 'error', retry: load }));
    }
  };
  void load();
  return section;
}
function activityCards() {
  const environment = current.environment; if (!environment) return [note('暂时读不到运行状态。')];
  const { running_tasks: running = [], queued_tasks: queued = [], task_concurrency: limit, tasks } = environment, work = card(`正在执行 ${running.length}／${limit ?? 1}`);
  const list = element('ul', '', 'history');
  for (const task of running) { const row = element('li', ''); row.append(button(projectTaskLabel(task), () => openTask(task.id), 'quiet linkish'), state(task.status)); list.append(row); }
  work.append(running.length ? list : note('暂无正在执行的任务。'), note(`这台虚拟电脑最多同时执行 ${limit ?? 1} 个任务，其余任务排队。`));
  const queue = card(`排队任务 ${queued.length}`), queueList = element('ul', '', 'history');
  for (const task of queued) {
    const row = element('li', ''); row.append(button(projectTaskLabel(task), () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `入队 ${timestamp(task.created_at)}`, 'muted wide-cell')); queueList.append(row);
  }
  queue.append(queued.length ? queueList : note('暂无排队任务。'));
  const recent = card('最近任务'), taskList = element('ul', '', 'history');
  recent.classList.add('activity-history');
  for (const task of tasks) {
    const row = element('li', ''); row.append(button(projectTaskLabel(task), () => openTask(task.id), 'quiet linkish'), state(task.status));
    row.append(element('span', `${task.generation ? 'g' + task.generation + ' · ' : ''}${timestamp(task.updated_at)}`, 'muted wide-cell'),taskMetricsLine(task)); taskList.append(row);
  }
  recent.append(tasks.length ? taskList : note('还没有任务。'));
  return [work, queue, recent];
}

// One rule file: what it does, where the effective text comes from, and the project console override (edited on demand).
function ruleCard(path) {
  const id = current.id, [, purpose, task] = ruleInfo(path), row = current.rules?.files.find(file => file.path === path), section = card(purpose);
  section.classList.add('rule-card'); section.dataset.rulePath = path;
  if (!row) { section.append(note(current.rules ? '仓库没有这个文件。' : '暂时读不到规则文件，稍后再试。')); return section; }
  const meta = element('div', '', 'rule-meta'); meta.append(element('code', path), badge('生效：' + layerNames[row.source], row.source === 'builtin' ? '' : 'info'), element('span', '用于' + (/^[A-Za-z]/.test(task) ? ' ' : '') + task, 'muted'));
  section.append(meta);
  if (current.ruleNotice?.path === path) { const done = element('p', current.ruleNotice.text, 'view-success flash'); done.setAttribute('role', 'status'); section.append(done); current.ruleNotice = null; }
  const lines = row.effective.split('\n').length;
  section.append(collapsible(`当前生效内容（${lines} 行）`, row.effective));
  for (const layer of row.layers) if (layer.source !== row.source) section.append(collapsible(`${layerNames[layer.source]}（被覆盖）`, layer.content));
  if (!path.startsWith('.bot/rules/') && path !== '.bot/guide.md') return section;
  const consoleLayer = row.layers.find(layer => layer.source === 'console'), actions = element('div', '', 'actions'), message = element('p', '', 'view-error');
  message.setAttribute('role', 'alert');
  section.append(note(row.source === 'repository' ? (consoleLayer ? '默认分支的仓库文件整份覆盖控制台内容；控制台覆盖只在仓库删除该文件后生效。' : '默认分支的仓库文件整份覆盖内置默认；在这里添加的控制台覆盖只在仓库删除该文件后生效。')
    : consoleLayer ? '项目控制台覆盖了内置默认；默认分支加入同名仓库文件后以仓库为准。' : '使用内置默认。保存控制台覆盖后整份替换内置内容；默认分支加入同名仓库文件后以仓库为准。'), actions, message);
  const save = async content => {
    try { const { rules } = await api(`/api/repositories/${id}/rules`, 'PUT', { path, content }); if (current?.id !== id) return; current.rules = rules;
      current.ruleNotice = { path, text: content === null ? '已清除控制台覆盖' : '已保存控制台覆盖' };
      updateRuleSources(); if (typeof managerChanged === 'function') void managerChanged();
      const common = section.closest('details.common-rule');
      if (common) common.querySelector('.common-rule-body').replaceChildren(ruleCard(path));
      else if ($('project-detail')?.redraw) $('project-detail').redraw();
      else { current.focusRule = path; renderProject({ id: current.id, section: current.section, item: current.item }); } }
    catch (err) { message.textContent = err.message; }
  };
  // Browse first, edit on demand: the editor starts from the console text, or from the built-in default when there is none.
  actions.append(button(consoleLayer ? '编辑控制台覆盖' : '添加控制台覆盖', () => {
    const form = document.createElement('form'), editor = textarea('rule_content', consoleLayer?.content ?? row.layers[0].content, { rows: 8, spellcheck: false, className: 'code' }), buttons = element('div', '', 'actions');
    form.className = 'project-form rule-editor'; editor.setAttribute('aria-label', path + ' 控制台覆盖');
    const submit = element('button', '保存'); submit.type = 'submit'; buttons.append(submit, button('取消', () => { form.remove(); actions.hidden = false; }));
    form.append(editor, buttons); form.addEventListener('submit', event => { event.preventDefault(); submit.disabled = true; save(editor.value).finally(() => { submit.disabled = false; }); });
    actions.hidden = true; actions.after(form); editor.focus();
  }));
  if (consoleLayer) actions.append(button('清除控制台覆盖', async () => {
    if (await askConfirm({ title: `清除 ${path} 的控制台覆盖？`, body: ['清除后回到仓库文件或内置默认的内容。'], action: '清除', danger: true })) save(null);
  }));
  return section;
}

function ruleSource(path) {
  const row = current.rules?.files.find(file => file.path === path), source = element('span', '', 'task-rule-source');
  if (path) source.dataset.ruleSource = path;
  const name = row ? layerNames[row.source] : !current.rules ? '暂未读取' : !path ? '内置默认' : '未配置';
  source.append(badge(name, row?.source === 'repository' ? 'info' : row?.source === 'console' ? 'success' : ''));
  source.title = !current.rules ? '暂时无法读取规则，无法确定生效来源。' : !path ? '内置默认：生效（release-notes-v1）' : Object.entries(layerNames).map(([key, label]) => `${label}：${row?.source === key ? '生效' : row?.layers.some(layer => layer.source === key) ? '被覆盖' : '未配置'}`).join('；');
  return source;
}
function updateRuleSources() {
  $('project-page')?.querySelectorAll('[data-rule-source]').forEach(node => node.replaceWith(ruleSource(node.dataset.ruleSource)));
}
function commonRule(path, title) {
  const details = element('details', '', 'common-rule'), summary = element('summary'), body = element('div', '', 'common-rule-body');
  details.dataset.commonRule = path;
  summary.append(element('strong', title), ruleSource(path), element('span', '展开内容与编辑', 'muted'));
  details.append(summary, body);
  details.addEventListener('toggle', () => { if (details.open && !body.querySelector('form')) body.replaceChildren(ruleCard(path)); });
  return details;
}
function ruleSync() {
  const id = current.id, section = element('div', '', 'rule-sync'), source = note(''), message = element('p', '', 'view-error');
  section.dataset.overviewAnchor = 'rule-sources'; message.setAttribute('role', 'status');
  const describe = () => { source.textContent = current.rules?.sha ? `默认分支提交 ${current.rules.sha.slice(0, 12)} · ${timestamp(current.rules.updated_at)}` : current.rules ? '尚未读取默认分支，当前显示内置与控制台配置。' : '暂时无法读取规则，点击刷新重试。'; };
  const refresh = button('刷新默认分支文件', async () => {
    refresh.disabled = true; refresh.textContent = '正在读取默认分支…'; message.className = 'view-error'; message.textContent = '';
    try {
      const { rules } = await api(`/api/repositories/${id}/rules/refresh`, 'POST', {});
      if (current?.id !== id) return;
      current.rules = rules; updateRuleSources(); describe();
      // Refresh saved content without discarding an editor's unsaved draft.
      $('project-page').querySelectorAll('.common-rule').forEach(details => {
        const body = details.querySelector('.common-rule-body');
        if (!body.querySelector('form')) body.replaceChildren(...(details.open ? [ruleCard(details.dataset.commonRule)] : []));
      });
      const detail = $('project-detail'); if (detail?.redraw && !detail.hidden && !detail.querySelector('form')) detail.redraw();
      message.className = 'view-success flash'; message.textContent = `已读取默认分支提交 ${rules.sha.slice(0, 12)}`;
    } catch (err) { message.textContent = err.message; }
    finally { refresh.disabled = false; refresh.textContent = '刷新默认分支文件'; }
  });
  describe(); section.append(source, refresh, message); return section;
}
