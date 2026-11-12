import type { Store, Row } from '../storage/database.js';
import { Redactor } from '../agent/common.js';
import { fields, text, type Json } from '../core/security.js';
import type { OwnTaskOwner } from './own-tasks.js';
import { ReadTokens } from '../agent/read-token.js';
import { RepositoryExplorer, repositoryTools } from '../agent/exploration.js';

const fn=(name:string,description:string,properties:Json,required:string[]=[])=>({type:'function',function:{name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}}});
const repository={type:'string',description:'An authorized repository full name, never a host path.'};
export const serviceRepositoryTools=repositoryTools.map(({function:tool})=>fn(tool.name,
  tool.description.replace(/\s*Call github_read_token first\./g,'')+' Select an authorized repository by full name.',
  {repository,...tool.parameters.properties},['repository',...tool.parameters.required]));

/** Scoped read tools keep the installation credential inside the control plane. */
export class ServiceRepositories {
  private readonly clients=new Map<string,{tokens:ReadTokens;explorer:RepositoryExplorer}>();
  constructor(readonly store:Store,readonly redactor:Redactor,readonly guard:()=>Promise<void>,
    readonly project:(repository:unknown)=>Row,readonly scopes:()=>string[],readonly apiUrl?:string){}
  async execute(name:string,args:Json):Promise<unknown>{
    await this.guard();const {repository,...parameters}=args,project=this.project(repository);
    let client=this.clients.get(project.id);
    if(!client){const tokens=new ReadTokens(this.store,this.store.get('SELECT * FROM repositories WHERE id=?',project.id)!,this.redactor,this.guard,this.apiUrl,this.scopes(),this.scopes);
      client={tokens,explorer:new RepositoryExplorer(tokens,this.redactor,this.guard)};this.clients.set(project.id,client);}
    const access=await client.explorer.execute('github_read_token',{});if(access.error)return access;
    return {repository:project.full_name,result:await client.explorer.execute(name,parameters)};
  }
  async close(){await Promise.allSettled([...this.clients.values()].map(client=>client.tokens.revoke()));}
}
export const serviceMemoryTools=[
  fn('search_role_memory','Search your private memory of this conversation, not shared project knowledge.',{query:{type:'string'}}),
  fn('read_role_memory','Read an exact private memory item of this conversation.',{key:{type:'string'}},['key']),
  fn('remember_role_memory','Record private memory for this conversation. It is not shared with other groups or users.',{key:{type:'string'},content:{type:'string'}},['key','content']),
];

/** Private service memory is owned by the source, not by the reusable role template alone. */
export function serviceMemory(store:Store,owner:OwnTaskOwner,name:string,args:Json):Json {
  store.db.exec(`CREATE TABLE IF NOT EXISTS service_role_memory(owner TEXT NOT NULL,key TEXT NOT NULL,body TEXT NOT NULL,
    updated_at INTEGER NOT NULL,PRIMARY KEY(owner,key))`);
  const scope=JSON.stringify(owner);
  if(name==='remember_role_memory'){
    fields(args,['key','content']);const key=text(args.key,160),content=text(args.content,16000);
    store.run('INSERT INTO service_role_memory VALUES(?,?,?,?) ON CONFLICT(owner,key) DO UPDATE SET body=excluded.body,updated_at=excluded.updated_at',
      scope,key,store.secrets.seal({content},'service-memory:'+scope+':'+key),Date.now());return {key,recorded:true};
  }
  if(name==='read_role_memory'){
    fields(args,['key']);const key=text(args.key,160),row=store.get('SELECT body FROM service_role_memory WHERE owner=? AND key=?',scope,key);
    return row?{key,...store.secrets.open(row.body,'service-memory:'+scope+':'+key)}:{error:'memory_not_found'};
  }
  fields(args,['query']);const query=String(args.query??'').toLowerCase();
  return {items:store.all('SELECT key,body FROM service_role_memory WHERE owner=? ORDER BY updated_at DESC LIMIT 100',scope)
    .map(row=>({key:row.key,...store.secrets.open(row.body,'service-memory:'+scope+':'+row.key)}))
    .filter(row=>(row.key+' '+(row as Json).content).toLowerCase().includes(query)).slice(0,20)};
}
