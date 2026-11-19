// One installation: its archive snapshot, the repositories it grants and its recent deliveries. Evidence is shown as
// recorded: a missing history never becomes "no request", and an unverified signature is marked instead of trusted.
// #871: a table without a caption has no name of its own, and a header cell without scope="col" is not tied to the cells
// under it, so a screen reader reads a wide row as isolated values. The caption is read aloud and hidden from the page
// (.sr-only); the narrow layout keeps printing the same column names from data-label.
// #527: this page names everything through static/i18n.js (settings.installations.*), so an English console reads the
// archive in English. Only the enum values stay as stored; their words are keys resolved when a card draws.
function tableCaption(table, text) { const caption = element('caption', text, 'sr-only'); table.prepend(caption); }
function columnHeader(text) { const cell = element('th', text); cell.scope = 'col'; return cell; }
const installationStatusKeys = { active: 'status_active', pending_sync: 'status_pending_sync', suspended: 'status_suspended', deleted: 'status_deleted' };
const installationCompletenessKeys = { complete: 'completeness_complete', pending: 'completeness_pending', stale: 'completeness_stale', error: 'completeness_error' };
const installationStatusName = status => installationStatusKeys[status] ? t('settings.installations.' + installationStatusKeys[status]) : status;
const installationCompletenessName = value => installationCompletenessKeys[value] ? t('settings.installations.' + installationCompletenessKeys[value]) : value;
const installationScopeName = selection => selection === 'all' ? t('settings.installations.scope_all')
  : selection === 'selected' ? t('settings.installations.scope_selected') : t('settings.installations.scope_pending');
const installationGrantText = permissions => Object.entries(permissions || {})
  .map(([name, level]) => t('settings.installations.grant', { permission: permissionNames[name] || name, level: accessNames[level] || level }))
  .join(t('settings.installations.grant_separator'));
// A person is a login and an id; an unknown or absent person is a word, not an empty cell.
const installationPerson = (value, absentKey = 'not_provided') => value
  ? t('settings.installations.person', { login: value.login || t('settings.installations.name_unknown'), id: value.id })
  : t('settings.installations.' + absentKey);
