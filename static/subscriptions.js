// Subscription drafts share the schedule page's login/project lifetime and command receipt.
function renderSubscriptionEditor(host, { project, destinations, read, command, model, busy, invalidate, active }) {
  const root=element('section','','subscription-editor-panel');root.setAttribute('aria-label','事件订阅管理');host.append(root);
  const address=location.hash, live=()=>active()&&root.isConnected&&address===location.hash;
  const labels={'task.failed':'任务失败','ci.failed':'CI 失败','ci.recovered':'CI 恢复','project.daily':'项目日报'};
  const stateLabel={active:'订阅已启用',paused:'已暂停',deleted:'已解除'};
  const heading=element('div','','subscription-heading'), list=element('div','','subscription-list'), controls=element('div','','actions');
  const message=element('p','','muted'), context=element('p','','subscription-context'), comparison=element('section','','subscription-comparison');
  message.setAttribute('role','status');comparison.setAttribute('role','alert');comparison.hidden=true;
  const layout=element('div','','subscription-layout'),editor=element('div','','subscription-editor-content');root.append(heading,message,context,controls,layout);layout.append(list,editor);editor.append(comparison);
  heading.append(element('h4','事件订阅'),note('事件到达后才会触发，与定时计划分别管理。每条订阅独立授权一个项目。'));
  let rows=[],next=null,loading=false,ready=false,generation=0,previewGeneration=0,projectName='项目 '+project,observedAt=null,selected=null;
  const form=document.createElement('form');form.className='subscription-form';form.setAttribute('aria-label','事件订阅编辑');
  const fields=document.createElement('fieldset');fields.className='subscription-fields';form.append(fields);
  const name=document.createElement('input');name.required=true;name.setAttribute('aria-label','订阅名称');
  const zone=document.createElement('input');zone.required=true;zone.setAttribute('aria-label','订阅时区');
  const aggregate=document.createElement('input');aggregate.type='number';aggregate.min='0';aggregate.max='1440';aggregate.step='any';aggregate.setAttribute('aria-label','聚合窗口分钟');
  const start=document.createElement('input');start.type='time';start.setAttribute('aria-label','静默开始');
  const end=document.createElement('input');end.type='time';end.setAttribute('aria-label','静默结束');
  const enabled=document.createElement('input');enabled.type='checkbox';enabled.setAttribute('aria-label','启用事件订阅');
  const destination=document.createElement('select');destination.required=true;destination.setAttribute('aria-label','订阅目的地');
  const destinationLabel=id=>{const d=destinations.destinations.find(d=>d.id===id);return d?(d.type==='group'?'群聊 ':'私聊 ')+d.chat_id:'目的地需重新核验 · '+id;};
  const ensureDestination=id=>{if(![...destination.options].some(option=>option.value===id)){const option=element('option',destinationLabel(id));option.value=id;destination.append(option);}};
  destinations.destinations.forEach(d=>ensureDestination(d.id));
  const eventFields=element('div','','subscription-events'),checks={};eventFields.setAttribute('role','group');eventFields.setAttribute('aria-label','事件类型');
  for(const [key,label] of Object.entries(labels)){const input=document.createElement('input');input.type='checkbox';input.setAttribute('aria-label',label);checks[key]=input;eventFields.append(field(label,input));}
  const preview=element('div','','subscription-preview');preview.setAttribute('aria-label','事件订阅时间预览');
  const errorBox=element('p','','view-error');errorBox.setAttribute('role','alert');
  const panes=[['events','事件与范围',[field('订阅名称',name),eventFields]],['time','聚合与静默',[field('聚合窗口分钟',aggregate),field('订阅时区（IANA）',zone),field('静默开始',start),field('静默结束',end)]],['destination','接收方',[field('订阅目的地',destination),consoleLink('#/identity','管理会话绑定和范围'),note('从已绑定的私聊或你能管理、覆盖本项目的群中选择；预览只说明时间，不会发送通知。')]],['confirm','确认与预览',[field('启用事件订阅',enabled),preview]]];
  const steps=element('div','','subscription-steps');form.prepend(steps);
  for(const [key,label,children] of panes){const pane=element('section','','subscription-pane');pane.dataset.step=key;pane.append(element('h5',label),...children);fields.append(pane);const step=button(label,()=>{model.step=key;form.dataset.step=key;for(const node of steps.children)node.setAttribute('aria-current',node===step?'step':'false');},'quiet');step.dataset.step=key;step.setAttribute('aria-current',key===(model.step||'events')?'step':'false');steps.append(step);}
  form.dataset.step=model.step||'events';
  const previewButton=button('预览事件订阅时间',async()=>{
    if(!live()||!ready||loading)return;model.step='confirm';form.dataset.step='confirm';for(const node of steps.children)node.setAttribute('aria-current',node.dataset.step==='confirm'?'step':'false');const spec=capture(),signature=JSON.stringify(spec),request=++previewGeneration;preview.textContent='正在核验当前订阅草稿…';
    try{const result=await read('preview_subscription',{subscription:spec});if(!live()||request!==previewGeneration||signature!==JSON.stringify(capture()))return;
      const at=value=>value==null?'未安排发送':new Intl.DateTimeFormat('zh-CN',{timeZone:result.timezone,dateStyle:'medium',timeStyle:'medium',hour12:false}).format(new Date(value))+' · '+result.timezone;
      preview.replaceChildren(note('假设此刻收到一条事件；这不是已经安排的触发或实际通知。'),facts([['事件收到',at(result.event_received_at)],['聚合结束',at(result.aggregation_ends_at)],['最早发送',at(result.first_send_at)],['接收方',destinationLabel(result.destination.id)]]));errorBox.textContent='';
    }catch(error){if(!live()||request!==previewGeneration)return;if(!destinationError(error)&&invalidate(error))return;preview.textContent='发送时间未知，请修正后重新预览。';errorBox.textContent=destinationError(error)?'目的地或受众需要重新核验；草稿已保留。'+error.message:error.message;}
  },'quiet');
  const save=element('button','保存事件订阅');save.type='submit';save.dataset.subscriptionWrite='1';
  const actions=element('div','','subscription-form-actions');actions.append(previewButton,save);const confirmation=element('p');confirmation.setAttribute('role','status');form.append(confirmation,errorBox,actions);editor.append(form);
  const defaults=()=>({name:'项目事件',destination_id:destinations.destinations[0]?.id||'',events:['task.failed'],projects:[project],aggregate_ms:300000,timezone:'Asia/Shanghai',enabled:true});
  const capture=()=>({name:name.value,destination_id:destination.value,events:Object.entries(checks).filter(([,node])=>node.checked).map(([key])=>key),projects:[project],aggregate_ms:Number(aggregate.value)*60000,timezone:zone.value,quiet_start:start.value||undefined,quiet_end:end.value||undefined,enabled:enabled.checked});
  const destinationError=error=>error.code?.startsWith('channel_')||error.code?.startsWith('schedule_destination_');
  function fill(){const spec=model.fields||selected?.spec||defaults();ensureDestination(spec.destination_id);name.value=spec.name;zone.value=spec.timezone;aggregate.value=String(spec.aggregate_ms/60000);start.value=spec.quiet_start||'';end.value=spec.quiet_end||'';destination.value=spec.destination_id;enabled.checked=spec.enabled;for(const [key,node]of Object.entries(checks))node.checked=spec.events.includes(key);}
  // Freeze both versions at the first edit; a read or time preview must not silently rebase this draft.
  function changed(){if(!live())return;if(!model.fields){model.draftRevision=model.lastReadRevision;model.baseRevision=selected?.revision??null;}model.fields=capture();model.error='';model.flash='';errorBox.textContent='';++previewGeneration;preview.textContent='草稿已修改，请重新预览发送时间。';if(model.conflict)drawComparison();update();}
  fields.addEventListener('input',changed);fields.addEventListener('change',changed);
  form.onsubmit=event=>{event.preventDefault();if(!live()||!ready||loading||busy()||model.conflict||selected&&!selected.editable)return;if(!capture().events.length){errorBox.textContent='至少选择一种事件。';return;}const spec=capture();if(!model.fields){model.fields=spec;model.draftRevision=model.lastReadRevision;model.baseRevision=selected?.revision??null;}
    void command(model.selected?'subscription.update':'notification.register',model.selected?{id:model.selected,revision:model.baseRevision,subscription:spec}:{subscription:spec},model.draftRevision);
  };
  async function select(row){if(busy()||!live())return;if(model.fields&&!await askConfirm({title:'切换订阅并放弃未保存修改？',body:['只清除当前订阅草稿，计划表单保留。'],action:'切换订阅'}))return;if(!live())return;model.selected=row?.id||'';model.fields=null;model.baseRevision=row?.revision??null;model.draftRevision=null;model.conflict=false;model.candidate=null;model.error='';model.flash='';model.step='events';form.dataset.step='events';for(const node of steps.children)node.setAttribute('aria-current',node.dataset.step==='events'?'step':'false');selected=row||null;++previewGeneration;preview.replaceChildren();drawComparison();fill();update();}
  const fresh=button('新建事件订阅',()=>select(null),'quiet'),refresh=button('重新读取事件订阅',()=>load(false),'quiet'),more=button('加载更多订阅',()=>load(true),'quiet');controls.append(fresh,refresh,more);
  const rowActions=[];
  function drawList(){list.replaceChildren();rowActions.length=0;for(const row of rows){const article=element('article','','subscription-row');article.setAttribute('aria-label',row.spec.name);article.append(element('strong',row.spec.name),badge(stateLabel[row.state]||row.state,row.state==='active'?'success':'warning'),facts([['事件',row.spec.events.map(key=>labels[key]||key).join('、')],['项目',projectName],['时区',row.spec.timezone],['聚合',row.spec.aggregate_ms/60000+' 分钟'],['静默',row.spec.quiet_start?row.spec.quiet_start+'–'+row.spec.quiet_end:'未设置'],['接收方',destinationLabel(row.spec.destination_id)],['身份',row.editable?'我的订阅':row.state==='deleted'?'已解除（只读）':'其他身份的订阅（只读）'],['原因',row.reason]]));
      const buttons=element('div','','actions'),choose=button(row.editable?'编辑订阅':'查看订阅',()=>select(row),'quiet');choose.dataset.subscriptionSelect='1';buttons.append(choose);
      if(row.editable)for(const [action,label]of [['pause','暂停订阅'],['resume','恢复订阅'],['delete','解除订阅']]){const node=button(label,async()=>{if(!live()||!ready||loading||busy())return;if(action==='delete'&&!await askConfirm({title:'解除事件订阅？',body:[row.spec.name,'仍待发送的通知会停止；已送达记录保留。'],action:'解除订阅'}))return;if(!live()||!ready||loading||busy())return;void command('subscription.'+action,{id:row.id,revision:row.revision},model.lastReadRevision);},'quiet');node.dataset.subscriptionWrite='1';rowActions.push({node,row,action});buttons.append(node);}article.append(buttons);list.append(article);}
  }
  const describe=spec=>[spec?.name||'未保存',spec?.events?.map(key=>labels[key]||key).join('、')||'未选择',spec?spec.aggregate_ms/60000+' 分钟':'未保存',spec?.timezone||'未保存',spec?.quiet_start?spec.quiet_start+'–'+spec.quiet_end:'未设置',spec?destinationLabel(spec.destination_id):'未保存',spec?.enabled?'启用':'暂停'];
  function drawComparison(){comparison.replaceChildren();comparison.hidden=!model.conflict;if(!model.conflict)return;comparison.append(element('h5','订阅版本或项目配置已变化，草稿已保留'));
    const candidate=model.candidate;
    if(!candidate){comparison.append(note('先重新读取当前订阅，再比较并明确采用当前版本。'),button('重新读取订阅并比较',()=>load(false),'quiet'));return;}
    const table=element('table','','subscription-diff'),head=element('tr');for(const text of ['字段','当前保存','你的草稿'])head.append(element('th',text));table.append(head);const current=describe(candidate.record?.spec),draft=describe(model.fields);
    ['名称','事件','聚合','时区','静默','接收方','启停'].forEach((label,index)=>{const row=element('tr');row.append(element('th',label),element('td',current[index]),element('td',draft[index]));table.append(row);});comparison.append(table);
    if(model.selected&&!candidate.record){comparison.append(note('当前订阅已无法读取，请保留草稿或明确切换到新建订阅。'));return;}
    comparison.append(button('比较后保留订阅草稿并采用当前版本',async()=>{if(!await askConfirm({title:'使用当前订阅版本继续保存草稿？',body:['保存将使用刚展示的版本和你的完整草稿，仍会重新校验当前权限和接收范围。'],action:'保留订阅草稿'}))return;if(!live())return;if(model.candidate!==candidate){errorBox.textContent='当前版本再次变化，请重新比较。';return;}model.baseRevision=candidate.record?.revision??null;model.draftRevision=candidate.revision;model.conflict=false;model.candidate=null;model.error='';drawComparison();update();},'quiet'));
  }
  function update(){if(!live())return;const readonly=!!model.selected&&(!selected||!selected.editable);fields.disabled=!ready||busy()||readonly;save.disabled=!ready||loading||busy()||readonly||!!model.conflict;previewButton.disabled=!ready||loading||busy()||readonly;
    fresh.disabled=busy()||loading;refresh.disabled=busy()||loading;more.disabled=!ready||busy()||loading;more.hidden=next==null;
    for(const {node,row,action}of rowActions)node.disabled=!ready||loading||busy()||!!model.conflict||action==='pause'&&row.state!=='active'||action==='resume'&&row.state!=='paused';
    context.textContent='项目范围：'+projectName+' · '+(readonly?(selected?.state==='deleted'?'只读：订阅已解除':selected?'只读：这条订阅由其他身份创建':'只读：当前订阅记录不可用'):model.selected?'编辑我的订阅':'新建我的订阅')+(model.fields?' · 草稿未保存':'')+' · '+(destination.selectedOptions[0]?.textContent||'尚未选择接收方');
    for(const node of root.querySelectorAll('[data-subscription-select]'))node.disabled=busy()||loading;for(const node of steps.children)node.disabled=busy();confirmation.textContent=model.flash||'';if(model.error)errorBox.textContent=model.error;if(model.conflict&&comparison.hidden)drawComparison();
  }
  async function load(append){if(!live()||loading||busy())return;const request=++generation;loading=true;message.textContent='正在读取事件订阅，状态待核验…';update();
    try{const value=await read('list_subscriptions',{limit:20,offset:append?next||0:0});if(!live()||request!==generation)return;
      let incoming=append?[...rows,...value.subscriptions]:value.subscriptions;
      // A selected record may sit beyond the first page after a local refresh. Read it within the same project scope.
      if(model.selected&&!incoming.some(row=>row.id===model.selected)){const exact=await read('list_subscriptions',{id:model.selected,limit:1});if(!live()||request!==generation)return;incoming=[...incoming,...exact.subscriptions];}
      rows=[...new Map(incoming.map(row=>[row.id,row])).values()];next=value.next_offset;model.lastReadRevision=value.revision;observedAt=new Date().toLocaleString();selected=rows.find(row=>row.id===model.selected)||null;ready=true;
      if(model.fields&&(model.conflict||model.draftRevision!==value.revision||model.selected&&model.baseRevision!==selected?.revision)){model.conflict=true;model.candidate={revision:value.revision,record:selected};}
      else if(!model.fields){model.baseRevision=selected?.revision??null;model.conflict=false;model.candidate=null;}
      message.textContent=rows.length?'已读取 '+rows.length+' 条事件订阅 · '+observedAt:'当前项目没有事件订阅；事件尚未到达也不会生成通知。';fill();drawList();drawComparison();update();
    }catch(error){if(!live()||request!==generation||invalidate(error))return;ready=false;message.textContent='事件订阅读取失败，最新状态未知。'+(rows.length?'保留上次读取的 '+rows.length+' 条（'+observedAt+'）。':'')+error.message;}
    finally{if(live()&&request===generation){loading=false;update();}}
  }
  model.update=()=>{if(!live())return;update();};fill();update();void load(false);
  void read('list_projects').then(value=>{if(!live())return;projectName=value.projects?.find(row=>String(row.id)===project)?.full_name||projectName;drawList();update();}).catch(error=>{if(live())invalidate(error);});
}
