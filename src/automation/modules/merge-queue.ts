import type { Action, AutomationModule, MergeCandidate, Outcome, RuleContext } from '../types.js';

/**
 * The merge queue, ported from PPMA's `gate-queue.yml` / `ci_merge.py` (#1).
 *
 * Eligible: not a draft, no skip label, no conflict, green gate. Order: oldest first, pinned to the
 * head the gate judged (a push between planning and merging fails that merge, as in PPMA). The queue
 * is a fact supplied by the caller, which also owns re-reading the head's checks before merging.
 * `merge.enabled` stays false until a repository asks for it.
 */
export function eligible(candidate: MergeCandidate, skipLabels: string[]): boolean {
  if (candidate.draft || candidate.conflict) return false;
  if (candidate.gate !== 'success') return false;
  return !candidate.labels.some(label => skipLabels.includes(label));
}

export function order(candidates: MergeCandidate[], oldestFirst: boolean): MergeCandidate[] {
  const sorted = [...candidates].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return oldestFirst ? sorted : sorted.reverse();
}

export const mergeQueue: AutomationModule = {
  id: 'merge-queue',
  plan({ config, facts }: RuleContext): Outcome {
    if (!config.merge.enabled) return { actions: [], notes: [] };
    const candidates = facts.mergeQueue;
    if (!candidates) return { actions: [], notes: ['no merge queue facts; nothing planned'] };
    const actions: Action[] = [];
    for (const candidate of order(candidates, config.merge.oldestFirst)) {
      if (!eligible(candidate, config.merge.skipLabels)) continue;
      actions.push({ type: 'merge', number: candidate.number, method: config.merge.method });
    }
    return { actions, notes: [] };
  },
};
