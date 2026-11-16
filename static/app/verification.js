// #708: signing in does not wait for the GitHub permission check. The console opens at once; while the check runs this
// line shows how far it has come, and when it ends the pages that list what the person can manage are drawn again.
// #754: the progress is read from /api/auth/me, and that read can fail for reasons that are not an expired session — a 5xx
// from the control plane, a timeout, a dropped network. Retrying such a read at the pace of a healthy one only adds load to
// the failure it is following, so the wait doubles (1.5 s, 3 s, 6 s … capped at 30 s) and, once three reads in a row have
// failed, the line says so and offers a read now. A hidden tab reads nothing; coming back reads at once.
let githubVerificationOwner = null, githubVerificationWatch = null;
// #866: the signed-in account whose project-list read failed after the check, until one read of it comes back.
let repositoriesUnreadOwner = null;
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
  catch (err) {
    if (!me || me.id !== next.id) return;
    // The check finished; the list read it answers did not. One read, one recovery: the notice's button owns the retry,
    // so the views are drawn from what is known now and the list is not read again here. A route() on the project list
    // would repeat the endpoint that just failed — drawing fresh rows beside a notice that says the read failed, or a
    // second retry for one read, and leaving the project picker at its placeholder either way.
    await showRepositoriesUnread(next, err); return;
  }
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
// The views the check feeds, drawn into the state they are in now: the check finished, the list not read. The identity
// root is redrawn from its own reads; the project list shows the failed read where the list itself lives and carries no
// retry of its own, because the notice's button reads the list, the project picker and this page together.
async function showRepositoriesUnread(next, err) {
  const editing = tab === 'identity' && identityFormBeingEdited();
  if (!editing && tab === 'identity') await route().catch(error);
  else if (!projectRoute() && tab === 'projects' && $('rows')) {
    $('rows').removeAttribute('aria-busy');
    $('count').textContent = '读取失败';
    $('rows').replaceChildren(consoleState('项目列表未能读取',
      `${err && err.message ? err.message : '请求失败'}。权限核验已完成；页面上方的「${t('verification.repositories_retry')}」会重新读取这份列表，并更新项目切换器。`,
      { tone: 'error' }));
  }
  if (typeof syncConsoleShell === 'function') syncConsoleShell(projectRoute());
  showGithubRepositoriesUnread(next);
}
function showGithubRepositoriesUnread(next) {
  const line = $('github-verification'); if (!line) return;
  repositoriesUnreadOwner = next.id;
  line.hidden = false; line.dataset.state = 'failed';
  line.replaceChildren(element('span', t('verification.repositories_failed')),
    button(t('verification.repositories_retry'), () => readGithubRepositoriesAgain(next), 'btn-secondary'));
}
// #866: the failed read is repeated by no redraw, but a later read of the project list answers the same question. When one
// comes back, the notice goes and the project picker follows the list that was just read, so the line can never keep
// saying the read failed beside rows that were read.
function recoverGithubRepositoriesUnread(listed, params) {
  if (repositoriesUnreadOwner == null || !me || me.id !== repositoriesUnreadOwner) return;
  repositoriesUnreadOwner = null;
  showGithubVerification();
  // A filtered page is a slice of the list, not the list the picker stands for.
  if (params && (params.get('repository_id') || params.get('account_id') || params.get('owner_id'))) return;
  repositories = listed;
  options($('repository-filter'), repositories, r => r.full_name);
  if (typeof syncConsoleShell === 'function') syncConsoleShell(projectRoute());
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
  repositoriesUnreadOwner = null;
  showGithubVerification();
  // The read that just succeeded is the recovery; a render failure after it still goes through the console's error path.
  await applyGithubRepositories(next, listed).catch(error);
}
