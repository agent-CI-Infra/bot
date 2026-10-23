// Count the whole queue, not the paginated task list. Waiting/configuration faults are not executing tasks.
export const projectActivityColumns = `COALESCE(activity.running_tasks,0) AS running_tasks,COALESCE(activity.queued_tasks,0) AS queued_tasks`;
export const projectActivityJoin = `LEFT JOIN (
  SELECT repository_id,
    SUM(CASE WHEN status='queued' THEN 0 ELSE 1 END) AS running_tasks,
    SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued_tasks
  FROM tasks WHERE status IN ('running','preparing','implementing','validating','publishing','result_ready','queued')
  GROUP BY repository_id
) activity ON activity.repository_id=r.id`;
