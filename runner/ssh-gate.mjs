#!/usr/bin/env node
// Helper the generated ssh_config runs (runner/ssh-config.mjs). Usage: ssh-gate.mjs <mode> <agent socket> <argument>
//   check <target id>      Match exec: exit 0 only when the caller's run may use the target now.
//   deny <alias>           ProxyCommand of a refused alias: print ssh_target_denied and fail before any connection.
//   tunnel <target id>     ProxyCommand of a tunnel target: bytes go to the registered host:port through the control
//                          plane. Any further arguments (an address the caller adds) are ignored.
//   known-host <pin> %I %H %t %K   KnownHostsCommand: print the presented key only when its SHA-256 is the registered
//                          one. OpenSSH also asks before key exchange (%I is ORDER, key NONE): nothing is known then.
import { createHash } from 'node:crypto';
import { EXTENSION, agentExtension } from './ssh-agent.mjs';

const [mode, socketPath, argument, ...rest] = process.argv.slice(2);
const refuse = (code, detail) => { process.stderr.write(`${code}: ${detail}\n`); process.exit(1); };

if (mode === 'known-host') {
  const [reason, host, type, key] = rest;
  if (!['HOSTNAME', 'ADDRESS'].includes(reason) || !host || !type || !key || key === 'NONE') process.exit(0);
  const fingerprint = 'SHA256:' + createHash('sha256').update(Buffer.from(key, 'base64')).digest('base64').replace(/=+$/, '');
  if (fingerprint === argument) process.stdout.write(`${host} ${type} ${key}\n`);
  else process.stderr.write(`ssh_host_key_mismatch: the host presented ${fingerprint}, not the registered fingerprint\n`);
  process.exit(0);
}
if (mode === 'deny') refuse('ssh_target_denied', `${argument} is a registered SSH host that this command may not use (run, role, untrusted checkout or revoked access).`);
if (!socketPath || !argument) refuse('ssh_target_denied', 'missing target');
if (mode === 'check') {
  const answer = await agentExtension(socketPath, EXTENSION.check, argument);
  answer.socket?.destroy();
  // A plain refusal is reported once, by the deny block ssh falls through to.
  if (!answer.ok && answer.error !== 'ssh_target_denied') process.stderr.write(`${answer.error}: SSH access could not be checked\n`);
  process.exit(answer.ok ? 0 : 1);
}
if (mode === 'tunnel') {
  const answer = await agentExtension(socketPath, EXTENSION.tunnel, argument);
  if (!answer.ok) { answer.socket?.destroy(); refuse(answer.error, `no tunnel to the registered host of ${argument}`); }
  const socket = answer.socket;
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
  socket.on('close', () => process.exit(0));
  socket.on('error', () => process.exit(1));
  process.stdin.on('end', () => socket.end());
} else refuse('ssh_target_denied', `unknown mode ${mode}`);
