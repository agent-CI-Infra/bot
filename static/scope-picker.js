// Both triggers share one searchable list. Storage contains only project ids, partitioned by the signed-in user.
let scopePickerTrigger = null, scopePickerActive = 0, scopePickerSignature = '', scopePickerVisit = null, scopePickerRepositoriesOwner = null;
const scopeOrganization = row => row.full_name?.includes('/') ? row.full_name.split('/')[0] : (row.account_name || t('scope.other'));
const scopeRepository = row => row.full_name?.includes('/') ? row.full_name.split('/').slice(1).join('/') : (row.full_name || String(row.id));
const scopeRecentKey = () => 'console-recent-projects:' + me.id;
function scopeRecentProjects(visit = null) {
  // start() draws the signed-in shell before its whole-list read answers. That empty placeholder cannot revoke history.
  if (scopePickerRepositoriesOwner !== me.id) return [];
  let saved = [];
  try { const value = JSON.parse(localStorage.getItem(scopeRecentKey()) || '[]'); if (Array.isArray(value)) saved = value; } catch { /* storage may be disabled or malformed */ }
  const allowed = new Set(repositories.map(row => String(row.id)));
  const ids = [...new Set([...(visit ? [visit] : []), ...saved].filter(id => typeof id === 'string' && allowed.has(id)))].slice(0, 5);
  try { localStorage.setItem(scopeRecentKey(), JSON.stringify(ids)); } catch { /* switching still works without storage */ }
  return ids;
}
function scopePickerButton(id) {
  const trigger = button('', () => $('console-scope-picker').open ? closeScopePicker() : openScopePicker(trigger), 'quiet console-scope-trigger');
  trigger.id = id; trigger.setAttribute('aria-haspopup', 'listbox'); trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', 'console-scope-list'); return trigger;
}
function syncScopePicker() {
  if (!me) {
    closeScopePicker(false); scopePickerVisit = null; scopePickerSignature = ''; scopePickerRepositoriesOwner = null;
    for (const trigger of [$('console-project'), $('console-mobile-project')]) {
      trigger.replaceChildren(); trigger.dataset.projectId = ''; trigger.title = ''; trigger.setAttribute('aria-label', t('nav.switch_project'));
    }
    $('console-scope-list').replaceChildren(); $('console-scope-footer').replaceChildren(); return;
  }
  const id = consoleScope(), repo = repositories.find(row => String(row.id) === id);
  const visit = JSON.stringify([me.id, repo?.id || null]);
  const recent = scopeRecentProjects(visit !== scopePickerVisit && repo ? String(repo.id) : null); scopePickerVisit = visit;
  for (const trigger of [$('console-project'), $('console-mobile-project')]) {
    const name = repo ? scopeRepository(repo) : t('nav.all_projects');
    const detail = repo ? scopeOrganization(repo) : t('scope.count', { count: repositories.length });
    trigger.title = repo?.full_name || name; trigger.dataset.projectId = repo ? String(repo.id) : '';
    trigger.setAttribute('aria-label', t('nav.switch_project') + '：' + (repo?.full_name || name));
    const mark = element('span', repo ? name[0].toUpperCase() : '⊞', 'console-scope-mark'); mark.setAttribute('aria-hidden', 'true');
    const text = element('span', '', 'console-scope-copy'); text.append(element('strong', name), element('small', detail));
    const arrow = element('span', '⌄', 'console-scope-arrow'); arrow.setAttribute('aria-hidden', 'true');
    trigger.replaceChildren(mark, text, arrow);
  }
  const signature = JSON.stringify([me.id, me.role, id, currentLocale(), recent, repositories.map(row => [row.id, row.full_name, row.account_name, row.enabled])]);
  if (signature !== scopePickerSignature) { scopePickerSignature = signature; drawScopePicker(); }
}
function drawScopePicker() {
  const search = $('console-scope-search'), list = $('console-scope-list');
  $('console-scope-picker').setAttribute('aria-label', t('nav.switch_project'));
  $('console-scope-picker').querySelector('.console-scope-close').setAttribute('aria-label', t('scope.close'));
  search.placeholder = t('scope.search'); search.setAttribute('aria-label', t('scope.search'));
  list.setAttribute('aria-label', t('nav.switch_project'));
  const query = search.value.trim().toLocaleLowerCase(), selected = consoleScope();
  const option = row => {
    const id = row ? String(row.id) : '', name = row ? scopeRepository(row) : t('nav.all_projects');
    const item = element('div', '', 'console-scope-option'); item.dataset.projectId = id;
    item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String((selected || '') === id));
    item.setAttribute('aria-label', row ? row.full_name + (!row.enabled ? '，' + t('scope.disabled') : '') : name);
    item.title = row?.full_name || name; item.append(element('span', name, 'console-scope-name'));
    if (row && !row.enabled) item.append(element('small', t('scope.disabled'), 'console-scope-disabled'));
    item.addEventListener('pointerdown', event => event.preventDefault());
    item.addEventListener('click', () => chooseConsoleScope(id || null).catch(error)); return item;
  };
  const group = (title, rows, id) => {
    const box = element('div', '', 'console-scope-group'), label = element('div', title, 'console-scope-group-label');
    box.id = id; label.id = id + '-label'; box.setAttribute('role', 'group'); box.setAttribute('aria-labelledby', label.id);
    box.append(label, ...rows.map(option)); return box;
  };
  const recent = scopeRecentProjects().map(id => repositories.find(row => String(row.id) === id));
  list.replaceChildren(option(null));
  if (!query && recent.length) list.append(group(t('scope.recent'), recent, 'console-scope-recent'));
  const projects = element('div'); projects.id = 'console-scope-projects';
  const groups = new Map();
  for (const row of repositories) {
    if (!(row.full_name || '').toLocaleLowerCase().includes(query)) continue;
    const org = scopeOrganization(row); if (!groups.has(org)) groups.set(org, []); groups.get(org).push(row);
  }
  for (const [org, rows] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    rows.sort((a, b) => scopeRepository(a).localeCompare(scopeRepository(b)));
    projects.append(group(org + ' · ' + rows.length, rows, 'console-scope-org-' + projects.childElementCount));
  }
  list.append(projects);
  if (!groups.size) { const empty = element('p', t('scope.empty'), 'console-scope-empty'); empty.setAttribute('role', 'status'); list.append(empty); }
  const options = [...list.querySelectorAll('[role=option]')];
  options.forEach((item, index) => { item.id = 'console-scope-option-' + index; });
  scopePickerActive = Math.max(0, options.findIndex(item => item.getAttribute('aria-selected') === 'true'));
  activateScopeOption(scopePickerActive, false);
  const footer = $('console-scope-footer'); footer.replaceChildren(consoleLink('#/projects', t('scope.manage')));
  if (me.role === 'super_admin') footer.append(consoleLink('#/settings/projects', t('scope.start')));
}
function activateScopeOption(index, scroll = true) {
  const options = [...$('console-scope-list').querySelectorAll('[role=option]')];
  if (!options.length) return;
  scopePickerActive = (index + options.length) % options.length;
  options.forEach((item, i) => item.classList.toggle('is-active', i === scopePickerActive));
  $('console-scope-search').setAttribute('aria-activedescendant', options[scopePickerActive].id);
  if (scroll) options[scopePickerActive].scrollIntoView({ block: 'nearest' });
}
function openScopePicker(trigger) {
  const panel = $('console-scope-picker');
  if (!me || document.querySelector('dialog[open]')) return;
  scopePickerTrigger = trigger; $('console-scope-search').value = ''; drawScopePicker();
  if (consoleMedia.matches) panel.showModal(); else panel.show();
  for (const button of [$('console-project'), $('console-mobile-project')]) button.setAttribute('aria-expanded', 'true');
  $('console-scope-search').setAttribute('aria-expanded', 'true');
  $('console-scope-search').focus(); activateScopeOption(scopePickerActive);
}
function closeScopePicker(restore = true) {
  const panel = $('console-scope-picker'); if (!panel?.open) return;
  panel.close();
  for (const button of [$('console-project'), $('console-mobile-project')]) button.setAttribute('aria-expanded', 'false');
  $('console-scope-search').setAttribute('aria-expanded', 'false');
  if (restore) scopePickerTrigger?.focus({ preventScroll: true });
  scopePickerTrigger = null;
}
async function chooseConsoleScope(id) {
  closeScopePicker();
  if ((consoleScope() || null) === id) return;
  if (id && !repositories.some(row => String(row.id) === id)) return;
  if (typeof confirmKnowledgeLeave === 'function' && !await confirmKnowledgeLeave()) return;
  // Commit only after the existing editor guard accepts. The default must be ready before hashchange: a second
  // navigation can replace that pending event, and must still see the scope the reader just chose.
  setConsoleDefaultProject(id); consoleProject = id;
  if (/^#\/(board|costs|management)(\/|$)/.test(location.hash)) {
    if (tab === 'management') syncConsoleShell(); else route().catch(error);
    return;
  }
  const project = projectRoute();
  if (consoleInboxRoute()) location.hash = '#/inbox' + (id ? '/' + id : '');
  else if (/^#\/new-task(?:\/|$)/.test(location.hash)) location.hash = '#/new-task' + (id ? '/' + id : '');
  else location.hash = id ? `#/projects/${id}/${project?.section || 'overview'}` : '#/projects';
}
function initScopePicker() {
  const panel = document.createElement('dialog'); panel.id = 'console-scope-picker'; panel.className = 'console-scope-picker';
  panel.setAttribute('aria-label', t('nav.switch_project'));
  const header = element('div', '', 'console-scope-search-row'), search = document.createElement('input');
  search.id = 'console-scope-search'; search.type = 'search'; search.autocomplete = 'off'; search.setAttribute('role', 'combobox');
  search.setAttribute('aria-autocomplete', 'list'); search.setAttribute('aria-controls', 'console-scope-list'); search.setAttribute('aria-expanded', 'false');
  const close = button('×', () => closeScopePicker(), 'quiet console-scope-close'); close.setAttribute('aria-label', t('scope.close'));
  header.append(search, close);
  const list = element('div'); list.id = 'console-scope-list'; list.setAttribute('role', 'listbox');
  const footer = element('div', '', 'console-scope-footer'); footer.id = 'console-scope-footer';
  panel.append(header, list, footer); document.body.append(panel);
  search.addEventListener('input', drawScopePicker);
  panel.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeScopePicker(); }
    if (event.target !== search) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); activateScopeOption(scopePickerActive + (event.key === 'ArrowDown' ? 1 : -1)); }
    if (event.key === 'Enter') { event.preventDefault(); chooseConsoleScope(list.querySelectorAll('[role=option]')[scopePickerActive]?.dataset.projectId || null).catch(error); }
  });
  panel.addEventListener('cancel', event => { event.preventDefault(); closeScopePicker(); });
  footer.addEventListener('click', event => { if (event.target.closest('a')) closeScopePicker(); });
  document.addEventListener('click', event => {
    if (panel.open && !panel.contains(event.target) && !event.target.closest('.console-scope-trigger')) closeScopePicker();
  });
  document.addEventListener('keydown', event => {
    if (!me || event.key.toLowerCase() !== 'k' || !(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return;
    if (document.querySelector('dialog[open], [role=dialog][aria-modal=true]:not([hidden])') || event.target.closest('.management-input, [contenteditable=true]')) return;
    event.preventDefault(); openScopePicker($(consoleMedia.matches ? 'console-mobile-project' : 'console-project'));
  });
  addEventListener('hashchange', () => closeScopePicker(false));
  // Wait for a stable viewport: transient layout measurements must not dismiss an open picker.
  let presentationTimer = null;
  consoleMedia.addEventListener('change', () => {
    clearTimeout(presentationTimer);
    presentationTimer = setTimeout(() => {
      if (panel.open && panel.matches(':modal') !== consoleMedia.matches) closeScopePicker(false);
    }, 100);
  });
}
