import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename } from 'node:path';

export function discoverSets(files = readdirSync('test').filter(name => name.endsWith('.test.mjs') && !name.endsWith('.live.test.mjs')).sort().map(name => `test/${name}`)) {
  if (files.some(file => file.endsWith('.live.test.mjs'))) throw new Error('*.live.test.mjs files call real external services; run them with node --test, not as a test set');
  if (new Set(files).size !== files.length) throw new Error('duplicate test files');
  const sets = new Map();
  for (const file of files) {
    const text = readFileSync(file, 'utf8'), line = /^\/\/ test-set:(.*)$/m.exec(text)?.[1].trim();
    const named = line && /^([a-z0-9-]+)\s+\S/.exec(line)?.[1];
    if (line !== undefined && !named) throw new Error(`${file}: write "// test-set: <name> <why these files must not run at the same time>"`);
    const name = named || basename(file, '.test.mjs'), set = sets.get(name) || { name, files: [], size: 0 };
    set.files.push(file); set.size += statSync(file).size; sets.set(name, set);
  }
  return [...sets.values()];
}

export function loadWeights(path = new URL('./test-set-weights.json', import.meta.url)) {
  const weights = JSON.parse(readFileSync(path, 'utf8'));
  if (!weights || Array.isArray(weights) || typeof weights !== 'object' || Object.values(weights).some(value => !Number.isFinite(value) || value <= 0))
    throw new Error('test-set weights must be positive finite seconds');
  return weights;
}

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// The checked-in weights decide membership on every runner. Local timing history may change
// execution order, but must never let independently planned shards disagree about membership.
export function planShards(sets, count = 2, weights = loadWeights()) {
  if (!Number.isSafeInteger(count) || count < 1 || count > sets.length) throw new Error('shard count must be between 1 and the number of test sets');
  const known = sets.filter(set => Object.hasOwn(weights, set.name));
  const perByte = known.length ? known.reduce((n, set) => n + weights[set.name], 0) / known.reduce((n, set) => n + set.size, 0) : 1 / 1000;
  const weighted = sets.map(set => ({ ...set, weight: Object.hasOwn(weights, set.name) ? weights[set.name] : Math.max(0.01, set.size * perByte) }));
  const shards = Array.from({ length: count }, (_, i) => ({ index: i + 1, sets: [], weight: 0 }));
  for (const set of [...weighted].sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name, 'en'))) {
    const target = shards.reduce((best, shard) => shard.weight < best.weight ? shard : best);
    target.sets.push(set); target.weight += set.weight;
  }
  const corpusHash = digest([...sets].sort((a, b) => a.name.localeCompare(b.name, 'en')).map(set => ({ name: set.name,
    files: [...set.files].sort().map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]) })));
  return { corpusHash, hash: digest({ corpusHash, shards: shards.map(shard => shard.sets.map(set => [set.name, set.weight])) }), shards };
}
