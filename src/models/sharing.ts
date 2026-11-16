import type { Store, Row } from '../storage/database.js';

/**
 * Which projects a deployment-shared model serves (#850). A shared model serves every project unless a super administrator
 * restricted it (models.restricted=1) to the projects listed in model_projects. A project's own model serves only it.
 */
export function sharedModelStorage(store: Store): void {
  if (store.all('PRAGMA table_info(models)').some(column => column.name === 'restricted')) return;
  store.transaction(() => {
    store.db.exec('ALTER TABLE models ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0');
    // Before, every shared model served only the projects it was authorized to. One already authorized to every project
    // serves all of them, later ones included; any other keeps its list, so no project gains a model it did not have.
    const projects = Number(store.get('SELECT count(*) n FROM repositories')!.n);
    for (const model of store.all(`SELECT m.id,(SELECT count(DISTINCT p.repository_id) FROM model_projects p JOIN repositories r ON r.id=p.repository_id WHERE p.model_id=m.id) n
      FROM models m WHERE m.repository_id IS NULL`))
      if (Number(model.n) < projects) store.run('UPDATE models SET restricted=1 WHERE id=?', model.id);
  });
}
/** Does a model serve this project? */
export function modelServes(store: Store, model: Row, project: string): boolean {
  if (model.repository_id !== null) return model.repository_id === project;
  return !model.restricted || !!store.get('SELECT 1 FROM model_projects WHERE model_id=? AND repository_id=?', model.id, project);
}
