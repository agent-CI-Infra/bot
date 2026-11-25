import { existsSync } from 'node:fs';
import { DEFAULT_RUNNER_SOCKET_DIR } from './wire-protocol.mjs';

// Compatibility entry: legacy image layers with CMD ["node", "/opt/runner/idle.mjs"] automatically
// run the resident runner daemon when /run/bot-runner is mounted or BOT_RUNNER_SOCKET/BOT_RUNNER_LISTEN is configured.
if (existsSync(DEFAULT_RUNNER_SOCKET_DIR) || process.env.BOT_RUNNER_SOCKET || process.env.BOT_RUNNER_LISTEN) {
  const { startRunnerDaemon } = await import('./daemon.mjs');
  const daemon = await startRunnerDaemon();
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    void daemon.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} else {
  setInterval(() => {}, 3600000);
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}
