import type { Row, Store } from '../storage/database.js';

const reviewDependencyFinished = new Set(['succeeded', 'pr_opened', 'completed', 'cancelled', 'superseded', 'failed', 'needs_replan']);

export function waitForReviewSatisfied(store: Store, task: Row): boolean {
  const dependency = JSON.parse(task.input || '{}').wait_for_review;
  return !dependency || reviewDependencyFinished.has(store.get('SELECT status FROM tasks WHERE id=?', dependency)?.status);
}

/** Same readiness rule for the atomic scheduler, including missing dependencies. */
export const reviewDependencySql=`(json_extract(input,'$.wait_for_review') IS NULL OR json_extract(input,'$.wait_for_review') IN ('',0) OR EXISTS(SELECT 1 FROM tasks dependency WHERE dependency.id=json_extract(tasks.input,'$.wait_for_review') AND dependency.status IN ('succeeded','pr_opened','completed','cancelled','superseded','failed','needs_replan')))`;
