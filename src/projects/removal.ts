import { type Store } from '../storage/database.js';
import { type Actor, superAdmin } from '../app/auth.js';
import { fail, fields, type Json } from '../core/security.js';
import { type InstallationSync } from '../app/installations.js';
import { dropUninstalledIntegrations } from './integrations.js';
import { type ProjectService } from './service.js';

// The task engine's running work on a repository's computer; a deletion waits for it before removing task rows.
export interface RunningTasks { working(repositoryId: string): Promise<unknown>[] }
const finished = "('succeeded','pr_opened','completed','cancelled','superseded','failed')";

// Removes everything that belongs only to this repository, children before parents (no foreign key cascades on delete).
// The audit stays: it names repositories without a foreign key.
export function deleteProjectRecords(store: Store, id: string): void {
  const clients = 'SELECT id FROM external_clients WHERE repository_id=?', subscriptions = `SELECT id FROM external_subscriptions WHERE repository_id=? OR client_id IN (${clients})`;
  const deliveries = 'SELECT id FROM deliveries WHERE repository_id=?', tasks = 'SELECT id FROM tasks WHERE repository_id=?', models = 'SELECT id FROM models WHERE repository_id=?';
  const statements: [string, number][] = [
    [`DELETE FROM external_event_cursors WHERE client_id IN (${clients})`, 1], [`DELETE FROM external_grants WHERE client_id IN (${clients})`, 1],
    [`DELETE FROM external_deliveries WHERE repository_id=? OR subscription_id IN (${subscriptions}) OR source_id IN (${deliveries})`, 4],
    [`DELETE FROM external_subscriptions WHERE repository_id=? OR client_id IN (${clients})`, 2], ['DELETE FROM external_clients WHERE repository_id=?', 1],
    [`DELETE FROM external_events WHERE repository_id=? OR source_id IN (${deliveries})`, 2],
    ['DELETE FROM board_values WHERE repository_id=?', 1], ['DELETE FROM board_objects WHERE repository_id=?', 1],
    ...['task_logs', 'task_tools', 'github_effects', 'development_candidates', 'task_metrics'].map((table): [string, number] => [`DELETE FROM ${table} WHERE task_id IN (${tasks})`, 1]),
    [`DELETE FROM model_requests WHERE repository_id=? OR task_id IN (${tasks})`, 2],
    ['DELETE FROM task_claims WHERE repository_id=?', 1], ['DELETE FROM bot_branches WHERE repository_id=?', 1], ['DELETE FROM bot_pull_requests WHERE repository_id=?', 1],
    ['DELETE FROM tasks WHERE repository_id=?', 1], ['DELETE FROM automation_runs WHERE repository_id=?', 1], ['DELETE FROM deliveries WHERE repository_id=?', 1],
    ['DELETE FROM environment_operations WHERE repository_id=?', 1], ['DELETE FROM project_environments WHERE repository_id=?', 1],
    ['DELETE FROM computer_console_specs WHERE repository_id=?', 1], ['DELETE FROM repository_rule_sources WHERE repository_id=?', 1],
    // Models only this repository may use, with their prices and grants; a shared model only loses its grant to this repository.
    [`UPDATE policies SET model_id=NULL WHERE model_id IN (${models})`, 1], [`DELETE FROM model_pricing WHERE model_id IN (${models})`, 1],
    [`DELETE FROM model_projects WHERE repository_id=? OR model_id IN (${models})`, 2], ['DELETE FROM policies WHERE repository_id=?', 1], ['DELETE FROM models WHERE repository_id=?', 1],
    ['DELETE FROM project_admin_assignments WHERE repository_id=?', 1], ['DELETE FROM repo_integrations WHERE repository_id=?', 1],
    ['DELETE FROM quickstart_runs WHERE repository_id=?', 1], ['DELETE FROM installed_repositories WHERE repository_id=?', 1], ['DELETE FROM repositories WHERE id=?', 1]];
  for (const [sql, count] of statements) {
    const table = /^(?:DELETE FROM|UPDATE) (\w+)/.exec(sql)![1]!;
    if (store.hasTable(table)) store.run(sql, ...Array<string>(count).fill(id));
  }
}

// Deleting a project is allowed only when GitHub, asked right now, says the account no longer reaches the repository at all.
export class ProjectRemoval {
  constructor(readonly store: Store, readonly installations?: InstallationSync, readonly projects?: ProjectService, readonly engine?: RunningTasks,
    readonly settleMs = 120_000) {}
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    const match = /^\/api\/installations\/([1-9]\d*)$/.exec(url.pathname);
    if (!match || method !== 'DELETE') return undefined;
    superAdmin(user); fields(input, ['confirm']); if (input.confirm !== true) fail(400, 'confirmation_required');
    return this.remove(user, match[1]!);
  }
  private async remove(user: Actor, id: string): Promise<Json> {
    const registered = this.store.get('SELECT * FROM repositories WHERE id=?', id);
    const listed = this.store.all('SELECT DISTINCT account_id FROM installed_repositories WHERE repository_id=?', id).map(row => String(row.account_id));
    if (!registered && !listed.length) return fail(404, 'repository_not_found');
    if (!this.installations) return fail(503, 'sync_not_configured');
    // The project's own account decides; a repository never started needs every account that lists it to have lost it.
    for (const account of registered ? [String(registered.account_id)] : listed) {
      const access = await this.installations.access(account, id);
      if (access.state !== 'gone') fail(409, access.state === 'limited' ? 'repository_permissions_insufficient' : 'repository_still_accessible');
    }
    if (!registered) return this.store.transaction(() => {
      if (this.store.get('SELECT 1 FROM repositories WHERE id=?', id)) fail(409, 'repository_started');
      this.store.run('DELETE FROM installed_repositories WHERE repository_id=?', id); dropUninstalledIntegrations(this.store);
      this.store.audit(user.id, 'repository.removed', id, id);
      return { deleted: true, repository_id: id, registered: false };
    });
    try {
      // No new work, and every unfinished task is cancelled: a running one stops at its next checkpoint and can no longer
      // write its own status back.
      this.store.transaction(() => {
        this.store.run('UPDATE policies SET enabled=0 WHERE repository_id=?', id);
        this.store.run(`UPDATE tasks SET status='cancelled',error_code='repository_deleted',claim_token=NULL,updated_at=? WHERE repository_id=? AND status NOT IN ${finished}`,
          new Date().toISOString(), id);
        this.store.audit(user.id, 'repository.deleting', id, id);
      });
      // Stopping the computer also interrupts the command a running task is waiting for.
      await this.projects?.removeEnvironment(id, this.settleMs);
      if (!await this.settled(id)) fail(409, 'tasks_still_stopping');
      return this.store.transaction(() => {
        if (this.engine?.working(id).length) fail(409, 'tasks_still_stopping');
        deleteProjectRecords(this.store, id);
        this.store.audit(user.id, 'repository.deleted', id, id);
        return { deleted: true, repository_id: id, registered: true };
      });
    } finally { this.projects?.endRemoval(id); }
  }
  private async settled(id: string): Promise<boolean> {
    const work = this.engine?.working(id) || []; if (!work.length) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.allSettled(work), new Promise(resolve => { timer = setTimeout(resolve, this.settleMs); })]); clearTimeout(timer);
    return !this.engine!.working(id).length;
  }
}
