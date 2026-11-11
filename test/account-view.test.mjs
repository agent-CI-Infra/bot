import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { harness, setup, account, repository } from './helpers.mjs';

// The account detail page has to answer three questions without a second request: which installations this credential
// reaches, how many projects use it, and what GitHub granted is short of. An empty installation list is stated as an
// empty list, never left out, so the page cannot read "no data" as "nothing installed".
const privateKey = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
const installation = (h, accountId, installationId, fields) => h.store.run(`INSERT INTO installed_repositories
  (account_id,repository_id,installation_id,full_name,owner_id,owner_login,private,installed,synced_at,permissions,events,permissions_at)
  VALUES(?,?,?,?,?,?,0,?,?,?,?,?)`, accountId, `repo-${installationId}-${fields.full_name}`,
  installationId, fields.full_name, fields.owner_id, fields.owner_login, fields.installed === false ? 0 : 1, new Date().toISOString(),
  fields.permissions === undefined ? null : JSON.stringify(fields.permissions), fields.events === undefined ? null : JSON.stringify(fields.events), fields.permissions_at ?? null);

test('the account view names its installations, its projects and the permissions it is short of', async t => {
  const h = await harness(t), { admin } = await setup(h);
  // A bot account works through its own token and has no App installation: the field is an empty list, not absent.
  const bot = await account(admin);
  let view = (await admin('/api/accounts/' + bot.id)).value.account;
  assert.deepEqual(view.installations, []);
  assert.equal(view.project_count, 0);
  // Every existing field keeps its name and meaning; the two new fields are additions only.
  for (const field of ['id', 'name', 'type', 'app_id', 'credentials_configured', 'created_at', 'endpoints']) assert.ok(field in view, field);
  // The write paths return the same view, so a page that just saved does not reload into a different shape.
  view = (await admin('/api/accounts/' + bot.id, 'PATCH', { name: 'Renamed bot' })).value.account;
  assert.deepEqual(view.installations, []);
  assert.equal(view.project_count, 0);

  // An App with two installations and one project started from it.
  const app = await account(admin, { type: 'github_app', app_id: '123', private_key: privateKey(), token: undefined });
  await repository(admin, app.id, '101');
  installation(h, app.id, '77', { full_name: 'fixture/full', owner_id: '10', owner_login: 'fixture',
    permissions: { contents: 'write', issues: 'write', pull_requests: 'write', statuses: 'write', actions: 'write', checks: 'write', metadata: 'read' },
    events: ['issues', 'pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment'],
    permissions_at: new Date().toISOString() });
  // A second installation read a while ago: it is short of four permissions and three events, and that reading is stale.
  installation(h, app.id, '88', { full_name: 'other/short', owner_id: '20', owner_login: 'other',
    permissions: { contents: 'read' }, events: ['issues'], permissions_at: '2026-01-01T00:00:00.000Z' });
  // An installation GitHub removed stays on the account as history, marked not installed rather than silently dropped.
  installation(h, app.id, '99', { full_name: 'gone/gone', owner_id: '30', owner_login: 'gone', permissions: {}, events: [], installed: false });
  view = (await admin('/api/accounts/' + app.id)).value.account;
  assert.equal(view.project_count, 1);
  assert.deepEqual(view.installations.map(row => [row.installation_id, row.installed]), [['77', true], ['88', true], ['99', false]]);
  const [full, short] = view.installations;
  assert.equal(full.owner_login, 'fixture');
  assert.deepEqual(full.missing_permissions, []);
  assert.deepEqual(full.missing_events, []);
  assert.equal(full.permissions_stale, false);
  // The gap comes from permissionGap: names, required level and what is actually granted, never a second rule set.
  assert.deepEqual(short.missing_permissions.map(row => row.permission), ['contents', 'issues', 'pull_requests', 'statuses', 'actions', 'checks', 'metadata']);
  // Every gap names the features it stops, using the server's existing feature table so the page renders the impact
  // instead of mapping permission names to features of its own.
  // A baseline grant still leaves the two App-only features short: each gap names exactly the feature it stops.
  assert.deepEqual(full.access_gaps.map(gap => [gap.kind, gap.name, gap.features]),
    [['permission', 'workflows', ['gate']], ['event', 'workflow_run', ['actions_failures']]]);
  assert.ok(short.access_gaps.length > 0);
  assert.ok(short.access_gaps.every(gap => gap.features.length > 0), JSON.stringify(short.access_gaps));
  assert.ok(short.access_gaps.find(gap => gap.kind === 'permission' && gap.name === 'contents').features.includes('development'));
  assert.ok(short.access_gaps.find(gap => gap.kind === 'event' && gap.name === 'pull_request').features.includes('review'));
  // The level GitHub reported is carried through, so the page can say what it is short of and what it has.
  assert.equal(short.missing_permissions.find(row => row.permission === 'contents').current, 'read');
  assert.equal(short.missing_permissions.find(row => row.permission === 'issues').current, null);
  assert.deepEqual(short.missing_events, ['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment']);
  assert.equal(short.permissions_stale, true);
  // A grant that was never read leaves the gap unknown (null), not "no gap" and not an omission.
  installation(h, app.id, '66', { full_name: 'unread/unread', owner_id: '40', owner_login: 'unread' });
  view = (await admin('/api/accounts/' + app.id)).value.account;
  const unread = view.installations.find(row => row.installation_id === '66');
  assert.equal(unread.missing_permissions, null);
  assert.equal(unread.missing_events, null);
  // An unread grant leaves the impact unknown (null), never an empty list that reads as "nothing is affected".
  assert.equal(unread.access_gaps, null);
  assert.equal(unread.permissions_checked_at, null);
  assert.equal(unread.permissions_stale, true);
  // The same projection on every write path the detail page calls.
  view = (await admin('/api/accounts/' + app.id, 'PATCH', { name: 'Renamed App' })).value.account;
  assert.equal(view.project_count, 1);
  assert.equal(view.installations.length, 4);
  // Neither the sealed credential nor the token rides along with the installation list.
  const text = JSON.stringify(view);
  for (const secret of [app.secret, app.token, h.store.get('SELECT credentials FROM accounts WHERE id=?', app.id).credentials]) assert.ok(!text.includes(secret));
});

test('revoking credentials returns only the outcome and leaves no credential fields behind', async t => {
  const h = await harness(t), { admin } = await setup(h), app = await account(admin, { type: 'github_app', app_id: '456', private_key: privateKey(), token: undefined });
  const revoked = await admin(`/api/accounts/${app.id}/credentials/revoke`, 'POST', {});
  assert.equal(revoked.status, 201);
  // Only the status: not the account view, its webhook paths or anything the sealed credentials opened.
  assert.deepEqual(Object.keys(revoked.value).sort(), ['revoked']);
  assert.equal(revoked.value.revoked, true);
  const text = JSON.stringify(revoked.value);
  assert.ok(!text.includes('/hooks/github/'));
  assert.ok(!text.includes(h.store.get('SELECT credentials FROM accounts WHERE id=?', app.id).credentials));
  const after = (await admin('/api/accounts/' + app.id)).value.account;
  assert.equal(after.credentials_configured, false);
  assert.equal(after.name, 'Test account');
  assert.deepEqual(after.installations, []);
  assert.equal(after.project_count, 0);
});
