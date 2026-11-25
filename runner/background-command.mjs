import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { maskedStream } from './command-output.mjs';
import { INLINE_ARGV_COMMAND_LIMIT } from './command-policy.mjs';

function prepareScript(command) {
  if (Buffer.byteLength(command, 'utf8') <= INLINE_ARGV_COMMAND_LIMIT) {
    return { args: ['-c', command], cleanup: () => {} };
  }
  const dir = process.env.TMPDIR || '/tmp';
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, `.bot-bg-cmd-${randomBytes(12).toString('hex')}.sh`);
  const fd = openSync(scriptPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, command, 'utf8');
  } finally {
    closeSync(fd);
  }
  let removed = false;
  return {
    args: [scriptPath],
    cleanup() {
      if (removed) return;
      removed = true;
      try { unlinkSync(scriptPath); } catch {}
    },
  };
}

// The runner disconnects after startup; keep draining and masking both streams for the lifetime of the service.
process.once('message', ({ command, secrets }) => {
  const send = message => { if (process.connected) process.send(message, () => {}); };
  let invocation;
  try {
    invocation = prepareScript(command);
  } catch (error) {
    writeSync(2, String(error?.message || error));
    send({ type: 'exit', code: 127, signal: null });
    if (process.connected) process.disconnect();
    return;
  }
  const child = spawn('/bin/sh', invocation.args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    const masked = maskedStream(secrets, text => writeSync(1, text));
    stream.on('data', masked.data); stream.on('end', masked.end);
  }
  child.on('exit', (code, signal) => { invocation.cleanup(); send({ type: 'exit', code, signal }); });
  child.on('error', error => { invocation.cleanup(); writeSync(2, String(error.message)); send({ type: 'exit', code: 127, signal: null }); });
  child.on('close', () => { invocation.cleanup(); if (process.connected) process.disconnect(); });
});
