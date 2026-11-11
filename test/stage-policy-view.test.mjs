import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const { stagePolicyGraph: graph, stageDependencyReferences: references, syncStageDependencies: sync } = runInNewContext(
  readFileSync(new URL('../static/roles.js', import.meta.url), 'utf8') + ';({stagePolicyGraph,stageDependencyReferences,syncStageDependencies})', { structuredClone });
const plain = value => JSON.parse(JSON.stringify(value));
const stage = (stage_id, depends_on = [], extra = {}) => ({ stage_id, depends_on, required: true, delivery_types: ['code'], ...extra });

test('draft dependency levels preserve parallel order without changing the saved definitions', () => {
  const stages = [stage('build'), stage('review', ['build']), stage('test', ['build']), stage('final', ['test', 'review'])];
  const before = JSON.stringify(stages);
  assert.deepEqual(plain(graph(stages)), { layers: [['build'], ['review', 'test'], ['final']], issues: [] });
  assert.equal(JSON.stringify(stages), before);
  assert.deepEqual(plain(graph([])), { layers: [], issues: [] });
  assert.equal(graph(undefined).issues[0].code, 'unavailable');
});
test('invalid ids and ambiguous dependency lists cannot produce a misleading partial preview', () => {
  for (const stages of [[stage('UPPER')], [stage('same'), stage('same')], [stage('ok', ['x', 'x'])], [stage('ok', [42])]]) {
    assert.equal(graph(stages).layers.length, 0); assert.ok(graph(stages).issues.length);
  }
  assert.equal(graph([stage('child', ['missing'])]).issues[0].code, 'missing_dependency');
});
test('draft previews identify optional prerequisites and incompatible delivery coverage', () => {
  const optional = graph([stage('parent', [], { required: false }), stage('child', ['parent'])]);
  assert.equal(optional.issues[0].code, 'optional_dependency');
  const delivery = graph([stage('parent'), stage('child', ['parent'], { delivery_types: ['code', 'artifact'] })]);
  assert.deepEqual(plain(delivery.issues[0]), { code: 'delivery_mismatch', id: 'child', dependency: 'parent', types: ['artifact'] });
});
test('cycles include blocked descendants rather than showing them as runnable stages', () => {
  const result = graph([stage('root'), stage('a', ['b']), stage('b', ['a']), stage('child', ['b'])]);
  assert.deepEqual(plain(result), { layers: [], issues: [{ code: 'cycle', ids: ['a', 'b', 'child'] }] });
});
test('typing through another stage id preserves both original dependency identities across redraws', () => {
  const build = stage('build'), sibling = stage('b'), child = stage('child', ['build']), other = stage('other', ['b']);
  const state = { draft: { required_stages: [build, sibling, child, other] } };
  let refs = references(state); build.stage_id = 'b'; sync(refs);
  refs = references(state); build.stage_id = 'build_new'; sync(refs);
  assert.deepEqual(plain(child.depends_on), ['build_new']); assert.deepEqual(plain(other.depends_on), ['b']);
  assert.equal(refs.get(child)[0], build); assert.equal(refs.get(other)[0], sibling);
});
test('replacing a conflicted draft drops old object references and respects new dependency choices', () => {
  const state = { draft: { required_stages: [stage('a'), stage('b'), stage('child', ['a'])] } };
  references(state); state.draft = structuredClone(state.draft); state.draft.required_stages[2].depends_on = ['b'];
  const refs = references(state), [a, b, child] = state.draft.required_stages;
  assert.equal(refs.size, 3); assert.equal(refs.get(child)[0], b);
  a.stage_id = 'renamed_a'; b.stage_id = 'renamed_b'; sync(refs);
  assert.deepEqual(plain(child.depends_on), ['renamed_b']);
});
