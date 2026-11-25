// SSH context of a project computer (#1379), shared by the manager, which writes the computer's ssh_config, and the
// runner daemon, which answers the agent socket. Neither holds a private key or a password: the control plane signs and
// releases passwords per call, after checking the run, its role and the target again.

// Fixed paths inside a computer. /run/bot-runner is the computer's runner directory (manager/projects.mjs): the manager
// owns it and closes it for writing once the daemon has bound its sockets, so a task cannot replace a socket or the config.
export const SSH_RUNNER_DIR = '/run/bot-runner';
export const SSH_AGENT_SOCKET = `${SSH_RUNNER_DIR}/ssh-agent.sock`;
export const SSH_CONFIG_NAME = 'ssh_config';
export const SSH_KEYS_NAME = 'ssh-keys';
// The image includes this file from /etc/ssh/ssh_config.d (docker/project-computer.Dockerfile); OpenSSH reads the config
// of the passwd home, never $HOME, so a system include is the only place every ssh, scp, sftp and rsync reads.
export const SSH_CONFIG_PATH = `${SSH_RUNNER_DIR}/${SSH_CONFIG_NAME}`;
export const SSH_KEYS_DIR = `${SSH_RUNNER_DIR}/${SSH_KEYS_NAME}`;
export const SSH_NODE = '/usr/local/bin/node';
export const SSH_RUNNER_CODE = '/opt/runner';

// Request types that start processes which may use SSH: a command's shell, or an agent process whose direct children run
// the model's commands (runner/ssh-agent.mjs).
export const SSH_COMMAND_TYPES = Object.freeze(['command', 'workspace_command']);
export const SSH_AGENT_TYPES = Object.freeze(['workspace_agent_config', 'workspace_agent_start', 'workspace_agent_continue', 'workspace_harness_start']);
export const SSH_TARGET_LIMIT = 256;

const id = /^[a-f0-9]{48}$/;
const alias = /^[a-z0-9][a-z0-9.-]{0,119}$/;
const host = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^[0-9A-Fa-f:.]{2,45}$/;
const user = /^[A-Za-z0-9_][A-Za-z0-9_.@\\-]{0,127}$/;
const pin = /^SHA256:[A-Za-z0-9+/]{43}$/;
const blob = /^[A-Za-z0-9+/]{16,16384}={0,2}$/;
const grantSecret = /^rsg_[A-Za-z0-9_-]{43}$/;
const fail = () => { throw Object.assign(new Error('invalid_ssh_grant'), { code: 'invalid_ssh_grant' }); };

function target(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const keys = ['id', 'alias', 'host', 'port', 'username', 'auth', 'route', 'jump_id', 'host_key_sha256', 'public_key'];
  if (Object.keys(value).some(key => !keys.includes(key))) fail();
  if (!id.test(value.id) || !alias.test(value.alias) || typeof value.host !== 'string' || !host.test(value.host)) fail();
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535 || !user.test(value.username ?? '')) fail();
  if (!['key', 'password'].includes(value.auth) || !['direct', 'proxy_jump', 'tunnel'].includes(value.route) || !pin.test(value.host_key_sha256 ?? '')) fail();
  if ((value.route === 'proxy_jump') !== id.test(value.jump_id ?? '') || value.route !== 'proxy_jump' && value.jump_id !== null) fail();
  if (value.auth === 'key' ? !blob.test(value.public_key ?? '') : value.public_key !== null) fail();
  return { id: value.id, alias: value.alias, host: value.host, port: value.port, username: value.username, auth: value.auth,
    route: value.route, jump_id: value.jump_id, host_key_sha256: value.host_key_sha256, public_key: value.public_key };
}

/**
 * The SSH context the control plane attaches to a call that starts processes: a one-time grant secret, every alias the
 * project registered (so a refused alias fails with ssh_target_denied instead of an unknown host) and the ids this run
 * may use. Throws invalid_ssh_grant for anything else.
 */
