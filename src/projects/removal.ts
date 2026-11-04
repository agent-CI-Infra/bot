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
    ['DELETE FROM review_sessions WHERE repository_id=?', 1], ['DELETE FROM review_objects WHERE repository_id=?', 1],
    ...['review_updates', 'task_logs', 'task_tools', 'github_effects', 'development_candidates', 'task_metrics'].map((table): [string, number] => [`DELETE FROM ${table} WHERE task_id IN (${tasks})`, 1]),
    [`DELETE FROM model_requests WHERE repository_id=? OR task_id IN (${tasks})`, 2],
    ['DELETE FROM task_claims WHERE repository_id=?', 1], ['DELETE FROM bot_branches WHERE repository_id=?', 1], ['DELETE FROM bot_pull_requests WHERE repository_id=?', 1],
    ['DELETE FROM tasks WHERE repository_id=?', 1], ['DELETE FROM automation_runs WHERE repository_id=?', 1], ['DELETE FROM deliveries WHERE repository_id=?', 1],
    ['DELETE FROM environment_operations WHERE repository_id=?', 1], ['DELETE FROM project_environments WHERE repository_id=?', 1],
    ['DELETE FROM computer_console_specs WHERE repository_id=?', 1], ['DELETE FROM repository_rule_sources WHERE repository_id=?', 1],
    // Models only this repository may use, with their prices and grants; a shared model only loses its grant to this repository.
    [`UPDATE policies SET model_id=NULL WHERE model_id IN (${models})`, 1], [`DELETE FROM model_pricing WHERE model_id IN (${models})`, 1],
    [`DELETE FROM model_projects WHERE repository_id=? OR model_id IN (${models})`, 2], ['DELETE FROM policies WHERE repository_id=?', 1], ['DELETE FROM models WHERE repository_id=?', 1],
    ['DELETE FROM project_admin_assignments WHERE repository_id=?', 1], ['DELETE FROM repo_integrations WHERE repository_id=?', 1],
    ['DELETE FROM public_board_consents WHERE repository_id=?', 1], ['DELETE FROM public_board_jobs WHERE repository_id=?', 1], ['DELETE FROM quickstart_runs WHERE repository_id=?', 1], ['DELETE FROM installed_repositories WHERE repository_id=?', 1], ['DELETE FROM repositories WHERE id=?', 1]];
  for (const [sql, count] of statements) {
    const table = /^(?:DELETE FROM|UPDATE) (\w+)/.exec(sql)![1]!;
    if (store.hasTable(table)) store.run(sql, ...Array<string>(count).fill(id));
  }
}

// Both project-removal endpoints share environment and record cleanup. Off-installation removal first checks GitHub.
export class ProjectRemoval {
  constructor(readonly store: Store, readonly installations?: InstallationSync, readonly projects?: ProjectService, readonly engine?: RunningTasks,
    readonly settleMs = 120_000) {}
  async api(user: Actor, method: string, url: URL, input: Json): Promise<Json | undefined> {
    // The legacy local removal endpoint must also remove the environment and notes, rather than only database rows.
    const local = /^\/api\/projects\/([1-9]\d*)$/.exec(url.pathname);
    if (local && method === 'DELETE') {
      superAdmin(user); fields(input, ['confirm']);
      const id = local[1]!;
      if (!this.store.get('SELECT 1 FROM repositories WHERE id=?', id)) fail(404, 'repository_not_found');
      if (this.store.get("SELECT 1 FROM environment_operations WHERE repository_id=? AND state='pending'", id)
        || this.store.get("SELECT 1 FROM quickstart_runs WHERE repository_id=? AND state IN ('queued','running')", id)) fail(409, 'project_account_pending');
      await this.removeRegistered(user, id); return { deleted: true };
    }
    // The console's GitHub-checked project deletion. Plain DELETE /api/installations/:id only hides a list row.
    const match = /^\/api\/installations\/([1-9]\d*)\/removal$/.exec(url.pathname);
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
      // A grant made before the repository was enabled goes with it, as a project's grants go with the project.
      this.store.run('DELETE FROM project_admin_assignments WHERE repository_id=?', id);
      this.store.audit(user.id, 'repository.removed', id, id);
      return { deleted: true, repository_id: id, registered: false };
    });
    return this.removeRegistered(user, id);
  }
  private async removeRegistered(user: Actor, id: string): Promise<Json> {
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
      // Check child ordering, constraints and deletion triggers before destroying the persistent notes. Roll back this
      // dry run: environment failures must leave the project records available for inspection and retry.
      this.store.db.exec('SAVEPOINT project_removal_check');
      try { deleteProjectRecords(this.store, id); this.store.audit(user.id, 'repository.deleted', id, id); }
      finally { this.store.db.exec('ROLLBACK TO project_removal_check; RELEASE project_removal_check'); }
      await this.projects?.removeEnvironment(id, this.settleMs, true);
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
