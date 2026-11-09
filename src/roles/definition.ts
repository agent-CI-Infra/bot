import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import { fail } from '../core/security.js';
import { stop, TaskError } from '../agent/common.js';
import { selectedModel, visibleModel, openModel } from '../agent/model.js';
import { playbooks } from '../tasks/playbooks.js';
import { rolePool, sharedInstructions, configuredRoles } from './pool.js';
import { roleKind, capabilityPolicy, capabilityPolicies, environmentProfiles, budgetPolicies, outputSchemas, allowedFor, type RoleKind } from './catalog.js';
import { harnesses } from './harness.js';
import { recommendedBackend, plannedBackend } from './backends.js';
import { validateStages, type StageDefinition } from './stage-policy.js';

/**
 * RoleDefinitionV2: one project's versioned role configuration. Every reference names a fixed version: model profiles pin
 * the model's endpoint and name, skills pin a content-hashed bundle revision, harnesses, capability policies, environment
 * profiles, budgets and output schemas pin the server catalog version. Credentials are never part of a definition; the
 * model reference names a stored model whose key stays sealed in the models table.
 *
 * The persona prompt is data. Tools and authority come only from the capability policy, which a role kind bounds.
 */
export interface Ref { id: string; version: string }
export interface ModelProfileRef { model_id: string; name: string; profile_hash: string; version: number; api: string; tool_calls: boolean; structured_output: string }
export interface SkillBundleRef { id: string; revision: number; content_hash: string }
export interface RoleDefinitionV2 {
  role_id: string; revision: number; enabled: boolean; kind: RoleKind; name: string; responsibility: string; persona_prompt: string;
  model_profile_ref: ModelProfileRef | null; skill_bundle_ref: SkillBundleRef | null; harness_ref: Ref; capability_policy_ref: Ref;
  /** Server-owned opt-in: old V2 review/Actions dev assignments used the entry's Pi executor. */
  entry_harness_source?: 'role';
  environment_profile_ref: Ref; budget_policy_ref: Ref & { max_turns?: number; max_output_tokens?: number; max_total_tokens?: number; max_model_requests?: number; max_tool_calls?: number; max_wall_seconds?: number; max_cost?: { amount: number; currency: string } }; output_schema_ref: Ref;
}
export type Entry = 'development' | 'request' | 'review' | 'actions';
export interface RoleConfiguration {
  schema: 2; revision: number; enabled: boolean; legacy?: boolean;
  controller: { role: string; entries: Record<Entry, boolean> };
  required_stages?: StageDefinition[];
  roles: RoleDefinitionV2[];
  skills: (SkillBundleRef & { source: any; files: { path: string; sha256: string; bytes: number }[] })[];
  updated_at?: string; updated_by?: string;
}
const entries: Entry[] = ['development', 'request', 'review', 'actions'];
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const short = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 16);
const idPattern = /^[a-z][a-z0-9_-]{0,31}$/;
// Validation errors name the configuration field, so the console and API can point at it.
const invalid = (code: string, field: string): never => fail(400, code, field);
const builtinNames: Record<string, [string, string]> = {
  coordinator:['Task Coordinator','Resolves explicit cross-task coordination requests without product execution or acceptance authority.'],
  manager: ['Project controller', 'Coordinates the project flow for one task: queries task facts, delegates bounded work, nominates a delivery for independent QA.'],
  dev: ['Developer', 'Implements or investigates the task within the entry point\'s existing authority.'],
  test: ['Tester', 'Independently tests the fixed candidate.'], reviewer: ['Reviewer', 'Independently inspects the fixed candidate for actionable defects.'],
  ux: ['UX reviewer', 'Inspects user interactions, visible state and accessibility of the candidate.'], qa: ['Independent QA', 'Decides whether the exact candidate meets the task contract, in a fresh context.']
};
// Own properties only: a custom role may be called "constructor".
const names = (id: string): [string, string] => Object.hasOwn(builtinNames, id) ? builtinNames[id]! : [id, 'Project observer role: inspects the fixed candidate and reports findings.'];
const catalogRef = (list: { id: string; version: string }[], id: string) => { const entry = list.find(e => e.id === id)!; return { id: entry.id, version: entry.version }; };
const defaultHarness = () => recommendedBackend;
const harnessRef = (id: string) => ({ id, version: harnesses.find(h => h.id === id)?.version ?? 'unregistered' });
const definitionHash = ({ revision, ...rest }: RoleDefinitionV2) => short(rest);

