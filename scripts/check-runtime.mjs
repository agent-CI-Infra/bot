import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { posix } from 'node:path';

const skipDirs = new Set(['node_modules', 'dist', '.git', '.tmp', '.cache']);
function collect(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const rel = posix.join(dir, entry.name);
    if (rel === 'public-board/dashboard') continue;
    if (entry.isDirectory()) files.push(...collect(rel));
    else if (entry.isFile() && /\.(?:mjs|js)$/.test(entry.name)) files.push(rel);
  }
  return files;
}

const files = ['manager', 'runner', 'tunnel', 'webhook', 'static', 'scripts', 'public-board', 'test'].flatMap(collect).sort((a, b) => a.localeCompare(b, 'en'));

const queue = [...files];
const workers = Math.min(availableParallelism(), 16, Math.max(1, queue.length));
let failed = false;

async function checkOne(file) {
  const { code, stderr } = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks = [];
    child.stderr.on('data', chunk => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', exitCode => resolve({ code: exitCode, stderr: Buffer.concat(chunks).toString() }));
  });
  if (code !== 0) {
    failed = true;
    process.stderr.write(stderr || `Syntax check failed: ${file} (exit ${code})\n`);
  }
}

await Promise.all(Array.from({ length: workers }, async () => {
  while (queue.length && !failed) await checkOne(queue.shift());
}));
if (failed) process.exit(1);

// The Pi harness pins the SDK version the project computer image installs; the two must not drift apart.
const pinned = /version: '([^']+)'/.exec(/export const piRuntime = \{[^}]*\}/.exec(readFileSync('src/agent/pi.ts', 'utf8'))?.[0] || '')?.[1];
const installed = JSON.parse(readFileSync('runner/package.json', 'utf8')).dependencies['@earendil-works/pi-coding-agent'];
if (!pinned || pinned !== installed) { console.error(`src/agent/pi.ts pins Pi ${pinned}, runner/package.json installs ${installed}`); process.exit(1); }
console.log(`Runtime JavaScript syntax checks passed (${files.length} files)`);
