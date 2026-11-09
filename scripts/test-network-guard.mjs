// Loaded into every Node.js process of a unit test set (scripts/test-sets.mjs adds it to NODE_OPTIONS): TCP connections
// may only go to loopback, where the local fake servers listen. Any other connection fails as if it had been refused and
// is written to BOT_TEST_NETWORK_LOG, which fails the set even when the code under test swallows the error. Tests that
// need a real external service belong in *.live.test.mjs (docs/development.md, section 测试集与并行).
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const loopback = host => host === 'localhost' || host.endsWith('.localhost') || /^(?:::ffff:)?127\./.test(host) || ['::1', '0.0.0.0', '::'].includes(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // net.connect() hands over its arguments as one normalized [options, callback] array; sockets may also be given
  // (port, host) or a Unix socket path.
  let options = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof options !== 'object' || options === null) options = typeof options === 'string' && !/^\d+$/.test(options) ? { path: options } : { port: options, host: args[1] };
  const host = String(typeof options.host === 'string' ? options.host : 'localhost').replace(/^\[(.*)\]$/, '$1');
  if (options.path || loopback(host)) return connect.apply(this, args);
  const message = `connection to ${host}:${options.port} blocked: unit tests may only connect to loopback`;
  if (process.env.BOT_TEST_NETWORK_LOG) appendFileSync(process.env.BOT_TEST_NETWORK_LOG, `${message} (pid ${process.pid}: ${process.argv.slice(1).join(' ')})\n`);
  process.nextTick(() => this.destroy(Object.assign(new Error(message), { code: 'ECONNREFUSED' })));
  return this;
};
