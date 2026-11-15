// #779: signing out and deleting your own account end the same session, so the local cleanup lives here once instead of
// in the sign-out handler. Both callers own their request: listeners.js posts /api/auth/logout, and records.js has just
// deleted the account (the server session is gone already), so this is the local cleanup only — never a logout call.
function endSession() {
  renderVersion++; me = null;
  if (typeof resetAnnouncedPage === 'function') resetAnnouncedPage();
  if (typeof applyStaticTranslations === 'function') applyStaticTranslations();
  tab = 'projects';
  // Signing out returns to the default page, so whoever signs in next does not land on the previous user's page; the
  // wizard keeps its address (onboarding.js resets it to the first step).
  if (!onboardingAddress.test(location.hash)) history.replaceState(null, '', location.pathname);
  repositories = []; accounts = [];
  $('rows').replaceChildren(); $('detail-body').replaceChildren();
}