async function installationDetail(request, ref) {
  const section = settingsCard(t('settings.installations.detail_title')), content = element('div', ''), back = settingsLink('#/settings/installations', t('settings.installations.back'));
  section.append(back, content);
  const match = /^([^/]+)\/([1-9]\d*)\/([1-9]\d*)$/.exec(ref || '');
  if (!match) { content.append(note(t('settings.installations.invalid_ref'))); return [section]; }
  const base = `/api/installations/archive/${match[1]}/${match[2]}/${match[3]}`;
  // A notice carries the tone of its own outcome: a failed re-sync must not look like a success.
  const draw = async (notice, tone = 'view-success') => {
    content.replaceChildren(element('p', t('settings.installations.loading'), 'muted'));
    try {
      const [record, repositories, deliveries] = await Promise.all([api(base), api(base + '/repositories'), api(base + '/events')]);
      content.replaceChildren(...(notice ? [element('p', notice, tone)] : []),
        ...installationDetailBody(base, record.installation, repositories.repositories || [], deliveries.events || [], draw));
    } catch (err) { content.replaceChildren(note(t('settings.installations.load_error', { message: readErrorText(err) }))); }
  };
  await draw('');
  return [section];
}
function installationDetailBody(base, snapshot, repositories, deliveries, redraw) {
  const nodes = [], installation = snapshot.installation, evidence = snapshot.evidence || {};
  nodes.push(element('h3', t('settings.installations.item_title', { login: snapshot.target.login || t('settings.installations.target_pending'), id: installation.installation_id }), 'card-sub'),
    facts([[t('settings.installations.fact_status'), installationStatusName(snapshot.status)],
      [t('settings.installations.fact_scope'), installationScopeName(snapshot.repository_selection)],
      [t('settings.installations.fact_completeness'), installationCompletenessName(snapshot.completeness)],
      [t('settings.installations.fact_last_sync'), snapshot.last_success_at ? timestamp(snapshot.last_success_at) : t('settings.installations.never_synced')],
      [t('settings.installations.fact_execution'), snapshot.execution_blocked ? t('settings.installations.execution_blocked') : t('settings.installations.execution_allowed')],
      [t('settings.installations.fact_versions'), t('settings.installations.versions_value', {
        projection: snapshot.projection_version, scope: snapshot.scope_version, permissions: snapshot.permissions_version })]]));
  nodes.push(facts([[t('settings.installations.fact_granted'), installationGrantText(snapshot.permissions) || t('settings.installations.permissions_missing')]]));
  // #237: an App's definition, an installation's scope and the actual user grants are three separate checks, each with its
  // own evidence. The list page already runs the App check against GitHub; this page offers the same check so that the
  // profile answers "what does the App declare" on its own and names the features a gap would block.
  const app = accounts.find(account => account.type === 'github_app' && String(account.app_id) === String(installation.app_id));
  const appSection = element('section', ''); appSection.append(element('h3', t('settings.installations.app_title'), 'card-sub'));
  appSection.append(facts([[t('settings.installations.fact_app'), app ? t('settings.installations.account_app', { name: app.name, app: app.app_id }) : t('settings.installations.account_unmatched')],
    [t('settings.installations.fact_installation_scope'), installationScopeName(snapshot.repository_selection)]]));
  if (app?.credentials_configured) appSection.append(note(t('settings.installations.app_check_note')), appPermissionCheck(app));
  else appSection.append(note(t(app ? 'settings.installations.app_revoked_detail' : 'settings.installations.app_unmatched_detail')));
  nodes.push(appSection);
  // A missing history is stated as missing; it is not evidence that nobody ever applied, nor an approver to show.
  if (evidence.history_missing) nodes.push(note(t('settings.installations.history_missing_note')));
  else {
    nodes.push(facts([[t('settings.installations.fact_sender'), installationPerson(evidence.sender)],
      [t('settings.installations.fact_requester'), installationPerson(evidence.requester)],
      [t('settings.installations.fact_approver'), evidence.approval?.label || t('settings.installations.approver_unknown')]]));
  }
  const repoSection = element('section', ''); repoSection.append(element('h3', t('settings.installations.repos_title', { count: repositories.length }), 'card-sub'));
  if (!repositories.length) repoSection.append(element('p', t('settings.installations.repos_empty'), 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', '');
    const captions = [t('settings.installations.col_repository'), t('settings.installations.col_private'), t('settings.installations.col_last_sync')];
    tableCaption(table, t('settings.installations.repos_caption', { count: repositories.length }));
    for (const caption of captions) head.append(columnHeader(caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head); table.append(thead, body);
    for (const repository of repositories) {
      const row = element('tr', ''),
        cell = (index, value) => { const td = element('td'); td.dataset.label = captions[index]; td.append(value); return td; };
      // The narrow layout prints the column name from data-label instead of leaving a bare value under no heading.
      row.append(cell(0, repository.full_name), cell(1, repository.private ? t('settings.installations.private_yes') : t('settings.installations.private_no')),
        cell(2, repository.last_success_at ? timestamp(repository.last_success_at) : t('settings.installations.not_synced')));
      body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); repoSection.append(wrap);
  }
  nodes.push(repoSection);
  const eventSection = element('section', ''); eventSection.append(element('h3', t('settings.installations.events_title', { count: deliveries.length }), 'card-sub'));
  if (!deliveries.length) eventSection.append(element('p', t('settings.installations.events_empty'), 'muted'));
  else {
    const table = element('table', '', 'rule-table'), head = element('tr', '');
    const captions = [t('settings.installations.col_time'), t('settings.installations.col_event'), t('settings.installations.col_action'),
      t('settings.installations.col_sender'), t('settings.installations.col_requester'), t('settings.installations.col_evidence'), t('settings.installations.col_signature')];
    tableCaption(table, t('settings.installations.events_caption', { count: deliveries.length }));
    for (const caption of captions) head.append(columnHeader(caption));
    const thead = document.createElement('thead'), body = document.createElement('tbody'); thead.append(head); table.append(thead, body);
    for (const event of deliveries) {
      const row = element('tr', ''), cell = (index, value) => { const td = element('td'); td.dataset.label = captions[index]; td.append(value); return td; };
      row.append(cell(0, event.received_at ? timestamp(event.received_at) : '—'), cell(1, event.event || '—'),
        cell(2, event.action || '—'), cell(3, installationPerson(event.sender)), cell(4, installationPerson(event.requester)),
        cell(5, event.evidence_type || '—'));
      const signature = element('td'); signature.dataset.label = captions[6];
      signature.append(event.signature_verified ? badge(t('settings.installations.signature_verified'), 'success') : badge(t('settings.installations.signature_unverified'), 'danger'));
      row.append(signature); body.append(row);
    }
    const wrap = element('div', '', 'rule-table-wrap'); wrap.append(table); eventSection.append(wrap);
  }
  nodes.push(eventSection);
  // Only this card redraws after the sync request; the other archive cards keep what they already showed.
  const sync = button(t('settings.installations.resync'), async () => {
    sync.disabled = true;
    try { await api(base + '/sync', 'POST', {}); await redraw(t('settings.installations.resync_queued')); }
    catch (err) { await redraw(t('settings.installations.resync_failed', { message: readErrorText(err) }), 'view-error'); }
    finally { sync.disabled = false; }
  });
  const actions = element('div', '', 'actions'); actions.append(sync); nodes.push(actions);
  return nodes;
}
