import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parse } from 'yaml';

const compose = parse(readFileSync('docker/compose.yaml', 'utf8'));
const webhookSource = readFileSync('webhook/main.mjs', 'utf8');
const managerSource = readFileSync('manager/main.mjs', 'utf8');
const botSource = readFileSync('src/main.ts', 'utf8');
const releaseWorkflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));

function parseDurationSeconds(value) {
  const match = /^(\d+)s$/.exec(String(value || ''));
  assert.ok(match, `expected duration in seconds, got ${JSON.stringify(value)}`);
  return Number(match[1]);
}

function loadWebhookInSandbox({ autoClose = true } = {}) {
  const listeners = new Map(), timers = [], servers = [], exits = [];
  const nextTimer = (fn, ms) => {
    const handle = { fn, ms, cleared: false, unrefed: false, unref() { this.unrefed = true; return this; } };
    timers.push(handle);
    return handle;
  };
  vm.runInNewContext(webhookSource.replace("import http from 'node:http';", ''), {
    http: {
      createServer() {
        const state = { closed: 0, idleClosed: 0, allClosed: 0, closeCb: null };
        const server = {
          listen() { return this; },
          close(cb) { state.closed += 1; state.closeCb = cb; if (autoClose) cb?.(); },
          closeIdleConnections() { state.idleClosed += 1; },
          closeAllConnections() { state.allClosed += 1; if (!autoClose && state.closeCb) { const cb = state.closeCb; state.closeCb = null; cb(); } },
        };
        servers.push(state);
        return server;
      },
    },
    process: {
      on(sig, fn) { listeners.set(sig, fn); },
      exit(code) { exits.push(code); },
    },
    setTimeout: nextTimer,
    clearTimeout(handle) { if (handle) handle.cleared = true; },
    fetch: async () => new Response('{}'), URL, AbortSignal,
  });
  return { listeners, timers, servers, exits };
}

test('webhook/main.mjs closes both servers cleanly on SIGTERM and ignores duplicate signals', () => {
  const env = loadWebhookInSandbox({ autoClose: true });
  assert.equal(env.servers.length, 2, 'webhook creates proxy and metrics servers');
  assert.ok(env.listeners.has('SIGTERM') && env.listeners.has('SIGINT'), 'registers SIGTERM and SIGINT handlers');

  env.listeners.get('SIGTERM')();
  env.listeners.get('SIGINT')();

  assert.deepEqual(env.exits, [0], 'exits once with status 0 when both servers close');
  for (const server of env.servers) {
    assert.equal(server.closed, 1);
    assert.equal(server.idleClosed, 1);
  }
  assert.ok(env.timers.every(t => t.cleared && t.unrefed), 'clears and unrefs fallback shutdown timers');
});

test('webhook/main.mjs escalates to closeAllConnections before Docker default 10s stop_grace_period', () => {
  const env = loadWebhookInSandbox({ autoClose: false });
  env.listeners.get('SIGTERM')();

  assert.deepEqual(env.exits, [], 'waits briefly for active requests before force-closing');
  const drain = env.timers.find(t => t.ms < 5_000), hard = env.timers.find(t => t.ms >= 5_000);
  assert.ok(drain && drain.ms > 0 && drain.ms < 10_000, 'schedules connection drain timeout below 10s');
  assert.ok(hard && hard.ms < 10_000, 'schedules hard exit timeout below Docker default 10s grace period');

  drain.fn();
  assert.deepEqual(env.exits, [0], 'closeAllConnections unblocks server.close and exits 0');
  for (const server of env.servers) assert.equal(server.allClosed, 1);
});

test('compose.yaml enables init for all long-running services and keeps stop_grace_period above internal shutdown limits', () => {
  for (const name of ['bot', 'manager', 'webhook', 'tunnel']) {
    assert.equal(compose.services[name]?.init, true, `services.${name}.init must be true`);
  }
  const botGraceMs = parseDurationSeconds(compose.services.bot.stop_grace_period) * 1000;
  const managerGraceMs = parseDurationSeconds(compose.services.manager.stop_grace_period) * 1000;

  const extractLimit = (source, label) => {
    const match = /shutdownLimitMs\s*=\s*([0-9_]+)/.exec(source);
    assert.ok(match, `${label} must define shutdownLimitMs`);
    return Number(match[1].replaceAll('_', ''));
  };
  const botLimitMs = extractLimit(botSource, 'src/main.ts');
  const managerLimitMs = extractLimit(managerSource, 'manager/main.mjs');

  assert.ok(botLimitMs < botGraceMs, `bot shutdownLimitMs (${botLimitMs}) must be strictly below stop_grace_period (${botGraceMs})`);
  assert.ok(managerLimitMs < managerGraceMs, `manager shutdownLimitMs (${managerLimitMs}) must be strictly below stop_grace_period (${managerGraceMs})`);

  for (const [label, source] of [['src/main.ts', botSource], ['manager/main.mjs', managerSource]]) {
    assert.match(source, /if\s*\(stopping\)\s*return;/, `${label} guards against duplicate shutdown signals`);
    assert.match(source, /server\.closeIdleConnections\?\.\(\)/, `${label} closes idle keep-alive connections immediately on shutdown`);
    assert.match(source, /server\.closeAllConnections\?\.\(\)/, `${label} force-closes lingering connections after drain timeout`);
  }
  assert.match(botSource, /stalls\.stop\(\)/, 'src/main.ts stops StallMonitor on shutdown');
  assert.match(botSource, /Promise\.allSettled\(/, 'src/main.ts runs store.close() even if a shutdown hook rejects');
});

test('release.yml Deploy failure trap restores canonical ingress containers left in created state before printing ps', () => {
  const deployStep = releaseWorkflow.jobs.deploy.steps.find(entry => entry.name === 'Deploy');
  assert.ok(deployStep?.run, 'Deploy step exists');
  const script = deployStep.run;

  assert.match(script, /recover_ingress\(\)\s*\{[\s\S]*?for target in webhook tunnel;/, 'restores webhook before tunnel');
  assert.ok(script.includes('[ "$name" = "/$canonical" ] && [ "$state" = created ]'), 'only starts canonical containers stuck in created state');
  assert.match(script, /trap 'status=\$\?; if \[ "\$status" -ne 0 \]; then recover_ingress \|\| true; docker compose ps -a \|\| true; fi' EXIT/, 'failure trap runs recover_ingress before printing docker compose ps -a');
});
