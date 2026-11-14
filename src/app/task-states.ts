// A task state that asks a person for something: the work goes on only after someone fixes a configuration, an
// environment or a permission, decides how to continue, or a failed run is taken care of. `cancelled` is not one of
// them — the bot writes it when it stops because the Issue or PR it works on was closed or turned into a draft (#655),
// and that stop asks nobody for anything. `retry_wait` is not one either: the bot resumes it when the retry delay is
// over. `waiting_configuration` and `waiting_environment` stay here even though the engine retries them on a later
// tick: until the cause is fixed the work cannot go on, and the Issue asks for them to stay (#655). The board column,
// the inbox and the overview count these states, and only these, so they agree on one set.
export const actionStatuses = "('failed','paused','waiting_configuration','waiting_environment','waiting_permission','waiting_publication','needs_replan','needs_help')";
export const actionStatusSQL = (status: string) => `${status} IN ${actionStatuses}`;
// The stop the bot makes by itself, kept apart from the states that ask a person for something.
export const autoStoppedSQL = (status: string) => `${status}='cancelled'`;
// The newest task of the same work on the same object that the bot did not stop by itself, NULL when there is none: the
// card then stays where that last real task left it instead of turning into work for a person.
export const settledStatusSQL = (alias: string) => `(SELECT p.status FROM tasks p
  WHERE p.repository_id=${alias}.repository_id AND p.object_number=${alias}.object_number AND p.kind=${alias}.kind
    AND p.status<>'cancelled' ORDER BY coalesce(nullif(p.updated_at,''),p.created_at) DESC,p.created_at DESC,p.rowid DESC LIMIT 1)`;
