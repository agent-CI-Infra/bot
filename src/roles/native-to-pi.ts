import type { Store } from '../storage/database.js';
import { moveNativeRolesToPi } from './definition.js';

/**
 * One-time migration (#1255): Pi is the default backend for the management assistant, group assistants and project roles,
 * and what a database from before it saved as Native moves to Pi. Native can still be chosen by hand until it is removed.
 * - Service roles: `service_roles.harness` `native` → `pi`, a new revision, so a console form opened before the upgrade
 *   cannot save Native back unseen.
 * - Group bindings: `channel_service_bindings.harness` `native` → `pi`. The revision stays: it is part of the group's
 *   authorization fence, and the backend does not change what the group may do (as in the #1072 and #1249 migrations).
 * - Project roles: see moveNativeRolesToPi.
 * Codex, Claude Code and every other backend stay as they are. A new database runs this once with nothing to move, so a
 * configuration saved as Native afterwards (by hand, or by a test fixture) stays Native.
 */
export function migrateNativeToPi(s: Store, log: (line: string) => void = line => console.log(line)) {
  const marker = 'migration:1255:native-to-pi';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  const counts = s.transaction(() => {
    const time = new Date().toISOString();
    const roles = s.hasTable('service_roles') ? s.all("SELECT id FROM service_roles WHERE harness='native' ORDER BY id").map(row => String(row.id)) : [];
    for (const id of roles) {
      s.run("UPDATE service_roles SET harness='pi',revision=revision+1,updated_at=? WHERE id=? AND harness='native'", time, id);
      s.audit('migration:1255', 'service_role.native_to_pi', id);
    }
    const bindings = s.hasTable('channel_service_bindings') ? s.all("SELECT id FROM channel_service_bindings WHERE harness='native' ORDER BY id").map(row => String(row.id)) : [];
    for (const id of bindings) {
      s.run("UPDATE channel_service_bindings SET harness='pi' WHERE id=? AND harness='native'", id);
      s.audit('migration:1255', 'channel.service_binding.native_to_pi', id);
    }
    const projects = moveNativeRolesToPi(s);
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, time);
    return { serviceRoles: roles.length, bindings: bindings.length, ...projects };
  });
  if (counts.serviceRoles || counts.bindings || counts.projects || counts.kept)
    log(`[migration:1255] Native → Pi: ${counts.serviceRoles} service roles, ${counts.bindings} group bindings, ${counts.roles} roles in ${counts.projects} projects`
      + (counts.kept ? `; ${counts.kept} roles stay Native (their pinned model profile needs text_json output, which Pi cannot use)` : ''));
}
