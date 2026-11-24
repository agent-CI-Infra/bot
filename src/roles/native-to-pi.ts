import type { Store } from '../storage/database.js';
import { moveNativeRolesToPi, moveRolesToPi, retireNativeRoles } from './definition.js';
import { harnesses } from './harness.js';
import { requiredRoles } from './pool.js';

/**
 * One-time migration (#1255): Pi is the default backend for the management assistant, group assistants and project roles,
 * and what a database from before it saved as Native moves to Pi.
 * - Service roles: `service_roles.harness` `native` → `pi`, a new revision, so a console form opened before the upgrade
 *   cannot save Native back unseen.
 * - Group bindings: `channel_service_bindings.harness` `native` → `pi`. The revision stays: it is part of the group's
 *   authorization fence, and the backend does not change what the group may do (as in the #1072 and #1249 migrations).
 * - Project roles: see moveNativeRolesToPi.
 * Codex, Claude Code and every other backend stay as they are. What it leaves on Native (roles whose model profile needs
 * text_json, and anything chosen by hand before Native was removed) is moved by the #1257 retirements below.
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

/**
 * Native is gone for service assistants (#1257): the console and the API no longer offer it. A management assistant,
 * service role or group binding still saved on Native (chosen by hand after the migration above) moves to Pi at start-up,
 * under the same revision rules: a service role gets a new revision, a group binding keeps its own (its fence). Nothing
 * can save Native any more, so this runs at every start and finds nothing after the first.
 */
export function retireNativeServiceAssistants(s: Store, log: (line: string) => void = line => console.log(line)) {
  const counts = s.transaction(() => {
    const time = new Date().toISOString();
    const roles = s.hasTable('service_roles') ? s.all("SELECT id FROM service_roles WHERE harness='native' ORDER BY id").map(row => String(row.id)) : [];
    for (const id of roles) {
      s.run("UPDATE service_roles SET harness='pi',revision=revision+1,updated_at=? WHERE id=? AND harness='native'", time, id);
      s.audit('migration:1257', 'service_role.native_retired', id);
    }
    const bindings = s.hasTable('channel_service_bindings') ? s.all("SELECT id FROM channel_service_bindings WHERE harness='native' ORDER BY id").map(row => String(row.id)) : [];
    for (const id of bindings) {
      s.run("UPDATE channel_service_bindings SET harness='pi' WHERE id=? AND harness='native'", id);
      s.audit('migration:1257', 'channel.service_binding.native_retired', id);
    }
    return { roles: roles.length, bindings: bindings.length };
  });
  if (counts.roles || counts.bindings) log(`[migration:1257] Native retired: ${counts.roles} service roles and ${counts.bindings} group bindings moved to Pi`);
}

/**
 * Native is gone for project roles too (#1257): once, at start-up, what still names it moves to Pi (see retireNativeRoles;
 * until #1338 a role whose pinned model profile needed text_json output went to Process). Nothing can save Native
 * afterwards: the role API refuses a backend that is not registered.
 */
export function retireNativeProjectRoles(s: Store, log: (line: string) => void = line => console.log(line)) {
  const marker = 'migration:1257:retire-native-roles';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  const counts = s.transaction(() => {
    const moved = retireNativeRoles(s);
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
    return moved;
  });
  if (counts.roles || counts.tasks || counts.instances)
    log(`[migration:1257] Native retired: ${counts.roles} roles in ${counts.projects} projects moved to Pi, ${counts.tasks} frozen task configurations, ${counts.instances} role instances`);
}

/**
 * The management assistant, group assistants, Manager and QA run only on Pi (#1337): the console offers no other backend
 * for them and the API refuses one. Once, at start-up, what a database saved for them on another backend moves to Pi:
 * - Service roles: `service_roles.harness` → `pi`, a new revision (as in #1255).
 * - Group bindings: `channel_service_bindings.harness` → `pi`; the revision stays, it is part of the group's fence.
 * - Manager and QA in saved and frozen role configurations and their role instances: see moveRolesToPi.
 */
export function pinAssistantsToPi(s: Store, log: (line: string) => void = line => console.log(line)) {
  const marker = 'migration:1337:assistants-on-pi';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  const counts = s.transaction(() => {
    const time = new Date().toISOString();
    const roles = s.hasTable('service_roles') ? s.all("SELECT id FROM service_roles WHERE harness<>'pi' ORDER BY id").map(row => String(row.id)) : [];
    for (const id of roles) {
      s.run("UPDATE service_roles SET harness='pi',revision=revision+1,updated_at=? WHERE id=?", time, id);
      s.audit('migration:1337', 'service_role.moved_to_pi', id);
    }
    const bindings = s.hasTable('channel_service_bindings') ? s.all("SELECT id FROM channel_service_bindings WHERE harness<>'pi' ORDER BY id").map(row => String(row.id)) : [];
    for (const id of bindings) {
      s.run("UPDATE channel_service_bindings SET harness='pi' WHERE id=?", id);
      s.audit('migration:1337', 'channel.service_binding.moved_to_pi', id);
    }
    // Every other registered backend; earlier migrations already moved the unregistered ones (Native, ACP).
    const others = harnesses.map(h => h.id).filter(id => id !== 'pi');
    const project = moveRolesToPi(s, 'migration:1337', others, (role, backend) => requiredRoles.includes(role) && backend !== 'pi');
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, time);
    return { serviceRoles: roles.length, bindings: bindings.length, ...project };
  });
  if (counts.serviceRoles || counts.bindings || counts.roles || counts.tasks || counts.instances)
    log(`[migration:1337] assistants on Pi: ${counts.serviceRoles} service roles, ${counts.bindings} group bindings, ${counts.roles} Manager/QA roles in ${counts.projects} projects, ${counts.tasks} frozen task configurations, ${counts.instances} role instances`
      + (counts.unusable ? `; ${counts.unusable} of those roles pin a model profile Pi cannot use and wait for configuration` : ''));
}

/**
 * The Process backend is gone (#1338). Once, at start-up, every role saved on it moves to Pi through moveRolesToPi: saved
 * configurations, frozen task configurations and role instances, so a waiting or reopened task continues on Pi. A pinned
 * model profile that answered in text_json, which only Process read, answers through tool calls (see onPi in
 * definition.ts). The role API refuses `process` afterwards as an unregistered backend.
 */
export function retireProcessRoles(s: Store, log: (line: string) => void = line => console.log(line)) {
  const marker = 'migration:1338:retire-process';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  const counts = s.transaction(() => {
    const moved = moveRolesToPi(s, 'migration:1338', ['process'], (_role, backend) => backend === 'process');
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
    return moved;
  });
  if (counts.roles || counts.tasks || counts.instances)
    log(`[migration:1338] Process retired: ${counts.roles} roles in ${counts.projects} projects, ${counts.tasks} frozen task configurations, ${counts.instances} role instances moved to Pi`
      + (counts.unusable ? `; ${counts.unusable} of those roles pin a model profile Pi cannot use and wait for configuration` : ''));
}
