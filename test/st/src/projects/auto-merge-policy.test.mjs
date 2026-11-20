import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, setup, account, repository } from '../../../fixtures/helpers.mjs';
import { commands } from '../../../../dist/management/catalog.js';

// #1170: the project's auto-merge policy is one setting with three levels, disallow by default, set through the policy API
// and the project.update management command, and shown to the management assistant with the effective configuration.
test('the policy API and project.update set the auto-merge policy; disallow is the default and other values are refused', async t => {
  const h = await harness(t), { admin } = await setup(h), a = await account(admin); await repository(admin, a.id, '101');
  const read = async () => (await admin('/api/repositories/101/policy')).value.policy.auto_merge_policy;
  assert.equal(await read(), 'disallow');

  const saved = await admin('/api/repositories/101/policy', 'PATCH', { auto_merge_policy: 'non_bot_only' });
  assert.equal(saved.status, 200); assert.equal(saved.value.policy.auto_merge_policy, 'non_bot_only');
  for (const value of ['always', '', null, true]) {
    const refused = await admin('/api/repositories/101/policy', 'PATCH', { auto_merge_policy: value });
    // The route checks the project.update schema (its enum) before updatePolicy, which checks the level again.
    assert.equal(refused.status, 400, String(value)); assert.match(refused.value.error, /^invalid_(management_arguments|auto_merge_policy)$/);
  }
  // Saving other settings keeps it; saving the same level again is no new audit entry.
  assert.equal((await admin('/api/repositories/101/policy', 'PATCH', { review_language: 'en' })).value.policy.auto_merge_policy, 'non_bot_only');
  await admin('/api/repositories/101/policy', 'PATCH', { auto_merge_policy: 'non_bot_only' });
  assert.deepEqual(h.store.all("SELECT resource_id FROM audit WHERE action='policy.auto_merge'").map(row => row.resource_id), ['disallow -> non_bot_only']);

  // The management command takes the same three values and goes through the same validation.
  assert.deepEqual(commands['project.update'].arguments.properties.auto_merge_policy.enum, ['disallow', 'non_bot_only', 'allow_all']);
  const config = async () => (await admin('/api/management/query', 'POST', { operation: 'get_effective_config', target: { project_id: '101' }, arguments: {} })).value;
  const before = await config();
  assert.equal(before.auto_merge_policy, 'non_bot_only');
  const command = await admin('/api/management/commands', 'POST', { operation: 'project.update', target: { project_id: '101' }, arguments: { auto_merge_policy: 'allow_all' },
    expected_revision: before.revision, idempotency_key: 'auto-merge-all', source_conversation: 'web', source_message: 'auto-merge-all' });
  assert.equal(command.value.state, 'succeeded', JSON.stringify(command.value));
  assert.equal(await read(), 'allow_all');
  assert.equal((await config()).auto_merge_policy, 'allow_all');
  const invalid = await admin('/api/management/commands', 'POST', { operation: 'project.update', target: { project_id: '101' }, arguments: { auto_merge_policy: 'sometimes' },
    expected_revision: (await config()).revision, idempotency_key: 'auto-merge-bad', source_conversation: 'web', source_message: 'auto-merge-bad' });
  assert.notEqual(invalid.value?.state, 'succeeded');
  assert.equal(await read(), 'allow_all');
});
