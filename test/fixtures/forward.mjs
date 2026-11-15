// Loopback forwarder for the model fixtures of the Docker acceptance stacks.
//
// The control plane refuses plain HTTP to any address that is not this machine (#755), so the acceptance stacks do not
// give the fixture a hostname: this process shares the bot container's network namespace (network_mode: service:bot),
// listens on 127.0.0.1:9100 there and forwards every connection to the fixtures service. The model URL the harness
// stores is then http://127.0.0.1:9100/…, which is a real loopback address for the product rule; the plain HTTP hop
// between this process and the fixtures container exists only inside the test stack.
import { createServer, connect } from 'node:net';

const [listen = '127.0.0.1:9100', target = 'fixtures:9100'] = process.argv.slice(2);
const [listenHost, listenPort] = listen.split(':');
const [targetHost, targetPort] = target.split(':');

createServer(client => {
  const upstream = connect(Number(targetPort), targetHost);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on('error', close);
  upstream.on('error', close);
  client.pipe(upstream).pipe(client);
}).listen(Number(listenPort), listenHost, () => console.log(`forwarding ${listen} -> ${target}`));
