import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { composePrompt } from '../docs/assistants/repository-assistant-prompts/compose-prompt.mjs';

const directory = new URL('../docs/assistants/repository-assistant-prompts/', import.meta.url);
async function fixture(t) {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, 'repository-assistant-'));
  const child = relative(parent, resolve(root));
  assert.ok(child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'prompts'));
  await writeFile(join(root, 'role.prompt.txt'), '\uFEFF  测试角色🙂\r\n', 'utf8');
  await writeFile(join(root, 'prompts', 'repository-query.md'), '\uFEFF查询段落\r\n来源\r\n', 'utf8');
  await writeFile(join(root, 'prompts', 'issue-report.md'), '提报段落\r\n回执\r\n', 'utf8');
  return { root, url: pathToFileURL(root + sep) };
}

test('CLI uses its own files rather than different prompt files in the working directory', async t => {
  const { root, url } = await fixture(t);
  const expected = await composePrompt(directory);
  assert.notEqual(await composePrompt(url), expected);
  const output = join(root, '输出', '群助手.txt');
  const result = spawnSync(process.execPath, [
    fileURLToPath(new URL('compose-prompt.mjs', directory)), '--output', output,
  ], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(await readFile(output, 'utf8'), expected);
});

test('composes every part once in order, preserving Unicode and normalizing BOM and line endings', async t => {
  const { url } = await fixture(t);
  assert.equal(await composePrompt(url),
    '测试角色🙂\n\n【repository-query】\n查询段落\n来源\n\n【issue-report】\n提报段落\n回执\n');
});

test('accepts the service-role length boundary and rejects one extra character', async t => {
  const { root, url } = await fixture(t);
  const length = (await composePrompt(url)).length;
  const role = '测试角色🙂' + '示'.repeat(32000 - length);
  await writeFile(join(root, 'role.prompt.txt'), role, 'utf8');
  assert.equal((await composePrompt(url)).length, 32000);
  await writeFile(join(root, 'role.prompt.txt'), role + '示', 'utf8');
  await assert.rejects(composePrompt(url), /32000/);
});

test('rejects any missing or empty component instead of emitting a partial prompt', async t => {
  const { root, url } = await fixture(t);
  for (const path of ['role.prompt.txt', 'prompts/repository-query.md', 'prompts/issue-report.md']) {
    const file = join(root, path), original = await readFile(file, 'utf8');
    await writeFile(file, '\uFEFF \r\n\t', 'utf8');
    await assert.rejects(composePrompt(url), /不能为空/);
    await rm(file);
    await assert.rejects(composePrompt(url), { code: 'ENOENT' });
    await writeFile(file, original, 'utf8');
  }
});
