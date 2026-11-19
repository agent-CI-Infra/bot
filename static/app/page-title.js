// #737: one place decides what the browser title says and when a new page announces itself. Before this file every
// route reset the title to the generic chrome name, so a tab or a history entry never said which page it belonged to.
// The title names the page the address belongs to, and a real address change moves the focus to that page's heading once.
const pageTitleKeys = {
  projects: 'nav.projects', board: 'nav.board', costs: 'nav.costs', management: 'nav.management',
  settings: 'nav.settings', inbox: 'nav.inbox', conversations: 'nav.conversations', 'new-task': 'nav.new_task',
  more: 'nav.more', external: 'nav.external', design: 'page.design', identity: 'identity.title', preferences: 'nav.preferences'
};
// The project page a reader is on: #/projects/<id>/<section> shows the project name and the section caption, and an
// address that names no section of the project is the not-found page inside it.
function pageTitleFor(missing, target) {
  if (missing) return t('page.not_found');
  if (target) {
    const caption = projectSectionCaption(target.section);
    if (!caption) return t('page.not_found');
    // The heading is only the name of the project the address asks for when that project is the one drawn: a project
    // the reader cannot start or reach leaves the previous page's header in place, and its name is not this page's.
    const rendered = typeof current !== 'undefined' && current && String(current.id) === String(target.id)
      ? current.repository?.full_name : null;
    const project = repositories.find(row => String(row.id) === String(target.id))?.full_name || rendered;
    return project ? `${project} · ${caption}` : caption;
  }
  // #799: a settings page that names its own category (存储) is titled after it, not after the whole platform.
  if (tab === 'settings' && typeof settingsPageTitle === 'function') return settingsPageTitle();
  if (tab === 'task') {
    const heading = document.querySelector('#task-view #task-title')?.textContent?.trim();
    return heading && heading !== '正在加载…' ? `${heading} · 任务详情` : '任务详情';
  }
  const key = pageTitleKeys[tab];
  return key ? t(key) : '';
}
function applyDocumentTitle(missing = false, target = null) {
  // #779: no session, no page to name. A project render still in flight when the reader signed out (or deleted their own
  // account) must not rename the sign-in screen; the late call arrives here after endSession() already restored it.
  if (typeof me === 'undefined' || !me) return;
  const name = pageTitleFor(missing, target || projectRoute());
  document.title = name ? `${name} · ${t('meta.title')}` : t('meta.title');
}
// project/page.js still calls this name for a section the project does not have; the not-found title is the one decision
// below, so the two entries cannot drift apart.
function setNotFoundTitle(missing) { applyDocumentTitle(missing); }
// A page keeps the heading a reader lands on after a navigation: the project name on a project page, the console page's
// own h1, or the list heading. A page without one falls back to the skip link's target, which is focusable already.
function pageHeading(target) {
  const shown = el => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0;
  const candidates = target && !projectConsoleRoute(target) ? [document.querySelector('#console-project-header .project-head h1'), document.querySelector('#project-page .project-head h1')]
    : [...document.querySelectorAll('#console-page h1, #settings-panel h1, #page-title')];
  const heading = candidates.find(shown);
  if (heading) return heading;
  return $('main-content');
}
// The address that owns the announcement: the project and the section, not the record inside the section and not the
// query a filter adds. Redrawing the same page (a poll, a locale refresh, a filter change) never moves a reader's focus.
let announcedPage = null;
// The navigation this announcement answers: the reader asked for the page from the console's own chrome (the tab strip
// or a project section link), or the redraw took the focus away from them entirely. A focus the reader placed inside the
// page that is still standing after the redraw is left alone: a page that focuses something of its own while it draws
// (returning to the item a reader came from) keeps it, and so does a control that survives the redraw.
function pageChangeWasAsked(from, active) {
  // The phone's navigation is its own list of destinations (#481): the links carry data-page, not data-tab.
  if (from && from.isConnected && from.closest('#tabs, #console-secondary-nav, #console-mobile-nav, [data-tab]')) return true;
  return !active || active === document.body || !active.isConnected;
}
function announcePage(missing, target, previousFocus = null) {
  const page = missing ? 'not-found' : target ? `project:${target.id}/${target.section}` : tab === 'task' ? `task:${taskRoute()?.id || ''}` : `page:${tab}`;
  if (page === announcedPage) return;
  const first = announcedPage === null;
  announcedPage = page;
  if (first) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && active !== previousFocus) return;
  if (!pageChangeWasAsked(previousFocus, active)) return;
  const heading = pageHeading(target);
  if (!heading) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus({ preventScroll: true });
}
// A language switch keeps the title of the page the reader is on, including a click on the language already in effect.
// Before the console has a page (the login form, the boot screen) there is no page identity to name, so nothing is
// written there and the document keeps the title its own markup carries.
if (typeof onLocaleChange === 'function') onLocaleChange(() => {
  if (typeof me === 'undefined' || !me) return;
  applyDocumentTitle(unknownAddress(location.hash));
});
// Signing out ends the reader's pages; the next sign-in opens a page of its own and may announce it once like any other.
function resetAnnouncedPage() { announcedPage = null; }
