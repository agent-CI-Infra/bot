#!/usr/bin/env node
// Starts and removes the throwaway bot an acceptance run tests, as its own Compose project.
//
//   node bot-acceptance/stack.mjs up      pull and start the images of ACCEPTANCE_IMAGE_TAG (e.g. sha-<12 hex>)
//   node bot-acceptance/stack.mjs logs    copy every service's log into <state>/evidence/compose/
//   node bot-acceptance/stack.mjs down    remove the project, its volumes and every container, volume, network and image
//                                     its manager created (they carry the deployment label, not the Compose project)
//
//   ACCEPTANCE_PROJECT    Compose project, default bot-acceptance; it must start with bot-acceptance, so the local
//                         deployment (project bot) can never be the target
//   ACCEPTANCE_PORT       host port on 127.0.0.1, default 8791
//   ACCEPTANCE_TUNNEL     quick (development, prints the trycloudflare origin) or named (default; the token is given
//                         to the bot by bootstrap)
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stateDir, writeJson } from './lib/state.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function settings(env = process.env) {
  const project = env.ACCEPTANCE_PROJECT || 'bot-acceptance', tunnel = env.ACCEPTANCE_TUNNEL || 'named', port = env.ACCEPTANCE_PORT || '8791';
  if (!/^bot-acceptance[a-z0-9-]*$/.test(project)) throw new Error('ACCEPTANCE_PROJECT must start with bot-acceptance');
  if (!['quick', 'named'].includes(tunnel)) throw new Error('ACCEPTANCE_TUNNEL is quick or named');
  if (!/^\d+$/.test(port)) throw new Error('ACCEPTANCE_PORT must be a port number');
  const files = ['-f', join(root, 'compose.yaml'), ...(tunnel === 'quick' ? ['-f', join(root, 'bot-acceptance/compose.quick-tunnel.yaml')] : [])];
  return { project, tunnel, port, files };
}

function compose(s, args, { env = {}, capture = false, check = true } = {}) {
  const result = spawnSync('docker', ['compose', '-p', s.project, ...s.files, ...args], { cwd: root, encoding: 'utf8', maxBuffer: 256 << 20,
    env: { ...process.env, BOT_PORT: s.port, ...env }, stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'] });
  if (check && result.status !== 0) throw new Error(`docker compose ${args[0]} exited ${result.status}${capture ? `: ${result.stderr.slice(-500)}` : ''}`);
  return result;
}

export async function up(s, imageTag, { dir = stateDir(), log = message => console.error(message), timeoutMs = 5 * 60_000 } = {}) {
  if (!/^[\w.-]+$/.test(imageTag || '')) throw new Error('ACCEPTANCE_IMAGE_TAG must be an image tag such as sha-<12 hex>');
  // BOT_IMAGE_TAG pins every service to the commit under test, and the console reports it as the version.
  compose(s, ['up', '-d', '--quiet-pull'], { env: { BOT_IMAGE_TAG: imageTag } });
  const stack = { project: s.project, image_tag: imageTag, port: Number(s.port), tunnel: s.tunnel, bot_url: `http://127.0.0.1:${s.port}` };
  if (s.tunnel === 'quick') {
    // cloudflared prints the random host it was given; it is the run's public origin.
    const deadline = Date.now() + timeoutMs;
    while (!stack.public_origin) {
      const logs = compose(s, ['logs', '--no-color', 'tunnel'], { capture: true, check: false });
      // A restarted connector gets a new host; the last one printed is the live one.
      stack.public_origin = [...`${logs.stdout}${logs.stderr}`.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)].at(-1)?.[0];
      if (stack.public_origin) break;
      if (Date.now() > deadline) throw new Error('the quick tunnel printed no trycloudflare.com address');
      log('stack: waiting for the quick tunnel address'); await new Promise(r => setTimeout(r, 3000));
    }
  }
  writeJson(dir, 'stack.json', stack);
  return stack;
}

export function logs(s, dir = stateDir()) {
  const out = join(dir, 'evidence', 'compose'); mkdirSync(out, { recursive: true });
  for (const service of ['bot', 'manager', 'webhook', 'tunnel', 'key-init']) {
    const result = compose(s, ['logs', '--no-color', '--timestamps', service], { capture: true, check: false });
    writeFileSync(join(out, `${service}.log`), `${result.stdout}${result.stderr}`);
  }
  return out;
}

export function down(s, { log = message => console.error(message) } = {}) {
  // The manager names and labels its resources after a hash of its internal token (manager/main.mjs); read only that hash.
  const hash = compose(s, ['exec', '-T', 'manager', 'node', '-e',
    "process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(process.env.BOT_MANAGER_TOKEN_FILE)).digest('hex').slice(0,16))"],
  { capture: true, check: false });
  const deployment = hash.status === 0 && /^[0-9a-f]{16}$/.test(hash.stdout) ? hash.stdout : null;
  compose(s, ['down', '--volumes', '--remove-orphans', '--timeout', '30'], { check: false });
  if (!deployment) { log('stack: manager not running; resources it created (if any) were left in place'); return { deployment: null }; }
  const label = `label=department.bot.deployment=${deployment}`, docker = args => execFileSync('docker', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const containers = docker(['ps', '-aq', '--filter', label]); if (containers.length) docker(['rm', '-f', ...containers]);
  const volumes = docker(['volume', 'ls', '-q', '--filter', label]); if (volumes.length) docker(['volume', 'rm', '-f', ...volumes]);
  const networks = docker(['network', 'ls', '-q', '--filter', label]); if (networks.length) docker(['network', 'rm', ...networks]);
  const images = docker(['images', '-q', '--filter', label]); if (images.length) docker(['rmi', '-f', ...new Set(images)]);
  log(`stack: removed ${containers.length} containers, ${volumes.length} volumes, ${networks.length} networks, ${images.length} images of deployment ${deployment}`);
  return { deployment, containers: containers.length, volumes: volumes.length, networks: networks.length, images: images.length };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const s = settings(), command = process.argv[2];
    if (command === 'up') console.log(JSON.stringify(await up(s, process.env.ACCEPTANCE_IMAGE_TAG), null, 2));
    else if (command === 'logs') console.log(logs(s));
    else if (command === 'down') console.log(JSON.stringify(down(s)));
    else throw new Error('usage: stack.mjs up|logs|down');
  } catch (error) { console.error(`stack failed: ${error.message}`); process.exit(1); }
}
