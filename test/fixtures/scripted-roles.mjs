import { scriptedHarness } from './scripted-driver.mjs';
import { rolePool } from '../../dist/roles/pool.js';

// Since #1068 a project without a configuration of its own runs every role on Pi, which needs a project computer. Tests
// of role and task mechanics that drive a fake model in process store a legacy configuration that names the test-only
// scripted driver for every built-in role (#1256; scripted-driver.mjs); a legacy configuration's unnamed roles run Pi
// (#1255). An instance keeps the backend it was first bound to, and the review and Actions entries run their dev
// assignment on Pi. Stored after start-up, it is not migrated (the start-up migrations have already run).
export const scriptedHarnesses = () => Object.fromEntries(rolePool.map(role => [role.id, scriptedHarness]));
export function scriptedRoles(store, repositoryId) {
  store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles:' + repositoryId, JSON.stringify({ enabled: false, harnesses: scriptedHarnesses() }));
}
