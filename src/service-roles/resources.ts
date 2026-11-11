import type { Store, Row } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import { Workspace } from '../agent/workspace.js';
import { Redactor } from '../agent/common.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import type { OwnTaskOwner } from './own-tasks.js';
import { ReadTokens } from '../agent/read-token.js';
import { RepositoryExplorer, repositoryTools } from '../agent/exploration.js';

const fn=(name:string,description:string,properties:Json,required:string[]=[])=>({type:'function',function:{name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}}});
const repository={type:'string',description:'An authorized repository full name, never a host path.'},path={type:'string'};
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
export const serviceComputerTools=[
  fn('read_file','Read a file in your private workspace on this project computer.',{repository,path},['repository','path']),
  fn('write_file','Write a file in your private project workspace. This never publishes repository changes.',{repository,path,content:{type:'string'}},['repository','path','content']),
  fn('run_command','Run a command in your private project workspace; no host credentials or publication authority.',{repository,command:{type:'string'}},['repository','command']),
];
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

/** One disposable workspace per source turn and repository, guarded before and after every manager operation. */
export class ServiceComputers {
  private readonly spaces=new Map<string,Workspace>();
  constructor(readonly store:Store,readonly manager:Manager|undefined,readonly id:string,readonly conversation:string,
    readonly redactor:Redactor,readonly check:()=>Promise<void>,readonly project:(repository:unknown)=>Row){
    // Service turns belong to management/group conversations, not project RoleConversation rows.
    store.db.exec(`CREATE TABLE IF NOT EXISTS service_role_operations(id TEXT PRIMARY KEY,turn_id TEXT NOT NULL,
      request TEXT NOT NULL,result TEXT,state TEXT NOT NULL)`);
  }
  async execute(name:string,args:Json):Promise<unknown>{
    if(!this.manager)fail(409,'computer_not_configured');
    fields(args,name==='read_file'?['repository','path']:name==='write_file'?['repository','path','content']:['repository','command']);
    await this.check();const project=this.project(args.repository);
    let space=this.spaces.get(project.id);
    if(!space){
      let environment=await this.manager!.call('GET','/v1/projects/'+project.id);
      if(!environment)environment=await this.manager!.call('PUT','/v1/projects/'+project.id);
      if(!['ready','busy'].includes(environment?.state))fail(409,'environment_not_ready');
      const generation=environment.generation;
      const guard=async()=>{await this.check();this.project(args.repository);const current=await this.manager!.call('GET','/v1/projects/'+project.id);if(current?.generation!==generation)fail(409,'environment_generation_changed');};
      space=new Workspace(this.store,this.manager!,{id:this.id+':'+project.id,conversation_id:this.conversation,repository_id:project.id,workspace_id:randomId(),generation,attempt:1},this.redactor,guard,()=>{},'service_role_operations');
      const initialized=await space.call('initialize',{type:'workspace_init'});if(initialized.error)fail(409,'workspace_init_failed');
      this.spaces.set(project.id,space);
    }
    const key='service:'+randomId();
    if(name==='read_file')return space.call(key,{type:'workspace_read',path:text(args.path,2048)});
    if(name==='write_file'){if(typeof args.content!=='string'||args.content.length>48000||args.content.includes('\0'))fail(400,'invalid_field','content');await space.write(key,text(args.path,2048),Buffer.from(args.content as string));return {written:true};}
    return space.call(key,{type:'workspace_command',command:text(args.command,16000),timeout_ms:120000});
  }
  async close(){await Promise.allSettled([...this.spaces.values()].map(space=>space.release(false)));}
}
