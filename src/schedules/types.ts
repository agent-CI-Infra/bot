import type { ActorContext } from '../identity/authorization.js';
import type { Json } from '../core/security.js';

export const eventTypes = ['project.daily', 'task.failed', 'ci.failed', 'ci.recovered'] as const;
export interface Limits {
  concurrency: number; runtime_ms: number; runs: number; model_calls: number; cost_micros: number;
  retries: number; manual_retries: number; notifications_per_minute: number;
}
export const defaultLimits: Limits = { concurrency: 1, runtime_ms: 60000, runs: 100, model_calls: 0, cost_micros: 0, retries: 3, manual_retries: 1, notifications_per_minute: 10 };
export interface Plan {
  name: string; kind: 'personal' | 'project'; actor_id: string; owner_id: string; maintainer_id: string;
  workflow: string; parameters: Json; timezone: string; cron?: string; interval_ms?: number;
  start_at: number; end_at?: number; enabled: boolean; misfire: 'skip' | 'once'; grace_ms: number;
  destination_id: string; limits: Limits;
}
export interface SubscriptionSpec {
  name: string; destination_id: string; events: string[]; projects: string[]; aggregate_ms: number;
  timezone: string; quiet_start?: string; quiet_end?: string; enabled: boolean;
}
export interface ControlledTrigger {
  occurrence_id: string; run_id: string; project_id: string; tenant_id: string; workflow: string;
  parameters: Json; logical_at: number; source: string; authorization_revision: number; config: Json;
}
/** Dispatch is a short local transaction. A handler must persist its idempotent business run here.
 * Network/model/tool actions belong to that business service, which must invoke guard before each action.
 * No production development or release handler is installed until its owning module implements this contract. */
export interface TriggerHandler {
  capability: string;
  dispatch(trigger: ControlledTrigger, actor: ActorContext, guard: () => void): { run_id: string; state: string };
}
export interface ActionUsage { model_calls?: number; cost_micros?: number; }
