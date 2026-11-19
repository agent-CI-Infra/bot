import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { assistant, runnerRoot, tasksDirectory } from './paths.mjs';
import { environment, workspaceTag } from './command.mjs';
import { normalizePolicy } from './browser-policy.mjs';

export function browserSessionDir(workspaceId) {
  return join(tasksDirectory, workspaceId, 'browser');
}

function sockPath(workspaceId) { return join(browserSessionDir(workspaceId), 'session.sock'); }
function pidPath(workspaceId) { return join(browserSessionDir(workspaceId), 'daemon.pid'); }
function readyPath(workspaceId) { return join(browserSessionDir(workspaceId), 'ready'); }

function readPid(workspaceId) {
  try {
    const value = Number(readFileSync(pidPath(workspaceId), 'utf8').trim());
    return Number.isInteger(value) && value > 1 ? value : null;
  } catch { return null; }
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function stopBrowserSession(workspaceId, { keepEvidence = true } = {}) {
  const pid = readPid(workspaceId);
  if (pid && alive(pid)) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    for (let i = 0; i < 40; i++) {
      if (!alive(pid)) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  const dir = browserSessionDir(workspaceId);
  try { unlinkSync(sockPath(workspaceId)); } catch { /* gone */ }
  try { unlinkSync(pidPath(workspaceId)); } catch { /* gone */ }
  try { unlinkSync(readyPath(workspaceId)); } catch { /* gone */ }
  try { rmSync(join(dir, 'profile'), { recursive: true, force: true }); } catch { /* gone */ }
  if (!keepEvidence) try { rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
}

function talk(workspaceId, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fullSock = sockPath(workspaceId);
    const dirFd = fullSock.length > 100 && existsSync('/proc/self/fd') ? openSync(browserSessionDir(workspaceId), 'r') : null;
    const closeDirFd = () => { if (dirFd !== null) try { closeSync(dirFd); } catch { /* closed */ } };
    const socket = createConnection(dirFd !== null ? `/proc/self/fd/${dirFd}/session.sock` : fullSock);
    let buffer = '', settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      closeDirFd();
      resolve(value);
    };
    // The daemon arms the action deadline after Chromium boot and polls it every 1s,
    // then bounds page/context close at 1s each. This safety net must outlast that.
    const timer = setTimeout(() => done({ error: 'browser_timeout', detail: '这个浏览器动作超过了本任务允许的时间。' }), Math.max(1000, timeoutMs + 5_000));
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      const line = lines.filter(Boolean).at(-1);
      if (!line) return;
      try { done(JSON.parse(line)); }
      catch { done({ error: 'browser_failed', detail: '浏览器会话的回答无法解析。' }); }
    });
    socket.on('error', error => {
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT')
        done({ error: 'browser_crashed', detail: '项目电脑上的浏览器会话已经结束。' });
      else if (!settled) { settled = true; clearTimeout(timer); closeDirFd(); reject(error); }
    });
    socket.on('end', () => {
      if (!settled) done({ error: 'browser_crashed', detail: '项目电脑上的浏览器会话已经结束。' });
    });
  });
}

async function waitReady(workspaceId, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(sockPath(workspaceId)) && existsSync(readyPath(workspaceId)) && alive(readPid(workspaceId))) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function ensureDaemon(workspaceId) {
  if (existsSync(sockPath(workspaceId)) && alive(readPid(workspaceId))) return;
  const dir = browserSessionDir(workspaceId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { unlinkSync(sockPath(workspaceId)); } catch { /* ok */ }
  try { unlinkSync(readyPath(workspaceId)); } catch { /* ok */ }
  const script = join(runnerRoot, 'browser-daemon.mjs');
  const child = spawn(process.execPath, [script, workspaceId], {
    detached: true,
    stdio: 'ignore',
    env: { ...environment, ...workspaceTag(workspaceId), ...(process.env.BOT_BROWSER_EXECUTABLE ? { BOT_BROWSER_EXECUTABLE: process.env.BOT_BROWSER_EXECUTABLE } : {}),
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}) }
  });
  writeFileSync(pidPath(workspaceId), String(child.pid), { mode: 0o600 });
  child.unref();
  if (!await waitReady(workspaceId)) {
    await stopBrowserSession(workspaceId);
    return { error: 'browser_runtime_unavailable', detail: '项目电脑上未能启动浏览器会话。' };
  }
  return null;
}

export async function runWorkspaceBrowser(input) {
  if (assistant) return { error: 'browser_computer_unavailable', detail: '助手电脑没有网络，不能启动任务浏览器。' };
  const workspaceId = input.workspace_id;
  if (!/^[a-f0-9]{48}$/.test(workspaceId || '')) throw new Error('invalid_workspace');
  const action = String(input.action || '');
  if (action === 'close') {
    await stopBrowserSession(workspaceId);
    return { ok: true };
  }
  const policy = normalizePolicy(input.policy);
  if (!policy) return { error: 'browser_not_configured', detail: '这个任务没有列出允许打开的站点，不能启动浏览器。' };
  const failed = await ensureDaemon(workspaceId);
  if (failed) return failed;
  return talk(workspaceId, { action, args: input.args || { url: input.url, name: input.name, selector: input.selector, text: input.text, label: input.label }, policy }, policy.timeout_ms);
}

export async function reapBrowserSession(workspaceId) {
  if (!/^[a-f0-9]{48}$/.test(workspaceId || '')) return;
  await stopBrowserSession(workspaceId, { keepEvidence: true });
}
