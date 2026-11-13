// Group only the rows already loaded, preserving each owner's first position and the order within it.
function pendingActivationGroup(pending) {
  const section = element('div', '', 'project-owner-group project-pending-group');
  section.setAttribute('role', 'listitem'); section.dataset.key = 'pending-activation';
  const list = element('div', '', 'project-owner-rows'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', '等待管理员启动');
  for (const repo of pending) {
    const line = element('div', '', 'row project-pending-row'), content = element('div', '', 'row-content'), status = element('div', '', 'row-state');
    line.setAttribute('role', 'listitem'); line.dataset.key = 'pending:' + repo.id;
    const note = element('p', '已安装到 GitHub，等待管理员在控制台启动后即可打开。'); note.title = note.textContent; content.append(element('strong', repo.full_name), note);
    status.append(element('span', '等待管理员启动', 'status status-warning'));
    line.append(content, status); list.append(line);
  }
  section.append(element('h2', '等待管理员启动', 'project-owner-title'), list, consoleLink('#/identity', '查看身份与权限'));
  return section;
}
// #544: the shared column header for the project list; it is re-created per list render but skipped by a quiet refresh.
// The list is a role=list of listitems, so a lone row/columnheader here would be invalid table semantics; the header is
// the visual legend (hidden from assistive tech) and every data cell names its column through aria-labelledby.
const projectColumnId = label => 'project-col-' + label;
function projectTableHead() {
  const head = element('div', '', 'project-table-head'); head.setAttribute('aria-hidden', 'true');
  for (const label of projectColumnLabels) { const cell = element('span', label, 'project-cell'); cell.id = projectColumnId(label); head.append(cell); }
  return head;
}
// Fold state per organization, scoped to the signed-in account so switching accounts never reuses another one's choices.
const ownerFolding = new Map(); let ownerFoldingAccount = null;
function ownerFoldState() {
  const account = me ? String(me.id ?? me.username ?? '') : '';
  if (account !== ownerFoldingAccount) { ownerFolding.clear(); ownerFoldingAccount = account; }
  return ownerFolding;
}
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
async function refreshStaleIntegrations() {
  if (integrationAutoRefresh) return; integrationAutoRefresh = true;
  try { updateIntegrationChips((await api('/api/integrations/check', 'POST', {})).integrations || []); } catch {}
  finally { integrationAutoRefresh = false; }
}
// Grants older than the cache are read again once when the list opens; only the permission badges change. They are not
// part of the five-second task refresh, and a failed check waits for the next visit or a manual sync.
async function refreshStalePermissions() {
  if (permissionAutoRefresh) return; permissionAutoRefresh = true;
  try {
    const rows = (await api('/api/installations/permissions/check', 'POST', {})).repositories || [];
    updatePermissionBadges(rows);
    // The check answers with the same snapshot rows the navigation shows gaps from; leaving it out is how the bar and the
    // project header end up describing two different reads.
    if (typeof updateConsoleGaps === 'function') updateConsoleGaps(rows);
  } catch {}
  finally { permissionAutoRefresh = false; }
}
