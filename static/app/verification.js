// #708: signing in does not wait for the GitHub permission check. The console opens at once; while the check runs this
// line shows how far it has come, and when it ends the pages that list what the person can manage are drawn again.
// #754: the progress is read from /api/auth/me, and that read can fail for reasons that are not an expired session — a 5xx
// from the control plane, a timeout, a dropped network. Retrying such a read at the pace of a healthy one only adds load to
// the failure it is following, so the wait doubles (1.5 s, 3 s, 6 s … capped at 30 s) and, once three reads in a row have
// failed, the line says so and offers a read now. A hidden tab reads nothing; coming back reads at once.
let githubVerificationOwner = null, githubVerificationWatch = null;
const GITHUB_VERIFICATION_POLL_MS = 1500;
const GITHUB_VERIFICATION_MAX_POLL_MS = 30000;
const GITHUB_VERIFICATION_FAILURES_SHOWN = 3;
function githubVerificationDelay(failures) {
  return Math.min(GITHUB_VERIFICATION_MAX_POLL_MS, GITHUB_VERIFICATION_POLL_MS * 2 ** failures);
}
function githubVerificationText(progress) {
  return progress && progress.total ? t('verification.progress', { checked: progress.checked, total: progress.total }) : t('verification.starting');
}
// `failures` is how many reads in a row failed: past a few the line stops pretending the check is merely slow and says the
// reading failed, with a button that reads at once instead of waiting out the backoff.
function showGithubVerification(failures = 0) {
  const line = $('github-verification'); if (!line) return;
  const progress = me && me.github_verification;
  line.hidden = !progress;
  if (!progress) { line.textContent = ''; line.removeAttribute('data-state'); return; }
  if (failures < GITHUB_VERIFICATION_FAILURES_SHOWN) {
    line.removeAttribute('data-state');
    line.textContent = githubVerificationText(progress); return;
  }
  line.dataset.state = 'failed';
  line.replaceChildren(element('span', t('verification.failed')),
    button(t('verification.retry'), () => githubVerificationWatch && githubVerificationWatch.readNow(), 'btn-secondary'));
}
// Called whenever the console (re)loads the signed-in account: it shows the line and follows the check until it ends.
function watchGithubVerification() {
  if (githubVerificationWatch) clearTimeout(githubVerificationWatch.timer);
  githubVerificationWatch = null;
  showGithubVerification();
  if (!me || !me.github_verification) { githubVerificationOwner = null; return; }
  const owner = githubVerificationOwner = me.id;
  const watch = githubVerificationWatch = { owner, failures: 0, timer: null, reading: false };
  const schedule = delay => { clearTimeout(watch.timer); watch.timer = setTimeout(() => { watch.timer = null; return poll(); }, delay); };
  // A person, or a tab that came back, does not wait out the backoff: read now, unless a read is already out.
  watch.readNow = () => { if (watch.reading) return; clearTimeout(watch.timer); watch.timer = null; return poll(); };
  const poll = async () => {
    // A hidden tab reads nothing at all, and schedules nothing: becoming visible reads at once (resumeGithubVerification).
    if (document.hidden || watch.reading) return;
    watch.reading = true;
    try {
      let next = null, expired = false;
      // A failed read keeps following, except an expired session (#715): its banner takes over and signing in again restarts this.
      try { next = await api('/api/auth/me'); } catch (err) { expired = err && err.status === 401; }
      // Signed out, the session expired, or another account signed in while the read was out: this watch is over.
      if (expired) { githubVerificationOwner = null; githubVerificationWatch = null; $('github-verification').hidden = true; return; }
      if (!me || me.id !== owner || githubVerificationWatch !== watch) return;
      // #754: only a read that came back is an answer. A failed one is retried after a wait that doubles, and says so in time.
      if (!next) {
        watch.failures += 1;
        showGithubVerification(watch.failures);
        schedule(githubVerificationDelay(watch.failures)); return;
      }
      watch.failures = 0;
      if (next.github_verification) {
        me.github_verification = next.github_verification;
        showGithubVerification();
        schedule(GITHUB_VERIFICATION_POLL_MS); return;
      }
      githubVerificationOwner = null; githubVerificationWatch = null;
      await finishGithubVerification(next).catch(error);
    } finally { watch.reading = false; }
  };
  schedule(GITHUB_VERIFICATION_POLL_MS);
}
// The tab came back while a check was being followed: read at once rather than wait out a delay failures may have doubled.
function resumeGithubVerification() {
  return githubVerificationWatch && !document.hidden ? githubVerificationWatch.readNow() : undefined;
}
document.addEventListener('visibilitychange', resumeGithubVerification);
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
// #866: this is the read the check was for, so the grants have just changed — and it can fail, while nothing follows the
// check any more. It used to end silently with the old list still on screen. The finished check stays finished: the line
// says the list could not be read, beside a button that reads it again, and only that read is repeated.
async function finishGithubVerification(next) {
  me = next; showGithubVerification();
  let listed;
  try { listed = (await api('/api/repositories')).repositories; }
  catch (err) { if (me && me.id === next.id) showGithubRepositoriesUnread(next); return; }
  await applyGithubRepositories(next, listed);
}
async function applyGithubRepositories(next, listed) {
  // Signed out or switched accounts while the list was read: the new session's own start() draws its pages.
  if (!me || me.id !== next.id) return;
  repositories = listed;
  options($('repository-filter'), repositories, r => r.full_name);
  const editing = tab === 'identity' && identityFormBeingEdited();
  if (!editing && !projectRoute() && ['projects', 'identity'].includes(tab)) await route();
  else if (typeof syncConsoleShell === 'function') syncConsoleShell(projectRoute());
}
function showGithubRepositoriesUnread(next) {
  const line = $('github-verification'); if (!line) return;
  line.hidden = false; line.dataset.state = 'failed';
  line.replaceChildren(element('span', t('verification.repositories_failed')),
    button(t('verification.repositories_retry'), () => readGithubRepositoriesAgain(next), 'btn-secondary'));
}
async function readGithubRepositoriesAgain(next) {
  if (!me || me.id !== next.id) return;
  const line = $('github-verification'), retry = line && line.querySelector('button');
  if (retry) retry.disabled = true;
  let listed;
  try { listed = (await api('/api/repositories')).repositories; }
  // Still failing: say so again, with the button ready for the next try. A read that was overtaken by another account
  // says nothing — the session that is signed in now draws its own pages.
  catch (err) { if (me && me.id === next.id) showGithubRepositoriesUnread(next); return; }
  // Another account signed in while the list was read: its own start() draws its pages and its own line.
  if (!me || me.id !== next.id) return;
  showGithubVerification();
  await applyGithubRepositories(next, listed);
}
