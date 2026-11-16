import type { Store } from '../storage/database.js';
import { withSection } from './settings.js';
import { retiredSections } from './catalog.js';

/**
 * Work types that were removed, and the upgrade that clears what older versions saved for them. Gate onboarding (#931)
 * went: CI changes are ordinary development tasks that end in a bot pull request.
 *
 * Finished tasks of a removed work type stay as they are, readable with their snapshots. Unfinished ones end, since nothing
 * runs them any more. The work type's switch and model and its Manager section go; the section is dropped with a new
 * revision, so the Manager page no longer shows it, and older revisions and task snapshots that still have it keep parsing
 * (parseSections skips a retired section). Gate onboarding's conversations and the one-click runs before them are dropped;
 * the gate pull requests they opened are the repository's and stay open on GitHub.
 *
 * Runs at every start inside one transaction; each step finds only what an older version left.
 */
export const retiredWorkTypes = ['gate.onboarding'];
const finished = "('succeeded','pr_opened','completed','cancelled','superseded')";
const json = (text: unknown) => { try { const value = JSON.parse(String(text)); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; } };

export function retireWorkTypes(store: Store): void {
  store.transaction(() => {
    store.db.exec('DROP TABLE IF EXISTS gate_onboarding_sessions; DROP TABLE IF EXISTS quickstart_runs;');
    const kinds = JSON.stringify(retiredWorkTypes), now = new Date().toISOString();
    store.run(`UPDATE tasks SET status='cancelled',error_code='work_removed',claim_token=NULL,next_run_at=0,updated_at=? WHERE kind IN (SELECT value FROM json_each(?)) AND status NOT IN ${finished}`, now, kinds);
    for (const policy of store.all("SELECT repository_id,work_settings,task_models FROM policies WHERE work_settings LIKE '%gate.onboarding%' OR task_models LIKE '%gate.onboarding%'")) {
      const work = json(policy.work_settings) ?? {}, models = json(policy.task_models);
      for (const id of retiredWorkTypes) { delete work[id]; if (models) delete models[id]; }
      store.run('UPDATE policies SET work_settings=?,task_models=? WHERE repository_id=?', JSON.stringify(work), models ? JSON.stringify(models) : policy.task_models, policy.repository_id);
    }
    // The latest revision of each project whose prompt still has a retired section.
    for (const row of store.all(`SELECT r.* FROM manager_revisions r WHERE r.content LIKE '%\`gate.onboarding\`%'
        AND r.revision=(SELECT max(revision) FROM manager_revisions WHERE repository_id=r.repository_id)`)) {
      let content = String(row.content);
      for (const id of retiredSections) content = withSection(content, id, null);
      if (content === row.content) continue;
      // The dispatch prompt is read as the latest saved one, so it carries over without a row for this revision.
      store.run('INSERT INTO manager_revisions VALUES(?,?,?,?,?,?,?,?)', row.repository_id, Number(row.revision) + 1, content, row.work_settings, row.event_filters, 'upgrade', null, now);
    }
  });
}
