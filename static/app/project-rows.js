// #934, #1133: an installed repository nobody has started is onboarded in the management assistant (#/management): clicking
// 开始接入 opens the assistant and prefills a repository-specific onboarding prompt.
function onboardingEntry(repo, caption = t('projects.list.onboard')) {
  const entry = element('a', caption, 'button-link btn-primary');
  entry.href = repo.started ? `#/projects/${encodeURIComponent(repo.id)}/management` : '#/management';
  entry.setAttribute('aria-label', t('projects.list.onboard_aria', { caption, repo: repo.full_name }));
  entry.addEventListener('click', event => {
    if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || typeof openRepositoryOnboarding !== 'function') return;
    event.preventDefault();
    Promise.resolve(openRepositoryOnboarding(repo)).catch(error);
  });
  return entry;
}
// #979: dozens of installed-but-not-started repositories used to spread over the whole page and bury the projects and
// actions around them. Beyond a handful they fold behind one summary line, and a long list gains a name filter. The fold
// and the typed name survive a redraw of the same page (a list refresh re-creates the group).
const pendingFoldThreshold = 5, pendingSearchThreshold = 10, pendingFoldState = new Map();
let pendingFoldAccount = null;
// Bind the fold and filter to the signed-in account, the same way ownerFoldState() does, so a later
// login in this tab does not keep the previous reader's typed repository name or open state (#980 review B2).
function pendingListState(scope) {
  const account = me ? String(me.id ?? me.username ?? '') : '';
  if (account !== pendingFoldAccount) { pendingFoldState.clear(); pendingFoldAccount = account; }
  const state = pendingFoldState.get(scope) || { open: false, query: '' };
  pendingFoldState.set(scope, state);
  return state;
}
function foldPendingList(list, count, scope) {
  if (count <= pendingFoldThreshold) return list;
  const state = pendingListState(scope);
  const fold = element('details', '', 'pending-repo-fold'); fold.dataset.testid = 'pending-repo-fold'; fold.open = state.open;
  fold.addEventListener('toggle', () => { state.open = fold.open; });
  fold.append(element('summary', t('projects.list.pending_fold', { count })));
  if (count > pendingSearchThreshold) {
    const label = element('label', t('projects.list.pending_search'), 'pending-repo-search'), input = document.createElement('input');
    input.type = 'search'; input.placeholder = t('projects.list.pending_search_placeholder'); input.setAttribute('autocomplete', 'off'); input.dataset.testid = 'pending-repo-search';
    const empty = element('p', '', 'muted pending-repo-empty'); empty.setAttribute('role', 'status'); empty.hidden = true;
    const apply = () => {
      const typed = input.value.trim(), query = typed.toLowerCase(); let shown = 0; state.query = input.value;
      for (const item of list.children) { const match = !query || String(item.dataset.name || '').toLowerCase().includes(query); item.hidden = !match; if (match) shown++; }
      empty.hidden = shown > 0; empty.textContent = shown ? '' : t('projects.list.pending_search_empty', { name: typed });
    };
    input.addEventListener('input', apply); input.value = state.query; if (state.query) apply();
    label.append(input); fold.append(label, empty);
  }
  fold.append(list);
  return fold;
}
function pendingActivationGroup(pending) {
  const section = element('div', '', 'project-owner-group project-pending-group');
  const title = t('projects.list.pending_title');
  section.setAttribute('role', 'listitem'); section.dataset.key = 'pending-activation';
  const list = element('div', '', 'project-owner-rows'); list.setAttribute('role', 'list'); list.setAttribute('aria-label', title);
  for (const repo of pending) {
    const line = element('div', '', 'row project-pending-row has-actions'), content = element('div', '', 'row-content'), status = element('div', '', 'row-state'), actions = element('div', '', 'actions');
    line.setAttribute('role', 'listitem'); line.dataset.key = 'pending:' + repo.id;
    line.dataset.name = repo.full_name; content.append(element('strong', repo.full_name));
    // #979: the group intro already says a super administrator starts these; only a row that differs carries its own note.
    if (repo.self_start) { const note = element('p', t('projects.list.pending_trusted')); note.title = note.textContent; content.append(note); }
    status.append(repo.self_start ? element('span', t('projects.list.pending_self_start'), 'status status-info') : element('span', t('projects.list.pending_approval'), 'status status-warning'));
    actions.append(onboardingEntry(repo));
    line.append(content, status, actions); list.append(line);
  }
  section.append(element('h2', title, 'project-owner-title'),
    element('p', t('projects.list.pending_intro') + (pending.every(repo => repo.self_start) ? '' : t('projects.list.pending_intro_review')) + t('projects.list.pending_intro_tail'), 'project-pending-intro muted'),
    foldPendingList(list, pending.length, 'projects'), consoleLink('#/identity', t('projects.list.identity_link')));
  return section;
}
// #544: the shared column header for the project list; it is re-created per list render but skipped by a quiet refresh.
// The list is a role=list of listitems, so a lone row/columnheader here would be invalid table semantics; the header is
// the visual legend (hidden from assistive tech) and every data cell names its column through aria-labelledby.
const projectColumnId = label => 'project-col-' + label;
// #527: the header prints the dictionary word for the key; the id stays key-derived so aria-labelledby never follows the language.
function projectTableHead(labels = projectColumnLabels) {
  const head = element('div', '', 'project-table-head'); head.setAttribute('aria-hidden', 'true');
  for (const label of labels) { const cell = element('span', projectColumnText(label), 'project-cell'); cell.id = projectColumnId(label); cell.dataset.colLabel = projectColumnText(label); head.append(cell); }
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
    const section = element('div', '', 'project-owner-group'), title = group.login || group.name || t('projects.list.owner_fallback', { owner });
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
    const count = element('span', t('projects.list.page_count', { count: group.rows.length }), 'project-owner-count muted');
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
// account changed must not write onto the current list — neither its chips nor its statement (the reviewer's R2). The
// list render is not part of the guard: a slow answer for the same account still updates the chips it can name.
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
