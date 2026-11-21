import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = new URL('.', import.meta.url);
const modules = ['repository-query', 'issue-report'];
const normalize = text => text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();

// Static composition for the existing service-role prompt field; no runtime skill loading.
export async function composePrompt(root = directory) {
  const role = normalize(await readFile(new URL('role.prompt.txt', root), 'utf8'));
  if (!role) throw new Error('角色提示词不能为空。');
  const sections = [role];
  for (const name of modules) {
    const source = normalize(await readFile(new URL('prompts/' + name + '.md', root), 'utf8'));
    if (!source) throw new Error('提示词模块不能为空：' + name);
    sections.push('【' + name + '】\n' + source);
  }
  const prompt = sections.join('\n\n') + '\n';
  if (prompt.length > 32000) throw new Error('合成提示词超过服务角色的 32000 字符上限。');
  return prompt;
}

async function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--output' || !args[1])) {
    throw new Error('用法：node compose-prompt.mjs [--output <文件路径>]');
  }
  const prompt = await composePrompt();
  if (!args.length) {
    process.stdout.write(prompt);
    return;
  }
  const output = resolve(args[1]);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, prompt, 'utf8');
  process.stderr.write('已生成 ' + output + '（' + prompt.length + ' 字符）\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  });
}
