// These are task states, not RoleRun counts or claims about environment/CI health.
export const taskGroupSQL = {
  active: "status IN ('running','preparing','implementing','validating','publishing','result_ready')",
  queued: "status='queued'",
  attention: "status IN ('failed','paused','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','needs_replan')",
};
// Count the whole queue, not the paginated task list. Waiting/configuration faults are not executing tasks.
export const projectActivityColumns = `COALESCE(activity.running_tasks,0) AS running_tasks,COALESCE(activity.queued_tasks,0) AS queued_tasks`;
export const projectActivityJoin = `LEFT JOIN (
  SELECT repository_id,
    SUM(CASE WHEN ${taskGroupSQL.active} THEN 1 ELSE 0 END) AS running_tasks,
    SUM(CASE WHEN ${taskGroupSQL.queued} THEN 1 ELSE 0 END) AS queued_tasks
  FROM tasks WHERE (${taskGroupSQL.active} OR ${taskGroupSQL.queued})
  GROUP BY repository_id
) activity ON activity.repository_id=r.id`;
