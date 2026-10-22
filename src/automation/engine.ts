import { builtInModules } from './registry.js';
import { actionKey, type Action, type AutomationModule, type Outcome, type RuleContext } from './types.js';

/**
 * Run every module over one event and merge their plans.
 *
 * Modules never write: the engine returns the deduplicated plan, and the caller records it (dry-run)
 * or hands it to the executor (enabled). A module that throws cannot take the others down, and its
 * failure is recorded as a note.
 */
export function planAutomation(context: RuleContext, modules: readonly AutomationModule[] = builtInModules): Outcome {
  const actions: Action[] = [];
  const notes: string[] = [];
  const seen = new Set<string>();
  for (const module of modules) {
    try {
      const outcome = module.plan(context);
      for (const action of outcome.actions) {
        const key = actionKey(action);
        if (seen.has(key)) continue;
        seen.add(key);
        actions.push(action);
      }
      notes.push(...outcome.notes.map(note => `${module.id}: ${note}`));
    } catch (error) {
      notes.push(`${module.id}: failed (${error instanceof Error ? error.name : 'error'})`);
    }
  }
  return { actions, notes };
}
