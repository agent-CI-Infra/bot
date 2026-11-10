// Docker acceptance of the production deployment: the remote script of the Deploy step in .github/workflows/release.yml,
// exactly as the workflow sends it, runs against a throwaway Compose project. Its `bot` and `manager` stand-ins keep the
// dependency of compose.yaml (bot starts once manager is healthy) and ignore the stop signal like a busy service, so an
// interrupted recreate leaves what it leaves on a server. Checked: a first deployment and a release converge; after a
// deployment interrupted once Compose had created a replacement container (with the old container still in place, and
// with only the replacement left), running the step again converges; a failing step prints every container's state.
// Only the containers and network of this project are removed afterwards; logs stay in .tmp/deploy-recovery/.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

// Any local image with a POSIX shell will do; nothing is pulled.
const image = process.env.BOT_TEST_BASE_IMAGE || 'department-bot-project-computer:local';
// The script deploys into its directory, whose name Compose takes as the project name.
const project = 'bot-deploy-recovery-' + randomBytes(4).toString('hex'), root = resolve('.tmp/deploy-recovery'), directory = resolve(root, project);
mkdirSync(directory, { recursive: true });
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
try { docker('image', 'inspect', image); } catch { throw new Error(`Image ${image} is not available locally; set BOT_TEST_BASE_IMAGE to a local image with sh.`); }

const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
const step = workflow.jobs.deploy.steps.find(entry => entry.name === 'Deploy').run, start = step.indexOf("<<'SCRIPT'\n") + "<<'SCRIPT'\n".length;
const remote = resolve(root, project + '.sh'); writeFileSync(remote, step.slice(start, step.lastIndexOf('SCRIPT')));

const stand = (missing = false) => ({ image: missing ? 'bot-deploy-recovery-missing:' + project : image, pull_policy: 'never',
  entrypoint: ['sh', '-c', "trap '' TERM INT; touch /tmp/ready; while :; do sleep 1; done"],
  environment: { VERSION: '${BOT_IMAGE_TAG:-none}' }, stop_grace_period: '5s',
  healthcheck: { test: ['CMD', 'test', '-f', '/tmp/ready'], interval: '1s', timeout: '1s', retries: 3 } });
const writeCompose = (missing = false) => writeFileSync(resolve(directory, 'compose.yaml'), JSON.stringify({ services: {
  manager: stand(missing), bot: { ...stand(), depends_on: { manager: { condition: 'service_healthy' } } } } }, null, 1));

const containers = () => docker('ps', '-a', '--filter', 'label=com.docker.compose.project=' + project, '--format', '{{.Names}}\t{{.ID}}').split('\n').filter(Boolean)
  .map(line => { const [name, id] = line.split('\t'); return { name, id }; });
const temporary = name => new RegExp(`^[0-9a-f]{12}_${project}-`).test(name);
const deploy = (tag, label) => {
  const result = spawnSync('bash', [remote, directory, tag], { encoding: 'utf8', timeout: 300_000 }), output = result.stdout + result.stderr;
  writeFileSync(resolve(root, `${project}-${label}.log`), output);
  return { status: result.status, output };
};
// Both services run the version under their canonical names, healthy, and nothing else of the project is left.
const converged = tag => {
  const names = containers().map(c => c.name).sort();
  assert.deepEqual(names, [`${project}-bot-1`, `${project}-manager-1`]);
  for (const name of names) {
    const state = JSON.parse(docker('inspect', '--format', '{{json .State}}', name));
    assert.equal(state.Health?.Status, 'healthy', name);
    assert.ok(JSON.parse(docker('inspect', '--format', '{{json .Config.Env}}', name)).includes('VERSION=' + tag), name);
  }
};
// Starts the deployment of a tag the way Compose does and kills it once the replacement of the manager exists, before
// the old manager is removed: what a Docker daemon that cannot stop a container leaves behind.
const interrupt = async tag => {
  writeFileSync(resolve(directory, '.env'), `BOT_IMAGE_TAG=${tag}\n`);
  const child = spawn('docker', ['compose', 'up', '-d'], { cwd: directory, stdio: 'ignore' });
  const until = Date.now() + 60_000;
  while (!containers().some(c => temporary(c.name))) {
    assert.ok(Date.now() < until, 'Compose never created a replacement container');
    await new Promise(next => setTimeout(next, 50));
  }
  child.kill('SIGKILL'); await new Promise(next => child.once('exit', next));
};
const evidence = { project, image, checks: [] }, passed = name => { evidence.checks.push(name); console.log('PASS ' + name); };

try {
  writeCompose();
  let result = deploy('v1', 'first');
  assert.equal(result.status, 0, result.output); converged('v1'); passed('a first deployment starts both services at its version');

  const before = containers().map(c => c.id).sort();
  result = deploy('v2', 'release');
  assert.equal(result.status, 0, result.output); converged('v2');
  assert.ok(containers().every(c => !before.includes(c.id)), 'every container is recreated');
  passed('a release recreates every service at the new version');

  await interrupt('v3');
  const left = containers().map(c => c.name);
  assert.ok(left.includes(`${project}-manager-1`) && left.some(temporary), left.join());
  result = deploy('v3', 'interrupted');
  assert.equal(result.status, 0, result.output); converged('v3');
  assert.match(result.output, new RegExp(`Removing [0-9a-f]{12}_${project}-manager-1, left by an interrupted deployment of ${project}-manager-1`));
  passed('running the step again converges after an interruption that left the old manager beside its replacement');

  await interrupt('v4');
  docker('rm', '-f', `${project}-manager-1`);
  assert.ok(containers().some(c => temporary(c.name)) && !containers().some(c => c.name === `${project}-manager-1`));
  result = deploy('v4', 'replacement-only');
  assert.equal(result.status, 0, result.output); converged('v4');
  passed('running the step again converges when only the never-started replacement is left');

  writeCompose(true);
  result = deploy('v5', 'failure');
  assert.notEqual(result.status, 0);
  assert.match(result.output, /NAME\s+IMAGE\s+COMMAND\s+SERVICE\s+CREATED\s+STATUS/);
  assert.match(result.output, new RegExp(`${project}-bot-1 .*(Up|Exited|Created)`));
  passed('a failing step prints the state of every container of the project');
  writeFileSync(resolve(root, project + '.json'), JSON.stringify(evidence, null, 1));
} finally {
  for (const { id } of containers()) docker('rm', '-f', id);
  try { docker('network', 'rm', project + '_default'); } catch { /* Compose may not have created it. */ }
}
