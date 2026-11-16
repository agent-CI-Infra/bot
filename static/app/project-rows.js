// #716: an installed repository that was never started is started by a super administrator, so the copy names that role
// and each row offers the one next step this reader has: copy a reminder to send them. In a trusted organization (#848) its
// administrator starts it, and the row carries 启动 instead. (Super administrators never get this group: their project list
// is the installed list, where such a row already carries 启动.)
const pendingActivationTitle = '等待超级管理员启动';
function pendingActivationReminder(repo) {
  const address = (location.origin || '') + (location.pathname || '/') + '#/projects';
  return `请在 LaunchPad 控制台启动仓库 ${repo.full_name}：${address}`;
}
function pendingActivationAction(repo) {
  const copy = button('复制提醒', async () => {
    const text = pendingActivationReminder(repo);
    try { await navigator.clipboard.writeText(text); copy.textContent = '已复制'; copy.title = text; }
    catch { copy.textContent = '请手动复制'; copy.title = text; const box = copy.parentElement; if (box && !box.querySelector('.project-pending-manual')) box.append(element('p', text, 'project-pending-manual')); }
  });
  copy.setAttribute('aria-live', 'polite');
  return copy;
}
// #848: in an organization a super administrator trusts, the repository's administrator starts it here. The organization's
// defaults choose the model and development; nothing else is asked.
function pendingStartAction(repo) {
  const start = button('启动', async () => {
    start.disabled = true; notice('message', `正在启动 ${repo.full_name}…`);
    try { await api(`/api/installations/${repo.id}/activate`, 'POST', {}); notice('message', `已启动 ${repo.full_name}。`); await route(); }
    catch (err) { start.disabled = false; notice('message', readErrorText(err), '', 'alert'); }
  });
  return start;
}
function pendingActivationGroup(pending) {
  const section = element('div', '', 'project-owner-group project-pending-group'), own = pending.some(repo => repo.self_start);
  const title = own ? '待启动的仓库' : pendingActivationTitle;
  section.setAttribute('role', 'listitem'); section.dataset.key = 'pending-activation';
  const list = element('div', '', 'project-owner-rows'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', title);
  for (const repo of pending) {
    const line = element('div', '', 'row project-pending-row has-actions'), content = element('div', '', 'row-content'), status = element('div', '', 'row-state'), actions = element('div', '', 'actions');
    line.setAttribute('role', 'listitem'); line.dataset.key = 'pending:' + repo.id;
    const note = element('p', repo.self_start ? '已安装到 GitHub，所属组织已受信任，你可以直接启动；模型和开发设置用组织的默认值。' : '已安装到 GitHub，需要超级管理员在控制台启动后才能打开。');
    note.title = note.textContent; content.append(element('strong', repo.full_name), note);
    status.append(repo.self_start ? element('span', '可自行启动', 'status status-info') : element('span', '待超级管理员启动', 'status status-warning'));
    actions.append(repo.self_start ? pendingStartAction(repo) : pendingActivationAction(repo));
    line.append(content, status, actions); list.append(line);
  }
  section.append(element('h2', title, 'project-owner-title'),
    element('p', '这些仓库已装好 GitHub App，启动后会出现在上面的项目列表里。', 'project-pending-intro muted'),
    list, consoleLink('#/identity', '查看身份与权限'));
  return section;
}
// #544: the shared column header for the project list; it is re-created per list render but skipped by a quiet refresh.
// The list is a role=list of listitems, so a lone row/columnheader here would be invalid table semantics; the header is
// the visual legend (hidden from assistive tech) and every data cell names its column through aria-labelledby.
const projectColumnId = label => 'project-col-' + label;
function projectTableHead(labels = projectColumnLabels) {
  const head = element('div', '', 'project-table-head'); head.setAttribute('aria-hidden', 'true');
  for (const label of labels) { const cell = element('span', label, 'project-cell'); cell.id = projectColumnId(label); head.append(cell); }
  return head;
}
// Fold state per organization, scoped to the signed-in account so switching accounts never reuses another one's choices.
const ownerFolding = new Map(); let ownerFoldingAccount = null;
function ownerFoldState() {
  const account = me ? String(me.id ?? me.username ?? '') : '';
  if (account !== ownerFoldingAccount) { ownerFolding.clear(); ownerFoldingAccount = account; }
  return ownerFolding;
}
// Group only the rows already loaded, preserving each owner's first position and the order within it.
function groupProjectRows(rows, lines) {
  const groups = new Map();
  rows.forEach((row, index) => {
    const owner = String(row.owner_id);
    if (!groups.has(owner)) groups.set(owner, { rows: [], lines: [], login: '', name: '' });
    const group = groups.get(owner);
    group.rows.push(row); group.lines.push(lines[index]);
    group.login ||= row.owner_login;
    if (row.full_name?.includes('/')) group.name ||= row.full_name.split('/')[0];
  });
  const folding = ownerFoldState();
  return [...groups].map(([owner, group]) => {
    const section = element('div', '', 'project-owner-group'), title = group.login || group.name || `所有者 ${owner}`;
    section.setAttribute('role', 'listitem'); section.dataset.ownerId = owner; section.dataset.key = owner;
    const list = element('div', '', 'project-owner-rows'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', title);
    list.append(...group.lines);
    // #544: the organization title is the fold control. It keeps its own text so the heading still reads as the owner,
    // the caret is drawn from aria-expanded, and the count says this page's size rather than pretending to be a total.
    const heading = element('h2', '', 'project-owner-title'), toggle = element('button', title, 'project-owner-toggle btn-text');
    toggle.setAttribute('type', 'button'); toggle.setAttribute('aria-expanded', String(!folding.has(owner)));
    heading.append(toggle);
    list.hidden = folding.has(owner); section.classList.toggle('is-folded', folding.has(owner));
    toggle.addEventListener('click', () => {
      const folded = toggle.getAttribute('aria-expanded') === 'true', states = ownerFoldState();
      toggle.setAttribute('aria-expanded', String(!folded)); list.hidden = folded; section.classList.toggle('is-folded', folded);
      if (folded) states.set(owner, true); else states.delete(owner);
    });
    const count = element('span', `本页 ${group.rows.length} 个项目`, 'project-owner-count muted');
    const bar = element('div', '', 'project-owner-bar'); bar.append(heading, count);
    section.append(bar, list);
    rowSignatures.set(section, JSON.stringify(group.rows));
    return section;
  });
}
// Stale chips are checked once in the background and only the chips change; the list is neither reloaded nor cleared.
// A result that is still stale (a failed check, or more repositories than one check covers) waits for a manual refresh.
// #869: a failure is no longer swallowed. The chips keep the previous reading, and the list states the failure with the
// time of the reading it is showing and one manual read; a success clears that statement. A result that lands after the
// account changed or the list drew again belongs to neither, so it is dropped rather than written over the current list.
async function refreshStaleIntegrations() {
  if (integrationAutoRefresh) return; integrationAutoRefresh = true;
  const ticket = projectCheckTicket();
  try {
    const integrations = (await api('/api/integrations/check', 'POST', {})).integrations || [];
    if (!projectCheckCurrent(ticket)) return;
    updateIntegrationChips(integrations); projectCheckPassed('integrations', integrations);
  } catch (err) { if (projectCheckCurrent(ticket)) projectCheckFailed('integrations', err); }
  finally { integrationAutoRefresh = false; }
}
// Grants older than the cache are read again once when the list opens; only the permission badges change. They are not
// part of the five-second task refresh, and a failed check waits for the next visit or a manual sync.
async function refreshStalePermissions() {
  if (permissionAutoRefresh) return; permissionAutoRefresh = true;
  const ticket = projectCheckTicket();
  try {
    const rows = (await api('/api/installations/permissions/check', 'POST', {})).repositories || [];
    if (!projectCheckCurrent(ticket)) return;
    updatePermissionBadges(rows);
    // The check answers with the same snapshot rows the navigation shows gaps from; leaving it out is how the bar and the
    // project header end up describing two different reads.
    if (typeof updateConsoleGaps === 'function') updateConsoleGaps(rows);
    projectCheckPassed('permissions', rows, 'permissions_checked_at');
  } catch (err) { if (projectCheckCurrent(ticket)) projectCheckFailed('permissions', err); }
  finally { permissionAutoRefresh = false; }
}
