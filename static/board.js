// Saved views and custom fields belong to the signed-in user. Execution stages remain read-only.
let boardState = null, boardRequest = 0;
function boardButton(name, action, className = 'quiet') {
  return button(name, async event => { const control=event.currentTarget; control.disabled=true;
    try { await action(); } catch(err) { error(err); } finally {
      control.disabled=control.id==='board-previous'?boardState.offset===0:control.id==='board-next'?!boardState.hasMore:false;
    }
  }, className);
}
function boardSelect(labelText, choices, value) {
  const label=element('label',labelText), select=document.createElement('select');
  select.setAttribute('aria-label',labelText);
  choices.forEach(([id,name])=>select.add(new Option(name,id))); select.value=value; label.append(select); return {label,select};
}
function boardView() { return boardState.views.find(v=>v.id===boardState.viewId); }
function boardColumns() {
  if(boardState.group==='bot_stage')return boardState.stages;
  return [{id:'unassigned',name:'未设置'},...(boardState.fields.find(f=>f.id===boardState.group)?.options||[])];
}
function boardDirty() { $('board-save-state').textContent='有未保存的更改'; }
async function renderBoard(request) {
  const owner=me.id; $('board-panel').replaceChildren();
  const data=await api('/api/board');
  if(request!==renderVersion||me?.id!==owner)return;
  if(!boardState||boardState.owner!==owner)boardState={owner,viewId:'default'};
  Object.assign(boardState,data);
  if(!boardState.views.some(v=>v.id===boardState.viewId))boardState.viewId='default';
  boardUseView();
  await boardLoadCards();
}
function boardUseView() {
  const view=boardView(); boardState.group=view.group_by; boardState.filters=structuredClone(view.filters);
  boardState.hidden=[...view.hidden_columns]; boardState.offset=0; boardState.cards=[]; boardState.hasMore=false;
  boardShell();
}
function boardShell() {
  const panel=$('board-panel'); panel.replaceChildren();
  const controls=element('div','','board-controls');
  const views=boardSelect('视图',boardState.views.map(v=>[v.id,v.name]),boardState.viewId);
  views.select.addEventListener('change',()=>{boardState.viewId=views.select.value;boardUseView();boardLoadCards().catch(error);});
  const groups=boardSelect('按字段分列',[['bot_stage','bot 执行'],...boardState.fields.map(f=>[f.id,f.name])],boardState.group);
  groups.select.addEventListener('change',async()=>{
    if(boardView().builtin&&groups.select.value!=='bot_stage'){
      const target=groups.select.value;groups.select.value='bot_stage';boardSaveAs(target);return;
    }
    boardState.group=groups.select.value;boardState.hidden=[];boardState.offset=0;boardDirty();
    boardHiddenControls();await boardLoadCards().catch(error);
  });
  const actions=element('div','','actions');
  actions.append(boardButton('保存视图',boardSave),boardButton('另存视图',()=>boardSaveAs()),boardButton('加列',boardAddColumn));
  if(!boardView().builtin)actions.append(boardButton('删除视图',async()=>{
    await api('/api/board/views/'+boardState.viewId,'DELETE',{});boardState.viewId='default';await renderBoard(renderVersion);
  }));
  controls.append(views.label,groups.label,actions);
  const note=element('p','执行阶段由任务自动计算，拖动不会改变阶段或启动 bot。自定义字段支持拖动，也可通过卡片上的选择框移动。','board-note');
  const filterEditor=element('form','','board-filter-editor');filterEditor.id='board-filter-editor';
  const filterRows=element('div','');filterRows.id='board-filter-rows';
  const filterActions=element('div','','actions'),dirty=element('span','','muted');dirty.id='board-save-state';
  filterActions.append(boardButton('添加筛选',()=>{boardState.filters.push({field:'object_type',value:'pr'});boardFilterRows();boardDirty();}),
    boardButton('应用筛选',async()=>{boardState.offset=0;await boardLoadCards();}),dirty);
  filterEditor.append(filterRows,filterActions);filterEditor.addEventListener('submit',e=>{e.preventDefault();boardState.offset=0;boardLoadCards().catch(error);});
  const columnSettings=element('details','','board-columns-settings');columnSettings.id='board-column-settings';
  const scroll=element('div','','board-scroll');scroll.id='board-columns';scroll.setAttribute('aria-label','看板列');scroll.tabIndex=0;
  const footer=element('div','','actions board-footer'),count=element('span','','muted');count.id='board-page-info';
  const paging=element('div','','actions'),prev=boardButton('上一页',async()=>{boardState.offset=Math.max(0,boardState.offset-100);await boardLoadCards();}),next=boardButton('下一页',async()=>{boardState.offset+=100;await boardLoadCards();});
  prev.id='board-previous';next.id='board-next';paging.append(prev,next);footer.append(count,paging);
  panel.append(controls,note,filterEditor,columnSettings,scroll,footer);boardFilterRows();boardHiddenControls();
}
function boardFilterRows() {
  const rows=$('board-filter-rows');rows.replaceChildren();
  boardState.filters.forEach((filter,index)=>{
    const row=element('div','','board-filter-row');
    const field=boardSelect('筛选条件 '+(index+1),[['repository_id','仓库'],['object_type','对象类型'],['bot_stage','bot 执行阶段'],['text','编号或标题文本'],['include_closed','包含已关闭对象']],filter.field);
    field.select.addEventListener('change',()=>{filter.field=field.select.value;filter.value=({repository_id:repositories[0]?.id||'',object_type:'pr',bot_stage:'unreviewed',text:'',include_closed:true})[filter.field];boardFilterRows();boardDirty();});
    let value;
    if(filter.field==='text'){
      const label=element('label','条件值 '+(index+1)),input=document.createElement('input');input.value=filter.value;input.maxLength=200;input.placeholder='输入编号或标题';
      input.addEventListener('input',()=>{filter.value=input.value;boardDirty();});label.append(input);value=label;
    }else{
      const choices=({repository_id:repositories.map(r=>[r.id,r.full_name]),object_type:[['issue','只要 Issue'],['pr','只要 PR']],
        bot_stage:boardState.stages.map(s=>[s.id,s.name]),include_closed:[['true','包含已关闭对象'],['false','仅打开或未知状态']]})[filter.field];
      // A revoked grant may remain in a saved view; never show the former repository's name or its cards.
      if(filter.field==='repository_id'&&!choices.some(c=>c[0]===filter.value))choices.push([filter.value,'仓库不可访问']);
      const control=boardSelect('条件值 '+(index+1),choices,String(filter.value));
      control.select.addEventListener('change',()=>{filter.value=filter.field==='include_closed'?control.select.value==='true':control.select.value;boardDirty();});value=control.label;
    }
    row.append(field.label,value,boardButton('删除条件 '+(index+1),()=>{boardState.filters.splice(index,1);boardFilterRows();boardDirty();}));rows.append(row);
  });
}
function boardConditions() { return boardState.filters.filter(f=>f.value!==''&&f.value!==undefined); }
function boardHiddenControls() {
  const settings=$('board-column-settings'),wasOpen=settings.open;settings.replaceChildren(element('summary','显示或隐藏列'));
  const choices=element('div','','actions');
  for(const column of boardColumns()){
    const label=element('label',''),check=document.createElement('input');check.type='checkbox';check.checked=!boardState.hidden.includes(column.id);
    check.addEventListener('change',()=>{boardState.hidden=check.checked?boardState.hidden.filter(id=>id!==column.id):[...boardState.hidden,column.id];boardDirty();boardRenderCards();});
    label.append(check,document.createTextNode(column.name));choices.append(label);
  }settings.append(choices);settings.open=wasOpen;
}
async function boardLoadCards() {
  const request=++boardRequest,owner=me.id,group=boardState.group;
  const params=new URLSearchParams({view_id:boardState.viewId,group_by:group,filters:JSON.stringify(boardConditions()),offset:String(boardState.offset),limit:'100'});
  $('board-columns').setAttribute('aria-busy','true');
  try {
    const result=await api('/api/board/cards?'+params);
    if(request!==boardRequest||me?.id!==owner||tab!=='board')return;
    boardState.cards=result.cards;boardState.hasMore=result.has_more;boardRenderCards();
  }finally{if(request===boardRequest)$('board-columns')?.removeAttribute('aria-busy');}
}
function boardRenderCards() {
  const columns=$('board-columns');columns.replaceChildren();
  for(const column of boardColumns()){
    if(boardState.hidden.includes(column.id))continue;
    const section=element('section','','board-column');section.dataset.columnId=column.id;
    if(boardState.group==='bot_stage')section.dataset.stage=column.id;
    section.setAttribute('aria-label',column.name);
    const cards=boardState.cards.filter(c=>(boardState.group==='bot_stage'?c.bot_stage:c.field_value||'unassigned')===column.id);
    const heading=element('div','','board-column-heading');heading.append(element('h2',column.name),element('span',String(cards.length),'muted'));section.append(heading);
    section.addEventListener('dragover',event=>{if(boardState.group!=='bot_stage'){event.preventDefault();event.dataTransfer.dropEffect='move';section.classList.add('board-drop-target');}});
    section.addEventListener('dragleave',()=>section.classList.remove('board-drop-target'));
    section.addEventListener('drop',async event=>{
      event.preventDefault();section.classList.remove('board-drop-target');if(boardState.group==='bot_stage')return;
      const key=event.dataTransfer.getData('application/x-bot-board');const item=boardState.cards.find(c=>boardKey(c)===key);
      if(item)await boardMove(item,column.id==='unassigned'?null:column.id).catch(error);
    });
    cards.forEach(item=>section.append(boardCard(item)));
    if(!cards.length)section.append(element('p','暂无卡片','board-empty'));columns.append(section);
  }
  if(!columns.children.length)columns.append(element('p','所有列均已隐藏，可在“显示或隐藏列”中恢复。','board-empty'));
  $('count').textContent=`本页 ${boardState.cards.length} 张卡片`;
  $('board-page-info').textContent=`第 ${boardState.offset/100+1} 页 · 每页最多 100 张${boardState.hasMore?' · 还有更多':''}`;
  $('board-previous').disabled=boardState.offset===0;$('board-next').disabled=!boardState.hasMore;
}
function boardKey(item) { return `${item.repository_id}/${item.object_type}/${item.object_number}`; }
function boardCard(item) {
  const card=element('article','','board-card'),label=`${item.object_type==='pr'?'PR':'Issue'} #${item.object_number}`;
  card.dataset.cardKey=boardKey(item);card.draggable=boardState.group!=='bot_stage';
  card.addEventListener('dragstart',event=>{if(boardState.group==='bot_stage'){event.preventDefault();return;}event.dataTransfer.setData('application/x-bot-board',boardKey(item));event.dataTransfer.effectAllowed='move';});
  const heading=element('div','','board-card-heading');heading.append(boardButton(item.title||label,()=>boardObject(item),'board-card-title'));
  if(boardState.group!=='bot_stage'){
    const handle=element('span','↕','board-drag-handle');handle.draggable=true;handle.setAttribute('aria-label','拖动卡片');handle.title='拖动卡片到其他列';heading.append(handle);
  }card.append(heading);
  const meta=element('div','','board-card-meta');meta.append(element('span',label),element('span',item.full_name));
  if(item.draft)meta.append(badge('草稿','warning'));
  if(item.github_state==='closed')meta.append(badge('已关闭',''));
  const stageName=boardState.stages.find(s=>s.id===item.bot_stage)?.name;meta.append(badge(stageName,item.bot_stage==='attention'?'warning':'info'));card.append(meta);
  if(boardState.group!=='bot_stage'){
    const custom=boardState.fields.find(f=>f.id===boardState.group),control=boardSelect(custom.name,[['','未设置'],...custom.options.map(o=>[o.id,o.name])],item.field_value||'');
    control.select.addEventListener('change',async()=>{control.select.disabled=true;try{await boardMove(item,control.select.value||null);}catch(err){control.select.value=item.field_value||'';error(err);}finally{control.select.disabled=false;}});card.append(control.label);
  }
  return card;
}
async function boardMove(item,option) {
  if(boardState.group==='bot_stage')return;
  await api('/api/board/cards/'+boardKey(item),'PATCH',{field_id:boardState.group,option_id:option});await boardLoadCards();
}
async function boardSave() {
  const view=boardView(),body={filters:boardConditions(),hidden_columns:boardState.hidden};
  if(!view.builtin)body.group_by=boardState.group;
  const result=await api('/api/board/views/'+view.id,'PATCH',body);Object.assign(view,result.view);$('board-save-state').textContent='已保存';boardState.offset=0;await boardLoadCards();
}
function boardForm(title,description,labels,submitCaption,submit) {
  const modal=document.createElement('dialog'),form=document.createElement('form'),heading=element('h2',title),id='board-form-heading';heading.id=id;modal.setAttribute('aria-labelledby',id);modal.id='board-form';
  form.append(heading,element('p',description,'muted'));const inputs={};
  for(const [name,caption,initial]of labels){const label=element('label',caption),input=document.createElement('input');input.name=name;input.required=true;input.maxLength=100;input.value=initial||'';label.append(input);form.append(label);inputs[name]=input;}
  const message=element('p','','board-form-error');message.setAttribute('role','alert');const actions=element('div','','actions');
  const save=element('button',submitCaption);save.type='submit';actions.append(button('取消',()=>modal.close()),save);form.append(message,actions);modal.append(form);document.body.append(modal);
  form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;message.textContent='';
    try{await submit(Object.fromEntries(Object.entries(inputs).map(([name,input])=>[name,input.value.trim()])));modal.close();}
    catch(err){message.textContent=err.message;}finally{save.disabled=false;}
  });modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
}
function boardSaveAs(group=boardState.group) {
  boardForm('另存视图','筛选、分列字段和隐藏列仅为当前账号保存。',[['name','视图名称',group==='bot_stage'?'我的看板':boardState.fields.find(f=>f.id===group)?.name+'看板']],'创建视图',async({name})=>{
    const result=await api('/api/board/views','POST',{name,group_by:group,filters:boardConditions(),hidden_columns:group===boardState.group?boardState.hidden:[]});
    boardState.viewId=result.view.id;await renderBoard(renderVersion);
  });
}
function boardAddColumn() {
  if(boardState.group==='bot_stage'){
    boardForm('新建自定义字段','bot 执行的六列跟随任务，不能增加或改名。创建单选字段后，将另存一个视图；加列就是为这个字段添加选项。',
      [['name','字段名称',''],['option','第一列名称','']],'创建字段和视图',async({name,option})=>{
        const {field}=await api('/api/board/fields','POST',{name});await api(`/api/board/fields/${field.id}/options`,'POST',{name:option});
        const {view}=await api('/api/board/views','POST',{name:name.slice(0,98)+'看板',group_by:field.id,filters:boardConditions(),hidden_columns:[]});
        boardState.viewId=view.id;await renderBoard(renderVersion);
      });
  }else{
    const field=boardState.fields.find(f=>f.id===boardState.group);
    boardForm('添加列',`为“${field.name}”添加一个单选选项，空列也会显示。`,[['name','列名称','']],'添加列',async({name})=>{
      const {option}=await api(`/api/board/fields/${field.id}/options`,'POST',{name});field.options.push(option);boardHiddenControls();boardRenderCards();
    });
  }
}
async function boardObject(item) {
  const owner=me.id,modal=document.createElement('dialog'),heading=element('h2',item.title||`${item.object_type==='pr'?'PR':'Issue'} #${item.object_number}`);
  heading.id='board-object-heading';modal.setAttribute('aria-labelledby',heading.id);modal.id='board-object';
  const head=element('div','','heading');head.append(heading,button('关闭',()=>modal.close()));modal.append(head);
  if(/^[\w.-]+\/[\w.-]+$/.test(item.full_name||'')){
    const link=element('a','在 GitHub 打开');link.href=`https://github.com/${item.full_name}/${item.object_type==='pr'?'pull':'issues'}/${item.object_number}`;link.target='_blank';link.rel='noopener noreferrer';modal.append(link);
  }
  const taskList=element('div','正在加载关联任务…','board-object-tasks');modal.append(taskList);document.body.append(modal);modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
  let offset=0;
  const load=async()=>{
    const result=await api('/api/board/cards/'+boardKey(item)+'/tasks?offset='+offset);
    if(me?.id!==owner||!modal.open)return;if(offset===0)taskList.replaceChildren();
    for(const task of result.tasks){
      const row=element('div','','board-task-row');row.append(element('span',kindLabels[task.kind]+' · '+timestamp(task.updated_at||task.created_at)),state(task.status),
        boardButton('查看任务详情',async()=>{modal.close();await openTask(task.id);}));taskList.append(row);
    }
    if(!taskList.children.length)taskList.textContent='这个对象尚无 bot 任务。';
    if(result.has_more){const more=boardButton('更多关联任务',async()=>{more.remove();offset+=100;await load();});taskList.append(more);}
  };
  try{await load();}catch(err){taskList.textContent=err.message;}
}
