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
      body.replaceChildren(consoleState('操作记录读取失败', err.status === 403 ? '需要本项目的配置权限才能读这张表。' : readErrorText(err), { tone: 'error', retry: load }));
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

// One repository skill, read-only: the bot reads it from the default branch; it is changed in the repository.
function ruleCard(path) {
  const row = current.rules?.files.find(file => file.path === path), section = card(ruleInfo(path)[1]);
  section.classList.add('rule-card'); section.dataset.rulePath = path;
  if (!row) { section.append(note(current.rules ? '默认分支没有这个文件。' : '暂时读不到仓库 skill，稍后再试。')); return section; }
  const meta = element('div', '', 'rule-meta'); meta.append(element('code', path), element('span', '默认分支的仓库文件，在仓库里修改', 'muted'));
  section.append(meta, collapsible(`内容（${row.effective.split('\n').length} 行）`, row.effective));
  return section;
}
// The .bot/ files a repository still has (#935): imported once at the upgrade, never read since, safe to delete.
function retiredRulesNotice(rules = current.rules) {
  const box = element('div', '', 'retired-rules'); box.dataset.retiredRules = '';
  box.append(element('strong', '仓库里的 .bot/ 文件已迁入角色配置，可以删除'),
    note(`默认分支还有 ${rules.retired_files.join('、')}。bot 已不再读取 .bot/：规则在 Manager 提示词的章节里，检视和开发标签在项目设置里，机器配置在「机器」页。${rules.imported?.files?.length ? `升级时已导入 ${rules.imported.files.join('、')}。` : ''}从仓库删除这些文件不会改变 bot 的行为。`));
  return box;
}
function ruleSync() {
  const id = current.id, section = element('div', '', 'rule-sync'), source = note(''), message = element('p', '', 'view-error');
  message.setAttribute('role', 'status');
  const describe = () => { source.textContent = current.rules?.sha ? `默认分支提交 ${current.rules.sha.slice(0, 12)} · ${timestamp(current.rules.updated_at)}` : current.rules ? '尚未读取默认分支，任务开始时会读取。' : '暂时无法读取仓库 skill，点击刷新重试。'; };
  const refresh = button('刷新默认分支文件', async () => {
    refresh.disabled = true; refresh.textContent = '正在读取默认分支…'; message.className = 'view-error'; message.textContent = '';
    try {
      const { rules } = await api(`/api/repositories/${id}/rules/refresh`, 'POST', {});
      if (current?.id !== id) return;
      current.rules = rules; describe();
      const holder = section.closest('[data-overview-anchor="rule-sources"]');
      if (holder?.redraw) holder.redraw(`已读取默认分支提交 ${rules.sha.slice(0, 12)}`);
      else { message.className = 'view-success flash'; message.textContent = `已读取默认分支提交 ${rules.sha.slice(0, 12)}`; }
    } catch (err) { message.textContent = readErrorText(err); }
    finally { refresh.disabled = false; refresh.textContent = '刷新默认分支文件'; }
  });
  describe(); section.append(source, refresh, message); return section;
}