export function validSshGrant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  if (Object.keys(value).some(key => !['grant', 'targets', 'allowed', 'password'].includes(key))) fail();
  if (!grantSecret.test(value.grant ?? '') || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > SSH_TARGET_LIMIT) fail();
  const targets = value.targets.map(target), byId = new Map(targets.map(row => [row.id, row]));
  if (byId.size !== targets.length || new Set(targets.map(row => row.alias)).size !== targets.length) fail();
  for (const row of targets) if (row.jump_id && (!byId.has(row.jump_id) || row.jump_id === row.id)) fail();
  if (!Array.isArray(value.allowed) || value.allowed.some(item => !byId.has(item)) || typeof value.password !== 'boolean') fail();
  return { grant: value.grant, targets, allowed: [...new Set(value.allowed)], password: value.password };
}

// ssh_config tokenizes arguments like a shell: quote a username that holds a backslash (DOMAIN\user).
const quoted = value => /[\\"\s]/.test(value) ? `"${value.replace(/[\\"]/g, match => '\\' + match)}"` : value;
const safePath = value => {
  if (typeof value !== 'string' || !/^\/[A-Za-z0-9._/-]*$/.test(value)) throw new Error('invalid_ssh_path');
  return value;
};

/** The public key file IdentityFile names, so ssh offers only the target's own agent key. */
export function publicKeyLine(row) {
  const key = Buffer.from(row.public_key, 'base64'), length = key.length >= 4 ? key.readUInt32BE(0) : 0;
  const type = length > 0 && length <= 64 && key.length >= 4 + length ? key.subarray(4, 4 + length).toString('latin1') : '';
  if (!/^[a-z0-9@.-]+$/.test(type)) throw new Error('invalid_ssh_public_key');
  return `${type} ${row.public_key} ${row.alias}\n`;
}

/**
 * Every registered alias gets a Match block gated by a check against the agent socket: the daemon finds the caller's
 * process group and the control plane checks the run, role and target again. A refused alias falls through to a block
 * whose ProxyCommand prints ssh_target_denied and exits, before any connection is made. Only registered aliases appear,
 * never `Host *`, so git@github.com and other hosts keep their defaults.
 */
export function renderSshConfig(targets, { node = SSH_NODE, code = SSH_RUNNER_CODE, socket = SSH_AGENT_SOCKET, keys = SSH_KEYS_DIR } = {}) {
  const gate = (...args) => [safePath(node), `${safePath(code)}/ssh-gate.mjs`, ...args].join(' ');
  const agent = safePath(socket), keyDir = safePath(keys);
  const byId = new Map(targets.map(row => [row.id, row]));
  const sorted = [...targets].sort((a, b) => a.alias.localeCompare(b.alias));
  const lines = ['# Generated by the project computer manager from the SSH hosts registered for this project.'];
  for (const row of sorted) {
    lines.push(`Match originalhost ${row.alias} exec "${gate('check', agent, row.id)}"`,
      `  HostName ${row.host}`, `  Port ${row.port}`, `  User ${quoted(row.username)}`,
      `  IdentityAgent ${agent}`, '  IdentitiesOnly yes',
      ...(row.auth === 'key'
        ? [`  IdentityFile ${keyDir}/${row.id}.pub`, '  PreferredAuthentications publickey', '  PasswordAuthentication no', '  KbdInteractiveAuthentication no']
        : ['  PreferredAuthentications password,keyboard-interactive', '  PubkeyAuthentication no']),
      // Only the registered fingerprint is known; the helper answers with the presented key when its SHA-256 matches.
      '  StrictHostKeyChecking yes', '  UserKnownHostsFile /dev/null', '  GlobalKnownHostsFile /dev/null', '  CheckHostIP no', '  UpdateHostKeys no',
      `  KnownHostsCommand ${gate('known-host', agent, row.host_key_sha256)} %I %H %t %K`,
      row.route === 'proxy_jump' ? `  ProxyJump ${byId.get(row.jump_id).alias}`
        : row.route === 'tunnel' ? `  ProxyCommand ${gate('tunnel', agent, row.id)}` : '  ProxyCommand none',
      // A connection serves this command only: no agent forwarding, port forwarding or shared master another run could reuse.
      '  ForwardAgent no', '  ClearAllForwardings yes', '  ControlMaster no', '  ControlPath none', '  PermitLocalCommand no');
  }
  for (const row of sorted) lines.push(`Host ${row.alias}`, `  ProxyCommand ${gate('deny', agent, row.alias)}`);
  return lines.join('\n') + '\n';
}
