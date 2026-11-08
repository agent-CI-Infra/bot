import { taskModelEntries } from '../app/management.js';
import { validateRuleContent } from '../rules/service.js';
import type { ServerResponse } from 'node:http';
import type { ActorContext } from '../identity/authorization.js';
import { assertCurrent } from '../identity/authorization.js';
import { fail, fields, randomId, type Json } from '../core/security.js';
import { ManagementService } from './service.js';
import { ManagementAgent } from './agent.js';

export class ManagementApi {
  readonly agent:ManagementAgent;
  constructor(readonly service:ManagementService){this.agent=new ManagementAgent(service.store,service);}
  async api(actor:ActorContext,method:string,url:URL,input:Json):Promise<Json|undefined>{
    const path=url.pathname;if(!path.startsWith('/api/management/'))return;
    if(path==='/api/management/query'&&method==='POST')return this.service.query(actor,input);
    if(path==='/api/management/commands'&&method==='POST')return this.service.submit(actor,input);
    const command=/^\/api\/management\/commands\/([a-f0-9]+)(?:\/(resume|approval))?$/.exec(path);
    if(command){
      if(method==='GET'&&!command[2])return this.service.read(actor,command[1]!);
      if(method==='POST'&&command[2]==='resume'){fields(input,[]);return this.service.resume(actor,command[1]!);}
      if(method==='POST'&&command[2]==='approval')return this.service.approve(actor,command[1]!,input);
    }
    if(path==='/api/management/conversations'){
      if(method==='GET')return this.agent.list(actor);
      if(method==='POST')return this.agent.create(actor,input);
    }
    const conversation=/^\/api\/management\/conversations\/([a-f0-9]+)(?:\/(messages|events)(?:\/([a-f0-9]+)\/(stop))?)?$/.exec(path);
    if(conversation){
      const id=conversation[1]!;
      if(method==='GET')return this.agent.history(actor,id,Number(url.searchParams.get('after')??0));
      if(method==='POST'&&conversation[2]==='messages'){
        if(conversation[4]==='stop'){fields(input,[]);return this.agent.stop(actor,id,conversation[3]!);}
        return this.agent.send(actor,id,input);
      }
    }
    return fail(404,'management_endpoint_not_found');
  }
  async stream(actor:ActorContext,url:URL,res:ServerResponse):Promise<void>{
    const match=/^\/api\/management\/conversations\/([a-f0-9]+)\/events$/.exec(url.pathname);if(!match)fail(404,'not_found');
    const id=match![1]!;let after=Number(url.searchParams.get('after')??0);
    this.agent.history(actor,id,after);
    res.writeHead(200,{'Content-Type':'application/x-ndjson; charset=utf-8','X-Accel-Buffering':'no'});
    const until=Date.now()+25000;
    while(!res.destroyed&&Date.now()<until){
      assertCurrent(actor);
      const page=this.agent.history(actor,id,after);
      for(const event of page.events as Json[]){res.write(JSON.stringify(event)+'\n');after=Number(event.sequence);}
      if(!(page.has_more)&&!(page.messages as Json[]).some(m=>['pending','running'].includes(String(m.state))))break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }res.end();
  }
  /** The existing workflow editor uses exactly the same command handler and audit as the conversation. */
  async workflow(actor:ActorContext,method:string,url:URL,input:Json):Promise<Json|undefined>{
    const match=/^\/api\/repositories\/([^/]+)\/workflows\/([^/]+)$/.exec(url.pathname);
    if(!match||method!=='PUT'||match[2]==='assistant')return;
    const project=match[1]!,workflow=decodeURIComponent(match[2]!);
    this.service.scope(actor,project,'config.write');
    const {version,...args}=input;
    const current=this.service.store.get('SELECT version FROM workflows WHERE repository_id=? AND id=?',project,workflow)?.version??0;
    if(version!==undefined&&Number(version)!==Number(current))fail(409,'workflow_version_conflict');
    const receipt=await this.service.submit(actor,{operation:'workflow.update',target:{project_id:project,workflow_id:workflow},arguments:args,
      expected_revision:this.service.revision({project_id:project}),idempotency_key:'console:'+randomId(),source_conversation:'console:workflow',source_message:actor.request_id});
    if(receipt.state==='awaiting_approval')fail(409,'management_approval_required');
    if(receipt.state!=='succeeded')fail(Number((receipt.result as Json)?.http_status??409),String((receipt.result as Json)?.error??'management_command_failed'),(receipt.result as {field?:string})?.field);
    return {workflow:(await this.service.workflows.list(project)).workflows.find(w=>w.id===workflow),management:receipt};
  }
  async task(actor:ActorContext,method:string,url:URL,input:Json):Promise<Json|undefined>{
    const create=url.pathname==='/api/tasks'&&method==='POST';
    const match=/^\/api\/tasks\/([^/]+)\/(retry|pause|cancel|instructions|adopt-config|contract)$/.exec(url.pathname);
    const role=/^\/api\/repositories\/([^/]+)\/roles$/.exec(url.pathname);
    const policy=/^\/api\/repositories\/([^/]+)\/policy$/.exec(url.pathname);
    const rules=/^\/api\/repositories\/([^/]+)\/rules$/.exec(url.pathname);
    if(!create&&!(match&&method===(match[2]==='contract'?'PATCH':'POST'))&&!(role&&method==='PUT')&&!(policy&&method==='PATCH')&&!(rules&&method==='PUT'))return;
    const task=match?this.service.store.get('SELECT repository_id FROM tasks WHERE id=?',match[1]!):null;
    const project=create?String(input.repository_id??''):role?role[1]!:rules?rules[1]!:policy?policy[1]!:String(task?.repository_id??'');
    this.service.scope(actor,project,role?'roles.edit':policy||rules?'config.write':'tasks.write');
    const operation=role?'roles.update':rules?'rules.update':policy?'project.update':create?'task.create':'task.'+match![2];
    if(policy&&input.task_models!==undefined)taskModelEntries(input.task_models);
    if(rules)validateRuleContent(input.content);
    let args={...input};delete args.repository_id;
    if(match?.[2]==='contract'){
      const current=this.service.store.get('SELECT revision FROM task_records WHERE task_id=?',match[1]!);
      if(input.expected_revision!==current?.revision)fail(409,'task_revision_changed');delete args.expected_revision;
    }
    const target={project_id:project,...(match?{task_id:match[1]!}:{})};
    const receipt=await this.service.submit(actor,{operation,target,arguments:args,expected_revision:this.service.revision(target),idempotency_key:'console:'+randomId(),source_conversation:'console:'+operation,source_message:actor.request_id});
    if(receipt.state==='awaiting_approval')fail(409,'management_approval_required');
    if(receipt.state!=='succeeded')fail(Number((receipt.result as Json)?.http_status??409),String((receipt.result as Json)?.error??'management_command_failed'),(receipt.result as {field?:string})?.field);
    if(rules)return {rules:await this.service.workflows.rules.view(project),management:receipt};
    return {...receipt.result as Json,management:receipt};
  }
}
