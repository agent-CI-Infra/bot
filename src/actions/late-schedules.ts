import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What an agent does when it notices a workflow's scheduled runs start much later than their cron (#1072): recommend, once
 * per repository, that the bot start the workflow on time. It is a prompt, not a flow: the agent judges the delay, looks for
 * an earlier recommendation and writes it with the tools it has. The text is docs/prompts/late-schedules.md, read once at
 * startup so the documented text and the text the model receives cannot drift apart. Agents that read Actions get it:
 * Actions failure handling, CI observation, project scheduled tasks and the Feishu and management assistants.
 */
export const lateSchedules = readFileSync(resolve(import.meta.dirname, '../../docs/prompts/late-schedules.md'), 'utf8');
