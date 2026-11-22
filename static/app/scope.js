// Addresses own project scope. Pages without a project dimension retain the last resolved scope in this session.
const projectConsolePages = ['inbox', 'costs', 'management', 'new-task'];
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
  if (/^#\/management\//.test(hash)) return undefined;
  if (/^#\/(projects|board|reviews|developments|inbox|costs|management|new-task)(?:\/|$)/.test(hash)) return null;
  return undefined;
}
function retainedConsoleScope() {
  if (consoleScopeOwner !== me?.id) return null;
  // Only the complete account-owned list may revoke a scope; startup and filtered lists are not authoritative.
  return scopePickerRepositoriesOwner === me?.id && consoleRetainedScope && !repositories.some(row => String(row.id) === consoleRetainedScope) ? null : consoleRetainedScope;
}
function consoleScope() {
  const scope = consoleAddressScope();
  return scope === undefined ? retainedConsoleScope() : scope;
}
function syncConsoleScope() {
  if (consoleScopeOwner !== me?.id) { consoleScopeOwner = me?.id || null; consoleRetainedScope = null; }
  if (!me) return;
  const scope = consoleAddressScope();
  if (scope !== undefined) consoleRetainedScope = scope;
  if (scopePickerRepositoriesOwner !== me.id) return;
  // A forbidden deep link still names its project, but neither neutral pages nor future visits inherit that grant.
  const beforeValidation = consoleRetainedScope;
  consoleRetainedScope = retainedConsoleScope();
  if (scope === undefined && beforeValidation === consoleRetainedScope) return;
  try { localStorage.setItem(consoleLastScopeKey(), consoleRetainedScope || 'all'); } catch { /* Navigation works with storage disabled. */ }
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
