// #737: one place decides what the browser title says and when a new page announces itself. Before this file every
// route reset the title to the generic chrome name, so a tab or a history entry never said which page it belonged to.
// The title names the page the address belongs to, and a real address change moves the focus to that page's heading once.
const pageTitleKeys = {
  projects: 'nav.projects', board: 'nav.board', costs: 'nav.costs', events: 'nav.events', management: 'nav.management',
  settings: 'nav.settings', inbox: 'nav.inbox', conversations: 'nav.conversations', 'new-task': 'nav.new_task',
  more: 'nav.more', external: 'nav.external', design: 'page.design', identity: 'identity.title', preferences: 'nav.preferences'
};
// The project page a reader is on: #/projects/<id>/<section> shows the project name and the section caption, and an
// address that names no section of the project is the not-found page inside it.
function pageTitleFor(missing, target) {
  if (missing) return t('page.not_found');
  if (target) {
    // 项目入口 is a project page too, but it is not one of the settings categories the catalog lists.
    const caption = projectSectionCaption(target.section) || (target.section === 'menu' ? '项目入口' : null);
    if (!caption) return t('page.not_found');
    const project = repositories.find(row => String(row.id) === String(target.id))?.full_name
      || document.querySelector('#project-page .project-head h1')?.textContent.trim();
    return project ? `${project} · ${caption}` : caption;
  }
  const key = pageTitleKeys[tab];
  return key ? t(key) : '';
}
function applyDocumentTitle(missing = false, target = null) {
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
  const candidates = target ? [document.querySelector('#project-page .project-head h1')]
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
  if (from && from.isConnected && from.closest('#tabs, #console-secondary-nav, [data-tab]')) return true;
  return !active || active === document.body || !active.isConnected;
}
function announcePage(missing, target, previousFocus = null) {
  const page = missing ? 'not-found' : target ? `project:${target.id}/${target.section}` : `page:${tab}`;
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
// A language switch applies the static translations (which put the generic title back) before this listener runs, so the
// title is recomputed from the page the reader is still on rather than left at the chrome name.
if (typeof onLocaleChange === 'function') onLocaleChange(() => applyDocumentTitle(unknownAddress(location.hash)));
