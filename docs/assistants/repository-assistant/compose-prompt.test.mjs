import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { composePrompt } from './compose-prompt.mjs';

const directory = new URL('.', import.meta.url);
async function fixture(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'repository-assistant-'));
  const child = relative(parent, resolve(root));
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(new URL('skills', directory), join(root, 'skills'), { recursive: true });
  await cp(new URL('role.prompt.txt', directory), join(root, 'role.prompt.txt'));
  return { root, url: pathToFileURL(root + sep) };
}

test('CLI writes the complete UTF-8 prompt independently of the working directory', async t => {
  const { root } = await fixture(t);
  const output = join(root, '输出', '群助手.txt');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('compose-prompt.mjs', directory)), '--output', output,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(await readFile(output, 'utf8'), await composePrompt());
});

test('rejects oversized prompts instead of silently truncating instructions', async t => {
  const { root, url } = await fixture(t);
  await writeFile(join(root, 'role.prompt.txt'), '示'.repeat(32001), 'utf8');
  await assert.rejects(composePrompt(url), /32000/);
});

test('rejects missing or malformed skills instead of producing a partial prompt', async t => {
  const { root, url } = await fixture(t);
  const file = join(root, 'skills', 'repository-query', 'SKILL.md');
  await writeFile(file, 'Incomplete content', 'utf8');
  await assert.rejects(composePrompt(url), /repository-query/);
  await rm(file);
  await assert.rejects(composePrompt(url), { code: 'ENOENT' });
});
