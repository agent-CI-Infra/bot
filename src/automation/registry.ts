import { gate } from './modules/gate.js';
import { labelLint, prStatus } from './modules/labels.js';
import { mergeQueue } from './modules/merge-queue.js';
import type { AutomationModule } from './types.js';

/**
 * The built-in capability modules (#1). A module is a pure planner: it reads an event, the
 * repository config and the facts the caller could verify, and returns actions. Adding a capability
 * means adding a module here, not changing the engine or a workflow.
 */
export const builtInModules: readonly AutomationModule[] = [labelLint, prStatus, gate, mergeQueue];

export const moduleIds: readonly string[] = builtInModules.map(module => module.id);
