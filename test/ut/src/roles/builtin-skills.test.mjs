import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readdirSync, readFileSync, statSync} from 'node:fs';
import {builtinSkillFiles, builtinSkillSummary} from '../../../../dist/roles/builtin-skills.js';

// Every built-in skill under skills/ is a self-contained bundle an agent can load: its front matter names it, its sources
// and license are recorded, and every link inside it reaches a file the bundle actually serves.
const root = new URL('../../../../skills/', import.meta.url);
const ids = readdirSync(root).filter(name => statSync(new URL(name, root)).isDirectory()).sort();
// GitHub's heading anchors: lower case, punctuation dropped, spaces to hyphens.
const anchor = heading => heading.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-');

test('built-in skills carry front matter, sources and a license', () => {
  assert.ok(ids.includes('layered-ci-gates'));
  for (const id of ids) {
    const {name, description} = builtinSkillSummary(id);
    // The constraints the Pi resource loader enforces, so a native session discovers the skill instead of skipping it.
    assert.equal(name, id, id);assert.match(name, /^[a-z0-9-]{1,64}$/, id);
    assert.ok(description.length > 40 && description.length <= 1024, id + ' description');
    const sources = JSON.parse(readFileSync(new URL(id + '/SOURCES.json', root), 'utf8'));
    assert.match(sources.repository, /^https:\/\/github\.com\/[^/]+\/[^/]+$/, id);
    assert.match(sources.revision, /^[0-9a-f]{40}$/, id);
    assert.ok(sources.license && sources.adaptation && sources.references.length, id);
    assert.ok(readFileSync(new URL(id + '/LICENSE', root), 'utf8').includes(sources.license === 'Apache-2.0' ? 'Apache License' : 'MIT License'), id + ' license text');
  }
});

test('a bundle serves SKILL.md, SOURCES.json and its references, and every relative link resolves inside it', () => {
  for (const id of ids) {
    const files = builtinSkillFiles(id), paths = files.map(f => f.path), byPath = new Map(files.map(f => [f.path, f.content]));
    assert.deepEqual(paths.slice(0, 2), ['SKILL.md', 'SOURCES.json'], id);
    const references = existsSync(new URL(id + '/references/', root)) ? readdirSync(new URL(id + '/references/', root)).filter(n => n.endsWith('.md')).sort().map(n => 'references/' + n) : [];
    assert.deepEqual(paths.slice(2), references, id);
    for (const file of files) assert.equal(file.bytes, Buffer.byteLength(file.content), file.path);
    for (const [path, content] of byPath) {
      if (!path.endsWith('.md')) continue;
      for (const [, target] of content.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^[a-z]+:/.test(target)) continue;
        const [file, hash] = target.split('#'), base = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
        const resolved = file ? new URL(file, 'file:///' + base).pathname.slice(1) : path;
        assert.ok(byPath.has(resolved), `${id}/${path} links to ${target}, which the bundle does not serve`);
        if (hash) assert.ok(byPath.get(resolved).split('\n').some(line => /^#+ /.test(line) && anchor(line.replace(/^#+ /, '')) === hash), `${id}/${path} links to a missing heading #${hash}`);
      }
    }
  }
});

test('the CI gate skill states the rules its users rely on', () => {
  const skill = builtinSkillFiles('layered-ci-gates').find(f => f.path === 'SKILL.md').content;
  for (const rule of [/Start with L1 \+ L2/, /Never weaken an existing gate without a person's explicit decision/, /An empty layer is "not set up", not "passing"/,
    /Without a merge queue, L3 cases move to post-merge \(push to the default branch\) or to daily\. Say what that delays/, /When a layer has no script, propose creating one/,
    /Every workflow change goes through a bot pull request/]) assert.match(skill, rule);
  assert.deepEqual(builtinSkillFiles('layered-ci-gates').map(f => f.path).filter(p => p.startsWith('references/')),
    ['references/catalog.md', 'references/example-sciencediscovery.md', 'references/github-setup.md', 'references/layers.md', 'references/report.md', 'references/stacks.md']);
});
