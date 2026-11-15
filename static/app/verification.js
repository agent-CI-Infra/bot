// #708: signing in does not wait for the GitHub permission check. The console opens at once; while the check runs this
// line shows how far it has come, and when it ends the pages that list what the person can manage are drawn again.
let githubVerificationTimer = null, githubVerificationOwner = null;
const GITHUB_VERIFICATION_POLL_MS = 1500;
function githubVerificationText(progress) {
  return progress && progress.total ? t('verification.progress', { checked: progress.checked, total: progress.total }) : t('verification.starting');
}
function showGithubVerification() {
  const line = $('github-verification'); if (!line) return;
  const progress = me && me.github_verification;
  line.hidden = !progress;
  line.textContent = progress ? githubVerificationText(progress) : '';
}
// Called whenever the console (re)loads the signed-in account: it shows the line and follows the check until it ends.
function watchGithubVerification() {
  clearTimeout(githubVerificationTimer); githubVerificationTimer = null;
  showGithubVerification();
  if (!me || !me.github_verification) { githubVerificationOwner = null; return; }
  const owner = githubVerificationOwner = me.id;
  const poll = async () => {
    let next = null, expired = false;
    // A failed read keeps following, except an expired session (#715): its banner takes over and signing in again restarts this.
    try { next = await api('/api/auth/me'); } catch (err) { expired = err && err.status === 401; }
    // Signed out, the session expired, or another account signed in while the read was out: this watch is over.
    if (expired) { githubVerificationOwner = null; $('github-verification').hidden = true; return; }
    if (!me || me.id !== owner || githubVerificationOwner !== owner) return;
    if (!next || next.github_verification) {
      if (next) me.github_verification = next.github_verification;
      showGithubVerification(); githubVerificationTimer = setTimeout(poll, GITHUB_VERIFICATION_POLL_MS); return;
    }
    githubVerificationOwner = null;
    await finishGithubVerification(next).catch(error);
  };
  githubVerificationTimer = setTimeout(poll, GITHUB_VERIFICATION_POLL_MS);
}
// #757: the identity sub-pages carry forms of their own — the Feishu app wizard's credentials, the binding page's
// confirmation string — and none of it depends on the grants a check proves. Ending a check over one of them must not
// redraw it, or the reader loses what they typed, silently.
const identityFormAddress = /^#\/identity\/(?:feishu|feishu-apps)(?:[?/]|$)/;
const typedEntry = field => !['checkbox', 'radio', 'hidden', 'submit', 'button', 'reset', 'file', 'image', 'range', 'color'].includes(String(field.type || '').toLowerCase());
function identityFormBeingEdited() {
  if (!identityFormAddress.test(location.hash)) return false;
  const panel = $('identity-panel'); if (!panel) return false;
  if ([...panel.querySelectorAll('dialog')].some(dialog => dialog.open)) return true;
  const active = document.activeElement;
  if (active && typeof panel.contains === 'function' && panel.contains(active)) return true;
  return [...panel.querySelectorAll('input, textarea, select')].some(field => typedEntry(field) && String(field.value ?? '') !== '');
}
// The check ended: read the projects the person may now manage. The project list and the identity page's root view are
// drawn again; a page whose form is being filled is left alone, and only the project picker beside it follows.
async function finishGithubVerification(next) {
  me = next; showGithubVerification();
  const listed = (await api('/api/repositories')).repositories;
  // Signed out or switched accounts while the list was read: the new session's own start() draws its pages.
  if (!me || me.id !== next.id) return;
  repositories = listed;
  options($('repository-filter'), repositories, r => r.full_name);
  const editing = tab === 'identity' && identityFormBeingEdited();
  if (!editing && !projectRoute() && ['projects', 'identity'].includes(tab)) await route();
  else if (typeof syncConsoleShell === 'function') syncConsoleShell(projectRoute());
}
