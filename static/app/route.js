// The generic list renderer still understands task rows; their old top-level addresses now select a board category.
const taskKinds = { reviews: 'review', developments: 'development' }, listTabs = ['projects','external'];
// Console pages are drawn by static/shell.js (renderConsolePage). They are not tabs of the generic list, and no list
// read may ever build /api/<tab> from them: #/more would become GET /api/more, an endpoint that does not exist (#365).
const consoleTabs = ['more', 'inbox', 'new-task', 'conversations', 'task', 'not-found'];
// #934, #1133: legacy #/onboarding/<id> links redirect to the management assistant and prefill its composer.
const repositoryOnboardingAddress = /^#\/onboarding\/([1-9]\d*)$/;
// #642: an address under #/ that names no page shows 找不到这个页面 instead of keeping (or silently loading) another page.
// In-page anchors such as the skip link's #main-content are not console addresses and still keep the current page.
function unknownAddress(hash) {
  const path = hash.split('?')[0];
  if (!path.startsWith('#/') || path === '#/') return false;
  // #736: the legacy computer address redirects to a project only when its id can be decoded. A malformed one names no
  // page at all, so it reads as unknown instead of becoming a project address built from garbage.
  const legacyComputerId = legacyComputerAddress.exec(path)?.[1];
  if (legacyComputerId && safeDecode(legacyComputerId) === null) return true;
  if (/^#\/tasks(?:\/|$)/.test(path) && !taskRoute(path)) return true;
  // #/projects/<anything> that is not a project address (#/projects/abc, #/projects/1/Members) is a broken project link.
  if (/^#\/projects\/./.test(path) && !projectRoute()) return true;
  return !addressTab(hash);
}
// The empty state #553 uses everywhere, with one primary way back. Inside a project it returns to that project's overview.
function pageNotFoundState(project = null) {
  const box = consoleState('找不到这个页面', project ? '这个项目里没有这个页面，链接可能已过期或输入有误。' : '链接可能已过期或输入有误。');
  box.classList.add('page-not-found'); box.dataset.pageNotFound = project ? 'project' : 'console';
  const actions = element('div', '', 'actions page-not-found-actions');
  const primary = element('a', project ? '回到项目总览' : '回到项目列表', 'button-link btn-primary');
  primary.href = project ? `#/projects/${project}/overview` : '#/projects';
  const secondary = element('a', project ? '回到项目列表' : '查看身份与权限', 'button-link btn-secondary');
  secondary.href = project ? '#/projects' : '#/identity';
  actions.append(primary, secondary); box.append(actions); return box;
}
function renderNotFoundPage() { $('console-page').replaceChildren(pageNotFoundState()); }
// Wizard steps live inside global settings; old top-level addresses are normalized by route().
const onboardingAddress = /^#\/settings\/onboarding(?:\/([0-6]))?$/;
const legacyOnboardingAddress = /^#onboarding(?:\/(\d+))?$/;
// #736: the old global computer address #/settings/computers/<id> named one machine of a project, with an encoded id.
const legacyComputerAddress = /^#\/settings\/computers(?:\/([^/?#]+))?$/;
// A project page (#/projects/<id>/<section>) replaces the list; any other address shows the current tab's list.
// The tab an address names: #/<tab>, a project page, a wizard step, or an older address (#external, #/accounts, #/users).
function addressTab(hash) {
  if (taskRoute(hash)) return 'task';
  if (/^#\/new-task(?:\/[1-9]\d*)?$/.test(hash)) return 'new-task';
  if (repositoryOnboardingAddress.test(hash)) return 'management';
  const project = projectRoute(hash);
  if (project) return projectConsoleRoute(project) ? project.section : 'projects';
  if (hash === '#/projects') return 'projects';
  if (['#/reviews', '#/developments'].includes(hash)) return 'board';
  if (onboardingAddress.test(hash)) return 'settings';
  if (hash === '#external') return 'external';
  // #224-A: the component/state sample page. It has an address of its own so a deep link works, and no #tabs entry:
  // it is the reviewed evidence surface for the design tokens, not a feature users navigate to.
  if (hash === '#/design') return 'design';
  const name = /^#\/([a-z]+)(?:\/|$)/.exec(hash)?.[1];
  return ['accounts', 'users'].includes(name) ? 'settings' : tabAddresses[name] ? name : null;
}
// #936: the address whose page was painted last. A dialog opened from that page belongs to it, so a real address
// change ends the dialog and a repaint of the same address (a list refresh, a poll) leaves it open.
let paintedAddress = '', routeGeneration = 0;
async function route() {
  const generation = ++routeGeneration;
  renderVersion++;
  // #737: the focus the redraw may take away, so a change the reader asked for can hand it to the page it opens.
  const focusBefore = document.activeElement;
  if (/^#\/channels(?:\/|$)/.test(location.hash)) history.replaceState(null, '', '#/identity/feishu');
  if (location.hash === '#/identity/feishu/conversations') history.replaceState(null, '', '#/conversations');
  if (location.hash === '#/identity/feishu/groups') history.replaceState(null, '', '#/identity/feishu?section=groups');
  // #736: the id is decoded here, so a malformed one keeps its address (and reads as unknown below) instead of
  // redirecting to a project path built from an undecodable segment.
  const legacyComputer = legacyComputerAddress.exec(location.hash);
  if (legacyComputer?.[1]) { const id = safeDecode(legacyComputer[1]); if (id !== null) history.replaceState(null, '', `#/projects/${id}/machine`); }
  else if (legacyComputer) history.replaceState(null, '', '#/settings/work-computers');
  // Replace legacy scope paths in place: Back must not revisit a redirect entry.
  const oldInbox = /^#\/inbox\/([1-9]\d*)(?:\/(\d+))?$/.exec(location.hash);
  if (oldInbox) history.replaceState(null, '', `#/projects/${oldInbox[1]}/inbox${oldInbox[2] ? '/' + oldInbox[2] : ''}`);
  const oldMenu = /^#\/projects\/([1-9]\d*)\/menu$/.exec(location.hash);
  if (oldMenu) history.replaceState(null, '', `#/projects/${oldMenu[1]}/overview`);
  const oldCreation = /^#\/new-task\/([1-9]\d*)$/.exec(location.hash);
  if (oldCreation) history.replaceState(null, '', `#/projects/${oldCreation[1]}/new-task`);
  const legacy = legacyOnboardingAddress.exec(location.hash);
  if (legacy) history.replaceState(null, '', '#/settings/onboarding/' + ([0, 1, 3, 4, 5, 6][Number(legacy[1] || 0)] ?? 0));
  const legacyRepoOnboarding = repositoryOnboardingAddress.exec(location.hash);
  if (legacyRepoOnboarding) {
    const id = legacyRepoOnboarding[1], matched = repositories.find(row => String(row.id) === id);
    if (typeof queueRepositoryOnboarding === 'function') queueRepositoryOnboarding({ id, full_name: matched?.full_name || null, started: !!matched });
    history.replaceState(null, '', matched ? `#/projects/${id}/management` : '#/management');
  }
  // Accounts and users were tabs of their own; their old addresses open the matching settings section.
  const moved = /^#\/(accounts|users)$/.exec(location.hash); if (moved) history.replaceState(null, '', '#/settings/' + moved[1]);
  // #480: a single project's editor lives only in the project workspace. The legacy global address keeps working as a
  // redirect, and carries that it came from the list so deleting the project still returns to the batch list.
  const legacyProjectSettings = /^#\/settings\/projects\/([1-9]\d*)$/.exec(location.hash);
  if (legacyProjectSettings) history.replaceState({ projectListOrigin: true }, '', `#/projects/${legacyProjectSettings[1]}/basic`);
  // #936: the task detail and the read-only delivery detail are dialogs of the page they were opened from. When the
  // address moves, they go with it - the target page must be usable without a second close - while a repaint of the
  // same address keeps them, so a poll or a list refresh does not shut a dialog the reader is reading. A dialog that
  // holds unsaved input (#editor, the confirmation box) is never a page dialog and is not touched here.
  if (location.hash !== paintedAddress) {
    if ($('detail')?.open) $('detail').close();
    if (typeof closeTaskPicker === 'function') closeTaskPicker();
  }
  // An address the console does not know keeps the current page (on a fresh load that is the projects page).
  const missing = unknownAddress(location.hash);
  let next = missing ? 'not-found' : addressTab(location.hash) || tab;
  // Project administrators open global settings only for its 存储 section.
  if (superTabs.includes(next) && me.role !== 'super_admin' && !(next === 'settings' && /^#\/settings(?:\/storage(?:\/.*)?)?$/.test(location.hash))) next = 'projects';
  // The sample page issues no fetch of its own - every panel is constant markup - so a client-side role check is
  // the whole gate. If it ever reads server data, it needs a server-side gate first: hiding a route is not one.
  if (next === 'design' && me.role !== 'super_admin') next = 'projects';
  const resolved = next; if (next !== tab) offset = 0; tab = next;
  const target = projectRoute(), page = $('project-page'), list = document.querySelector('.list-panel');
  // #737: the title names the page this address belongs to, before anything of it is drawn.
  applyDocumentTitle(missing, target);
  // Global and project computer views reuse DOM ids; discard the inactive view and its scheduled reads.
  if (!target && typeof leaveProjectPage === 'function') leaveProjectPage();
  if (tab !== 'task' && typeof leaveTaskDetailPage === 'function') leaveTaskDetailPage();
  if (tab !== 'settings') $('settings-panel').replaceChildren();
  const address=tab+':'+location.hash;if(messagePage!==address){notice('message');messagePage=address;}
  const consolePage = consoleTabs.includes(tab);
  if (!consolePage) $('console-page').replaceChildren();
  const sample = !target && tab === 'design', samplePage = $('design-page');
  page.hidden = !target; samplePage.hidden = !sample; list.hidden = !!target || tab === 'management' || consolePage || sample;
  $('console-page').hidden = !!target || !consolePage;
  // #553: a list read that this navigation abandoned must not leave its loading state behind the hidden list.
  if (list.hidden) $('rows').querySelector(':scope > .console-state-loading')?.remove();
  if (typeof syncConsoleShell === 'function') syncConsoleShell(target);
  // The board fills the viewport and scrolls inside its columns; every other page keeps normal document scrolling.
  document.body.classList.toggle('board-mode', tab === 'board');
  const activeNavTab = ['preferences', 'identity', 'external', 'conversations'].includes(tab) ? 'preferences' : tab;
  document.querySelectorAll('[data-tab]').forEach(el => el.setAttribute('aria-current', (!target || projectConsoleRoute(target)) && el.dataset.tab === activeNavTab ? 'page' : 'false'));
  // A second address can arrive while the first one is still loading (a hash change during a list read): the newer
  // route owns the page, so this one stops before it can redraw it from the address it no longer represents.
  if (generation !== routeGeneration || resolved !== tab) return;
  if (target) {
    if (tab !== 'management' && typeof leaveManagementPage === 'function') leaveManagementPage();
    await renderProject(target);
  } else if (consolePage) {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    await renderConsolePage(renderVersion);
  } else if (sample) {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    renderDesignPage();
  } else if (tab === 'management' && !target) await renderManagementPage();
  else {
    if (typeof leaveManagementPage === 'function') leaveManagementPage();
    await render();
  }
  if (typeof syncConsoleShell === 'function') syncConsoleShell(target);
  if (typeof restoreConsolePosition === 'function') restoreConsolePosition();
  // #737: the page a navigation landed on says its name in the title, and a real address change hands it the focus -
  // unless a later address arrived during the render above and owns the page by now.
  if (generation !== routeGeneration || resolved !== tab) return;
  announcePage(missing, target, focusBefore);
  paintedAddress = location.hash;
  if (typeof tryRestoreTaskReturn === 'function') {
    const proj = projectRoute();
    tryRestoreTaskReturn({ settle: !(proj && proj.section === 'overview') });
  }
}
window.addEventListener('hashchange', () => { if (me) route().catch(error); });
