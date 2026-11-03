import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Docker } from './docker.mjs';
import { Projects } from './projects.mjs';
import { createManagerServer } from './server.mjs';

process.umask(0o077);
const token = readFileSync(process.env.BOT_MANAGER_TOKEN_FILE);
const projects = new Projects({ database: process.env.BOT_MANAGER_DATABASE || '/data/manager.sqlite', docker: new Docker(),
  deployment: createHash('sha256').update(token).digest('hex').slice(0, 16), image: process.env.BOT_PROJECT_IMAGE || 'department-bot-project-computer:local',
  egress: process.env.BOT_PROJECT_EGRESS !== 'false' });
const { server, recovered } = createManagerServer({ projects, token });
server.listen(8793, '0.0.0.0');
let timer, stopping = false, checking = false;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
  stopping = true; clearInterval(timer);
  server.close(async () => { await recovered; await projects.shutdown(); process.exit(0); });
});
await recovered;
if (!stopping) timer = setInterval(async () => { if (checking) return; checking = true; try { await projects.check(); } finally { checking = false; } }, 5000);
