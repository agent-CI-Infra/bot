import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import { fail } from '../core/security.js';
import { stop, TaskError } from '../agent/common.js';
import { selectedModel, visibleModel, openModel } from '../agent/model.js';
import { rolePool, systemInstructions, roleTemplate, requiredRoles, configuredRoles } from './pool.js';
import { roleKind, builtinKinds, environmentProfiles, budgetPolicies, outputSchemas, allowedFor, type RoleKind } from './catalog.js';
import { harnesses, runsInTaskCheckout } from './harness.js';
import { defaultPermissions, migratePermissions, normalizePermissions, githubReadScopes, validPermissionInput, updatePermissions, permissionSnapshot, permitsTool, type RolePermissions } from './permissions.js';
import { recommendedBackend, plannedBackend } from './backends.js';
import { earlierTemplates, earlierPermissions } from './earlier-defaults.js';
import { cachedRuleFiles, maxSkillFiles, skillFilePath, trustedCachedRuleFiles } from '../rules/service.js';
import { assertHarnessModelSourceImplemented, isHarnessModelSource, LOCAL_CONFIG_CAPABLE_HARNESSES, normalizeHarnessModelSource, type HarnessModelSource } from '../harness/subscription.js';
import {roleSkills} from './skill-defaults.js';

/**
 * RoleDefinitionV2: one project's versioned role configuration. Every reference names a fixed version: model profiles pin
 * the model's endpoint and name, skills pin a content-hashed bundle revision, harnesses, environment
 * profiles, budgets and output schemas pin the server catalog version. Credentials are never part of a definition; the
 * model reference names a stored model whose key stays sealed in the models table.
 *
 * The persona prompt is editable role guidance. Flat permissions filter tools supplied by the trusted task entry.
 */
export interface Ref { id: string; version: string }
export interface ModelProfileRef { model_id: string; name: string; profile_hash: string; version: number; api: string; tool_calls: boolean; structured_output: string }
export interface SkillBundleRef { id: string; revision: number; content_hash: string }
export interface RoleDefinitionV2 {
  role_id: string; revision: number; enabled: boolean; kind: RoleKind; name: string; responsibility: string; persona_prompt: string;
  model_profile_ref: ModelProfileRef | null; skill_bundle_ref: SkillBundleRef | null; harness_ref: Ref & { model_source?: HarnessModelSource }; permissions: RolePermissions;
  /** Server-owned opt-in: old V2 review/Actions dev assignments used the entry's Pi executor. */
  entry_harness_source?: 'role';
  environment_profile_ref: Ref; budget_policy_ref: Ref & { max_turns?: number; max_output_tokens?: number; command_timeout_seconds?: number; max_total_tokens?: number; max_model_requests?: number; max_tool_calls?: number; max_wall_seconds?: number }; output_schema_ref: Ref;
}
export type Entry = 'development' | 'request' | 'review' | 'actions';
export interface RoleConfiguration {
  // enabled/entries remain readable in historical task snapshots; current projects always use the Manager.
  // follows_default: the project has no configuration of its own and runs the current built-in defaults (#1068).
  schema: 2; revision: number; enabled: boolean; legacy?: boolean; follows_default?: boolean;
  controller: { role: string; entries: Record<Entry, boolean> };
  roles: RoleDefinitionV2[];
  deleted_roles?: string[];
  skills: (SkillBundleRef & { source: any; files: { path: string; sha256: string; bytes: number }[] })[];
  updated_at?: string; updated_by?: string;
}
const entries: Entry[] = ['development', 'request', 'review', 'actions'];
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const short = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 16);
const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;
// Validation errors name the configuration field, so the console and API can point at it.
const invalid = (code: string, field: string): never => fail(400, code, field);
const earlierManagerNames = new Set(['Project controller']);
const earlierManagerDuties = new Set([
  'Coordinates the project flow for one task: queries task facts, delegates bounded work, nominates a delivery for independent QA.',
]);
const builtinNames: Record<string, [string, string]> = {
  manager: ['Manager', 'Manages project event dispatch, coordinates multi-role task execution, and handles cross-task scheduling and dependencies.'],
  dev: ['Developer', 'Implements or investigates the task within the entry point\'s existing authority.'],
  test: ['Tester', 'Independently tests the fixed candidate.'], reviewer: ['Reviewer', 'Independently inspects the fixed candidate for actionable defects.'],
  ux: ['UX reviewer', 'Inspects user interactions, visible state and accessibility of the candidate.'], qa: ['Independent QA', 'Decides whether the exact candidate meets the task contract, in a fresh context.']
};
// Own properties only: a custom role may be called "constructor".
const names = (id: string): [string, string] => Object.hasOwn(builtinNames, id) ? builtinNames[id]! : [id, 'Project observer role: inspects the fixed candidate and reports findings.'];
const catalogRef = (list: { id: string; version: string }[], id: string) => { const entry = list.find(e => e.id === id)!; return { id: entry.id, version: entry.version }; };
function migrateEnvironmentRef(ref: any, kind: RoleKind): Ref {
  const fallback = allowedFor(kind).environment[0]!;
  if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') return catalogRef(environmentProfiles, fallback);
  if (ref.id === 'isolated-workspace' && kind === 'writer') return catalogRef(environmentProfiles, 'task-workspace');
  if (ref.id === 'isolated-candidate' && (kind === 'observer' || kind === 'evaluator')) return catalogRef(environmentProfiles, fallback);
  const entry = environmentProfiles.find(e => e.id === ref.id);
  return entry ? { id: entry.id, version: entry.version } : catalogRef(environmentProfiles, fallback);
}
const defaultHarness = () => recommendedBackend;
const harnessRef = (id: string) => ({ id, version: harnesses.find(h => h.id === id)?.version ?? 'unregistered' });
const definitionHash = ({ revision, ...rest }: RoleDefinitionV2) => short(rest);

/**
 * The recommended configuration (#1068), the only definition of it: what a project without a configuration of its own
 * runs, what the console shows for it and what "restore defaults" returns to. It is built from the current code each
 * time, so such a project follows built-in updates; a task keeps the copy it froze when it started. A role that has to
 * run on another backend says so here, never by whether the project saved a configuration.
 */
export function defaultRoles(): RoleDefinitionV2[] {
  return rolePool.map(({ id }) => {
    const kind = roleKind(id), [name, responsibility] = names(id);
    return { role_id: id, revision: 0, enabled: true, kind, name, responsibility, persona_prompt: roleTemplate(id), model_profile_ref: null, skill_bundle_ref: null,
      harness_ref: harnessRef(defaultHarness()), permissions: defaultPermissions(id, kind),
      // The review and Actions entries run the dev role's own backend, as a saved recommended configuration always did.
      ...(id === 'dev' ? { entry_harness_source: 'role' as const } : {}),
      environment_profile_ref: catalogRef(environmentProfiles, allowedFor(kind).environment[0]!), budget_policy_ref: catalogRef(budgetPolicies, 'entry-default'),
      output_schema_ref: catalogRef(outputSchemas, allowedFor(kind).output[0]!) };
  });
}
/** A stored "follow the defaults" record: a revision and who set it, no roles. Reading it expands the current defaults. */
const followsDefault = (value: any) => value?.schema === 2 && !Array.isArray(value.roles);
function defaultConfiguration(marker: { revision?: number; updated_at?: string; updated_by?: string }): RoleConfiguration {
  return { schema: 2, revision: Number(marker.revision ?? 0), enabled: true, follows_default: true, controller: { role: 'manager', entries: managerEntries() },
    roles: defaultRoles(), skills: [], ...(marker.updated_at ? { updated_at: marker.updated_at, updated_by: marker.updated_by } : {}) };
}

