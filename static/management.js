// All actions, including the explicit forms, are durable management messages. Reconnecting only reads events.
async function renderManagement(panel, projectId = null) {
  panel.replaceChildren(); panel.className = 'management-panel';
  const endpoint='/api/management', header=element('div','','management-header'), scope=document.createElement('select');
  scope.setAttribute('aria-label','当前管理作用域');
  const projects=(await api(endpoint+'/query','POST',{operation:'list_projects',target:{},arguments:{limit:100}})).projects;
  const addScope=(value,caption)=>{const o=element('option',caption);o.value=value;scope.append(o);};
  addScope('platform','全部有权访问的项目');
  for(const tenant of new Set(projects.map(p=>p.tenant_id).filter(Boolean)))addScope('tenant:'+tenant,'组织 '+tenant);
  for(const p of projects)addScope('project:'+p.id,p.full_name);
  const scopeKey='management-scope:'+me.id;
  if(projectId)scope.value='project:'+projectId;else if([...scope.options].some(o=>o.value===localStorage.getItem(scopeKey)))scope.value=localStorage.getItem(scopeKey);
  const conversations=document.createElement('select');conversations.setAttribute('aria-label','持久会话');
  const fresh=button('新建会话',async()=>{conversation=null;await openConversation(true);},'quiet');
  header.append(field('当前作用域',scope),field('会话',conversations),fresh);panel.append(header);
  panel.append(note('工作流和角色默认行为只影响之后新建的任务。当前任务补充指令追加记录，不改写旧 run。修改目标或验收条件会增加合同版本并使旧候选和验收失效。采用新执行配置时，先暂停并等待旧执行结束。'));
  const feed=element('div','','management-feed');feed.setAttribute('aria-label','管理会话记录');feed.setAttribute('role','log');panel.append(feed);
  const status=element('p','','muted');status.setAttribute('role','status');panel.append(status);
  const actions=element('div','','actions');panel.append(actions);
  const input=document.createElement('form'),message=textarea('management-message','',{rows:3,placeholder:'例如：任务为什么没有继续？将检视提示词改成……'}),send=element('button','发送'),stopButton=element('button','停止','quiet');
  message.setAttribute('aria-label','管理消息');send.type='submit';stopButton.type='button';stopButton.hidden=true;input.append(field('管理消息',message),send,stopButton);panel.append(input);
  const forms=element('div','','management-forms');panel.append(forms);
  let conversation=null,cursor=0,active=null,reading=false,scopeGeneration=0,streamController=null,formGeneration=0;
  const output=(label,value)=>{
    const box=element('article','','management-observation');box.append(element('h4',label));
    if(typeof value==='string')box.append(element('p',value));
    else {
      if(value.task){const t=value.task;box.append(element('p',t.summary+' · '+(states[t.status]?.[0]??t.status)),element('p','当前阶段：'+(phaseLabels[t.phase]??t.phase)));
        if(t.error_code)box.append(element('p',(t.error_cause?.label??'等待原因')+' · '+t.error_code),element('p',t.error_detail??t.error_cause?.description??''));
        box.append(button('查看任务',()=>openTask(t.id),'quiet'),' · ',link(value.logs_url,'原始日志'),' · ',link(value.runs_url,'执行记录'));
        if(value.allowed_next_steps?.length)box.append(note('允许的下一步：'+value.allowed_next_steps.map(op=>({'task.pause':'暂停','task.cancel':'取消','task.retry':'重试','task.instructions':'追加指令','task.contract':'修订目标与验收','task.adopt-config':'采用新配置'}[op]??op)).join('、')));
      }else if(value.projects)for(const p of value.projects)box.append(element('p',p.full_name+' · '+(p.enabled?'已启用':'已停用')+(p.configuration_gaps.length?' · 待补：'+p.configuration_gaps.join('、'):'')));
      else if(value.tasks)for(const t of value.tasks)box.append(element('p',t.task.summary+' · '+(states[t.task.status]?.[0]??t.task.status)));
      else if(value.workflows)for(const w of value.workflows)box.append(element('p',w.name+' · 生效来源：'+(layerNames[w.prompt.source]??w.prompt.source)+' · 版本 '+w.prompt.version.slice(0,12)));
      else if(value.operation){
        box.append(element('p',value.result?.notice??(value.state==='succeeded'?'操作已执行，可回读当前状态。':value.state==='awaiting_approval'?'组织策略要求有权用户批准这个参数与版本。':'操作未成功：'+(value.result?.error??value.state))));
        if(value.before_revision)box.append(note('版本 '+value.before_revision.slice(0,12)+' → '+(value.after_revision??value.before_revision).slice(0,12)));
        if(value.result?.diff){const diff=element('details','');diff.append(element('summary','查看配置差异'),element('pre',JSON.stringify(value.result.diff,null,2)));box.append(diff);}
        if(value.result?.pr_url)box.append(link(value.result.pr_url,'查看配置 PR（待合入）'));
      }
      const details=element('details','');details.append(element('summary','原始事实与回执'),element('pre',JSON.stringify(value,null,2)));box.append(details);
    }
    feed.append(box);feed.scrollTop=feed.scrollHeight;return box;
  };
  const query=(operation,target={},args={})=>submit({query:{operation,target,arguments:args}});
  actions.append(button('查询项目',()=>query('list_projects'), 'quiet'),button('查询任务',()=>query('list_tasks',target()),'quiet'),button('查询有效配置',()=>query('get_effective_config',target()),'quiet'),button('成本与预算',()=>query('get_usage',target()),'quiet'),button('操作审计',()=>query('list_audit',target()),'quiet'));
  const target=()=>scope.value.startsWith('project:')?{project_id:scope.value.slice(8)}:{};
  function event(row){
    if(row.sequence<=cursor)return;cursor=row.sequence;
    const data=row.data;
    if(row.type==='tool_result'){
      const receipt=data.result;
      output(receipt.operation?`操作 ${receipt.operation} · ${receipt.state}`:'查询事实',receipt);
      if(receipt.id&&receipt.operation){
        const links=element('p','');links.append(link('/api/management/commands/'+receipt.id,'命令回执'));
        if(receipt.project_id)links.append(' · ',link('#/projects/'+receipt.project_id+'/workflows','配置'), ' · ',link('#/projects/'+receipt.project_id+'/activity','任务'));
        feed.append(links);
        const taskId=receipt.target?.task_id??(receipt.operation==='task.create'?receipt.result?.id:null);if(taskId)feed.append(button('查看任务',()=>openTask(taskId),'quiet'));
        if(receipt.result?.rollback)feed.append(button('按原值回滚',()=>submit({command:receipt.result.rollback}),'quiet'));
        if(['unknown','executing'].includes(receipt.state))feed.append(button('对账并回读',async()=>{try{output('对账回执',await api(endpoint+'/commands/'+receipt.id+'/resume','POST',{}));}catch(e){status.textContent=e.message;}},'quiet'));
        if(receipt.state==='awaiting_approval'){
          const decide=button('批准此版本',async()=>{try{const result=await api(endpoint+'/commands/'+receipt.id+'/approval','POST',{parameter_hash:receipt.parameter_hash,expected_revision:receipt.expected_revision,decision:'approve'});output('审批结果',result);}catch(e){status.textContent=e.message;}},'quiet');
          feed.append(decide);
        }
      }
    }else if(row.type==='reply')output('助手回复（执行结果以命令回执为准）',data.text);
    else if(['error','tool_error','stopped'].includes(row.type))output('运行状态',data);
    else if(row.type==='text'){status.textContent='助手正在回复…';}
    else if(row.type==='model_request')status.textContent='模型调用已记录，可关联用量和日志。';
  }
  async function read(){
    if(reading||!conversation)return;reading=true;const id=conversation,generation=scopeGeneration;
    try{
      while(conversation===id&&generation===scopeGeneration&&panel.isConnected){
        const page=await api(endpoint+'/conversations/'+id+'/events?after='+cursor);
        for(const row of page.events)event(row);
        const pending=page.messages.find(m=>['pending','running'].includes(m.state));
        active=pending?.id??null;stopButton.hidden=!active;send.disabled=!!active;
        if(!pending&&!page.has_more){await configureForms();status.textContent=page.messages.at(-1)?'当前消息：'+page.messages.at(-1).state:'会话已就绪';break;}
        // The stream is read-only. Closing or losing this fetch never submits the command a second time.
        streamController=new AbortController();
        const response=await fetch(endpoint+'/conversations/'+id+'/events?stream=1&after='+cursor,{signal:streamController.signal});
        if(!response.ok)throw new Error('读取运行流失败，请重新连接。');
        const reader=response.body.getReader(),decoder=new TextDecoder();let text='';
        for(;;){const part=await reader.read();if(part.done)break;text+=decoder.decode(part.value,{stream:true});let at;while((at=text.indexOf('\n'))>=0){const line=text.slice(0,at);text=text.slice(at+1);if(line)event(JSON.parse(line));}}
      }
    }catch(e){status.textContent=e.message+' 已提交的命令仍可回读。';}
    finally{reading=false;send.disabled=false;if(generation!==scopeGeneration&&panel.isConnected)void read();}
  }
  async function openConversation(create=false){
    scopeGeneration++;streamController?.abort();localStorage.setItem(scopeKey,scope.value);feed.replaceChildren();cursor=0;
    const all=(await api(endpoint+'/conversations')).conversations.filter(c=>c.scope===scope.value);
    conversations.replaceChildren(...all.map(c=>{const o=element('option',c.created_at+' · '+c.id.slice(0,8));o.value=c.id;return o;}));
    if(create||!all.length){const result=await api(endpoint+'/conversations','POST',{scope:scope.value});conversation=result.conversation.id;const o=element('option','新会话 '+conversation.slice(0,8));o.value=conversation;conversations.prepend(o);}
    else conversation=all[0].id;
    conversations.value=conversation;await configureForms();void read();
  }
  async function submit(body){
    if(!conversation)return;
    const source_message=crypto.randomUUID();
    try{const result=await api(endpoint+'/conversations/'+conversation+'/messages','POST',{source_message,...body});active=result.id;output('已提交消息',body.content??body.query?.operation??body.command?.operation);void read();}
    catch(e){status.textContent=e.message.includes('management_revision_conflict')?'配置或任务已有更新，请重新读取当前事实和版本后提交。':e.message;}
  }
  async function configureForms(){
    const generation=++formGeneration;
    forms.replaceChildren();if(!target().project_id){forms.append(note('选择具体项目后可以修改配置或管理任务。'));return;}
    const project=target().project_id;
    const effective=await api(endpoint+'/query','POST',{operation:'get_effective_config',target:{project_id:project},arguments:{}});
    if(generation!==formGeneration)return;
    const workflow=document.createElement('select');workflow.setAttribute('aria-label','工作流');
    for(const w of effective.workflows){const o=element('option',w.name+' · '+w.prompt.source);o.value=w.id;workflow.append(o);}
    const prompt=textarea('prompt','',{rows:5});prompt.setAttribute('aria-label','默认提示词');
    const chosen=()=>effective.workflows.find(w=>w.id===workflow.value);
    const fill=()=>{prompt.value=chosen()?.prompt.effective??'';};workflow.onchange=fill;fill();
    const form=document.createElement('form'),save=element('button','保存默认提示词');form.append(element('h3','工作流默认行为'),field('工作流',workflow),field('默认提示词',prompt),note('仓库来源高于控制台层。被覆盖时会保存控制台设置并明确显示实际行为尚未改变；配置 PR 合入后才生效。'),save);
    form.onsubmit=async e=>{e.preventDefault();await submit({command:{operation:'workflow.update',target:{project_id:project,workflow_id:workflow.value},arguments:{prompt:prompt.value},expected_revision:effective.revision}});};if(chosen()?.prompt.path){const publish=button('创建配置 PR',()=>submit({command:{operation:'configuration.pr',target:{project_id:project},arguments:{path:chosen().prompt.path,content:prompt.value},expected_revision:effective.revision}}),'quiet');form.append(publish);}
    forms.append(form);
    const tasks=(await api(endpoint+'/query','POST',{operation:'list_tasks',target:{project_id:project},arguments:{limit:100}})).tasks;
    if(generation!==formGeneration)return;
    const task=document.createElement('select');task.setAttribute('aria-label','管理任务');
    for(const t of tasks){const o=element('option',t.task.summary+' · '+t.task.status);o.value=t.task.id;task.append(o);}
    const taskBox=element('section','');taskBox.append(element('h3','任务管理'),field('任务',task));
    taskBox.append(button('查看阻塞原因',()=>query('get_task',{project_id:project,task_id:task.value}), 'quiet'));
    for(const [action,caption] of [['pause','暂停任务'],['cancel','取消任务'],['retry','重试任务'],['adopt-config','采用新执行配置']])taskBox.append(button(caption,async()=>{try{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});await submit({command:{operation:'task.'+action,target:{project_id:project,task_id:task.value},arguments:{},expected_revision:current.revision}});}catch(e){status.textContent=e.message;}},'quiet'));
    const instruction=textarea('instruction','',{rows:2});instruction.setAttribute('aria-label','补充指令');taskBox.append(field('追加补充指令',instruction),button('追加指令',async()=>{const current=await api(endpoint+'/query','POST',{operation:'get_task',target:{project_id:project,task_id:task.value},arguments:{}});await submit({command:{operation:'task.instructions',target:{project_id:project,task_id:task.value},arguments:{instruction:instruction.value},expected_revision:current.revision}});},'quiet'));
    forms.append(taskBox);
    if (typeof renderSchedules === 'function') {
      const schedules = element('section', ''); forms.append(schedules);
      try { await renderSchedules(schedules, project); } catch (e) { schedules.append(note('定时计划暂不可用：' + e.message)); }
    }
  }
  input.onsubmit=e=>{e.preventDefault();if(message.value.trim()){void submit({content:message.value});message.value='';}};
  stopButton.onclick=async()=>{if(active)await api(endpoint+'/conversations/'+conversation+'/messages/'+active+'/stop','POST',{});};
  scope.onchange=()=>openConversation();conversations.onchange=()=>{scopeGeneration++;streamController?.abort();conversation=conversations.value;cursor=0;feed.replaceChildren();void read();};
  actions.append(button('重新连接',()=>read(),'quiet'));
  await openConversation();if(!projectId)$('count').textContent='';
}
