import test from 'node:test';
import assert from 'node:assert/strict';
import { StallMonitor } from '../dist/core/stalls.js';

test('a blocked event loop is logged with the requests in flight, and a slow request with its path only', async t => {
  const lines = [], monitor = new StallMonitor({ stallMs: 500, slowMs: 1000, log: line => lines.push(line) });
  monitor.start(100); t.after(() => monitor.stop());
  const done = monitor.request('GET', '/api/tasks/abc/logs?token=secret-value');
  // Synchronous work, like a heavy query: nothing else runs until it returns.
  for (const end = Date.now() + 1200; Date.now() < end;);
  await new Promise(resolve => setTimeout(resolve, 300));
  done(); done();
  const stall = lines.find(line => line.startsWith('[stall]'));
  assert.ok(stall, lines.join('\n'));
  assert.match(stall, /event loop blocked ~1\.\d s; requests in flight: GET \/api\/tasks\/abc\/logs \(1\.\d s\)/);
  assert.deepEqual(lines.filter(line => line.startsWith('[slow]')).length, 1, 'a request is reported once');
  assert.match(lines.find(line => line.startsWith('[slow]')), /^\[slow\] GET \/api\/tasks\/abc\/logs \d+ ms$/);
  assert.ok(!lines.join('\n').includes('secret-value'), 'query strings are never logged');
});

test('a block with no request in flight says so, and ordinary timer jitter is not reported', async t => {
  const lines = [], monitor = new StallMonitor({ stallMs: 500, log: line => lines.push(line) });
  monitor.start(100); t.after(() => monitor.stop());
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.deepEqual(lines, []);
  for (const end = Date.now() + 800; Date.now() < end;);
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.match(lines.join('\n'), /requests in flight: none$/m);
});