export function roleStorageV2(s: Store) {
  s.db.exec(`
  CREATE TABLE IF NOT EXISTS role_config_revisions(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,config TEXT NOT NULL,hash TEXT NOT NULL,actor TEXT,created_at TEXT NOT NULL,PRIMARY KEY(repository_id,revision));
  CREATE TABLE IF NOT EXISTS skill_bundle_revisions(repository_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,files TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(repository_id,id,revision));
  CREATE TABLE IF NOT EXISTS role_snapshots(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,role TEXT NOT NULL,config_revision INTEGER NOT NULL,role_revision INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
  resetBuiltinRolePermissions(s);
  actionsWriteFollowsIssues(s);
  // After #381 and #1072 have brought saved permissions to the defaults it compares with.
  followBuiltinDefaults(s);
  retireAcpRoleBindings(s);
  retireAcpTaskExecutionConfigs(s);
  retireIsolatedEnvironmentProfiles(s);
}

const canonical = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1)));
/**
 * Whether a stored configuration is a built-in default nobody changed (#1068): the recommended configuration as it was
 * when the project adopted it, or as migrations later rewrote it. Read in its current form, it has exactly the built-in
 * roles, no skills or required stages, and every role is enabled, keeps its built-in name, duty, environment, output and
 * unlimited entry budget, has no model or skill of its own, runs the recommended backend through the gateway, and has
 * the role's current or an earlier built-in prompt and permissions (earlier-defaults.ts). A legacy configuration from
 * before RoleDefinitionV2 counts when it chose no backend and added no role or instructions. Everything else is a
 * customisation.
 */
export function unmodifiedConfiguration(s: Store, repositoryId: string, stored: any, earlier = { templates: earlierTemplates, permissions: earlierPermissions }): boolean {
  if (followsDefault(stored)) return true;
  if (stored?.schema !== 2) return !!stored && typeof stored === 'object' && !Object.keys(stored.harnesses ?? {}).length
    && (stored.roles ?? []).every((role: any) => !role?.prompt && rolePool.some(entry => entry.id === role?.id));
  if (!Array.isArray(stored.roles) || (stored.skills ?? []).length || (stored.required_stages ?? []).length || (stored.controller?.role ?? 'manager') !== 'manager') return false;
  const current = roleConfiguration(s, repositoryId, stored).roles, builtin = defaultRoles();
  if (current.length !== builtin.length) return false;
  return builtin.every(want => {
    const role = current.find(entry => entry.role_id === want.role_id);
    const matchesName = role && (role.name === want.name || (want.role_id === 'manager' && earlierManagerNames.has(role.name)));
    const matchesDuty = role && (role.responsibility === want.responsibility || (want.role_id === 'manager' && earlierManagerDuties.has(role.responsibility)));
    if (!role || !role.enabled || !matchesName || !matchesDuty || role.model_profile_ref || role.skill_bundle_ref) return false;
    if (role.harness_ref?.id !== want.harness_ref.id || (role.harness_ref.model_source ?? 'gateway') !== 'gateway') return false;
    if (role.environment_profile_ref?.id !== want.environment_profile_ref.id || role.output_schema_ref?.id !== want.output_schema_ref.id) return false;
    if (role.budget_policy_ref?.id !== want.budget_policy_ref.id || Object.keys(role.budget_policy_ref).some(key => !['id', 'version'].includes(key))) return false;
    const permissions = canonical(normalizePermissions(role.permissions));
    if (![{}, ...(earlier.permissions[want.role_id] ?? [])].some(change => canonical(normalizePermissions({ ...want.permissions, ...change })) === permissions)) return false;
    return role.persona_prompt === want.persona_prompt || (earlier.templates[want.role_id] ?? []).includes(sha256(role.persona_prompt).slice(0, 16));
  });
}

/**
 * Turns one project to the built-in defaults under a new revision; earlier revisions and their audit rows stay. A stored
 * configuration without a revision row of its own (one from before RoleDefinitionV2, revision 0) is kept as the next
 * revision first, in the form it is read in, so it stays readable through `?revision=` once the defaults replace it.
 */
function storeFollowDefault(s: Store, repositoryId: string, stored: any, revision: number, actor: string) {
  const now = new Date().toISOString(), insert = 'INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING';
  if (!s.get('SELECT 1 FROM role_config_revisions WHERE repository_id=? AND revision=?', repositoryId, revision)) {
    const { updated_at, updated_by, ...kept } = { ...roleConfiguration(s, repositoryId, stored), revision: ++revision };
    s.run(insert, repositoryId, revision, JSON.stringify({ ...kept, updated_at: now, updated_by: actor }), short(kept), actor, now);
  }
  const marker = { schema: 2 as const, revision: revision + 1, follows_default: true }, saved = { ...marker, updated_at: now, updated_by: actor };
  s.run(insert, repositoryId, marker.revision, JSON.stringify(saved), short(marker), actor, now);
  s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles:' + repositoryId, JSON.stringify(saved));
  return saved;
}

/**
 * One-time migration (#1068): a project that saved the recommended configuration and never changed it froze that day's
 * defaults. It now follows the built-in defaults like a project that never saved, under a new revision by
 * 'migration:1068'. Customised projects stay as they are; running tasks keep the configuration they froze.
 */
export function followBuiltinDefaults(s: Store, earlier?: Parameters<typeof unmodifiedConfiguration>[3]) {
  const marker = 'migration:1068:follow-builtin-defaults';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  s.transaction(() => {
    for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%'")) {
      let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
      const repositoryId = String(row.key).slice('roles:'.length);
      if (followsDefault(stored) || !unmodifiedConfiguration(s, repositoryId, stored, earlier)) continue;
      const saved = storeFollowDefault(s, repositoryId, stored, Number(stored.schema === 2 ? stored.revision : 0), 'migration:1068');
      s.audit('migration:1068', 'roles.follow_default', String(saved.revision), repositoryId);
    }
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
  });
}

/**
 * One-time migration (#705): ACP is retired; any saved V2 role configuration still bound to `acp` moves to the
 * recommended built-in backend (`pi`) under a new configuration revision, preserving historical revisions and snapshots.
 */
export function retireAcpRoleBindings(s: Store) {
  const marker = 'migration:705:retire-acp-backend';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  const fallback = harnessRef(recommendedBackend);
  s.transaction(() => {
    for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%'")) {
      let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
      if (stored?.schema !== 2 || !Array.isArray(stored.roles)) continue;
      const repositoryId = String(row.key).slice('roles:'.length), current = roleConfiguration(s, repositoryId, stored);
      let changed = false;
      const roles = current.roles.map(role => {
        if (role.harness_ref?.id !== 'acp') return role;
        changed = true;
        return { ...role, harness_ref: fallback, revision: role.revision + 1 };
      });
      if (!changed) continue;
      const now = new Date().toISOString(), { updated_at, updated_by, ...config } = { ...current, roles, revision: current.revision + 1 };
      const saved = { ...config, updated_at: now, updated_by: 'migration:705' };
      s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), 'migration:705', now);
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    }
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
  });
  retireAcpTaskExecutionConfigs(s);
}

/**
 * One-time migration (#705): tasks created before ACP retirement froze `roles` inside `task_execution_configs` (and legacy
 * `settings` / `role_instances` may also name `acp`). Re-saving the project role page does not rewrite frozen task snapshots,
 * so migrate frozen `acp` role bindings to `pi` so in-flight/waiting tasks can resume without `unknown_role_harness`.
 */
export function retireAcpTaskExecutionConfigs(s: Store) {
  const marker = 'migration:705:retire-acp-task-configs';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  if (!s.hasTable('task_execution_configs')) return;
  const fallback = harnessRef(recommendedBackend);
  s.transaction(() => {
    for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%' AND value LIKE '%acp%'")) {
      let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
      if (stored?.schema === 2 || !stored?.harnesses || typeof stored.harnesses !== 'object') continue;
      let changed = false;
      const harnessesMap = { ...stored.harnesses };
      for (const [roleId, h] of Object.entries(harnessesMap)) {
        if (h === 'acp') { harnessesMap[roleId] = recommendedBackend; changed = true; }
      }
      if (changed) s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify({ ...stored, harnesses: harnessesMap }), row.key);
    }

    for (const row of s.all("SELECT c.task_id,c.snapshot,t.repository_id FROM task_execution_configs c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.snapshot LIKE '%acp%'")) {
      let snap: any; try { snap = JSON.parse(String(row.snapshot)); } catch { continue; }
      if (!snap || typeof snap !== 'object' || !snap.roles || typeof snap.roles !== 'object') continue;
      let changed = false;
      if (snap.roles.schema === 2 && Array.isArray(snap.roles.roles)) {
        const roles = snap.roles.roles.map((role: any) => {
          if (role?.harness_ref?.id !== 'acp') return role;
          changed = true;
          return { ...role, harness_ref: fallback, revision: Number(role.revision ?? 0) + 1 };
        });
        if (changed) {
          const latestRev = row.repository_id ? roleConfiguration(s, String(row.repository_id)).revision : 0;
          snap = {
            ...snap,
            roles: {
              ...snap.roles,
              roles,
              revision: Math.max(Number(snap.roles.revision ?? 0) + 1, latestRev),
            },
          };
        }
      } else if (snap.roles.harnesses && typeof snap.roles.harnesses === 'object') {
        const harnessesMap = { ...snap.roles.harnesses };
        for (const [roleId, h] of Object.entries(harnessesMap)) {
          if (h === 'acp') { harnessesMap[roleId] = recommendedBackend; changed = true; }
        }
        if (changed) snap = { ...snap, roles: { ...snap.roles, harnesses: harnessesMap } };
      }
      if (changed) s.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify(snap), row.task_id);
    }

    if (s.hasTable('role_instances')) {
      s.run("UPDATE role_instances SET harness=?,session='[]',harness_state='{}' WHERE harness='acp'", recommendedBackend);
    }

    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
  });
}

/**
 * The project role part of the one-time Native→Pi migration (#1255, run once by src/roles/native-to-pi.ts inside its
 * transaction). A saved V2 configuration's Native roles move to Pi under a new configuration revision, keeping earlier
 * revisions and frozen task snapshots; a role whose pinned model profile Pi cannot use (text_json structured output) stays
 * on Native. A legacy configuration's `harnesses` entries naming Native become Pi; the roles it does not name already run Pi
 * (src/roles/pool.ts). Configurations that follow the defaults already run Pi.
 */
export function moveNativeRolesToPi(s: Store): { projects: number; roles: number; kept: number } {
  const pi = harnesses.find(h => h.id === 'pi')!, ref = harnessRef('pi'), counts = { projects: 0, roles: 0, kept: 0 };
  for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%'")) {
    let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
    if (!stored || typeof stored !== 'object' || followsDefault(stored)) continue;
    const repositoryId = String(row.key).slice('roles:'.length);
    if (stored.schema !== 2) {
      // What ran Native before #1255: a role named Native, or one left out of the map.
      const ids = [...rolePool.map(role => role.id), ...(stored.roles ?? []).map((role: any) => role?.id)].filter((id, at, all) => typeof id === 'string' && id !== 'coordinator' && all.indexOf(id) === at);
      const named = stored.harnesses && typeof stored.harnesses === 'object' ? stored.harnesses : {};
      const moved = ids.filter(id => (Object.hasOwn(named, id) ? named[id] : 'native') === 'native').length;
      if (!moved) continue;
      const map = Object.fromEntries(Object.entries(named).map(([id, harness]) => [id, harness === 'native' ? 'pi' : harness]));
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify({ ...stored, harnesses: map }), row.key);
      counts.projects++; counts.roles += moved;
      s.audit('migration:1255', 'roles.native_to_pi', '0', repositoryId);
      continue;
    }
    if (!Array.isArray(stored.roles)) continue;
    const current = roleConfiguration(s, repositoryId, stored);
    let moved = 0;
    const roles = current.roles.map(role => {
      if (role.harness_ref?.id !== 'native') return role;
      const output = role.model_profile_ref?.structured_output;
      if (output && !pi.structured_output.includes(output)) { counts.kept++; return role; }
      moved++;
      return { ...role, harness_ref: ref, revision: role.revision + 1 };
    });
    if (!moved) continue;
    const now = new Date().toISOString(), { updated_at, updated_by, ...config } = { ...current, roles, revision: current.revision + 1 };
    const saved = { ...config, updated_at: now, updated_by: 'migration:1255' };
    s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), 'migration:1255', now);
    s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    counts.projects++; counts.roles += moved;
    s.audit('migration:1255', 'roles.native_to_pi', String(saved.revision), repositoryId);
  }
  return counts;
}

/**
 * A role moved to Pi by a start-up migration (#1257, #1337, #1338), under its next role revision. Its pinned model stays; a
 * profile that answered in text_json, which only the removed Process driver read, now answers through tool calls like every
 * remaining backend (#1338).
 */
const onPi = (role: any) => ({ ...role, harness_ref: harnessRef('pi'), revision: Number(role.revision ?? 0) + 1,
  ...(role?.model_profile_ref?.structured_output === 'text_json' ? { model_profile_ref: { ...role.model_profile_ref, structured_output: 'tool_call' } } : {}) });

/**
 * The project role part of retiring Native (#1257, run once by src/roles/native-to-pi.ts inside its transaction), for what
 * #1255 left: roles chosen as Native by hand since, roles kept on Native because their pinned model profile answers in
 * text_json, frozen task configurations and role instances. Every such role moves to Pi (see onPi; Process, which these
 * text_json roles went to before, is gone since #1338).
 * - Saved configurations: V2 roles under a new configuration revision (`updated_by: migration:1257`), legacy `harnesses`
 *   entries in place.
 * - Frozen `task_execution_configs` snapshots, as #705 did for ACP, so a waiting or reopened task resumes instead of
 *   stopping at `unknown_role_harness`.
 * - `role_instances` move to Pi; session and harness state are cleared, so the next run rebuilds from task records.
 */
export function retireNativeRoles(s: Store): { projects: number; roles: number; tasks: number; instances: number } {
  const counts = { projects: 0, roles: 0, tasks: 0, instances: 0 };
  // A V2 role list with its Native roles moved; null when none was Native.
  const moveRoles = (roles: any[]) => roles.some(role => role?.harness_ref?.id === 'native') ? roles.map(role => role?.harness_ref?.id === 'native' ? onPi(role) : role) : null;
  const moveMap = (map: Record<string, unknown>) => Object.values(map).includes('native') ? Object.fromEntries(Object.entries(map).map(([id, harness]) => [id, harness === 'native' ? 'pi' : harness])) : null;

  for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%' AND value LIKE '%native%'")) {
    let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
    if (!stored || typeof stored !== 'object' || followsDefault(stored)) continue;
    const repositoryId = String(row.key).slice('roles:'.length);
    if (stored.schema !== 2) {
      const map = stored.harnesses && typeof stored.harnesses === 'object' ? moveMap(stored.harnesses) : null;
      if (!map) continue;
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify({ ...stored, harnesses: map }), row.key);
      counts.projects++; counts.roles += Object.values(stored.harnesses).filter(harness => harness === 'native').length;
      s.audit('migration:1257', 'roles.native_retired', '0', repositoryId);
      continue;
    }
    if (!Array.isArray(stored.roles)) continue;
    const current = roleConfiguration(s, repositoryId, stored), roles = moveRoles(current.roles);
    if (!roles) continue;
    const now = new Date().toISOString(), { updated_at, updated_by, ...config } = { ...current, roles, revision: current.revision + 1 };
    const saved = { ...config, updated_at: now, updated_by: 'migration:1257' };
    s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), 'migration:1257', now);
    s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    counts.projects++; counts.roles += current.roles.filter(role => role.harness_ref?.id === 'native').length;
    s.audit('migration:1257', 'roles.native_retired', String(saved.revision), repositoryId);
  }

  if (s.hasTable('task_execution_configs')) for (const row of s.all("SELECT c.task_id,c.snapshot,t.repository_id FROM task_execution_configs c LEFT JOIN tasks t ON t.id=c.task_id WHERE c.snapshot LIKE '%native%'")) {
    let snap: any; try { snap = JSON.parse(String(row.snapshot)); } catch { continue; }
    if (!snap?.roles || typeof snap.roles !== 'object') continue;
    let roles: any = null;
    if (snap.roles.schema === 2 && Array.isArray(snap.roles.roles)) {
      const moved = moveRoles(snap.roles.roles);
      // As #705 did: a revision past both the frozen one and the project's current one.
      if (moved) roles = { ...snap.roles, roles: moved, revision: Math.max(Number(snap.roles.revision ?? 0) + 1, row.repository_id ? roleConfiguration(s, String(row.repository_id)).revision : 0) };
    } else if (snap.roles.harnesses && typeof snap.roles.harnesses === 'object') {
      const map = moveMap(snap.roles.harnesses);
      if (map) roles = { ...snap.roles, harnesses: map };
    }
    if (!roles) continue;
    s.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify({ ...snap, roles }), row.task_id);
    counts.tasks++;
  }

  if (s.hasTable('role_instances')) counts.instances = Number(s.run("UPDATE role_instances SET harness='pi',session='[]',harness_state='{}' WHERE harness='native'").changes);
  return counts;
}

/**
 * Moves the project roles `moves(role, backend)` selects to Pi, for a one-time start-up migration that runs inside the
 * caller's transaction (#1337). `from` lists the backend ids it may select, so only rows naming one of them are read.
 * - Saved configurations: V2 roles under a new configuration revision (`updated_by: actor`), legacy `harnesses` entries in
 *   place (a legacy role it does not name already runs Pi).
 * - Frozen `task_execution_configs` snapshots, as #705 and #1257 did, so a waiting or reopened task resumes on Pi instead of
 *   stopping at the backend check.
 * - `role_instances` on a selected backend: session and harness state are cleared, so the next run rebuilds from task records.
 * A moved role keeps its pinned model (see onPi); `unusable` counts those whose profile Pi still cannot use (another model
 * API), which wait for configuration rather than switching models.
 */
export function moveRolesToPi(s: Store, actor: string, from: string[], moves: (role: string, backend: string) => boolean) {
  const pi = harnesses.find(h => h.id === 'pi')!, counts = { projects: 0, roles: 0, unusable: 0, tasks: 0, instances: 0 };
  const named = (column: string) => '(' + from.map(() => `${column} LIKE ?`).join(' OR ') + ')', patterns = from.map(id => `%"${id}"%`);
  const usable = (role: any) => { const p = role?.model_profile_ref; return !p || pi.model_api.includes(p.api) && pi.structured_output.includes(p.structured_output); };
  // A V2 role list with the selected roles moved, or null when none is selected.
  const moveRoles = (roles: any[], counted: boolean) => {
    let moved = 0;
    const next = roles.map(role => {
      if (!moves(String(role?.role_id), String(role?.harness_ref?.id))) return role;
      const onto = onPi(role);
      moved++; if (counted && !usable(onto)) counts.unusable++;
      return onto;
    });
    if (counted) counts.roles += moved;
    return moved ? next : null;
  };
  const moveMap = (map: Record<string, unknown>) => Object.entries(map).some(([id, harness]) => moves(id, String(harness)))
    ? Object.fromEntries(Object.entries(map).map(([id, harness]) => [id, moves(id, String(harness)) ? 'pi' : harness])) : null;

  for (const row of s.all(`SELECT key,value FROM settings WHERE key LIKE 'roles:%' AND ${named('value')}`, ...patterns)) {
    let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
    if (!stored || typeof stored !== 'object' || followsDefault(stored)) continue;
    const repositoryId = String(row.key).slice('roles:'.length);
    if (stored.schema !== 2) {
      const map = stored.harnesses && typeof stored.harnesses === 'object' ? moveMap(stored.harnesses) : null;
      if (!map) continue;
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify({ ...stored, harnesses: map }), row.key);
      counts.projects++; counts.roles += Object.entries(stored.harnesses).filter(([id, harness]) => moves(id, String(harness))).length;
      s.audit(actor, 'roles.moved_to_pi', '0', repositoryId);
      continue;
    }
    if (!Array.isArray(stored.roles)) continue;
    const current = roleConfiguration(s, repositoryId, stored), roles = moveRoles(current.roles, true);
    if (!roles) continue;
    const now = new Date().toISOString(), { updated_at, updated_by, ...config } = { ...current, roles, revision: current.revision + 1 };
    const saved = { ...config, updated_at: now, updated_by: actor };
    s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), actor, now);
    s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    counts.projects++;
    s.audit(actor, 'roles.moved_to_pi', String(saved.revision), repositoryId);
  }

  if (s.hasTable('task_execution_configs')) for (const row of s.all(`SELECT c.task_id,c.snapshot,t.repository_id FROM task_execution_configs c LEFT JOIN tasks t ON t.id=c.task_id WHERE ${named('c.snapshot')}`, ...patterns)) {
    let snap: any; try { snap = JSON.parse(String(row.snapshot)); } catch { continue; }
    if (!snap?.roles || typeof snap.roles !== 'object') continue;
    let roles: any = null;
    if (snap.roles.schema === 2 && Array.isArray(snap.roles.roles)) {
      const moved = moveRoles(snap.roles.roles, false);
      // As #705 did: a revision past both the frozen one and the project's current one, so role instances pinned to a
      // later revision still read this snapshot.
      if (moved) roles = { ...snap.roles, roles: moved, revision: Math.max(Number(snap.roles.revision ?? 0) + 1, row.repository_id ? roleConfiguration(s, String(row.repository_id)).revision : 0) };
    } else if (snap.roles.harnesses && typeof snap.roles.harnesses === 'object') {
      const map = moveMap(snap.roles.harnesses);
      if (map) roles = { ...snap.roles, harnesses: map };
    }
    if (!roles) continue;
    s.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify({ ...snap, roles }), row.task_id);
    counts.tasks++;
  }

  if (s.hasTable('role_instances')) for (const row of s.all(`SELECT id,role,harness FROM role_instances WHERE harness IN (${from.map(() => '?').join(',')})`, ...from)) {
    if (!moves(String(row.role), String(row.harness))) continue;
    s.run("UPDATE role_instances SET harness='pi',session='[]',harness_state='{}' WHERE id=?", row.id);
    counts.instances++;
  }
  return counts;
}

/**
 * One-time migration (#1121): per-run isolated container profiles (`isolated-workspace`, `isolated-candidate`) are retired;
 * saved project configurations and frozen `task_execution_configs` downgrade safely to shared project-computer profiles.
 */
export function retireIsolatedEnvironmentProfiles(s: Store) {
  const marker = 'migration:1121:retire-isolated-profiles';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  if (!s.hasTable('task_execution_configs')) return;
  const retired = new Set(['isolated-workspace', 'isolated-candidate']);
  s.transaction(() => {
    for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%' AND value LIKE '%isolated-%'")) {
      let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
      if (stored?.schema !== 2 || !Array.isArray(stored.roles)) continue;
      if (!stored.roles.some((r: any) => retired.has(r?.environment_profile_ref?.id))) continue;
      const repositoryId = String(row.key).slice('roles:'.length), current = roleConfiguration(s, repositoryId, stored);
      const storedById = new Map(stored.roles.map((role: any) => [role?.role_id, role]));
      const now = new Date().toISOString(), { updated_at, updated_by, ...config } = {
        ...current,
        roles: current.roles.map((r: RoleDefinitionV2) => retired.has((storedById.get(r.role_id) as any)?.environment_profile_ref?.id) ? { ...r, revision: r.revision + 1 } : r),
        revision: current.revision + 1,
      };
      const saved = { ...config, updated_at: now, updated_by: 'migration:1121' };
      s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), 'migration:1121', now);
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    }
    if (s.hasTable('task_execution_configs')) {
      for (const row of s.all("SELECT task_id,snapshot FROM task_execution_configs WHERE snapshot LIKE '%isolated-%'")) {
        let snap: any; try { snap = JSON.parse(String(row.snapshot)); } catch { continue; }
        if (snap?.roles?.schema !== 2 || !Array.isArray(snap.roles.roles)) continue;
        let changed = false;
        const roles = snap.roles.roles.map((role: any) => {
          if (!retired.has(role?.environment_profile_ref?.id)) return role;
          changed = true;
          const kind: RoleKind = role.kind ?? roleKind(String(role.role_id ?? ''));
          return { ...role, environment_profile_ref: migrateEnvironmentRef(role.environment_profile_ref, kind), revision: Number(role.revision ?? 0) + 1 };
        });
        if (changed) s.run('UPDATE task_execution_configs SET snapshot=? WHERE task_id=?', JSON.stringify({ ...snap, roles: { ...snap.roles, roles, revision: Number(snap.roles.revision ?? 0) + 1 } }), row.task_id);
      }
    }
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
  });
}

/**
 * One-time reset (#381): saved built-in roles take the new default permissions (only the Manager writes to GitHub; every
 * other role reads). Model, harness, prompt and other settings stay; custom roles keep their permissions. Each changed
 * project gets a new configuration revision by 'migration:381', so running role runs keep the snapshot they started with.
 */
export function resetBuiltinRolePermissions(s: Store) {
  const marker = 'migration:381:builtin-role-permissions';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  s.transaction(() => {
    for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%'")) {
      let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
      if (stored?.schema !== 2 || !Array.isArray(stored.roles)) continue;
      const repositoryId = String(row.key).slice('roles:'.length), current = roleConfiguration(s, repositoryId, stored);
      let changed = false;
      const roles = current.roles.map(role => {
        if (!Object.hasOwn(builtinKinds, role.role_id)) return role;
        const permissions = defaultPermissions(role.role_id, role.kind);
        if (JSON.stringify(role.permissions) === JSON.stringify(permissions)) return role;
        changed = true; return { ...role, permissions, revision: role.revision + 1 };
      });
      if (!changed) continue;
      const now = new Date().toISOString(), { updated_at, updated_by, ...config } = { ...current, roles, revision: current.revision + 1 };
      const saved = { ...config, updated_at: now, updated_by: 'migration:381' };
      s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), 'migration:381', now);
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    }
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
  });
}

/**
 * One-time upgrade (#1072): Actions got a write mode (starting workflows). Saved roles never chose it, so each role that
 * writes Issues and reads Actions takes Actions write, like the new defaults; a role that cannot read Actions, or whose
 * Actions items are custom, keeps them. The project capability ceiling still bounds every write. Like migration:381, each
 * changed project gets a new configuration revision, so running role runs keep the snapshot they started with.
 */
export function actionsWriteFollowsIssues(s: Store) {
  const marker = 'migration:1072:actions-write';
  if (s.get('SELECT 1 FROM settings WHERE key=?', marker)) return;
  s.transaction(() => {
    for (const row of s.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%'")) {
      let stored: any; try { stored = JSON.parse(String(row.value)); } catch { continue; }
      if (stored?.schema !== 2 || !Array.isArray(stored.roles)) continue;
      const repositoryId = String(row.key).slice('roles:'.length), current = roleConfiguration(s, repositoryId, stored);
      let changed = false;
      const roles = current.roles.map(role => {
        if (role.permissions.github_issues !== 'write' || role.permissions.github_actions !== 'read') return role;
        changed = true; return { ...role, permissions: { ...role.permissions, github_actions: 'write' as const }, revision: role.revision + 1 };
      });
      if (!changed) continue;
      const now = new Date().toISOString(), { updated_at, updated_by, ...config } = { ...current, roles, revision: current.revision + 1 };
      const saved = { ...config, updated_at: now, updated_by: 'migration:1072' };
      s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING', repositoryId, saved.revision, JSON.stringify(saved), short(config), 'migration:1072', now);
      s.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
    }
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', marker, new Date().toISOString());
  });
}

/**
 * The project's role configuration. Without one of its own (no row, or a "follow the defaults" record) it is the current
 * recommended configuration. An explicit stored value is a saved, historical or task configuration, kept intact.
 */
export function roleConfiguration(s: Store, repositoryId: string, stored?: any): RoleConfiguration {
  if (stored === undefined) {
    const saved = s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repositoryId);
    const config = roleConfiguration(s, repositoryId, saved ? JSON.parse(saved.value) : { schema: 2, revision: 0 });
    // Resolve the retired switches without rewriting revisions, permissions, event filters or frozen task snapshots.
    return { ...config, enabled: true, controller: { ...config.controller, entries: managerEntries() } };
  }
  const value = stored;
  if (followsDefault(value)) return defaultConfiguration(value);
  if (value.schema === 2) {
    // Filter out the retired Task Coordinator role (#1218) so legacy saved configs load and re-save cleanly while
    // historical role_config_revisions and task snapshots stay intact for audit.
    const roles = value.roles
      .filter((role: any) => role?.role_id !== 'coordinator')
      .map((role: any) => {
        const { capability_policy_ref, ...definition } = role;
        const kind: RoleKind = definition.kind ?? roleKind(String(definition.role_id ?? ''));
        const budgetEntry = budgetPolicies.find(b => b.id === definition.budget_policy_ref?.id);
        const outputEntry = outputSchemas.find(o => o.id === definition.output_schema_ref?.id);
        const outputRef = outputEntry ? { id: outputEntry.id, version: outputEntry.version } : catalogRef(outputSchemas, allowedFor(kind).output[0]!);
        const normalizedHarnessRef = definition.harness_ref && typeof definition.harness_ref === 'object'
          ? (() => {
              const ms = normalizeHarnessModelSource(definition.harness_ref.model_source);
              return ms === 'local_config'
                ? { ...definition.harness_ref, model_source: 'local_config' as const }
                : (() => { const { model_source: _ms, ...rest } = definition.harness_ref; return rest; })();
            })()
          : definition.harness_ref;
        return { ...definition, harness_ref: normalizedHarnessRef, kind, environment_profile_ref: migrateEnvironmentRef(definition.environment_profile_ref, kind), ...(budgetEntry ? { budget_policy_ref: { ...definition.budget_policy_ref, version: budgetEntry.version } } : {}), output_schema_ref: outputRef, permissions: migratePermissions(role), persona_prompt: role.permissions ? retireLegacyRoleGuidance(role.persona_prompt) : roleTemplate(role.role_id) + (role.persona_prompt ? '\nProject instructions:\n' + role.persona_prompt : '') };
      });
    // Stored roles are fixed, even in a copy of the defaults (a task's frozen configuration, or one saved as read): only a
    // record without roles follows the defaults.
    const { follows_default, required_stages: _retiredStages, deleted_roles: rawDeletedRoles, ...fixed } = value;
    const deletedRoles = Array.isArray(rawDeletedRoles) ? rawDeletedRoles.filter((id: unknown) => id !== 'coordinator') : undefined;
    return { ...fixed, ...(deletedRoles?.length ? { deleted_roles: deletedRoles } : {}), roles, skills: value.skills.map((bundle: any) => ({ ...bundle, source: skillSourceDescriptor(bundle.source, bundle) })) };
  }
  // Legacy: built-in prompts with appended project instructions and the per-role driver map (an unnamed role runs Pi).
  const legacy = configuredRoles(value).filter(r => r.id !== 'coordinator');
  return { schema: 2, revision: 0, enabled: !!value.enabled, legacy: true, controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } }, skills: [],
    roles: legacy.map(r => { const kind = roleKind(r.id), [name, responsibility] = names(r.id);
      const custom = (value.roles ?? []).find((c: any) => c.id === r.id);
      return { role_id: r.id, revision: 0, enabled: true, kind, name, responsibility, persona_prompt: roleTemplate(r.id) + (custom?.prompt ? '\nProject instructions:\n' + custom.prompt : ''), model_profile_ref: null, skill_bundle_ref: null,
        harness_ref: harnessRef(r.harness), permissions: defaultPermissions(r.id, kind), environment_profile_ref: catalogRef(environmentProfiles, allowedFor(kind).environment[0]!),
        budget_policy_ref: catalogRef(budgetPolicies, 'entry-default'), output_schema_ref: catalogRef(outputSchemas, allowedFor(kind).output[0]!) }; }) };
}
export const entryEnabled = (config: RoleConfiguration, entry: Entry) => config.enabled && config.controller.entries[entry] === true;
const managerEntries = (): Record<Entry, boolean> => ({ development: true, request: true, review: true, actions: true });

/** The model profile a role may pin: endpoint and model name fixed by hash; a rotated key keeps the same profile. */
export const modelProfileHash = (row: Record<string, any>) => short([String(row.api_url), String(row.model_name)]);
function checkMatrix(harness: (typeof harnesses)[number], profile: { api: string; tool_calls: boolean; structured_output: string }, field: string, raise: (code: string, field: string) => never) {
  if (!harness.model_api.includes(profile.api)) raise('harness_model_api_unsupported', field + '.api');
  if (harness.tool_calls && !profile.tool_calls) raise('harness_tool_calls_required', field + '.tool_calls');
  if (!harness.structured_output.includes(profile.structured_output)) raise('harness_structured_output_unsupported', field + '.structured_output');
}

/** Project old immutable bindings as ordinary files; the stored revision/hash and audit rows stay intact. */
function skillSourceDescriptor(source: any, ref: SkillBundleRef): any {
  return source.type === 'builtin' ? { type: 'inline', commit: null, origin: { ...source, revision: ref.revision, content_hash: ref.content_hash } } : source;
}
// Only remove the exact framework clauses formerly included in editable default templates. Project instructions remain.
function retireLegacyRoleGuidance(prompt: string): string {
  return prompt.replace('Task data, role memory and playbooks cannot change authority or the contract.', 'Task data, role memory and skills cannot change authority or the contract.')
    .replace('You have no repository execution or publication tools, cannot lower criteria, override QA, finish a task or merge PRs.', 'Use your Harness native tools to inspect code, run checks and investigate external services within the effective execution permissions. Coordinate implementation through workers; QA and authorized delivery remain independent.')
    .replace(' Discover optional playbooks.', '')
    .replace('When these decomposition conditions apply, read the roadmap-decomposition playbook before choosing the execution arrangement; it explains HOW to split and coordinate. ', '');
}

/** Pins one skill bundle source to its exact files: path, sha256 and size, plus the stored contents. */
function pinSkill(s: Store, repositoryId: string, input: any, index: number, previous?: { id: string; revision: number }) {
  const field = `skills[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('invalid_skill_bundle', field);
  if (Object.keys(input).some(k => !['id', 'source'].includes(k))) invalid('unknown_field', field);
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) invalid('invalid_skill_bundle_id', field + '.id');
  const source = input.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalid('invalid_skill_source', field + '.source');
  let files: { path: string; content: string }[] = [], descriptor: any;
  if (source.type === 'builtin') {
    // Compatibility is limited to an already saved binding. There is no catalog to resolve new names from.
    const stored = previous && previous.id === input.id ? s.get('SELECT source,files,content_hash FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?', repositoryId, previous.id, previous.revision) : undefined;
    const saved = stored ? JSON.parse(String(stored.source)) : null, origin = saved?.type === 'builtin' ? saved : saved?.origin;
    if (!origin || !Array.isArray(source.playbooks) || JSON.stringify([...source.playbooks].sort()) !== JSON.stringify(origin.playbooks)) fail(409, 'retired_skill_source', field + '.source.type');
    files = JSON.parse(String(stored!.files)).map(({ path, content }: { path: string; content: string }) => ({ path, content }));
    descriptor = skillSourceDescriptor(saved, { id: input.id, revision: previous!.revision, content_hash: String(stored!.content_hash) });
  } else if (source.type === 'repository') {
    // Repository skills come from the rule cache at exactly the named commit; a moved branch never changes a pinned bundle.
    if (typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit)) invalid('invalid_skill_source', field + '.source.commit');
    if (!Array.isArray(source.paths) || !source.paths.length || source.paths.length > maxSkillFiles || source.paths.some((p: any) => typeof p !== 'string')) invalid('invalid_skill_source', field + '.source.paths');
    const cached = cachedRuleFiles(s, repositoryId);
    if (!cached || cached.sha !== source.commit) {
      // Re-saving an unchanged pinned source must not follow a moving rule cache. Only this configuration's exact
      // existing bundle may supply those old files; a new id, path or commit still requires the matching cache.
      const stored = previous && previous.id === input.id ? s.get('SELECT source,files FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?', repositoryId, previous.id, previous.revision) : undefined;
      const saved = stored ? JSON.parse(String(stored.source)) : null;
      if (!saved || saved.type !== 'repository' || saved.commit !== source.commit || JSON.stringify([...saved.paths].sort()) !== JSON.stringify([...source.paths].sort())) fail(409, 'skill_source_commit_unavailable', field + '.source.commit');
      files = JSON.parse(String(stored!.files)).map((file: { path: string; content: string }) => ({ path: file.path, content: file.content }));
    } else {
      const available = cached.files;
      for (const path of source.paths) { if (!skillFilePath(path) || !Object.hasOwn(available, path)) invalid('skill_file_not_found', field + '.source.paths'); files.push({ path, content: available[path]! }); }
    }
    descriptor = { type: 'repository', path_root: '.agents/skills', commit: source.commit, paths: [...source.paths].sort() };
  } else if (source.type === 'inline') {
    if (!Array.isArray(source.files) || !source.files.length || source.files.length > 16) invalid('invalid_skill_source', field + '.source.files');
    for (const file of source.files) {
      if (!file || typeof file.path !== 'string' || !/^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/.test(file.path) || file.path.split('/').includes('..') || typeof file.content !== 'string' || file.content.includes('\0') || Buffer.byteLength(file.content) > 64 * 1024) invalid('invalid_skill_file', field + '.source.files');
      files.push({ path: file.path, content: file.content });
    }
    const stored = previous && previous.id === input.id ? s.get('SELECT source,content_hash FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?', repositoryId, previous.id, previous.revision) : undefined;
    const prior = stored ? skillSourceDescriptor(JSON.parse(String(stored.source)), { id: input.id, revision: previous!.revision, content_hash: String(stored.content_hash) }) : null;
    descriptor = { type: 'inline', commit: null, ...(prior?.origin ? { origin: prior.origin } : {}) };
  } else invalid('invalid_skill_source', field + '.source.type');
  if (new Set(files.map(f => f.path)).size !== files.length) invalid('duplicate_skill_file', field + '.source');
  files.sort((a, b) => a.path < b.path ? -1 : 1);
  const listing = files.map(f => ({ path: f.path, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content) }));
  return { id: input.id as string, source: descriptor, listing, files, content_hash: sha256(JSON.stringify({ source: descriptor, files: listing })) };
}

