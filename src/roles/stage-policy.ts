import type { RoleDefinitionV2 } from './definition.js';
import { capabilityNames, type CapabilityName } from './protocol.js';
import { fail } from '../core/security.js';

export interface StageDefinition {
  stage_id: string;
  depends_on: string[];
  delivery_types: ('code' | 'artifact' | 'no_changes')[];
  role_constraints: { kinds: ('writer' | 'observer')[]; role_ids?: string[]; capabilities: CapabilityName[]; independent: boolean };
  required: boolean;
  completion: { evidence_types: string[]; min_evidence: number; no_findings: boolean; tools?: string[] };
  retry: { max_attempts: number };
  budget: { max_tool_calls?: number; max_wall_seconds?: number };
}
/** Tool documentation of the existing StageDefinition contract; validation/authority remains below. */
export const stageDefinitionSchema={type:'object',additionalProperties:false,required:['stage_id','depends_on','delivery_types','role_constraints','required','completion','retry','budget'],properties:{
 stage_id:{type:'string'},depends_on:{type:'array',items:{type:'string'}},delivery_types:{type:'array',items:{type:'string',enum:['code','artifact','no_changes']}},
 role_constraints:{type:'object',additionalProperties:false,required:['kinds','capabilities','independent'],properties:{kinds:{type:'array',items:{type:'string',enum:['writer','observer']}},role_ids:{type:'array',items:{type:'string'}},capabilities:{type:'array',items:{type:'string',enum:capabilityNames}},independent:{type:'boolean'}}},
 required:{type:'boolean'},completion:{type:'object',additionalProperties:false,required:['evidence_types','min_evidence','no_findings'],properties:{evidence_types:{type:'array',items:{type:'string',enum:['tool_observation','execution_evidence','role_result']}},min_evidence:{type:'integer'},no_findings:{type:'boolean'},tools:{type:'array',items:{type:'string',enum:['read_file','run_command','read_task_record','read_evidence','submit_delivery','finish']}}}},
 retry:{type:'object',additionalProperties:false,required:['max_attempts'],properties:{max_attempts:{type:'integer'}}},budget:{type:'object',additionalProperties:false,properties:{max_tool_calls:{type:'integer'},max_wall_seconds:{type:'integer'}}}
}};
const evidenceTypes = ['tool_observation', 'execution_evidence', 'role_result'];
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: any, allowed: string[]) => object(value) && Object.keys(value).every(k => allowed.includes(k));
const strings = (value: any, allowed?: readonly string[]) => Array.isArray(value) && value.length > 0 && value.length <= 32 && new Set(value).size === value.length && value.every(v => typeof v === 'string' && (!allowed || allowed.includes(v)));
const positive = (value: any, max: number) => Number.isSafeInteger(value) && value > 0 && value <= max;
export function stageAllows(stage: StageDefinition, role: Pick<RoleDefinitionV2, 'role_id' | 'kind' | 'enabled'>) {
  return role.enabled && stage.role_constraints.kinds.includes(role.kind as 'writer' | 'observer') && (!stage.role_constraints.role_ids || stage.role_constraints.role_ids.includes(role.role_id));
}
/** Project policy is executable validation data. Neither persona text nor workflow diagrams can create it. */
export function validateStages(value: unknown, roles: RoleDefinitionV2[], field = 'required_stages'): StageDefinition[] {
  const invalid = (detail: string): never => fail(400, 'invalid_stage_policy', `${field}.${detail}`);
  if (!Array.isArray(value) || value.length > 32) invalid('stages');
  const stages = value as StageDefinition[];
  for (const stage of stages) {
    if (!keys(stage, ['stage_id','depends_on','delivery_types','role_constraints','required','completion','retry','budget']) || !/^[a-z][a-z0-9_-]{0,63}$/.test(stage.stage_id)) invalid('stage_id');
    const id = stage.stage_id, r = stage.role_constraints, c = stage.completion;
    if (!Array.isArray(stage.depends_on) || stage.depends_on.length > 32 || new Set(stage.depends_on).size !== stage.depends_on.length || stage.depends_on.some(d => typeof d !== 'string')) invalid(id + '.depends_on');
    if (!strings(stage.delivery_types, ['code','artifact','no_changes']) || typeof stage.required !== 'boolean') invalid(id + '.delivery_types');
    if (!keys(r, ['kinds','role_ids','capabilities','independent']) || (!strings(r.kinds, ['writer','observer']) || r.kinds.length!==1) || !strings(r.capabilities, capabilityNames) || typeof r.independent !== 'boolean' || r.role_ids !== undefined && !strings(r.role_ids)) invalid(id + '.role_constraints');
    if(r.kinds.includes('writer')&&stage.depends_on.length)invalid(id+'.writer_dependency');
    if (r.independent && (r.kinds.includes('writer') || !['fresh_context','fixed_candidate_read','raw_evidence'].every(c => r.capabilities.includes(c as CapabilityName)))) invalid(id + '.independence');
    if (!roles.some(role => stageAllows(stage, role))) invalid(id + '.unreachable_role');
    if (!keys(c, ['evidence_types','min_evidence','no_findings','tools']) || !strings(c.evidence_types, evidenceTypes) || !positive(c.min_evidence, 100) || typeof c.no_findings !== 'boolean' || c.tools!==undefined&&!strings(c.tools,['read_file','run_command','read_task_record','read_evidence','submit_delivery','finish']) || c.no_findings && r.kinds.includes('writer')) invalid(id + '.completion');
    if (!keys(stage.retry, ['max_attempts']) || !positive(stage.retry.max_attempts, 20)) invalid(id + '.retry');
    if (!keys(stage.budget, ['max_tool_calls','max_wall_seconds']) || Object.entries(stage.budget).some(([key, n]) => !positive(n, key === 'max_tool_calls' ? 10000 : 86400))) invalid(id + '.budget');
  }
  if (new Set(stages.map(s => s.stage_id)).size !== stages.length) invalid('duplicate_stage_id');
  for(const type of ['code','artifact','no_changes'])if(stages.filter(stage=>stage.delivery_types.includes(type as any)&&stage.role_constraints.kinds.includes('writer')).length>1)invalid('multiple_writers');
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (stage: StageDefinition) => {
    if (visiting.has(stage.stage_id)) invalid(stage.stage_id + '.cycle');
    if (visited.has(stage.stage_id)) return;
    visiting.add(stage.stage_id);
    for (const id of stage.depends_on) {
      const dep = stages.find(s => s.stage_id === id);
      if (!dep || stage.delivery_types.some(t => !dep.delivery_types.includes(t)) || stage.required && !dep.required) invalid(stage.stage_id + '.unreachable_dependency');
      visit(dep!);
    }
    visiting.delete(stage.stage_id); visited.add(stage.stage_id);
  };
  stages.forEach(visit);
  return JSON.parse(JSON.stringify(stages));
}
