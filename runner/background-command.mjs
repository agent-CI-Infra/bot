import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { maskedStream } from './command-output.mjs';
import { INLINE_ARGV_COMMAND_LIMIT } from './command-policy.mjs';

function openScriptFd(command) {
  const dir = process.env.TMPDIR || '/tmp';
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, `.bot-bg-cmd-${randomBytes(12).toString('hex')}.sh`);
  const wfd = openSync(scriptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(wfd, command, 'utf8');
  } finally {
    closeSync(wfd);
  }
  try {
    return openSync(scriptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } finally {
    try { unlinkSync(scriptPath); } catch {}
  }
}

// The runner disconnects after startup; keep draining and masking both streams for the lifetime of the service.
process.once('message', ({ command, secrets }) => {
  const send = message => { if (process.connected) process.send(message, () => {}); };
  let child;
  if (Buffer.byteLength(command, 'utf8') <= INLINE_ARGV_COMMAND_LIMIT) {
    child = spawn('/bin/sh', ['-c', command], { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  } else {
    let scriptFd;
    try {
      scriptFd = openScriptFd(command);
      child = spawn('/bin/sh', ['/dev/fd/3'], { env: process.env, stdio: ['ignore', 'pipe', 'pipe', scriptFd] });
    } catch (error) {
      writeSync(2, String(error?.message || error));
      send({ type: 'exit', code: 127, signal: null });
      if (process.connected) process.disconnect();
      return;
    } finally {
      if (scriptFd !== undefined) closeSync(scriptFd);
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    const masked = maskedStream(secrets, text => writeSync(1, text));
    stream.on('data', masked.data); stream.on('end', masked.end);
  }
  child.on('exit', (code, signal) => { send({ type: 'exit', code, signal }); });
  child.on('error', error => { writeSync(2, String(error.message)); send({ type: 'exit', code: 127, signal: null }); });
  child.on('close', () => { if (process.connected) process.disconnect(); });
});
