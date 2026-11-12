import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const merge = runInNewContext(readFileSync(new URL('../static/roles.js', import.meta.url), 'utf8') + ';mergeRoleDraft', { structuredClone });
const plain = value => JSON.parse(JSON.stringify(value));
const base = () => ({ enabled: true, controller: { entries: { development: true } }, roles: [{ role_id: 'dev', name: 'Dev', persona_prompt: 'base', permissions: { computer: 'allow' } }], skills: [], required_stages: [] });

test('role draft merges independent edits and preserves newer permissions without mutating its inputs', () => {
  const before = base(), local = structuredClone(before), remote = structuredClone(before);
  local.roles[0].persona_prompt = 'my prompt'; remote.roles[0].permissions.computer = 'deny'; remote.controller.entries.development = false;
  const snapshots = JSON.stringify([before, local, remote]), result = merge(before, local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.draft.roles[0].persona_prompt, 'my prompt'); assert.equal(result.draft.roles[0].permissions.computer, 'deny');
  assert.equal(result.draft.controller.entries.development, false); assert.equal(JSON.stringify([before, local, remote]), snapshots);
});
test('overlapping role prompts require an explicit field choice in either direction', () => {
  const before = base(), local = base(), remote = base(); local.roles[0].persona_prompt = 'mine'; remote.roles[0].persona_prompt = 'theirs';
  const result = merge(before, local, remote), conflict = result.conflicts[0];
  assert.equal(result.conflicts.length, 1); assert.equal(conflict.resolved, false);
  assert.deepEqual(plain(conflict.path), ['roles', 'dev', 'persona_prompt']);
  assert.equal(merge(before, local, remote, { [conflict.id]: 'draft' }).draft.roles[0].persona_prompt, 'mine');
  assert.equal(merge(before, local, remote, { [conflict.id]: 'latest' }).draft.roles[0].persona_prompt, 'theirs');
});
test('deleting a role cannot silently discard newer changes to that role', () => {
  const before = base(), local = base(), remote = base(); local.roles = []; remote.roles[0].name = 'Renamed';
  const result = merge(before, local, remote), conflict = result.conflicts[0];
  assert.equal(conflict.resolved, false); assert.equal(result.draft.roles[0].name, 'Renamed');
  assert.equal(merge(before, local, remote, { [conflict.id]: 'draft' }).draft.roles.length, 0);
  assert.equal(merge(before, local, remote, { [conflict.id]: 'latest' }).draft.roles.length, 1);
});
test('independent added roles survive in server order, while a remotely deleted untouched role stays deleted', () => {
  const before = base(), local = base(), remote = base(); local.roles.push({ role_id: 'observer', name: 'Local' }); remote.roles = [{ role_id: 'remote', name: 'Remote' }];
  const result = merge(before, local, remote);
  assert.equal(result.conflicts.length, 0); assert.deepEqual(plain(result.draft.roles.map(row => row.role_id)), ['remote', 'observer']);
});
test('ordered stage constraints stay atomic while other stage fields merge independently', () => {
  const before = base(); before.required_stages = [{ stage_id: 'qa', depends_on: ['dev'], title: 'QA' }];
  const local = structuredClone(before), remote = structuredClone(before); local.required_stages[0].depends_on.push('review'); remote.required_stages[0].depends_on = ['security']; remote.required_stages[0].title = 'Independent QA';
  const result = merge(before, local, remote);
  assert.deepEqual(plain(result.conflicts[0].path), ['required_stages', 'qa', 'depends_on']);
  assert.equal(result.draft.required_stages[0].title, 'Independent QA');
});
test('independent skill edits are merged by stable id and conflicting additions need a choice', () => {
  const before = base(), local = base(), remote = base(); local.skills = [{ id: 'a/b', source: { type: 'inline', files: [] } }]; remote.skills = [{ id: 'a/b', source: { type: 'repository', commit: 'a'.repeat(40), paths: ['.agents/skills/review/SKILL.md'] } }];
  const result = merge(before, local, remote), conflict = result.conflicts[0];
  assert.equal(conflict.id, JSON.stringify(['skills', 'a/b']));
  assert.equal(merge(before, local, remote, { [conflict.id]: 'draft' }).draft.skills[0].source.type, 'inline');
});
test('changing or clearing model references preserves conflict semantics rather than field-merging incompatible types', () => {
  const before = base(); before.roles[0].model_profile_ref = { model_id: 'old' };
  const local = structuredClone(before), remote = structuredClone(before); local.roles[0].model_profile_ref = null; remote.roles[0].model_profile_ref.model_id = 'new';
  const result = merge(before, local, remote); assert.equal(result.conflicts.length, 1);
  assert.equal(merge(before, local, remote, { [result.conflicts[0].id]: 'draft' }).draft.roles[0].model_profile_ref, null);
});
