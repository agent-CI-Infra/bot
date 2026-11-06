// Publication/scheduling fixtures substitute for the independent model just as their manager substitutes for the runner.
// Real evaluator transport, context isolation and semantic failure/recovery are tested in task-acceptance.test.mjs.
import assert from 'node:assert/strict';
import { TaskRecords } from '../dist/tasks/service.js';
export async function acceptanceFixture(store, task) {
 const record=new TaskRecords(store).get(task.id);
 assert.ok(record.candidate,'delivery must submit an actual versioned candidate');
 assert.equal(record.candidate.revision,record.revision);
 return {outcome:'pass',reason:'Independent fixture accepted this candidate',gaps:[],residuals:[],core_complete:true,required_evidence_complete:true,acceptable_risk:true};
}
