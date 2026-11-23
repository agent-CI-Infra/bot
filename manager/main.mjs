import { computerResultOwner } from '../runner/result-owner.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Docker } from './docker.mjs';
import { Projects } from './projects.mjs';
import { createManagerServer } from './server.mjs';
import { AssistantComputers } from './assistant-computers.mjs';
import { compactDatabase } from './compaction.mjs';

process.umask(0o077);
const token = readFileSync(process.env.BOT_MANAGER_TOKEN_FILE), database = process.env.BOT_MANAGER_DATABASE || '/data/manager.sqlite';
// Once, before the manager reports ready (#671): when free pages are most of manager.sqlite and the disk has room for a
// copy, the file is rewritten without them; the manager does not listen meanwhile. It logs its progress.
const compaction = await compactDatabase(database, { log: line => console.log('[manager] ' + line) });
const projects = new Projects({ database, docker: new Docker(),
  deployment: createHash('sha256').update(token).digest('hex').slice(0, 16), image: process.env.BOT_PROJECT_IMAGE || 'department-bot-project-computer:local',
  results: process.env.BOT_TOOL_RESULTS_DIR || null, egress: process.env.BOT_PROJECT_EGRESS !== 'false' });
projects.db.prepare("INSERT INTO settings VALUES('compaction',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(compaction));
// Assistant computers share the unified global computer defaults and precompiled image unless BOT_ASSISTANT_IMAGE overrides it.
const assistants = new AssistantComputers({ docker: projects.docker, db: projects.db, deployment: projects.deployment, disk: projects.disk,
  allocatedMemoryMb: () => projects.busyMemoryMb(),
  resultMount:owner=>projects.resultMount(computerResultOwner('assistant',owner)), agentTools:()=>projects.agentToolsVolume(), image: process.env.BOT_ASSISTANT_IMAGE || projects.image, homes: process.env.BOT_ASSISTANT_HOMES || '/assistant-homes',
  globalEnvironment: process.env.BOT_ASSISTANT_IMAGE ? null : () => projects.assistantGlobalEnvironment() });
const { server, recovered } = createManagerServer({ projects, token, assistants });
server.listen(8793, '0.0.0.0');
// Bound HTTP draining and teardown below compose.yaml stop_grace_period (100s) so deployments never hit Docker SIGKILL.
const shutdownDrainMs = 5_000, shutdownLimitMs = 80_000;
let timer, assistantTimer, stopping = false, checking = false, checkingAssistants = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  clearInterval(timer); clearInterval(assistantTimer);
  const forceExit = setTimeout(() => { console.error('[manager] shutdown timed out before stop_grace_period, exiting'); process.exit(1); }, shutdownLimitMs);
  forceExit.unref?.();
  const forceConnections = setTimeout(() => server.closeAllConnections?.(), shutdownDrainMs);
  forceConnections.unref?.();
  server.close(async () => {
    clearTimeout(forceConnections);
    try {
      await recovered; await assistants.shutdown(); await projects.shutdown();
      clearTimeout(forceExit);
      process.exit(0);
    } catch (error) {
      console.error('[manager] shutdown failed:', error);
      process.exit(1);
    }
  });
  server.closeIdleConnections?.();
});
await recovered;
// Background work once the manager is ready: close trajectory files a stopped process left open, then move the bodies of
// ledger rows written before #436 into files, slice by slice, and remove the files no call replays any more (#671).
if (!stopping) void projects.trajectories.seal().catch(error => console.error('[manager] sealing trajectory files failed:', error)).then(() => { if (!stopping) { projects.migration.start(); projects.expiry.start(); projects.vacuum.start(); } });
if (!stopping) timer = setInterval(async () => { if (checking) return; checking = true; try { await projects.check(assistants.activeImages()); } finally { checking = false; } }, 5000);
// Assistant computers keep their own timer: their idle timeouts never wait behind a slow project check.
if (!stopping) assistantTimer = setInterval(async () => { if (checkingAssistants) return; checkingAssistants = true; try { await assistants.check(); } catch (error) { console.error('[manager] assistant computer check failed:', error); } finally { checkingAssistants = false; } }, 5000);