/**
 * Validates and normalizes a PUT body against the stored configuration. Returns the next configuration and the skill
 * revisions it adds. Nothing is written here.
 */
export function normalizeConfiguration(s: Store, repositoryId: string, input: any, current: RoleConfiguration) {
  if (Object.keys(input).some(k => !['expected_revision', 'enabled', 'controller', 'roles', 'skills', 'deleted_roles'].includes(k))) invalid('unknown_field', Object.keys(input).find(k => !['expected_revision', 'enabled', 'controller', 'roles', 'skills', 'deleted_roles'].includes(k))!);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) invalid('expected_revision_required', 'expected_revision');
  if (input.expected_revision !== current.revision) fail(409, 'role_configuration_conflict', 'expected_revision');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') invalid('invalid_role_configuration', 'enabled');
  // Skill bundles first: a role may reference a bundle saved in this same request.
  const skillInput = input.skills ?? [];
  if (!Array.isArray(skillInput) || skillInput.length > 16) invalid('invalid_skill_bundles', 'skills');
  const pinned = skillInput.map((value: any, index: number) => pinSkill(s, repositoryId, value, index, current.skills.find(bundle => bundle.id === value?.id)));
  if (new Set(pinned.map((b: any) => b.id)).size !== pinned.length) invalid('duplicate_skill_bundle', 'skills');
  const added: any[] = [];
  const skills = input.skills === undefined ? current.skills : pinned.map((bundle: any) => {
    const latest = s.get('SELECT revision,content_hash FROM skill_bundle_revisions WHERE repository_id=? AND id=? ORDER BY revision DESC LIMIT 1', repositoryId, bundle.id);
    const revision = latest && latest.content_hash === bundle.content_hash ? Number(latest.revision) : Number(latest?.revision ?? 0) + 1;
    if (revision !== Number(latest?.revision)) added.push({ ...bundle, revision });
    return { id: bundle.id, revision, content_hash: bundle.content_hash, source: bundle.source, files: bundle.listing };
  });
  const roleInput = input.roles ?? [];
  if (!Array.isArray(roleInput) || roleInput.length > 32) invalid('invalid_role_definitions', 'roles');
  const ids = roleInput.map((r: any, i: number) => {
    if (!r || typeof r !== 'object' || typeof r.role_id !== 'string' || !idPattern.test(r.role_id)) invalid('invalid_role_id', `roles[${i}].role_id`);
    if (r.role_id === 'coordinator') invalid('retired_role', `roles[${i}].role_id`);
    return r.role_id;
  });
  if (new Set(ids).size !== ids.length) invalid('duplicate_role', 'roles');
  if (ids.filter((id: string) => !rolePool.some(r => r.id === id)).length > 16) invalid('too_many_custom_roles', 'roles');
  const allowedKeys = ['role_id', 'enabled', 'name', 'responsibility', 'persona_prompt', 'model_profile_ref', 'skill_bundle_ref', 'harness_ref', 'permissions', 'environment_profile_ref', 'budget_policy_ref', 'output_schema_ref'];
  const rawDeleted = input.deleted_roles ?? [];
  if (!Array.isArray(rawDeleted) || rawDeleted.some(id => typeof id !== 'string' || !idPattern.test(id))) invalid('invalid_deleted_roles', 'deleted_roles');
  // Retired coordinator is already omitted on read; ignore older clients echoing it in deleted_roles.
  const deleted = rawDeleted.filter((id: string) => id !== 'coordinator');
  for (const id of deleted) {
    if (requiredRoles.includes(id)) invalid('role_required', `roles.${id}`);
    if (ids.includes(id)) invalid('role_delete_conflict', `roles.${id}`);
    if (!current.roles.some(role => role.role_id === id)) invalid('unknown_role', `roles.${id}`);
  }
  const all = [...new Set([...current.roles.map(role => role.role_id), ...ids])].filter(id => !deleted.includes(id));
  if (all.length > 32 || all.filter(id => !rolePool.some(role => role.id === id)).length > 16) invalid('too_many_custom_roles', 'roles');
  const roles: RoleDefinitionV2[] = all.map(id => {
    const previous = current.roles.find(r => r.role_id === id);
    const given = roleInput.find((r: any) => r.role_id === id) ?? (previous ? { ...previous, ...(current.legacy ? { harness_ref: undefined } : {}) } : { role_id: id }), field = `roles.${id}`, kind = roleKind(id), allowed = allowedFor(kind);
    const unknown = Object.keys(roleInput.find((r: any) => r.role_id === id) ?? {}).find(k => !allowedKeys.includes(k)); if (unknown) invalid('unknown_field', `${field}.${unknown}`);
    const [defaultName, defaultResponsibility] = names(id);
    const textField = (key: string, max: number, fallback: string) => { const value = given[key] ?? fallback; if (typeof value !== 'string' || value.length > max || value.includes('\0')) invalid('invalid_role_field', `${field}.${key}`); return value; };
    const enabled = given.enabled ?? true; if (typeof enabled !== 'boolean') invalid('invalid_role_field', `${field}.enabled`);
    // Mandatory roles (manager, qa) cannot be switched off, only configured.
    if (!enabled && requiredRoles.includes(id)) invalid('role_required', `${field}.enabled`);
    const pick = (key: string, list: { id: string; version: string }[], choices: string[], fallback: string, code: string) => {
      const ref = given[key] ?? { id: fallback }; if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') invalid('invalid_role_reference', `${field}.${key}`);
      if (!choices.includes(ref.id)) invalid(code, `${field}.${key}.id`);
      const entry = list.find(e => e.id === ref.id)!; if (ref.version !== undefined && ref.version !== entry.version) invalid('reference_version_unavailable', `${field}.${key}.version`);
      return { id: entry.id, version: entry.version };
    };
    const harnessInput = given.harness_ref ?? (!current.legacy ? previous?.harness_ref : undefined) ?? { id: defaultHarness() };
    if (!harnessInput || typeof harnessInput !== 'object' || Array.isArray(harnessInput) || typeof harnessInput.id !== 'string') invalid('invalid_role_reference', `${field}.harness_ref`);
    const unknownHarnessKey = Object.keys(harnessInput).find(k => !['id', 'version', 'model_source'].includes(k));
    if (unknownHarnessKey) invalid('unknown_field', `${field}.harness_ref.${unknownHarnessKey}`);
    const harness = harnesses.find(h => h.id === harnessInput.id); if (!harness) invalid(plannedBackend(harnessInput.id) ? 'agent_backend_unavailable' : 'unknown_role_harness', `${field}.harness_ref.id`);
    // A backend's declared capabilities, rather than a special Manager/Pi pairing, determine admission.
    if (!harness!.kinds.includes(kind)) invalid('harness_role_unsupported', `${field}.harness_ref.id`);
    if (harnessInput.version !== undefined && harnessInput.version !== harness!.version) invalid('harness_version_unavailable', `${field}.harness_ref.version`);
    if (harnessInput.model_source !== undefined && !isHarnessModelSource(harnessInput.model_source)) invalid('invalid_role_reference', `${field}.harness_ref.model_source`);
    const modelSource: HarnessModelSource = normalizeHarnessModelSource(harnessInput.model_source) ?? (!current.legacy && previous?.harness_ref?.id === harness!.id ? normalizeHarnessModelSource(previous.harness_ref.model_source) : null) ?? 'gateway';
    if (modelSource === 'local_config' && !LOCAL_CONFIG_CAPABLE_HARNESSES.has(harness!.id)) invalid('subscription_mode_not_implemented', `${field}.harness_ref.model_source`);
    let model: ModelProfileRef | null = null;
    if (given.model_profile_ref !== undefined && given.model_profile_ref !== null) {
      const ref = given.model_profile_ref, mfield = `${field}.model_profile_ref`;
      // An external-model driver (ACP) or local_config mode uses its own model configuration; a project model here would be silently ignored.
      if (harness!.externalModel || modelSource === 'local_config') invalid('harness_model_profile_unsupported', mfield);
      if (typeof ref !== 'object' || Array.isArray(ref) || typeof ref.model_id !== 'string') invalid('invalid_role_reference', mfield);
      if (Object.keys(ref).some(k => !['model_id', 'profile_hash', 'version', 'api', 'tool_calls', 'structured_output', 'name'].includes(k))) invalid('unknown_field', mfield);
      const row = visibleModel(s, repositoryId, ref.model_id);
      if (!row?.api_key) invalid('role_model_not_available', mfield + '.model_id');
      const hash = modelProfileHash(row!);
      if (ref.profile_hash !== undefined && ref.profile_hash !== hash) fail(409, 'role_model_profile_changed', mfield + '.profile_hash');
      const profile = { api: ref.api ?? 'openai-chat-completions', tool_calls: ref.tool_calls ?? true, structured_output: ref.structured_output ?? 'tool_call' };
      if (typeof profile.api !== 'string' || typeof profile.tool_calls !== 'boolean' || typeof profile.structured_output !== 'string') invalid('invalid_role_reference', mfield);
      checkMatrix(harness!, profile, mfield, invalid);
      model = { model_id: String(row!.id), name: String(row!.model_name), profile_hash: hash, version: Number(row!.version), ...profile };
    }
    let skill: SkillBundleRef | null = null;
    if (given.skill_bundle_ref !== undefined && given.skill_bundle_ref !== null) {
      const ref = given.skill_bundle_ref, sfield = `${field}.skill_bundle_ref`;
      if (typeof ref !== 'object' || typeof ref.id !== 'string') invalid('invalid_role_reference', sfield);
      const bundle = skills.find((b: any) => b.id === ref.id); if (!bundle) invalid('skill_bundle_not_found', sfield + '.id');
      if (ref.revision !== undefined && ref.revision !== bundle!.revision) invalid('skill_bundle_revision_unavailable', sfield + '.revision');
      skill = { id: bundle!.id, revision: bundle!.revision, content_hash: bundle!.content_hash };
    }
    const budget = pick('budget_policy_ref', budgetPolicies, budgetPolicies.map(b => b.id), 'entry-default', 'unknown_budget_policy') as RoleDefinitionV2['budget_policy_ref'];
    if (budget.id === 'bounded' || budget.id === 'metered') {
      const b = given.budget_policy_ref, bfield = `${field}.budget_policy_ref`;
      // Integer limits and their bounds; metered adds the cumulative ones.
      const limits: Record<string, [number, number]> = { max_turns: [4, 256], max_output_tokens: [256, 32768], command_timeout_seconds: [10, 7200], ...(budget.id === 'metered' ? { max_total_tokens: [1000, 100_000_000], max_model_requests: [1, 10000], max_tool_calls: [1, 10000], max_wall_seconds: [60, 86400] } : {}) };
      // Legacy max_cost is accepted on read/save but never copied into the normalized resource limits.
      const budgetFields = ['id', 'version', ...Object.keys(limits), ...(budget.id === 'metered' ? ['max_cost'] : [])];
      const unknown = Object.keys(b).find(k => !budgetFields.includes(k)); if (unknown) invalid('unknown_field', `${bfield}.${unknown}`);
      if (budget.id==='bounded'&&Object.keys(b).every(k => k === 'id' || k === 'version')) invalid('invalid_budget_policy', bfield);
      for (const [key, [min, max]] of Object.entries(limits)) if (b[key] !== undefined && (!Number.isSafeInteger(b[key]) || b[key] < min || b[key] > max)) invalid('invalid_budget_policy', `${bfield}.${key}`);
      Object.assign(budget, Object.fromEntries(Object.keys(limits).filter(k => b[k] !== undefined).map(k => [k, b[k]])));
    }
    if (given.environment_profile_ref && typeof given.environment_profile_ref === 'object') {
      if (given.environment_profile_ref.id === 'isolated-workspace' && kind === 'writer') given.environment_profile_ref = { id: 'task-workspace' };
      else if (given.environment_profile_ref.id === 'isolated-candidate' && (kind === 'observer' || kind === 'evaluator')) given.environment_profile_ref = { id: allowed.environment[0]! };
    }
    const environmentRef = pick('environment_profile_ref', environmentProfiles, allowed.environment, allowed.environment[0]!, 'environment_profile_not_allowed');
    const permissionInput = given.permissions ?? previous?.permissions ?? defaultPermissions(id, kind);
    if (!permissionInput || typeof permissionInput !== 'object' || Array.isArray(permissionInput)) invalid('invalid_role_permissions', `${field}.permissions`);
    for (const [key, value] of Object.entries(permissionInput)) {
      if (!validPermissionInput(key, value, previous?.permissions ?? defaultPermissions(id,kind))) invalid('invalid_role_permission', `${field}.permissions.${key}`);
    }
    const permissions = updatePermissions(previous?.permissions ?? defaultPermissions(id,kind),permissionInput);
    const definition: RoleDefinitionV2 = { role_id: id, revision: 0, enabled, kind, name: textField('name', 80, defaultName), responsibility: textField('responsibility', 2000, defaultResponsibility),
      persona_prompt: textField('persona_prompt', 32000, previous?.persona_prompt ?? roleTemplate(id)), model_profile_ref: model, skill_bundle_ref: skill,
      harness_ref: { id: harness!.id, version: harness!.version, ...(modelSource === 'local_config' ? { model_source: 'local_config' as const } : {}) },
      permissions,
      environment_profile_ref: environmentRef,
      budget_policy_ref: budget, output_schema_ref: pick('output_schema_ref', outputSchemas, allowed.output, allowed.output[0]!, 'output_schema_not_allowed') };
    // Echoing an old V2 id (as the console does on every save) is not a new backend choice.
    if (id === 'dev' && (current.legacy || !previous?.harness_ref || previous.entry_harness_source === 'role' || harness!.id !== previous.harness_ref.id))
      definition.entry_harness_source = 'role';
    // A role's revision moves only when its own definition changes. Leaving the defaults saves every role for the first time.
    definition.revision = previous && !current.legacy && !current.follows_default && definitionHash(previous) === definitionHash(definition) ? previous.revision : (previous?.revision ?? 0) + 1;
    return definition;
  });
  const controllerInput = input.controller ?? {};
  if (typeof controllerInput !== 'object' || Array.isArray(controllerInput) || Object.keys(controllerInput).some(k => !['role', 'entries'].includes(k))) invalid('invalid_controller', 'controller');
  const controllerRole = controllerInput.role ?? 'manager';
  // Exactly one project controller: the controller-kind role.
  if (roles.find(r => r.role_id === controllerRole)?.kind !== 'controller') invalid('invalid_controller', 'controller.role');
  const entryInput = controllerInput.entries ?? current.controller.entries;
  if (!entryInput || typeof entryInput !== 'object' || Object.keys(entryInput).some(k => !entries.includes(k as Entry)) || Object.values(entryInput).some(v => typeof v !== 'boolean')) invalid('invalid_controller_entries', 'controller.entries');
  // Accept retired booleans from older clients, but they no longer opt work out of Manager execution.
  const deletedBuiltin = [...new Set([...(current.deleted_roles ?? []).filter(d => !ids.includes(d)), ...deleted.filter((d: string) => rolePool.some(r => r.id === d))])];
  const config: RoleConfiguration = { schema: 2, revision: current.revision + 1, enabled: true, controller: { role: controllerRole, entries: managerEntries() }, roles, ...(deletedBuiltin.length ? { deleted_roles: deletedBuiltin } : {}), skills };
  if (Buffer.byteLength(JSON.stringify(config)) > 512 * 1024) invalid('role_configuration_too_large', 'roles');
  return { config, added };
}

