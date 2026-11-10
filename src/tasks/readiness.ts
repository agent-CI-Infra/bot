import type { Row, Store } from '../storage/database.js';

const reviewDependencyFinished = new Set(['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed', 'needs_replan']);

export function waitForReviewSatisfied(store: Store, task: Row): boolean {
  const dependency = JSON.parse(task.input || '{}').wait_for_review;
  return !dependency || reviewDependencyFinished.has(store.get('SELECT status FROM tasks WHERE id=?', dependency)?.status);
}
