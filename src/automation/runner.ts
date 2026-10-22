import { randomId, type Json } from '../core/security.js';
import type { Store } from '../storage/database.js';
import { loadAutomationConfig, type AutomationConfig } from './config.js';
import { planAutomation } from './engine.js';
import type { Action, AutomationFacts } from './types.js';

export interface AutomationRun {
  id: string;
  repository_id: string;
  delivery_id: string;
  event: string;
  route: string;
  dry_run: number;
  actions: string;
  notes: string;
  created_at: string;
}

/**
 * Plan and record automation for one ingested event (#1).
 *
 * Runs inside the delivery transaction and never writes to GitHub: every row is a `dry_run` plan
 * until the executor ships. A rule or config failure is recorded on the run, never on the delivery,
 * so a bad rule cannot make webhook ingestion fail.
 */
export function recordAutomation(
  store: Store,
  repositoryId: string,
  event: string,
  action: string,
  payload: Json,
  deliveryId: string,
  facts: AutomationFacts = {},
  /** A repository YAML file: used when the policy row has no automation config of its own. */
  fallback?: AutomationConfig,
): AutomationRun {
  const row = store.get('SELECT automation FROM policies WHERE repository_id=?', repositoryId);
  const { config, problem } = loadAutomationConfig(row?.automation, fallback);
  const plan = planAutomation({ event: { repositoryId, event, action, payload, deliveryId }, config, facts });
  const notes = problem ? [problem, ...plan.notes] : plan.notes;
  const run: AutomationRun = {
    id: randomId(),
    repository_id: repositoryId,
    delivery_id: deliveryId,
    event,
    route: action ? `${event}.${action}` : event,
    dry_run: Number(config.dryRun),
    actions: JSON.stringify(plan.actions),
    notes: JSON.stringify(notes),
    created_at: new Date().toISOString(),
  };
  store.run(
    `INSERT INTO automation_runs(id,repository_id,delivery_id,event,route,dry_run,actions,notes,created_at)
     VALUES(?,?,?,?,?,?,?,?,?)`,
    run.id, run.repository_id, run.delivery_id, run.event, run.route, run.dry_run, run.actions, run.notes, run.created_at,
  );
  return run;
}

/** The seam for the executor: one planned action at a time, after the outbox records it. */
export interface ActionExecutor {
  execute(action: Action, run: AutomationRun): Promise<void>;
}