/** Drops the concurrency limits of roles the configuration no longer has. */
function dropRoleLimits(s: Store, repositoryId: string, roles: string[]) {
  if (!roles.length) return;
  const raw = s.get('SELECT role_concurrency FROM policies WHERE repository_id=?', repositoryId)?.role_concurrency;
  let limits: unknown;
  try { limits = JSON.parse(String(raw ?? '{}')); } catch { limits = {}; }
  if (limits && typeof limits === 'object' && !Array.isArray(limits)) {
    for (const role of roles) delete (limits as Record<string, unknown>)[role];
    s.run('UPDATE policies SET role_concurrency=? WHERE repository_id=?', JSON.stringify(limits), repositoryId);
  }
}

/**
 * Saves a validated configuration as the next immutable revision; it is the project's own from then on and no longer
 * follows built-in updates. `{expected_revision, follow_default: true}` instead returns the project to the built-in
 * defaults under the next revision; the custom revisions stay in the history. Running role runs keep their snapshot.
 */
export function saveConfiguration(s: Store, repositoryId: string, input: any, actor: string): RoleConfiguration {
  return s.transaction(() => {
    const current = roleConfiguration(s, repositoryId);
    if (input?.follow_default !== undefined) {
      const extra = Object.keys(input).find(k => !['expected_revision', 'follow_default'].includes(k)); if (extra) invalid('unknown_field', extra);
      if (input.follow_default !== true) invalid('invalid_role_configuration', 'follow_default');
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) invalid('expected_revision_required', 'expected_revision');
      if (input.expected_revision !== current.revision) fail(409, 'role_configuration_conflict', 'expected_revision');
      if (current.follows_default) return current;
      dropRoleLimits(s, repositoryId, current.roles.map(role => role.role_id).filter(id => !rolePool.some(role => role.id === id)));
      const stored = JSON.parse(String(s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repositoryId)!.value));
      return roleConfiguration(s, repositoryId, storeFollowDefault(s, repositoryId, stored, current.revision, actor));
    }
    const { config, added } = normalizeConfiguration(s, repositoryId, input, current), now = new Date().toISOString();
    if (input.deleted_roles?.length) dropRoleLimits(s, repositoryId, input.deleted_roles as string[]);
    for (const bundle of added) s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', repositoryId, bundle.id, bundle.revision, JSON.stringify(bundle.source), JSON.stringify(bundle.files.map((f: any) => ({ path: f.path, sha256: sha256(f.content), bytes: Buffer.byteLength(f.content), content: f.content }))), bundle.content_hash, now);
    const saved = { ...config, updated_at: now, updated_by: actor };
    s.run('INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?)', repositoryId, saved.revision, JSON.stringify(saved), short(config), actor, now);
    s.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'roles:' + repositoryId, JSON.stringify(saved));
    return saved;
  });
}
export const configurationRevision = (s: Store, repositoryId: string, revision: number): RoleConfiguration | undefined => { const row = s.get('SELECT config FROM role_config_revisions WHERE repository_id=? AND revision=?', repositoryId, revision); return row ? JSON.parse(row.config) : undefined; };
export function skillFiles(s: Store, repositoryId: string, ref: SkillBundleRef): { path: string; sha256: string; bytes: number; content: string }[] {
  const row = s.get('SELECT files,content_hash FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?', repositoryId, ref.id, ref.revision);
  if (!row || row.content_hash !== ref.content_hash) return stop('skill_bundle_unavailable', 'waiting_configuration', `技能包 ${ref.id}@${ref.revision} 已不存在或内容不一致。`);
  return JSON.parse(row.files);
}