export function roleStorageV2(s: Store) {
  s.db.exec(`
  CREATE TABLE IF NOT EXISTS role_config_revisions(repository_id TEXT NOT NULL,revision INTEGER NOT NULL,config TEXT NOT NULL,hash TEXT NOT NULL,actor TEXT,created_at TEXT NOT NULL,PRIMARY KEY(repository_id,revision));
  CREATE TABLE IF NOT EXISTS skill_bundle_revisions(repository_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,source TEXT NOT NULL,files TEXT NOT NULL,content_hash TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(repository_id,id,revision));
  CREATE TABLE IF NOT EXISTS role_snapshots(id TEXT PRIMARY KEY,repository_id TEXT NOT NULL,role TEXT NOT NULL,config_revision INTEGER NOT NULL,role_revision INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);
  `);
}

/** The stored configuration as V2. A configuration saved before V2 keeps running as before (legacy) until it is saved again. */
export function roleConfiguration(s: Store, repositoryId: string, stored?: any): RoleConfiguration {
  const saved = stored===undefined?s.get('SELECT value FROM settings WHERE key=?', 'roles:' + repositoryId):undefined;
  const value = stored??(saved ? JSON.parse(saved.value) : { enabled: false, harnesses: {} });
  if (value.schema === 2) {
    if(value.roles.some((r:RoleDefinitionV2)=>r.role_id==='coordinator'))return value;
    const fallback=roleConfiguration(s,repositoryId,{enabled:value.enabled,harnesses:{}}).roles.find(r=>r.role_id==='coordinator')!;
    return {...value,roles:[...value.roles,fallback]};
  }
  // Legacy: built-in prompts with appended project instructions, the per-role driver map, the native manager.
  const legacy = configuredRoles(value);
  return { schema: 2, revision: 0, enabled: !!value.enabled, legacy: true, controller: { role: 'manager', entries: { development: true, request: true, review: false, actions: false } }, skills: [],
    roles: legacy.map(r => { const kind = roleKind(r.id), [name, responsibility] = names(r.id);
      const custom = (value.roles ?? []).find((c: any) => c.id === r.id);
      return { role_id: r.id, revision: 0, enabled: true, kind, name, responsibility, persona_prompt: custom?.prompt ?? '', model_profile_ref: null, skill_bundle_ref: null,
        harness_ref: harnessRef(r.harness), capability_policy_ref: catalogRef(capabilityPolicies,r.id==='coordinator'?'coordinator':r.id==='manager'?'controller-coordination':allowedFor(kind).capability.find(id=>id==='controller')??allowedFor(kind).capability[0]!), environment_profile_ref: catalogRef(environmentProfiles, allowedFor(kind).environment[0]!),
        budget_policy_ref: catalogRef(budgetPolicies, 'entry-default'), output_schema_ref: catalogRef(outputSchemas,r.id==='coordinator'?'coordination-result':allowedFor(kind).output[0]!) }; }) };
}
export const entryEnabled = (config: RoleConfiguration, entry: Entry) => config.enabled && config.controller.entries[entry] === true;

/** The model profile a role may pin: endpoint and model name fixed by hash; a rotated key keeps the same profile. */
export const modelProfileHash = (row: Record<string, any>) => short([String(row.api_url), String(row.model_name)]);
function checkMatrix(harness: (typeof harnesses)[number], profile: { api: string; tool_calls: boolean; structured_output: string }, field: string, raise: (code: string, field: string) => never) {
  if (!harness.model_api.includes(profile.api)) raise('harness_model_api_unsupported', field + '.api');
  if (harness.tool_calls && !profile.tool_calls) raise('harness_tool_calls_required', field + '.tool_calls');
  if (!harness.structured_output.includes(profile.structured_output)) raise('harness_structured_output_unsupported', field + '.structured_output');
}

