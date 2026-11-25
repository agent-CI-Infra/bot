#!/usr/bin/env node
// SSH_ASKPASS helper for registered password targets (#1379). OpenSSH runs it with the prompt as its only argument and
// reads the answer from its stdout through a pipe. The daemon answers only when this process's parent is the image's ssh
// binary in an authorized process group and the prompt names exactly one password target of that run. The password is
// written to stdout and nowhere else; a refusal writes no byte to stdout.
import { EXTENSION, agentExtension } from './ssh-agent.mjs';

const prompt = process.argv[2] ?? '';
const socketPath = process.env.SSH_AUTH_SOCK;
const answer = socketPath && prompt ? await agentExtension(socketPath, EXTENSION.askpass, prompt) : { ok: false };
answer.socket?.destroy();
if (!answer.ok || !answer.value) {
  process.stderr.write(`${answer.error || 'ssh_target_denied'}: no registered password for this prompt\n`);
  process.exit(1);
}
process.stdout.end(Buffer.concat([answer.value, Buffer.from('\n')]), () => process.exit(0));
