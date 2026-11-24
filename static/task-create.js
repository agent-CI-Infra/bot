// Drafts and uncertain submissions stay in this page's memory, scoped to the signed-in user and project.
let taskCreationOwner = null;
const taskCreationDrafts = new Map();
function resetTaskCreation() { taskCreationDrafts.clear(); taskCreationOwner = null; }
// The codes are the server's; the sentences live in the dictionary (#527). An unknown code is shown as itself, and an
// empty one as the translated unknown-state label, which is what this page showed before it entered the dictionary.
function taskCreationError(value) {
  const code = String(value || ''), key = code && 'taskCreate.error.' + code;
  const known = ['capability_forbidden', 'project_disabled', 'installation_unavailable', 'installation_scope_changed',
    'management_revision_conflict', 'task_pull_request_forbidden', 'task_software_disabled', 'capability_ceiling'];
  if (known.includes(code)) return t(key);
  return code || t('taskCreate.error_unknown_status');
}
async function renderNewTask(request) {
  const page = $('console-page'), owner = me.id, address = location.hash;
  if (taskCreationOwner !== owner) { taskCreationDrafts.clear(); taskCreationOwner = owner; }
  const id = projectRoute()?.id || '';
  const root = element('section', '', 'task-create-page');
  const alive = () => root.isConnected && me?.id === owner && location.hash === address && request === renderVersion;
  const heading = element('div', '', 'console-page-head');
  heading.append(element('p', t('taskCreate.eyebrow'), 'eyebrow'), element('h1', t('taskCreate.title')), note(t('taskCreate.subtitle')));
  root.append(heading); page.replaceChildren(root);
  if (!id) {
    const picker = button(t('taskCreate.pick_project'), () => openScopePicker(picker), 'btn-primary');
    picker.setAttribute('aria-label', t('taskCreate.project_required')); picker.setAttribute('aria-haspopup', 'listbox');
    picker.setAttribute('data-scope-picker-trigger', ''); picker.setAttribute('aria-controls', 'console-scope-list'); picker.setAttribute('aria-expanded', 'false');
    root.append(field(t('taskCreate.project_required'), picker));
  }
  if (!id || !repositories.some(repo => String(repo.id) === id)) {
    root.append(consoleState(id ? t('taskCreate.state_project_unavailable') : t('taskCreate.state_choose_project'),
      id ? t('taskCreate.state_project_unavailable_text') : t('taskCreate.state_choose_project_text'))); return;
  }
  let draft = taskCreationDrafts.get(id);
  if (!draft) { draft = { request: '', goal: '', scope: '', criteria: '', endpoint: 'report', envelope: null, receipt: null, sending: false }; taskCreationDrafts.set(id, draft); }
  const layout = element('div', '', 'task-create-layout'), form = document.createElement('form'), set = document.createElement('fieldset');
  form.className = 'project-form task-create-form'; set.disabled = true;
  const original = textarea('request', draft.request, { rows: 4, required: true, maxLength: 16000 });
  const goal = textarea('goal', draft.goal, { rows: 2, required: true, maxLength: 16000 });
  const scope = textarea('scope', draft.scope, { rows: 3, required: true, maxLength: 16000 });
  const criteria = textarea('criteria', draft.criteria, { rows: 4, required: true, maxLength: 16000 });
  const endpoint = document.createElement('select'); endpoint.name = 'endpoint';
  endpoint.setAttribute('aria-label', t('taskCreate.field_endpoint'));
  endpoint.add(new Option(t('taskCreate.endpoint_report'), 'report')); endpoint.add(new Option(t('taskCreate.endpoint_pr'), 'reviewable_pull_request')); endpoint.value = draft.endpoint;
  for (const [key, control] of Object.entries({ request: original, goal, scope, criteria, endpoint })) {
    control.addEventListener('input', () => { draft[key] = control.value; });
    control.addEventListener('change', () => { draft[key] = control.value; });
  }
  set.append(field(t('taskCreate.field_request'), original), field(t('taskCreate.field_goal'), goal), field(t('taskCreate.field_scope'), scope),
    field(t('taskCreate.field_criteria'), criteria), field(t('taskCreate.field_endpoint'), endpoint));
  set.append(note(t('taskCreate.note_pr_permissions')));
  const submit = element('button', t('taskCreate.submit')); submit.type = 'submit'; submit.disabled = true;
  const feedback = element('div', '', 'task-create-feedback'); feedback.setAttribute('role', 'alert');
  form.append(set, feedback, submit);
  const context = card(t('taskCreate.context_title')), contextBody = element('div'), reload = button(t('taskCreate.context_reload'), () => void readContext(), 'quiet');
  context.setAttribute('role', 'region'); context.setAttribute('aria-label', t('taskCreate.context_title'));
  context.append(contextBody, reload, note(t('taskCreate.context_note')), consoleLink('#/projects/' + id + '/roles', t('taskCreate.link_roles')),
    consoleLink('#/projects/' + id + '/basic', t('taskCreate.link_settings')));
  const receiptBox = element('section', '', 'task-create-receipt'); receiptBox.setAttribute('aria-label', t('taskCreate.receipt_aria')); receiptBox.setAttribute('aria-live', 'polite');
  layout.append(form, context); root.append(layout, receiptBox);
  let effective = null, contextVersion = 0;
  const sync = () => { set.disabled = !effective?.task_creation?.allowed || !!draft.envelope || draft.sending; submit.disabled = set.disabled; reload.disabled = draft.sending; };
  function revoked(err) {
    if (![401, 403, 404].includes(err.status)) return false;
    taskCreationDrafts.delete(id); effective = null;
    root.replaceChildren(consoleState(t('taskCreate.revoked_title'), t('taskCreate.revoked_text'), { tone: 'error' }),
      consoleLink('#/projects', t('taskCreate.back_to_projects'))); return true;
  }
  async function readContext() {
    const version = ++contextVersion; effective = null; sync(); contextBody.replaceChildren(note(t('taskCreate.checking')));
    try {
      const result = await api('/api/management/query', 'POST', { operation: 'get_effective_config', target: { project_id: id }, arguments: {} });
      if (!alive() || version !== contextVersion) return;
      effective = result;
      contextBody.replaceChildren(element('p', t('taskCreate.identity', { name: userDisplayName(me) })),
        element('p', t('taskCreate.project', { name: repositories.find(repo => String(repo.id) === id).full_name })),
        note(result.task_creation?.allowed ? t('taskCreate.allowed') : taskCreationError(result.task_creation?.reason || t('taskCreate.reason_unknown'))));
    } catch (err) {
      if (!alive() || version !== contextVersion) return;
      if (!revoked(err)) contextBody.replaceChildren(consoleState(t('taskCreate.context_failed'), readErrorText(err), { tone: 'error' }));
    } finally { if (alive() && version === contextVersion) sync(); }
  }
  function showReceipt() {
    receiptBox.replaceChildren();
    const receipt = draft.receipt;
    if (!receipt) {
      if (draft.envelope) {
        receiptBox.append(consoleState(t('taskCreate.uncertain_title'), t('taskCreate.uncertain_text'), { tone: 'error' }));
        const retry = button(t('taskCreate.uncertain_button'), () => void send()); retry.disabled = draft.sending; receiptBox.append(retry);
      }
      return;
    }
    const names = { succeeded: t('taskCreate.state_succeeded'), failed: t('taskCreate.state_failed'), pending: t('taskCreate.state_pending'),
      executing: t('taskCreate.state_executing'), unknown: t('taskCreate.state_unknown'), rejected: t('taskCreate.state_rejected') };
    const created = receipt.state === 'succeeded' && typeof receipt.result?.id === 'string';
    receiptBox.append(element('h2', receipt.state === 'succeeded' && !created ? t('taskCreate.command_complete') : names[receipt.state] || t('taskCreate.command_status', { state: receipt.state })),
      note(t('taskCreate.receipt_id', { id: receipt.id })));
    if (receipt.state === 'succeeded' && typeof receipt.result?.id === 'string') {
      receiptBox.append(note(t('taskCreate.task_id', { id: receipt.result.id })), button(t('taskCreate.view_task'), async () => {
        try { await openTask(receipt.result.id); } catch (err) { if (alive()) feedback.textContent = readErrorText(err); }
      }), button(t('taskCreate.another_task'), () => { taskCreationDrafts.delete(id); void renderNewTask(++renderVersion); }, 'quiet'));
    } else if (receipt.state === 'failed' || receipt.state === 'rejected') {
      receiptBox.append(note(taskCreationError(receipt.result?.error || receipt.state)), button(t('taskCreate.back_to_draft'), async () => {
        draft.envelope = null; draft.receipt = null; draft.uncertain = false; feedback.replaceChildren(); showReceipt(); await readContext();
      }, 'quiet'));
    } else {
      receiptBox.append(note(t('taskCreate.receipt_unconfirmed')));
      const refresh = button(t('taskCreate.refresh_receipt'), async () => {
        refresh.disabled = true;
        try { const result = await api('/api/management/commands/' + receipt.id); draft.receipt = result; if (alive()) showReceipt(); }
        catch (err) { if (alive() && !revoked(err)) feedback.textContent = readErrorText(err); }
        finally { refresh.disabled = false; }
      }, 'quiet'); receiptBox.append(refresh);
    }
  }
  draft.update = () => { if (alive()) { feedback.textContent = draft.error || ''; sync(); showReceipt(); } };
  async function send() {
    if (draft.sending || !draft.envelope) return;
    const replay = !!draft.uncertain;
    draft.sending = true; draft.error = t('taskCreate.sending'); draft.update();
    try {
      draft.receipt = await api('/api/management/commands', 'POST', draft.envelope);
      draft.error = '';
    } catch (err) {
      // A definitive pre-command rejection permits editing. An uncertain earlier attempt keeps its original key.
      if (!replay && err.status >= 400 && err.status < 500 && !/idempotency_conflict/.test(err.message)) {
        draft.envelope = null;
        draft.error = t('taskCreate.retry_after_context', { error: readErrorText(err) });
        if (alive() && !revoked(err)) await readContext();
      } else { draft.uncertain = true; draft.error = t('taskCreate.retry_same_submission', { error: readErrorText(err) }); if (alive()) revoked(err); }
    }
    finally { draft.sending = false; draft.update?.(); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault(); if (submit.disabled || draft.envelope || !form.reportValidity()) return;
    const lines = value => value.split('\n').map(line => line.trim()).filter(Boolean);
    const values = { request: original.value.trim(), goal: goal.value.trim(), scope: lines(scope.value), criteria: lines(criteria.value) };
    if (!values.request || !values.goal || !values.scope.length || !values.criteria.length || values.scope.length > 100 || values.criteria.length > 100) {
      feedback.textContent = t('taskCreate.validation'); return;
    }
    const key = 'console-task:' + crypto.randomUUID();
    draft.uncertain = false;
    draft.envelope = { operation: 'task.create', target: { project_id: id }, arguments: { request: values.request, contract: { goal: values.goal, scope: values.scope, criteria: values.criteria, endpoint: endpoint.value } },
      expected_revision: effective.revision, idempotency_key: key, source_conversation: 'console:new-task', source_message: key };
    void send();
  });
  showReceipt(); await readContext();
}
