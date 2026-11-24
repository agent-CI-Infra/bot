import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';
import { scriptedServiceAssistants, withLentSessionWorkspaces } from './scripted-roles.mjs';

/**
 * The tool results a fixture model has seen, as a model reads them. A result over its share of the context is cut, and the cut
 * keeps small top-level fields (revision, ids, states) under `fields` (src/agent/tool-context.ts); they are lifted back to the
 * top, so a step reading `revision` does not depend on how large get_effective_config has grown.
 */
export const toolResults = body => body.messages.filter(m => m.role === 'tool').map(m => {
  const value = JSON.parse(m.content);
  return value?.truncated && value.fields ? { ...value.fields, ...value } : value;
});

export const isTitleRequest = body => body.messages[0]?.content?.startsWith('Generate a short conversation title');
export function replyWithTitle(response, title = '查看项目任务状态') {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: title } }],
    usage: { prompt_tokens: 12, completion_tokens: 6 } }));
}

export async function managementFixture(t,options={},manager=undefined) {
  // The fixture model answers in process: the management assistant and bound groups run the scripted test driver (#1256;
  // scripted-roles.mjs), whose turns borrow an empty session workspace from the assistant computers the fixture lacks.
  const h=await harness(t,manager,withLentSessionWorkspaces(options)),{admin,password}=await setup(h),a=await account(admin);
  scriptedServiceAssistants(h.store);
  await repository(admin,a.id,'101');await repository(admin,a.id,'102');await repository(admin,a.id,'201');
  h.store.run("UPDATE repositories SET full_name='agent-test-zone/admin-fixture-'||id,owner_id=CASE WHEN id='201' THEN '20' ELSE '10' END");
  const time=new Date().toISOString();
  for(const [id,project] of [['blocked','101'],['foreign','201']]){
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,error_code,created_at,updated_at) VALUES(?,?,'task.request','waiting_environment','prepare','Inspect task facts','environment_not_ready',?,?)",id,project,time,time);
    h.store.run('INSERT INTO task_logs(id,task_id,content,created_at) VALUES(?,?,?,?)','log-'+id,id,JSON.stringify({type:'fault',code:'environment_not_ready',detail:'Project computer is stopped'}),time);
  }
  const requests=[],titleRequests=[],modelState={gate:null,failure:0,configurationPrompt:null};
  const provider=createServer(async(req,res)=>{
    // Whole-body decoding: a multibyte character may be split across chunks.
    const chunks=[];for await(const b of req)chunks.push(b);const body=JSON.parse(Buffer.concat(chunks).toString());
    if(isTitleRequest(body)){
      titleRequests.push(body);
      if(modelState.titleRespond){await modelState.titleRespond(body,res);return;}
      return replyWithTitle(res);
    }
    requests.push(body);
    if(modelState.gate)await modelState.gate;
    if(modelState.respond){await modelState.respond(body,res);return;}
    if(modelState.failure){res.writeHead(modelState.failure,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture model failure'}}));return;}
    const context=JSON.parse(body.messages[1].content),calls=body.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls??[]),observations=toolResults(body);
    const request=String(context.request),configuration=request.includes('提示词'),pause=request.includes('暂停');
    const call=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'call-'+calls.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    let message;
    if(!calls.length)message=call('management_query',{operation:configuration?'get_effective_config':'get_task',target:configuration?{project_id:'101'}:{project_id:'101',task_id:'blocked'},arguments:{}});
    else if((configuration||pause)&&calls.length===1)message=call('management_command',{operation:configuration?'manager.update':'task.pause',target:configuration?{project_id:'101'}:{project_id:'101',task_id:'blocked'},arguments:configuration?{prompt:modelState.configurationPrompt??'Inspect evidence and cite the original logs.'}:{},expected_revision:observations[0].revision});
    // A refused call comes back as its observation on a steering driver (#1256): the answer then reports it.
    else if(observations.at(-1)?.error)message={role:'assistant',content:'没有完成：'+observations.at(-1).error};
    else message={role:'assistant',content:configuration?'默认提示词已保存；只影响之后的新任务。':pause?'任务已暂停，状态可以回读。':'任务正在等待项目电脑；原因来自持久化状态，可检查原始日志。'};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:12,completion_tokens:6}}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t?.after(()=>new Promise(r=>{provider.close(r);provider.closeAllConnections();}));
  const model=(await admin('/api/models','POST',{repository_id:'101',model_name:'Management fixture',api_url:`http://127.0.0.1:${provider.address().port}/v1`,api_key:'fixture-provider-key'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  // The management assistant is a service role with its own shared model; project 101's model only runs project tasks.
  const assistantModel=(await admin('/api/models','POST',{model_name:'Management fixture',api_url:`http://127.0.0.1:${provider.address().port}/v1`,api_key:'fixture-provider-key'})).value.model;
  const assistant=(await admin('/api/service-roles')).value.service_roles.find(r=>r.id==='management-assistant');
  await admin('/api/service-roles/management-assistant','PATCH',{expected_revision:assistant.revision,model_id:assistantModel.id});
  async function member(name,grants){
    const password=testPassword(),created=await admin('/api/users','POST',{username:name,password,...grants}),client=h.client();
    await client('/api/auth/login','POST',{username:name,password});return {id:created.value.user.id,client,password};
  }
  return {h,admin,password,a,model,assistantModel,requests,titleRequests,modelState,provider,member,close:async()=>{await h.stop();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});}};
}
export const query=(client,operation,target={},args={})=>client('/api/management/query','POST',{operation,target,arguments:args});
export async function command(client,operation,target,args={},key='command-'+Math.random(),revision){
  const current=revision??(await query(client,target.task_id?'get_task':'get_effective_config',target)).value.revision;
  return client('/api/management/commands','POST',{operation,target,arguments:args,expected_revision:current,idempotency_key:key,source_conversation:'fixture-conversation',source_message:key});
}
export async function settled(client,conversation,message){
  for(let i=0;i<200;i++){
    const result=await client('/api/management/conversations/'+conversation+'/events');
    const row=result.value.messages?.find(m=>m.id===message);
    if(row&&!['pending','running'].includes(row.state))return result.value;
    await new Promise(r=>setTimeout(r,10));
  }throw new Error('management_message_timeout');
}
