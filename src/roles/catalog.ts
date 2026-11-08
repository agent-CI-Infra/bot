import { createHash } from 'node:crypto';
/**
 * Server-defined, versioned building blocks a RoleDefinitionV2 can reference. Project configuration selects entries by id;
 * it never supplies tools, authorities or executable code. Every version is the hash of the entry's own content, so a
 * snapshot that names a version also fixes what that version meant.
 */
const version = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** A role's kind fixes the most authority it can ever hold; configuration can only choose an equal or narrower policy. */
export type RoleKind = 'controller' | 'writer' | 'observer' | 'evaluator';
export const builtinKinds: Record<string, RoleKind> = { coordinator:'controller', manager: 'controller', dev: 'writer', test: 'observer', reviewer: 'observer', ux: 'observer', qa: 'evaluator' };
export const roleKind = (id: string): RoleKind => Object.hasOwn(builtinKinds, id) ? builtinKinds[id]! : 'observer';

/** Authorities that no role policy grants. They stay with the framework, an explicit operator or GitHub rules. */
const reserved = { edit_candidate: false, finish_task: false, override_qa: false, publish: false, merge: false, grant_permissions: false };
const observerTools = ['read_file', 'run_command', 'read_task_history', 'read_playbook', 'select_playbooks', 'search_project_memory', 'read_project_memory', 'read_related_artifact', 'read_task_record', 'submit_role_result', 'search_role_memory', 'read_skill'];
const policies = [
  // The controller queries task facts, delegates, coordinates and nominates. It has no product, publication or acceptance tool.
  { id: 'controller', kind: 'controller', tools: ['read_task_record', 'read_task_history', 'read_playbook', 'select_playbooks', 'record_progress', 'delegate_role', 'nominate_delivery', 'read_skill'],
    authorities: { ...reserved, query_facts: true, delegate: true, coordinate: true, nominate: true } },
  // The writer keeps the entry's existing trusted tool profile (the workflow permissions); null means "the entry's tools".
  { id:'controller-coordination',kind:'controller',tools:['read_task_record','read_task_history','read_playbook','select_playbooks','record_progress','delegate_role','nominate_delivery','read_skill','read_coordination','list_project_tasks','wait_for_tasks','request_task_coordination','acknowledge_coordination'],authorities:{...reserved,query_facts:true,delegate:true,coordinate:true,nominate:true}},
  { id:'coordinator',kind:'controller',tools:['read_project_task','submit_coordination'],authorities:{...reserved,query_facts:true,coordinate:true,delegate:false,nominate:false}},
  { id: 'writer', kind: 'writer', tools: null, authorities: { ...reserved, edit_candidate: true, query_facts: true, delegate: false, nominate: false } },
  { id: 'observer', kind: 'observer', tools: observerTools, authorities: { ...reserved, query_facts: true, delegate: false, nominate: false } },
  { id: 'observer-readonly', kind: 'observer', tools: observerTools.filter(name => name !== 'run_command'), authorities: { ...reserved, query_facts: true, delegate: false, nominate: false } },
  { id: 'evaluator', kind: 'evaluator', tools: null, authorities: { ...reserved, query_facts: true, decide_acceptance: true, delegate: false, nominate: false } }
] as const;
export interface CapabilityPolicy { id: string; version: string; kind: RoleKind; tools: readonly string[] | null; authorities: Record<string, boolean> }
export const capabilityPolicies: CapabilityPolicy[] = policies.map(p => ({ ...p, version: version(p) }));
export const capabilityPolicy = (id: string) => capabilityPolicies.find(p => p.id === id);

/** Environment profiles describe where a role run executes. #169 will add separately provisioned environments. */
const environments = [
  { id: 'control-session', kinds: ['controller'], workspace: 'empty', repository: false, description: 'Fresh restricted Pi session per task run; no repository checkout or shell.' },
  { id: 'task-workspace', kinds: ['writer'], workspace: 'task', repository: true, description: 'The task workspace that holds the candidate.' },
  { id: 'candidate-checkout', kinds: ['observer'], workspace: 'disposable', repository: true, description: 'A disposable checkout of the fixed candidate snapshot.' },
  { id: 'evaluation-checkout', kinds: ['evaluator'], workspace: 'disposable', repository: true, description: 'A fresh checkout of the exact candidate for independent acceptance.' }
] as const;
export const environmentProfiles = environments.map(e => ({ ...e, version: version(e) }));

/** Budgets can only lower the trusted limits an entry already applies. */
const budgets = [
  { id: 'entry-default', description: 'The entry point\'s trusted turn and output limits.' },
  { id: 'bounded', description: 'Explicit max_turns (4-256) and max_output_tokens (256-32768), each capped by the entry limit.' }
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
  capability: capabilityPolicies.filter(p => p.kind === kind).map(p => p.id),
  environment: environmentProfiles.filter(e => (e.kinds as readonly string[]).includes(kind)).map(e => e.id),
  output: outputSchemas.filter(s => (s.kinds as readonly string[]).includes(kind)).map(s => s.id)
});
export const catalog = () => ({ capability_policies: capabilityPolicies, environment_profiles: environmentProfiles, budget_policies: budgetPolicies, output_schemas: outputSchemas });
