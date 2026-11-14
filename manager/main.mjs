import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Docker } from './docker.mjs';
import { Projects } from './projects.mjs';
import { createManagerServer } from './server.mjs';
import { RunEnvironments } from './run-environments.mjs';
import { AssistantComputers } from './assistant-computers.mjs';

process.umask(0o077);
const token = readFileSync(process.env.BOT_MANAGER_TOKEN_FILE);
const projects = new Projects({ database: process.env.BOT_MANAGER_DATABASE || '/data/manager.sqlite', docker: new Docker(),
  deployment: createHash('sha256').update(token).digest('hex').slice(0, 16), image: process.env.BOT_PROJECT_IMAGE || 'department-bot-project-computer:local',
  egress: process.env.BOT_PROJECT_EGRESS !== 'false' });
const runs = new RunEnvironments(projects);
// Assistant computers use the approved base image (no project's packages) unless BOT_ASSISTANT_IMAGE names another one.
const assistants = new AssistantComputers({ docker: projects.docker, db: projects.db, deployment: projects.deployment,
  image: process.env.BOT_ASSISTANT_IMAGE || projects.image, homes: process.env.BOT_ASSISTANT_HOMES || '/assistant-homes' });
const { server, recovered } = createManagerServer({ projects, token, runs, assistants });
server.listen(8793, '0.0.0.0');
let timer, assistantTimer, stopping = false, checking = false, checkingAssistants = false;
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
  stopping = true; clearInterval(timer); clearInterval(assistantTimer);
  server.close(async () => { await recovered; await assistants.shutdown(); await projects.shutdown(); process.exit(0); });
});
await recovered;
// Background work once the manager is ready: close trajectory files a stopped process left open, then move the bodies of
// ledger rows written before #436 into files, slice by slice, and remove the files no call replays any more (#671).
if (!stopping) void projects.trajectories.seal().catch(error => console.error('[manager] sealing trajectory files failed:', error)).then(() => { if (!stopping) { projects.migration.start(); projects.expiry.start(); } });
if (!stopping) timer = setInterval(async () => { if (checking) return; checking = true; try { await projects.check(); await runs.reap(); } finally { checking = false; } }, 5000);
// Assistant computers keep their own timer: their idle timeouts never wait behind a slow project check.
if (!stopping) assistantTimer = setInterval(async () => { if (checkingAssistants) return; checkingAssistants = true; try { await assistants.check(); } catch (error) { console.error('[manager] assistant computer check failed:', error); } finally { checkingAssistants = false; } }, 5000);
