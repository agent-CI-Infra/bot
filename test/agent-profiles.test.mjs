import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceProfile } from '../dist/agent/profiles.js';
import { toolCapabilityError } from '../runner/capabilities.mjs';

test('workspace profiles explicitly separate local writes, shell and remote publication', () => {
  const review=workspaceProfile('review.pr', {}), development=workspaceProfile('development.issue', {});
  assert.equal(review.capabilities.workspace.write,false);
  assert.equal(development.capabilities.workspace.write,true);
  assert.equal(review.completion,'review');
  assert.equal(development.completion,'publication');
  assert.ok(Object.values(review.capabilities.github.permissions).every(value=>value==='read'));
  assert.ok(Object.values(development.capabilities.github.permissions).every(value=>value==='read'));
  assert.equal(toolCapabilityError(review,'write_file',{path:'src/a.ts'}),'review_repository_write_forbidden');
  assert.equal(toolCapabilityError(development,'write_file',{path:'src/a.ts'}),null);
  assert.equal(toolCapabilityError(review,'create_pull_request',{}),'publication_not_allowed');
  assert.equal(toolCapabilityError(review,'write_file',{path:'../notes/project.md'}),null);
});

test('a create_pull_request tool does not grant workspace write capability', () => {
  assert.equal(toolCapabilityError({tools:[{function:{name:'create_pull_request'}}]},'write_file',{path:'a'}),'review_repository_write_forbidden');
  assert.equal(toolCapabilityError({capabilities:{workspace:{write:true}}},'run_command',{}),'shell_not_allowed');
  assert.equal(toolCapabilityError({capabilities:{github:{permissions:{contents:'write'}}}},'github_read_token',{}),'github_read_token_not_allowed');
});

test('unknown task kinds cannot accidentally receive development defaults', () => {
  for (const kind of ['release.unknown','toString','constructor','__proto__']) assert.throws(()=>workspaceProfile(kind,{}),/not_registered/);
});