/** Pins one skill bundle source to its exact files: path, sha256 and size, plus the stored contents. */
function pinSkill(s: Store, repositoryId: string, input: any, index: number) {
  const field = `skills[${index}]`;
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('invalid_skill_bundle', field);
  if (Object.keys(input).some(k => !['id', 'source'].includes(k))) invalid('unknown_field', field);
  if (typeof input.id !== 'string' || !idPattern.test(input.id)) invalid('invalid_skill_bundle_id', field + '.id');
  const source = input.source;
  if (!source || typeof source !== 'object' || Array.isArray(source)) invalid('invalid_skill_source', field + '.source');
  let files: { path: string; content: string }[] = [], descriptor: any;
  if (source.type === 'builtin') {
    // The built-in guides: their content hash is their version; there is no repository commit.
    if (!Array.isArray(source.playbooks) || !source.playbooks.length || source.playbooks.length > 16) invalid('invalid_skill_source', field + '.source.playbooks');
    for (const id of source.playbooks) { const guide = playbooks.find(p => p.id === id); if (!guide) invalid('skill_file_not_found', field + '.source.playbooks'); files.push({ path: `playbooks/${guide!.id}.md`, content: guide!.description + '\n\n' + guide!.content }); }
    descriptor = { type: 'builtin', playbooks: [...source.playbooks].sort(), commit: null };
  } else if (source.type === 'repository') {
    // Repository skills come from the rule cache at exactly the named commit; a moved branch never changes a pinned bundle.
    if (typeof source.commit !== 'string' || !/^[a-f0-9]{40}$/.test(source.commit)) invalid('invalid_skill_source', field + '.source.commit');
    if (!Array.isArray(source.paths) || !source.paths.length || source.paths.length > 32 || source.paths.some((p: any) => typeof p !== 'string')) invalid('invalid_skill_source', field + '.source.paths');
    const cached = s.hasTable('repository_rule_sources') ? s.get('SELECT sha,files FROM repository_rule_sources WHERE repository_id=?', repositoryId) : undefined;
    if (!cached || cached.sha !== source.commit) fail(409, 'skill_source_commit_unavailable', field + '.source.commit');
    const available = JSON.parse(cached!.files);
    for (const path of source.paths) { if (!/^\.agents\/skills\/(?:[^/]+\/)+SKILL\.md$/.test(path) || !Object.hasOwn(available, path)) invalid('skill_file_not_found', field + '.source.paths'); files.push({ path, content: available[path] }); }
    descriptor = { type: 'repository', path_root: '.agents/skills', commit: source.commit, paths: [...source.paths].sort() };
  } else if (source.type === 'inline') {
    if (!Array.isArray(source.files) || !source.files.length || source.files.length > 16) invalid('invalid_skill_source', field + '.source.files');
    for (const file of source.files) {
      if (!file || typeof file.path !== 'string' || !/^[A-Za-z0-9._-][A-Za-z0-9._/-]{0,199}$/.test(file.path) || file.path.split('/').includes('..') || typeof file.content !== 'string' || file.content.includes('\0') || Buffer.byteLength(file.content) > 64 * 1024) invalid('invalid_skill_file', field + '.source.files');
      files.push({ path: file.path, content: file.content });
    }
    descriptor = { type: 'inline', commit: null };
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
  if (Object.keys(input).some(k => !['expected_revision', 'enabled', 'controller', 'roles', 'skills', 'required_stages'].includes(k))) invalid('unknown_field', Object.keys(input).find(k => !['expected_revision', 'enabled', 'controller', 'roles', 'skills', 'required_stages'].includes(k))!);
  if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0) invalid('expected_revision_required', 'expected_revision');
  if (input.expected_revision !== current.revision) fail(409, 'role_configuration_conflict', 'expected_revision');
  if (typeof input.enabled !== 'boolean') invalid('invalid_role_configuration', 'enabled');
  // Skill bundles first: a role may reference a bundle saved in this same request.
  const skillInput = input.skills ?? [];
  if (!Array.isArray(skillInput) || skillInput.length > 16) invalid('invalid_skill_bundles', 'skills');
  const pinned = skillInput.map((value: any, index: number) => pinSkill(s, repositoryId, value, index));
  if (new Set(pinned.map((b: any) => b.id)).size !== pinned.length) invalid('duplicate_skill_bundle', 'skills');
  const added: any[] = [];
  const skills = pinned.map((bundle: any) => {
    const latest = s.get('SELECT revision,content_hash FROM skill_bundle_revisions WHERE repository_id=? AND id=? ORDER BY revision DESC LIMIT 1', repositoryId, bundle.id);
    const revision = latest && latest.content_hash === bundle.content_hash ? Number(latest.revision) : Number(latest?.revision ?? 0) + 1;
    if (revision !== Number(latest?.revision)) added.push({ ...bundle, revision });
    return { id: bundle.id, revision, content_hash: bundle.content_hash, source: bundle.source, files: bundle.listing };
  });
  const roleInput = input.roles ?? [];
  if (!Array.isArray(roleInput) || roleInput.length > 32) invalid('invalid_role_definitions', 'roles');
  const ids = roleInput.map((r: any, i: number) => { if (!r || typeof r !== 'object' || typeof r.role_id !== 'string' || !idPattern.test(r.role_id)) invalid('invalid_role_id', `roles[${i}].role_id`); return r.role_id; });
  if (new Set(ids).size !== ids.length) invalid('duplicate_role', 'roles');
  if (ids.filter((id: string) => !rolePool.some(r => r.id === id)).length > 16) invalid('too_many_custom_roles', 'roles');
  const allowedKeys = ['role_id', 'enabled', 'name', 'responsibility', 'persona_prompt', 'model_profile_ref', 'skill_bundle_ref', 'harness_ref', 'capability_policy_ref', 'environment_profile_ref', 'budget_policy_ref', 'output_schema_ref'];
  const all = [...rolePool.map(r => r.id), ...ids.filter((id: string) => !rolePool.some(r => r.id === id))];
  const roles: RoleDefinitionV2[] = all.map(id => {
    const given = roleInput.find((r: any) => r.role_id === id) ?? { role_id: id }, field = `roles.${id}`, kind = roleKind(id), allowed = allowedFor(kind);
    const unknown = Object.keys(given).find(k => !allowedKeys.includes(k)); if (unknown) invalid('unknown_field', `${field}.${unknown}`);
    const [defaultName, defaultResponsibility] = names(id);
    const textField = (key: string, max: number, fallback: string) => { const value = given[key] ?? fallback; if (typeof value !== 'string' || value.length > max || value.includes('\0')) invalid('invalid_role_field', `${field}.${key}`); return value; };
    const enabled = given.enabled ?? true; if (typeof enabled !== 'boolean') invalid('invalid_role_field', `${field}.enabled`);
    // The controller and QA are mandatory parts of the flow: they cannot be switched off, only configured.
    if (!enabled && (kind === 'controller' || kind === 'evaluator')) invalid('role_required', `${field}.enabled`);
    const pick = (key: string, list: { id: string; version: string }[], choices: string[], fallback: string, code: string) => {
      const ref = given[key] ?? { id: fallback }; if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') invalid('invalid_role_reference', `${field}.${key}`);
      if (!choices.includes(ref.id)) invalid(code, `${field}.${key}.id`);
      const entry = list.find(e => e.id === ref.id)!; if (ref.version !== undefined && ref.version !== entry.version) invalid('reference_version_unavailable', `${field}.${key}.version`);
      return { id: entry.id, version: entry.version };
    };
    const previous = current.roles.find(r => r.role_id === id);
    const harnessInput = given.harness_ref ?? (!current.legacy ? previous?.harness_ref : undefined) ?? { id: defaultHarness() };
    if (!harnessInput || typeof harnessInput.id !== 'string') invalid('invalid_role_reference', `${field}.harness_ref`);
    const harness = harnesses.find(h => h.id === harnessInput.id); if (!harness) invalid(plannedBackend(harnessInput.id) ? 'agent_backend_unavailable' : 'unknown_role_harness', `${field}.harness_ref.id`);
    // A backend's declared capabilities, rather than a special Manager/Pi pairing, determine admission.
    if (!harness!.kinds.includes(kind)) invalid('harness_role_unsupported', `${field}.harness_ref.id`);
    if (harnessInput.version !== undefined && harnessInput.version !== harness!.version) invalid('harness_version_unavailable', `${field}.harness_ref.version`);
    let model: ModelProfileRef | null = null;
    if (given.model_profile_ref !== undefined && given.model_profile_ref !== null) {
      const ref = given.model_profile_ref, mfield = `${field}.model_profile_ref`;
      // An external-model driver (ACP) uses its agent's own model; a project model here would be silently ignored.
      if (harness!.externalModel) invalid('harness_model_profile_unsupported', mfield);
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
      const limits: Record<string, [number, number]> = { max_turns: [4, 256], max_output_tokens: [256, 32768], ...(budget.id === 'metered' ? { max_total_tokens: [1000, 100_000_000], max_model_requests: [1, 10000], max_tool_calls: [1, 10000], max_wall_seconds: [60, 86400] } : {}) };
      const budgetFields = ['id', 'version', ...Object.keys(limits), ...(budget.id === 'metered' ? ['max_cost'] : [])];
      const unknown = Object.keys(b).find(k => !budgetFields.includes(k)); if (unknown) invalid('unknown_field', `${bfield}.${unknown}`);
      if (Object.keys(b).every(k => k === 'id' || k === 'version')) invalid('invalid_budget_policy', bfield);
      for (const [key, [min, max]] of Object.entries(limits)) if (b[key] !== undefined && (!Number.isSafeInteger(b[key]) || b[key] < min || b[key] > max)) invalid('invalid_budget_policy', `${bfield}.${key}`);
      if (b.max_cost !== undefined && (!b.max_cost || typeof b.max_cost !== 'object' || Object.keys(b.max_cost).some(k => !['amount', 'currency'].includes(k)) || typeof b.max_cost.amount !== 'number' || !(b.max_cost.amount > 0) || b.max_cost.amount > 1_000_000 || !['USD', 'CNY'].includes(b.max_cost.currency))) invalid('invalid_budget_policy', `${bfield}.max_cost`);
      Object.assign(budget, Object.fromEntries(Object.keys(limits).filter(k => b[k] !== undefined).map(k => [k, b[k]])), b.max_cost !== undefined ? { max_cost: { amount: b.max_cost.amount, currency: b.max_cost.currency } } : {});
    }
    const environmentRef = pick('environment_profile_ref', environmentProfiles, allowed.environment, allowed.environment[0]!, 'environment_profile_not_allowed');
    // A per-run container profile needs a driver that runs inside it; built-in drivers do not, so they are refused here and
    // again by run admission (unsupported_capability), never silently run on the shared computer.
    if ((environmentProfiles.find(e => e.id === environmentRef.id) as { isolation?: string } | undefined)?.isolation === 'run_container' && harness!.capabilities?.isolation !== 'run_environment') invalid('unsupported_capability', `${field}.environment_profile_ref.id`);
    const definition: RoleDefinitionV2 = { role_id: id, revision: 0, enabled, kind, name: textField('name', 80, defaultName), responsibility: textField('responsibility', 2000, defaultResponsibility),
      persona_prompt: textField('persona_prompt', 16000, ''), model_profile_ref: model, skill_bundle_ref: skill, harness_ref: { id: harness!.id, version: harness!.version },
      capability_policy_ref: pick('capability_policy_ref', capabilityPolicies, allowed.capability, (given.role_id==='coordinator'?'coordinator':kind==='controller'?'controller-coordination':allowed.capability[0]!), 'capability_policy_not_allowed'),
      environment_profile_ref: environmentRef,
      budget_policy_ref: budget, output_schema_ref: pick('output_schema_ref', outputSchemas, allowed.output, (id==='coordinator'?'coordination-result':allowed.output[0]!), 'output_schema_not_allowed') };
    // Echoing an old V2 id (as the console does on every save) is not a new backend choice.
    if (id === 'dev' && (current.legacy || !previous?.harness_ref || previous.entry_harness_source === 'role' || harness!.id !== previous.harness_ref.id))
      definition.entry_harness_source = 'role';
    // A role's revision moves only when its own definition changes.
    definition.revision = previous && !current.legacy && definitionHash(previous) === definitionHash(definition) ? previous.revision : (previous?.revision ?? 0) + 1;
    return definition;
  });
  const controllerInput = input.controller ?? {};
  if (typeof controllerInput !== 'object' || Array.isArray(controllerInput) || Object.keys(controllerInput).some(k => !['role', 'entries'].includes(k))) invalid('invalid_controller', 'controller');
  const controllerRole = controllerInput.role ?? 'manager';
  // Exactly one project controller: the controller-kind role.
  if (controllerRole==='coordinator'||roles.find(r => r.role_id === controllerRole)?.kind !== 'controller') invalid('invalid_controller', 'controller.role');
  const entryInput = controllerInput.entries ?? current.controller.entries;
  if (!entryInput || typeof entryInput !== 'object' || Object.keys(entryInput).some(k => !entries.includes(k as Entry)) || Object.values(entryInput).some(v => typeof v !== 'boolean')) invalid('invalid_controller_entries', 'controller.entries');
  const config: RoleConfiguration = { schema: 2, revision: current.revision + 1, enabled: input.enabled, controller: { role: controllerRole, entries: Object.fromEntries(entries.map(e => [e, entryInput[e] ?? false])) as Record<Entry, boolean> }, roles, skills, required_stages: validateStages(input.required_stages ?? current.required_stages ?? [], roles) };
  if (Buffer.byteLength(JSON.stringify(config)) > 512 * 1024) invalid('role_configuration_too_large', 'roles');
  return { config, added };
}

