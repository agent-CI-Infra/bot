import type { Json } from '../core/security.js';

/** What a rule asks the control plane to do. Actions are planned first and executed later. */
export type Action =
  | { type: 'label.add'; label: string }
  | { type: 'label.remove'; label: string }
  | { type: 'comment.upsert'; marker: string; body: string }
  | { type: 'status.post'; context: string; state: 'success' | 'pending' | 'failure'; description: string }
  | { type: 'merge'; number: number; method: 'merge' }
  | { type: 'workflow.dispatch'; workflow: string; ref: string };

/** One GitHub event, reduced to what rules need. The payload is untrusted data. */
export interface AutomationEvent {
  repositoryId: string;
  event: string;
  action: string;
  payload: Json;
  deliveryId: string;
}

/** Facts a planner cannot read from the webhook payload. Missing facts fail closed. */
export interface GateFacts {
  maintainer?: boolean;
  conflict?: boolean;
  headChecksPassed?: boolean;
  reviewAnswered?: boolean;
}

export interface MergeCandidate {
  number: number;
  createdAt: string;
  draft: boolean;
  conflict: boolean;
  labels: string[];
  gate: 'success' | 'pending' | 'failure';
}

export interface AutomationFacts {
  gate?: GateFacts;
  mergeQueue?: MergeCandidate[];
}

export interface RuleContext {
  event: AutomationEvent;
  config: import('./config.js').AutomationConfig;
  facts: AutomationFacts;
}

export interface Outcome {
  actions: Action[];
  notes: string[];
}

/** A capability module: pure planning, no I/O. */
export interface AutomationModule {
  id: string;
  plan(context: RuleContext): Outcome;
}

export const actionKey = (action: Action): string => JSON.stringify(action);