export interface RoleSnapshot {
  schema: 2; repository_id: string; role_id: string; kind: RoleKind; role_revision: number; config_revision: number; legacy: boolean; name: string; responsibility: string;
  prompt: { framework_hash: string; persona_hash: string; system_hash: string };
  model: { source: 'role' | 'workflow' | 'project' | 'external_harness' | 'local_config'; workflow: string; requested: ModelProfileRef | null; id: string; version: number; name: string; profile_hash: string | null; api: string | null; tool_calls: boolean | null; structured_output: string | null };
  skills: { id: string; revision: number; content_hash: string; source: any; files: { path: string; sha256: string; bytes: number }[] } | null;
  harness: { id: string; version: string; session: string; events: string; environment: string; runtime: { package: string; version: string } | null; source: 'role' | 'entry_executor' | 'legacy'; model_source?: HarnessModelSource };
  capability: { id: string; version: string; tools: readonly string[] | null; authorities: Record<string, boolean>; permissions?: RolePermissions };
  environment: { id: string; version: string; workspace: string; repository: boolean; isolation?: string };
  budget: RoleDefinitionV2['budget_policy_ref'];
  output_schema: { id: string; version: string; tool: string | null };
}
/** Only environment/background rules are fixed; all role duties live in the editable template. */
export function rolePrompt(definition: RoleDefinitionV2) {
  return systemInstructions + '\n\nRole instructions:\n' + definition.persona_prompt;
}