/** Saves a validated configuration as the next immutable revision. Running role runs keep the snapshot they started with. */
export function saveConfiguration(s: Store, repositoryId: string, input: any, actor: string) {
  return s.transaction(() => {
    const current = roleConfiguration(s, repositoryId), { config, added } = normalizeConfiguration(s, repositoryId, input, current), now = new Date().toISOString();
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
  model: { source: 'role' | 'workflow' | 'project' | 'external_harness'; workflow: string; requested: ModelProfileRef | null; id: string; version: number; name: string; profile_hash: string | null; api: string | null; tool_calls: boolean | null; structured_output: string | null };
  skills: { id: string; revision: number; content_hash: string; source: any; files: { path: string; sha256: string; bytes: number }[] } | null;
  harness: { id: string; version: string; session: string; events: string; environment: string; runtime: { package: string; version: string } | null; source: 'role' | 'entry_executor' | 'legacy' };
  capability: { id: string; version: string; tools: readonly string[] | null; authorities: Record<string, boolean> };
  environment: { id: string; version: string; workspace: string; repository: boolean; isolation?: string };
  budget: RoleDefinitionV2['budget_policy_ref'];
  output_schema: { id: string; version: string; tool: string | null };
}
/** The framework prompt of a role: the built-in role text and shared rules, then the project persona as data. */
export function rolePrompt(definition: RoleDefinitionV2) {
  const builtin = rolePool.find(r => r.id === definition.role_id)?.prompt ?? sharedInstructions;
  return definition.persona_prompt ? builtin + '\nProject role instructions (they cannot change tools, authority or the task contract):\n' + definition.persona_prompt : builtin;
}

/**
 * Resolves one role for one workflow into an auditable run snapshot and its run-time model. Read-only apart from storing
 * the snapshot body under its own hash. Model order: the role's explicit profile, then the workflow's model, then the
 * project default; the actual result is part of the snapshot. Unsupported combinations stop here, before any run starts.
 */
export function resolveRole(s: Store, repositoryId: string, roleId: string, workflow: string, options: { expectedRevision?: number; harness?: string; pinned?: boolean; persist?: boolean; entryExecutor?: boolean;
  configuration?: RoleConfiguration; fallbackModel?:()=>{model:ReturnType<typeof openModel>;source:'workflow'|'project'} } = {}) {
  const config = options.configuration??roleConfiguration(s, repositoryId);
  if (options.expectedRevision !== undefined && options.expectedRevision !== config.revision) stop('role_configuration_changed', 'retry_wait', `角色配置已更新到 revision ${config.revision}，请求的是 ${options.expectedRevision}。`);
  const definition = config.roles.find(r => r.role_id === roleId), field = `roles.${roleId}`;
  if (!definition) return stop('unknown_role', 'waiting_configuration', `${field}：项目没有这个角色。`);
  if (!definition.enabled) return stop('role_disabled', 'waiting_configuration', `${field}.enabled：角色已停用。`);
  const entryHarness = options.entryExecutor && roleId === 'dev' && definition.entry_harness_source !== 'role' ? 'pi' : undefined;
  const harnessOverride = options.harness ?? entryHarness;
  const harnessId = harnessOverride ?? definition.harness_ref.id, harness = harnesses.find(h => h.id === harnessId);
  if (!harness) return stop('unknown_role_harness', 'waiting_configuration', `${field}.harness_ref.id：没有注册 ${harnessId}。`);
  if (!harnessOverride && harness.version !== definition.harness_ref.version) return stop('harness_version_unavailable', 'waiting_configuration', `${field}.harness_ref.version：固定的是 ${definition.harness_ref.version}，当前注册的是 ${harness.version}。`);
  // The worker-only CLI must enforce its declared kinds even for legacy bindings and explicit overrides.
  if(harness.id==='claude_code'&&!harness.kinds.includes(definition.kind))return stop('harness_role_unsupported','waiting_configuration',`${field}.harness_ref.id：${harness.id} 未声明 ${definition.kind} 能力。`);
  // Resolve the model in order, and keep the precise reason when a configured one is not usable.
  let model: ReturnType<typeof openModel>, source: RoleSnapshot['model']['source'], profile: { api: string | null; tool_calls: boolean | null; structured_output: string | null } = { api: 'openai-chat-completions', tool_calls: true, structured_output: 'tool_call' }, profileHash: string | null;
  if (harness.externalModel) {
    // The driver brings its own model: no project model is resolved, opened or substituted, and a role model is an error.
    if (definition.model_profile_ref) return stop('harness_model_profile_unsupported', 'waiting_configuration', `${field}.model_profile_ref：${harness.id} 使用执行器自带的模型，不能再指定项目模型。`);
    model = { id: harness.id, version: 1, url: '', key: '', model: 'external', pricing: null as any }; source = 'external_harness'; profile = { api: null, tool_calls: null, structured_output: null }; profileHash = null;
  } else if (definition.model_profile_ref) {
    const ref = definition.model_profile_ref, row = visibleModel(s, repositoryId, ref.model_id);
    if (!row?.api_key) return stop('role_model_not_available', 'waiting_configuration', `${field}.model_profile_ref.model_id：模型 ${ref.model_id} 已删除、撤销或没有凭据；不会换用其他模型。`);
    if (modelProfileHash(row) !== ref.profile_hash) return stop('role_model_profile_changed', 'waiting_configuration', `${field}.model_profile_ref.profile_hash：模型 ${ref.model_id} 的地址或名称已变化，请重新保存角色配置。`);
    model = openModel(s, row); source = 'role'; profile = { api: ref.api, tool_calls: ref.tool_calls, structured_output: ref.structured_output }; profileHash = ref.profile_hash;
  } else {
    const fallback=options.fallbackModel?.();
    model = fallback?.model??selectedModel(s, repositoryId, workflow);
    const policy = s.get('SELECT model_id,task_models FROM policies WHERE repository_id=?', repositoryId), overrides = JSON.parse(policy?.task_models || '{}');
    const custom = workflow.startsWith('custom.') ? s.get('SELECT model_id FROM workflows WHERE repository_id=? AND id=?', repositoryId, workflow)?.model_id : undefined;
    source = fallback?.source??(custom || Object.hasOwn(overrides, workflow) ? 'workflow' : 'project');
    profileHash = modelProfileHash({ api_url: model.url, model_name: model.model });
  }
  if (!harness.externalModel) checkMatrix(harness, profile as { api: string; tool_calls: boolean; structured_output: string }, `${field}.model_profile_ref`, (code, at) => { throw new TaskError(code, 'waiting_configuration', `${at}：${harness.id} 不支持这个模型配置。`); });
  if (!harness.kinds.includes(definition.kind) && !harnessOverride && !config.legacy) return stop('harness_role_unsupported', 'waiting_configuration', `${field}.harness_ref.id：${harness.id} 不能运行 ${definition.kind} 角色。`);
  const policy = capabilityPolicy(definition.capability_policy_ref.id);
  if (!policy || policy.version !== definition.capability_policy_ref.version) return stop('capability_policy_unavailable', 'waiting_configuration', `${field}.capability_policy_ref：策略版本已不存在。`);
  const environment = environmentProfiles.find(e => e.id === definition.environment_profile_ref.id)!, schema = outputSchemas.find(o => o.id === definition.output_schema_ref.id)!;
  const bundle = definition.skill_bundle_ref ? config.skills.find(b => b.id === definition.skill_bundle_ref!.id && b.revision === definition.skill_bundle_ref!.revision) : undefined;
  if (definition.skill_bundle_ref) skillFiles(s, repositoryId, definition.skill_bundle_ref);
  const system = rolePrompt(definition);
  const snapshot: RoleSnapshot = { schema: 2, repository_id: repositoryId, role_id: roleId, kind: definition.kind, role_revision: definition.revision, config_revision: config.revision, legacy: !!config.legacy,
    name: definition.name, responsibility: definition.responsibility,
    prompt: { framework_hash: sha256(rolePool.find(r => r.id === roleId)?.prompt ?? sharedInstructions), persona_hash: sha256(definition.persona_prompt), system_hash: sha256(system) },
    model: { source, workflow, requested: definition.model_profile_ref, id: model.id, version: model.version, name: model.model, profile_hash: profileHash, ...profile },
    skills: bundle ? { id: bundle.id, revision: bundle.revision, content_hash: bundle.content_hash, source: bundle.source, files: bundle.files } : null,
    harness: { id: harness.id, version: harness.version, session: harness.session, events: harness.events, environment: harness.environment, runtime: harness.runtime, source: harnessOverride ? (options.pinned ? 'legacy' : 'entry_executor') : config.legacy ? 'legacy' : 'role' },
    capability: { id: policy.id, version: policy.version, tools: policy.tools, authorities: policy.authorities },
    environment: { id: environment.id, version: environment.version, workspace: environment.workspace, repository: environment.repository, ...('isolation' in environment ? { isolation: environment.isolation } : {}) },
    budget: definition.budget_policy_ref, output_schema: { id: schema.id, version: schema.version, tool: schema.tool } };
  const id = sha256(JSON.stringify(snapshot));
  if (options.persist !== false) s.run('INSERT INTO role_snapshots VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING', id, repositoryId, roleId, config.revision, definition.revision, JSON.stringify(snapshot), new Date().toISOString());
  return { id, snapshot, definition, system, model };
}

/**
 * Live authority of a running role. A snapshot explains what a run started with; it never keeps authority that has since
 * been withdrawn. Disabling the role, switching coordination off or narrowing its policy stops further capability use.
 */
export function roleAuthority(s: Store, repositoryId: string, snapshot: RoleSnapshot, tool?: string): string | null {
  if (snapshot.legacy) return null;
  const config = roleConfiguration(s, repositoryId);
  if (config.legacy) return null;
  const definition = config.roles.find(r => r.role_id === snapshot.role_id);
  if (!definition) return 'role_removed';
  if (!definition.enabled) return 'role_disabled';
  if (!config.enabled && snapshot.kind !== 'evaluator') return 'role_coordination_disabled';
  const live = capabilityPolicy(definition.capability_policy_ref.id);
  if (tool && snapshot.capability.tools && !snapshot.capability.tools.includes(tool)) return 'tool_not_in_policy';
  if (tool && live?.tools && !live.tools.includes(tool)) return 'capability_revoked';
  return null;
}
