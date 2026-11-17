// Addresses own project scope. Pages without a project dimension retain the last resolved scope in this session.
const projectConsolePages = ['board', 'inbox', 'costs', 'management', 'new-task'];
let consoleScopeOwner = null, consoleRetainedScope = null, consoleTaskScope = null;
const consoleLastScopeKey = () => 'console-last-scope:' + me.id;
function projectConsoleRoute(route) {
  return !!route && projectConsolePages.includes(route.section) && (!route.item || route.section === 'inbox' && /^\d+$/.test(route.item));
}
function consoleAddressScope(hash = location.hash) {
  const project = projectRoute(hash);
  if (project) return project.id;
  const task = taskRoute(hash);
  if (task) return consoleTaskScope?.owner === me?.id && consoleTaskScope.task === task.id ? consoleTaskScope.project : undefined;
  if (/^#\/(projects|board|reviews|developments|inbox|costs|management|new-task)(?:\/|$)/.test(hash)) return null;
  return undefined;
}
function consoleScope() {
  const scope = consoleAddressScope();
  return scope === undefined ? (consoleScopeOwner === me?.id ? consoleRetainedScope : null) : scope;
}
function syncConsoleScope() {
  if (consoleScopeOwner !== me?.id) { consoleScopeOwner = me?.id || null; consoleRetainedScope = null; }
  const scope = consoleAddressScope();
  if (!me || scope === undefined) return;
  consoleRetainedScope = scope;
  // A placeholder list during startup cannot revoke a remembered scope. Unknown deep links are never persisted.
  if (scopePickerRepositoriesOwner !== me.id || scope && !repositories.some(row => String(row.id) === scope)) return;
  try { localStorage.setItem(consoleLastScopeKey(), scope || 'all'); } catch { /* Navigation works with storage disabled. */ }
}
function restoreConsoleStart(rows) {
  if (location.hash && location.hash !== '#/') return;
  let scope;
  try { scope = localStorage.getItem(consoleLastScopeKey()); } catch { /* Use All projects when storage is unavailable. */ }
  const project = rows.find(row => String(row.id) === scope);
  if (scope && scope !== 'all' && !project) {
    try { localStorage.setItem(consoleLastScopeKey(), 'all'); } catch { /* The fallback address still takes effect. */ }
  }
  history.replaceState(null, '', project ? `#/projects/${project.id}/overview` : '#/projects');
}
function consolePageAddress(page, id = consoleScope()) {
  if (id) return `#/projects/${id}/${page === 'projects' ? 'overview' : page}`;
  return '#/' + page;
}
