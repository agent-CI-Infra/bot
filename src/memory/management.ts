import type { ManagementService } from '../management/service.js';
import { ProjectMemory } from './project.js';
import { memoryApi } from './api.js';

/** Management, Web, Pi and ACP share ProjectMemory; adapters never maintain a knowledge body cache. */
export function registerKnowledge(service: ManagementService, githubUrl?: string): void {
  service.knowledgeSearch = async (actor, project, query, offset, limit) => {
    const memory = new ProjectMemory(service.store, { actor }), items = []; let after: string | undefined;
    do {
      const page = memory.search(project, query, { after, limit: 50 }); items.push(...page.items); after = page.next_after ?? undefined;
    } while (after && items.length <= offset + limit);
    return { items: items.slice(offset, offset + limit), next_offset: items.length > offset + limit || after ? offset + limit : null };
  };
  service.knowledgeRead=async(actor,project,id,revision,versions,baseline)=>(await memoryApi(service.store,service.user(actor),'GET',new URL('http://local/api/repositories/'+encodeURIComponent(project)+'/memories/'+encodeURIComponent(id)+(versions?'/versions':'')+'?'+new URLSearchParams({...revision?{revision:String(revision)}:{},...baseline?{baseline}:{}})),{},githubUrl))!;
  service.register('knowledge.revise', {
    async reconcile(actor, command, key) {
      const m = new ProjectMemory(service.store, { actor }), old = m.get(command.target.project_id, String(command.arguments.id));
      const row = service.store.get('SELECT revision FROM project_memory_versions WHERE memory_id=? AND reason=?', old.id, 'management:' + key + (command.arguments.reason ? '; '+command.arguments.reason : ''));
      return row ? { memory: m.get(command.target.project_id, old.id, row.revision) } : null;
    },
    async execute(actor, command, key) {
      const args = command.arguments, action = typeof args.action === 'string' ? args.action : null;
      return (await memoryApi(service.store, service.user(actor), action ? 'POST' : 'PATCH',
        new URL('http://local/api/repositories/' + encodeURIComponent(command.target.project_id) + '/memories/' + encodeURIComponent(String(args.id)) + (action ? '/review' : '')),
        { expected_revision: args.revision, reason: 'management:' + key + (args.reason ? '; '+args.reason : ''), ...(action ? { action, evidence: args.evidence, supersedes: args.supersedes, run_id: args.run_id } : { body: args.body }), ...(args.catalog ? { catalog: args.catalog } : {}) }, githubUrl))!;
    },
  });
}
