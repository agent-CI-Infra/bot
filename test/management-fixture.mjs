import { createServer } from 'node:http';
import { once } from 'node:events';
import { harness, setup, account, repository, testPassword } from './helpers.mjs';

export async function managementFixture(t,options={}) {
  const h=await harness(t,undefined,options),{admin,password}=await setup(h),a=await account(admin);
  await repository(admin,a.id,'101');await repository(admin,a.id,'102');await repository(admin,a.id,'201');
  h.store.run("UPDATE repositories SET full_name='agent-test-zone/admin-fixture-'||id,owner_id=CASE WHEN id='201' THEN '20' ELSE '10' END");
  const time=new Date().toISOString();
  for(const [id,project] of [['blocked','101'],['foreign','201']]){
    h.store.run("INSERT INTO tasks(id,repository_id,kind,status,phase,summary,error_code,created_at,updated_at) VALUES(?,?,'task.request','waiting_environment','prepare','Inspect task facts','environment_not_ready',?,?)",id,project,time,time);
    h.store.run('INSERT INTO task_logs VALUES(?,?,?,?)','log-'+id,id,JSON.stringify({type:'fault',code:'environment_not_ready',detail:'Project computer is stopped'}),time);
  }
  const requests=[],modelState={gate:null,failure:0};
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);requests.push(body);
    if(modelState.gate)await modelState.gate;
    if(modelState.respond){await modelState.respond(body,res);return;}
    if(modelState.failure){res.writeHead(modelState.failure,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixture model failure'}}));return;}
    const context=JSON.parse(body.messages[1].content),calls=body.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls??[]),observations=body.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
    const request=String(context.request),configuration=request.includes('提示词'),pause=request.includes('暂停');
    const call=(name,args)=>({role:'assistant',content:null,tool_calls:[{id:'call-'+calls.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
    let message;
    if(!calls.length)message=call('management_query',{operation:configuration?'get_effective_config':'get_task',target:configuration?{project_id:'101'}:{project_id:'101',task_id:'blocked'},arguments:{}});
    else if((configuration||pause)&&calls.length===1)message=call('management_command',{operation:configuration?'workflow.update':'task.pause',target:configuration?{project_id:'101',workflow_id:'review.issue'}:{project_id:'101',task_id:'blocked'},arguments:configuration?{prompt:'Inspect evidence and cite the original logs.'}:{},expected_revision:observations[0].revision});
    else message={role:'assistant',content:configuration?'默认提示词已保存；只影响之后的新任务。':pause?'任务已暂停，状态可以回读。':'任务正在等待项目电脑；原因来自持久化状态，可检查原始日志。'};
    res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message}],usage:{prompt_tokens:12,completion_tokens:6}}));
  });
  provider.listen(0,'127.0.0.1');await once(provider,'listening');
  t?.after(()=>new Promise(r=>{provider.close(r);provider.closeAllConnections();}));
  const model=(await admin('/api/models','POST',{repository_id:'101',model_name:'Management fixture',api_url:`http://127.0.0.1:${provider.address().port}/v1`,api_key:'fixture-provider-key'})).value.model;
  await admin('/api/repositories/101/policy','PATCH',{model_id:model.id});
  async function member(name,grants){
    const password=testPassword(),created=await admin('/api/users','POST',{username:name,password,...grants}),client=h.client();
    await client('/api/auth/login','POST',{username:name,password});return {id:created.value.user.id,client,password};
  }
  return {h,admin,password,a,model,requests,modelState,provider,member,close:async()=>{await h.stop();await new Promise(r=>{provider.close(r);provider.closeAllConnections();});}};
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