/**
 * Resolves one role for one work type into an auditable run snapshot and its run-time model. Read-only apart from storing
 * the snapshot body and its effective skill bundle under their own hashes. Preview resolution stores neither.
 * Model order: the role's explicit profile, then the work type's model, then the
 * project default; the actual result is part of the snapshot. Unsupported combinations stop here, before any run starts.
 */
export function resolveRole(s: Store, repositoryId: string, roleId: string, workflow: string, options: { expectedRevision?: number; harness?: string; pinned?: boolean; persist?: boolean; entryExecutor?: boolean;
  configuration?: RoleConfiguration; fallbackModel?:()=>{model:ReturnType<typeof openModel>;source:'workflow'|'project'};
  /** The task is a CI change a project administrator confirmed (#931): its planning and writing roles get the CI gate skill. */
  ciChange?: boolean;
  /** Trusted base-branch `.agents/skills/` snapshot for this task; `undefined` reads the project's rule cache. */
  repositorySkills?: { sha: string | null; files: Record<string, string> } | null } = {}) {
  const config = roleConfiguration(s, repositoryId, options.configuration);
  if (options.expectedRevision !== undefined && options.expectedRevision !== config.revision) stop('role_configuration_changed', 'retry_wait', `角色配置已更新到 revision ${config.revision}，请求的是 ${options.expectedRevision}。`);
  const definition = config.roles.find(r => r.role_id === roleId), field = `roles.${roleId}`;
  if (!definition) return stop('unknown_role', 'waiting_configuration', `${field}：项目没有这个角色。`);
  if (!definition.enabled) return stop('role_disabled', 'waiting_configuration', `${field}.enabled：角色已停用。`);
  const entryHarness = options.entryExecutor && roleId === 'dev' && definition.entry_harness_source !== 'role' ? 'pi' : undefined;
  const harnessOverride = options.harness ?? entryHarness;
  const harnessId = harnessOverride ?? definition.harness_ref.id, harness = harnesses.find(h => h.id === harnessId);
  if (!harness) return stop('unknown_role_harness', 'waiting_configuration', `${field}.harness_ref.id：没有注册 ${harnessId}。`);
  if (!harnessOverride && harness.version !== definition.harness_ref.version) return stop('harness_version_unavailable', 'waiting_configuration', `${field}.harness_ref.version：固定的是 ${definition.harness_ref.version}，当前注册的是 ${harness.version}。`);
  const modelSource: HarnessModelSource = !harnessOverride ? (normalizeHarnessModelSource(definition.harness_ref.model_source) ?? 'gateway') : 'gateway';
  assertHarnessModelSourceImplemented(modelSource, `${field}.harness_ref.model_source`, harness.id);
  // Container backends must enforce their declared kinds even for legacy bindings and explicit overrides.
  if(runsInTaskCheckout(harness)&&!harness.kinds.includes(definition.kind))return stop('harness_role_unsupported','waiting_configuration',`${field}.harness_ref.id：${harness.id} 未声明 ${definition.kind} 能力。`);
  // Resolve the model in order, and keep the precise reason when a configured one is not usable.
  let model: ReturnType<typeof openModel>, source: RoleSnapshot['model']['source'], profile: { api: string | null; tool_calls: boolean | null; structured_output: string | null } = { api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' }, profileHash: string | null;
  const hasConfigOverride = (harness.id === 'claude_code' && Boolean(process.env.BOT_CLAUDE_CODE_CONFIG)) || (harness.id === 'codex' && Boolean(process.env.BOT_CODEX_CONFIG));
  if (modelSource === 'local_config') {
    // Local project-computer config mode (#1260): platform injects no model configuration; CLI reads /workspace/home.
    if (definition.model_profile_ref) return stop('harness_model_profile_unsupported', 'waiting_configuration', `${field}.model_profile_ref：${harness.id} 已设为项目电脑内自行配置，不能再指定平台模型。`);
    model = { id: `${harness.id}:local_config`, version: 1, url: '', key: '', model: 'local_config', pricing: null as any };
    source = 'local_config';
    profile = { api: null, tool_calls: null, structured_output: null };
    profileHash = null;
  } else if (harness.externalModel) {
    // The driver brings its own model: no project model is resolved, opened or substituted, and a role model is an error.
    if (definition.model_profile_ref) return stop('harness_model_profile_unsupported', 'waiting_configuration', `${field}.model_profile_ref：${harness.id} 使用执行器自带的模型，不能再指定项目模型。`);
    model = { id: harness.id, version: 1, url: '', key: '', model: 'external', pricing: null as any }; source = 'external_harness'; profile = { api: null, tool_calls: null, structured_output: null }; profileHash = null;
  } else if (definition.model_profile_ref) {
    const ref = definition.model_profile_ref, row = visibleModel(s, repositoryId, ref.model_id);
    if (!row?.api_key) return stop('role_model_not_available', 'waiting_configuration', `${field}.model_profile_ref.model_id：模型 ${ref.model_id} 已删除、撤销或没有凭据；不会换用其他模型。`);
    if (modelProfileHash(row) !== ref.profile_hash) return stop('role_model_profile_changed', 'waiting_configuration', `${field}.model_profile_ref.profile_hash：模型 ${ref.model_id} 的地址或名称已变化，请重新保存角色配置。`);
    model = openModel(s, row); source = 'role'; profile = { api: ref.api, tool_calls: ref.tool_calls, structured_output: ref.structured_output }; profileHash = ref.profile_hash;
  } else {
    try {
      const fallback = options.fallbackModel?.();
      model = fallback?.model ?? selectedModel(s, repositoryId);
      source = fallback?.source ?? 'project';
      profileHash = modelProfileHash({ api_url: model.url, model_name: model.model });
    } catch (err) {
      if (hasConfigOverride && (err as any)?.code === 'model_not_configured') {
        model = { id: harness.id, version: 1, url: '', key: '', model: 'external', pricing: null as any };
        source = 'external_harness';
        profile = { api: null, tool_calls: null, structured_output: null };
        profileHash = null;
      } else {
        throw err;
      }
    }
  }
  if (!harness.externalModel && source !== 'external_harness' && source !== 'local_config') checkMatrix(harness, profile as { api: string; tool_calls: boolean; structured_output: string }, `${field}.model_profile_ref`, (code, at) => { throw new TaskError(code, 'waiting_configuration', `${at}：${harness.id} 不支持这个模型配置。`); });
  if (!harness.kinds.includes(definition.kind) && !harnessOverride && !config.legacy) return stop('harness_role_unsupported', 'waiting_configuration', `${field}.harness_ref.id：${harness.id} 不能运行 ${definition.kind} 角色。`);
  const permission = permissionSnapshot(definition.permissions,definition.kind);
  const environment = environmentProfiles.find(e => e.id === definition.environment_profile_ref.id)!, schema = outputSchemas.find(o => o.id === definition.output_schema_ref.id)!;
  const bundle = definition.skill_bundle_ref ? config.skills.find(b => b.id === definition.skill_bundle_ref!.id && b.revision === definition.skill_bundle_ref!.revision) : undefined;
  const projectFiles=definition.skill_bundle_ref?skillFiles(s,repositoryId,definition.skill_bundle_ref):[];
  const configuredSkills=bundle?{id:bundle.id,revision:bundle.revision,content_hash:bundle.content_hash,source:bundle.source,files:bundle.files}:null;
  const repositorySource=options.repositorySkills===undefined
    ? (()=>{const cached=trustedCachedRuleFiles(s,repositoryId);return cached?{sha:cached.sha,files:cached.files}:null;})()
    : options.repositorySkills;
  const skills=roleSkills(s,repositoryId,{id:roleId,kind:definition.kind},configuredSkills,projectFiles,options.persist!==false,!!options.ciChange,repositorySource);
  const system = rolePrompt(definition);
  const snapshot: RoleSnapshot = { schema: 2, repository_id: repositoryId, role_id: roleId, kind: definition.kind, role_revision: definition.revision, config_revision: config.revision, legacy: !!config.legacy,
    name: definition.name, responsibility: definition.responsibility,
    prompt: { framework_hash: sha256(systemInstructions), persona_hash: sha256(definition.persona_prompt), system_hash: sha256(system) },
    model: { source, workflow, requested: definition.model_profile_ref, id: model.id, version: model.version, name: model.model, profile_hash: profileHash, ...profile },
    skills,
    harness: { id: harness.id, version: harness.version, session: harness.session, events: harness.events, environment: harness.environment, runtime: harness.runtime, source: harnessOverride ? (options.pinned ? 'legacy' : 'entry_executor') : config.legacy ? 'legacy' : 'role', ...(modelSource === 'local_config' ? { model_source: 'local_config' as const } : {}) },
    capability: permission,
    environment: { id: environment.id, version: environment.version, workspace: environment.workspace, repository: environment.repository },
    budget: definition.budget_policy_ref, output_schema: { id: schema.id, version: schema.version, tool: schema.tool } };
  const id = sha256(JSON.stringify(snapshot));
  if (options.persist !== false) s.run('INSERT INTO role_snapshots VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', id, repositoryId, roleId, config.revision, definition.revision, JSON.stringify(snapshot), new Date().toISOString());
  return { id, snapshot, definition, system, model };
}

/**
 * Live authority of a running role. A snapshot explains what a run started with; it never keeps authority that has since
 * been withdrawn. Disabling the role or narrowing its permissions stops further tool use.
 */
export function roleAuthority(s: Store, repositoryId: string, snapshot: RoleSnapshot, tool?: string, direct=false): string | null {
  const config = roleConfiguration(s, repositoryId);
  const definition = config.roles.find(r => r.role_id === snapshot.role_id);
  if (!definition) return 'role_removed';
  if (!definition.enabled) return 'role_disabled';
  const live = definition.permissions;
  for (const name of ['read_file','write_file','run_command']) if(snapshot.capability.permissions&&permitsTool(snapshot.capability.permissions,name)&&!permitsTool(live,name))return 'capability_revoked';
  const reads=snapshot.capability.permissions?githubReadScopes(snapshot.capability.permissions)
    :snapshot.capability.tools?.includes('github_read_token')?['issues','pull_requests','contents','actions','checks','statuses']:[];
  if(reads.some(scope=>!githubReadScopes(live).includes(scope)))return 'capability_revoked';
  if (tool && snapshot.capability.tools && !snapshot.capability.tools.includes(tool)) return 'tool_not_in_permissions';
  if (tool && !permitsTool(live, tool)) return 'capability_revoked';
  return null;
}
