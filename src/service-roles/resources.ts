import type { Store, Row } from '../storage/database.js';
import { Redactor } from '../agent/common.js';
import type { Json } from '../core/security.js';
import { ReadTokens } from '../agent/read-token.js';
import { RepositoryExplorer, repositoryTools } from '../agent/exploration.js';

const fn=(name:string,description:string,properties:Json,required:string[]=[])=>({type:'function',function:{name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}}});
const repository={type:'string',description:'An authorized repository full name, never a host path.'};
export const serviceRepositoryTools=repositoryTools.map(({function:tool})=>fn(tool.name,
  tool.description.replace(/\s*Call github_read_token first\./g,'')+' Select an authorized repository by full name.',
  {repository,...tool.parameters.properties},['repository',...tool.parameters.required]));

/**
 * Scoped read tools keep the installation credential inside the control plane. `project` resolves the repository the model
 * named to the row tokens are issued for (id, full_name, owner_id, account_id): a started project, or for an onboarding
 * session (#930) a repository installed but not started yet.
 */
export class ServiceRepositories {
  private readonly clients=new Map<string,{tokens:ReadTokens;explorer:RepositoryExplorer}>();
  constructor(readonly store:Store,readonly redactor:Redactor,readonly guard:()=>Promise<void>,
    readonly project:(repository:unknown)=>Row,readonly scopes:()=>string[],readonly apiUrl?:string){}
  async execute(name:string,args:Json):Promise<unknown>{
    await this.guard();const {repository,...parameters}=args,project=this.project(repository);
    let client=this.clients.get(project.id);
    if(!client){const tokens=new ReadTokens(this.store,project,this.redactor,this.guard,this.apiUrl,this.scopes(),this.scopes);
      client={tokens,explorer:new RepositoryExplorer(tokens,this.redactor,this.guard)};this.clients.set(project.id,client);}
    // A rate limit is answered, not thrown, so it never ends the assistant's turn (#1393).
    const out=await client.explorer.executeConnected(name,parameters);
    return 'refused' in out?out.refused:{repository:project.full_name,result:out.result};
  }
  async close(){await Promise.allSettled([...this.clients.values()].map(client=>client.tokens.revoke()));}
}
