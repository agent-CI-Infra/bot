// The store first: entered at roles/pool.js, the module graph would run tasks/followups.js before tasks/priority.js has
// finished (a test file may import this fixture before anything else).
import '../../dist/storage/database.js';
import { rolePool } from '../../dist/roles/pool.js';

// Since #1068 a project without a configuration runs the recommended one: every role on Pi, which needs a project
// computer. Tests of role and task mechanics that drive a fake model in process store a legacy configuration that runs
// every built-in role on Native. Since #1255 a legacy configuration's unnamed roles run Pi too, so each built-in role is
// named here. An instance keeps the backend it was first bound to, and the review and Actions entries run their dev
// assignment on Pi. Stored after start-up, it is not migrated (the start-up migrations have already run).
export const nativeHarnesses = () => Object.fromEntries(rolePool.map(role => [role.id, 'native']));
export function nativeRoles(store, repositoryId) {
  const harnesses = nativeHarnesses();
  store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles:' + repositoryId, JSON.stringify({ enabled: false, harnesses }));
}

// The same for the service assistants (#1255): the management assistant starts on Pi, which needs an assistant computer;
// tests of conversation mechanics that drive a fake model in process run it on Native, as before (management-fixture.mjs). Group bindings name
// their backend when they are saved (channel-fixture.mjs boundGroup). Tests of Pi service assistants choose Pi themselves.
export function nativeServiceAssistants(store) {
  store.run("UPDATE service_roles SET harness='native' WHERE id='management-assistant'");
}
