// The generic list renderer still understands task rows; their old top-level addresses now select a board category.
const taskKinds = { reviews: 'review', developments: 'development' }, listTabs = ['projects','events','external'];
// Console pages are drawn by static/shell.js (renderConsolePage). They are not tabs of the generic list, and no list
// read may ever build /api/<tab> from them: #/more would become GET /api/more, an endpoint that does not exist (#365).
const consoleTabs = ['more', 'inbox', 'new-task', 'conversations'];
// Wizard steps live inside global settings; old top-level addresses are normalized by route().
const onboardingAddress = /^#\/settings\/onboarding(?:\/([0-6]))?$/;
const legacyOnboardingAddress = /^#onboarding(?:\/(\d+))?$/;
// A project page (#/projects/<id>/<section>) replaces the list; any other address shows the current tab's list.
// The tab an address names: #/<tab>, a project page, a wizard step, or an older address (#external, #/accounts, #/users).
function addressTab(hash) {
  if (/^#\/new-task(?:\/[1-9]\d*)?$/.test(hash)) return 'new-task';
  if (projectRoute() || hash === '#/projects') return 'projects';
  if (['#/reviews', '#/developments'].includes(hash)) return 'board';
  if (onboardingAddress.test(hash)) return 'settings';
  if (hash === '#external') return 'external';
  // #224-A: the component/state sample page. It has an address of its own so a deep link works, and no #tabs entry:
  // it is the reviewed evidence surface for the design tokens, not a feature users navigate to.
  if (hash === '#/design') return 'design';
  const name = /^#\/([a-z]+)(?:\/|$)/.exec(hash)?.[1];
  return ['accounts', 'users'].includes(name) ? 'settings' : tabAddresses[name] ? name : null;
}
async function route() {
  renderVersion++;
  if (/^#\/channels(?:\/|$)/.test(location.hash)) history.replaceState(null, '', '#/identity/feishu');
  if (location.hash === '#/identity/feishu/conversations') history.replaceState(null, '', '#/conversations');
  if (location.hash === '#/identity/feishu/groups') history.replaceState(null, '', '#/identity/feishu?section=groups');
  const legacyComputer = /^#\/settings\/computers(?:\/([^/?#]+))?$/.exec(location.hash);
  if (legacyComputer) history.replaceState(null, '', legacyComputer[1] ? `#/projects/${decodeURIComponent(legacyComputer[1])}/machine` : '#/settings/work-computers');
  // A project chat link keeps the project context; the top-level management address is a page of its own.
  const chatProject = /^#\/projects\/([^/]+)\/management$/.exec(location.hash)?.[1];
  // The project chat trigger has no settings section of its own: keep the project, open its first page underneath,
  // so a shared or reloaded address does not silently become 基本设置.
  if (chatProject) history.replaceState(null, '', `#/projects/${chatProject}/overview`);
  const legacy = legacyOnboardingAddress.exec(location.hash);
  if (legacy) history.replaceState(null, '', '#/settings/onboarding/' + ([0, 1, 3, 4, 5, 6][Number(legacy[1] || 0)] ?? 0));
  // Accounts and users were tabs of their own; their old addresses open the matching settings section.
  const moved = /^#\/(accounts|users)$/.exec(location.hash); if (moved) history.replaceState(null, '', '#/settings/' + moved[1]);
  // #480: a single project's editor lives only in the project workspace. The legacy global address keeps working as a
  // redirect, and carries that it came from the list so deleting the project still returns to the batch list.
  const legacyProjectSettings = /^#\/settings\/projects\/([1-9]\d*)$/.exec(location.hash);
  if (legacyProjectSettings) history.replaceState({ projectListOrigin: true }, '', `#/projects/${legacyProjectSettings[1]}/basic`);
  // An address the console does not know keeps the current page (on a fresh load that is the projects page).
  let next = addressTab(location.hash) || tab;
  // Project administrators open global settings only for its 存储 section.
  if (superTabs.includes(next) && me.role !== 'super_admin' && !(next === 'settings' && /^#\/settings(?:\/storage(?:\/.*)?)?$/.test(location.hash))) next = 'projects';
  // The sample page issues no fetch of its own - every panel is constant markup - so a client-side role check is
  // the whole gate. If it ever reads server data, it needs a server-side gate first: hiding a route is not one.
  if (next === 'design' && me.role !== 'super_admin') next = 'projects';
  const resolved = next;
  if (next !== tab) offset = 0; tab = next;
  const target = projectRoute(), page = $('project-page'), list = document.querySelector('.list-panel');
  // Global and project computer views reuse DOM ids; discard the inactive view and its scheduled reads.
  if (!target && typeof leaveProjectPage === 'function') leaveProjectPage();
  if (tab !== 'settings') $('settings-panel').replaceChildren();
  const address=tab+':'+location.hash;if(messagePage!==address){notice('message');messagePage=address;}
  const consolePage = consoleTabs.includes(tab);
  if (!consolePage) $('console-page').replaceChildren();
  const sample = !target && tab === 'design', samplePage = $('design-page');
  page.hidden = !target; samplePage.hidden = !sample; list.hidden = !!target || tab === 'management' || consolePage || sample;
  $('console-page').hidden = !consolePage;
  if (typeof syncConsoleShell === 'function') syncConsoleShell(target);
  // The board fills the viewport and scrolls inside its columns; every other page keeps normal document scrolling.
  document.body.classList.toggle('board-mode', !target && tab === 'board');
  const activeNavTab = ['preferences', 'identity', 'external', 'conversations'].includes(tab) ? 'preferences' : tab;
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', !target && el.dataset.tab === activeNavTab ? 'page' : 'false'));
  // A second address can arrive while the first one is still loading (a hash change during a list read): the newer
  // route owns the page, so this one stops before it can redraw it from the address it no longer represents.
  if (resolved !== tab) return;
  if (consolePage) {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    await renderConsolePage(renderVersion);
  } else if (sample) {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    renderDesignPage();
  } else if (tab === 'management' && !target) await renderManagementPage();
  else {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    if (target) await renderProject(target); else await render();
    if (chatProject) void openManagementChat(chatProject).catch(error);
  }
  if (typeof syncConsoleShell === 'function') syncConsoleShell(target);
  if (typeof restoreConsolePosition === 'function') restoreConsolePosition();
}
window.addEventListener('hashchange', () => { if (me) route().catch(error); });
