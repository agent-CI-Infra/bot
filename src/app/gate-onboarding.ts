import { superAdmin, type Actor } from './auth.js';
import { fail, fields, type Json } from '../core/security.js';
import type { GateOnboarding } from '../projects/gate-onboarding.js';

/**
 * The gate onboarding conversation. Super administrators start one per repository, send messages (with their own plan
 * edits), answer the merge queue question when the facts cannot tell, and confirm a plan revision; only the confirmation
 * lets the control plane open the gate PR.
 */
export async function gateOnboardingApi(gate: GateOnboarding | undefined, user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
  const project = /^\/api\/projects\/([1-9]\d*)\/gate-onboarding$/.exec(url.pathname);
  if (project) {
    superAdmin(user);
    if (!gate) return fail(404, 'not_found');
    // ready says whether the project can use gate onboarding now (started, computer ready, workflow on, model configured).
    if (method === 'GET') return { session: gate.latest(project[1]!), ready: gate.readiness(project[1]!) };
    if (method === 'POST') { fields(input, []); return { session: gate.start(project[1]!) }; }
    return fail(404, 'not_found');
  }
  const session = /^\/api\/gate-onboarding\/([a-f0-9]{48})(?:\/(messages|confirm|merge-queue|preview))?$/.exec(url.pathname);
  if (!session) return undefined;
  superAdmin(user);
  if (!gate) return fail(404, 'not_found');
  const [, id, action] = session;
  if (!action && method === 'GET') { const value = gate.get(id!); return value ? { session: value } : fail(404, 'gate_onboarding_not_found'); }
  if (action === 'messages' && method === 'POST') { fields(input, ['content', 'revision', 'plan']); return { session: gate.message(id!, input.content, input.revision, input.plan) }; }
  // Renders files for unsent edits; nothing is saved.
  if (action === 'preview' && method === 'POST') { fields(input, ['plan']); return gate.preview(id!, input.plan); }
  if (action === 'merge-queue' && method === 'POST') { fields(input, ['answer']); return { session: gate.answerMergeQueue(id!, input.answer) }; }
  if (action === 'confirm' && method === 'POST') { fields(input, ['revision', 'plan', 'merge_queue']); return { session: gate.confirm(id!, input.revision, input.plan, input.merge_queue) }; }
  return fail(404, 'not_found');
}
