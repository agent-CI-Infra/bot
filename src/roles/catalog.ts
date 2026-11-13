import { createHash } from 'node:crypto';
import { permissionItems } from './permissions.js';
/**
 * Server-defined, versioned building blocks a RoleDefinitionV2 can reference. Project configuration selects entries by id;
 * it never supplies tools, authorities or executable code. Every version is the hash of the entry's own content, so a
 * snapshot that names a version also fixes what that version meant.
 */
const version = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** A role's kind selects its runtime contract and workspace, independently of its editable permissions. */
export type RoleKind = 'controller' | 'writer' | 'observer' | 'evaluator';
export const builtinKinds: Record<string, RoleKind> = { coordinator:'controller', manager: 'controller', dev: 'writer', test: 'observer', reviewer: 'observer', ux: 'observer', qa: 'evaluator' };
export const roleKind = (id: string): RoleKind => Object.hasOwn(builtinKinds, id) ? builtinKinds[id]! : 'observer';

/**
 * Environment profiles describe where a role run executes. The first four share the project computer (directories of one
 * container, one uid). The isolated profiles provision a container for each run (see src/projects/run-environment.ts);
 * admission requires a harness that executes inside it and the manager's inspection of that container.
 */
const environments = [
  { id: 'control-session', kinds: ['controller'], workspace: 'empty', repository: false, description: 'Fresh restricted Pi session per task run; no repository checkout or shell.' },
  { id: 'task-workspace', kinds: ['writer'], workspace: 'task', repository: true, description: 'The task workspace that holds the candidate.' },
  { id: 'candidate-checkout', kinds: ['observer'], workspace: 'disposable', repository: true, description: 'A disposable checkout of the fixed candidate snapshot.' },
  { id: 'evaluation-checkout', kinds: ['evaluator'], workspace: 'disposable', repository: true, description: 'A fresh checkout of the exact candidate for independent acceptance.' },
  { id: 'isolated-workspace', kinds: ['writer'], workspace: 'run', repository: true, isolation: 'run_container', description: 'A container of its own for each run: own HOME, processes, tmp, caches and network identity; writes only its own tmpfs workspace, seeded from the fixed source.' },
  { id: 'isolated-candidate', kinds: ['observer', 'evaluator'], workspace: 'run', repository: true, isolation: 'run_container', description: 'A container of its own for each run, built from the fixed candidate; no developer volume is mounted.' }
] as const;
export const environmentProfiles = environments.map(e => ({ ...e, version: version(e) }));

/** Configured per-run limits replace entry defaults; cumulative limits use their own units. */
const budgets = [
  { id: 'entry-default', description: 'The entry point\'s trusted turn and output limits.' },
  { id: 'bounded', description: 'Explicit per-run max_turns (4-256) and max_output_tokens (256-32768); omitted values use entry defaults.' },
  // Cumulative over every run of the role in its task (recoveries, attempts, delegations, sub-agents); see src/roles/role-run.ts.
  { id: 'metered', description: 'bounded limits plus cumulative max_total_tokens, max_model_requests, max_tool_calls, max_wall_seconds for the role within its task. Unknown usage is never counted as zero.' }
] as const;
export const budgetPolicies = budgets.map(b => ({ ...b, version: version(b) }));

// The structured submissions each kind ends with. The schema text itself is the versioned content.
export const findingsSchema = { type: 'object', properties: { summary: { type: 'string' }, findings: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } }, severity: { type: 'string' } }, required: ['description', 'evidence'], additionalProperties: false } }, inspected_scope: { type: 'array', items: { type: 'string' } }, unknowns: { type: 'array', items: { type: 'string' } } }, required: ['summary', 'findings', 'inspected_scope', 'unknowns'], additionalProperties: false };
export const nominationSchema = { type: 'object', properties: { result_ref: { type: 'string' } }, required: ['result_ref'], additionalProperties: false };
export const coordinationResultSchema={type:'object',properties:{summary:{type:'string'},outcome:{type:'string',enum:['notices','needs_human']},notices:{type:'array',items:{type:'object',properties:{task_id:{type:'string'},message:{type:'string'},action:{type:'string',enum:['review','rework']}},required:['task_id','message','action'],additionalProperties:false}}},required:['summary','outcome','notices'],additionalProperties:false};
const schemas = [
  { id: 'delivery-nomination', kinds: ['controller'], tool: 'nominate_delivery', schema: nominationSchema },
  { id: 'coordination-result', kinds: ['controller'], tool: 'submit_coordination', schema: coordinationResultSchema },
  { id: 'entry-delivery', kinds: ['writer'], tool: null, schema: null, description: 'The entry point\'s own submission: submit_delivery, finish_review or the event workflow finish tool.' },
  { id: 'role-findings', kinds: ['observer'], tool: 'submit_role_result', schema: findingsSchema },
  { id: 'acceptance-verdict', kinds: ['evaluator'], tool: 'submit_acceptance', schema: null, description: 'The framework acceptance verdict validated by validateVerdict.' }
] as const;
export const outputSchemas = schemas.map(s => ({ ...s, version: version(s) }));

/** Each kind's selectable entries. The first is the default. */
export const allowedFor = (kind: RoleKind) => ({
  environment: environmentProfiles.filter(e => (e.kinds as readonly string[]).includes(kind)).map(e => e.id),
  output: outputSchemas.filter(s => (s.kinds as readonly string[]).includes(kind)).map(s => s.id)
});
export const catalog = () => ({ permission_items: permissionItems, environment_profiles: environmentProfiles, budget_policies: budgetPolicies, output_schemas: outputSchemas });
