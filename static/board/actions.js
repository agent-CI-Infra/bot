async function boardSave() {
  const view=boardView(),body={filters:boardOwnFilters(),hidden_columns:boardState.hidden};
  if(!view.builtin||boardStandardGroups.includes(boardState.group))body.group_by=boardState.group;
  const result=await api('/api/board/views/'+view.id,'PATCH',body);Object.assign(view,result.view);boardState.dirty=false;boardViewControls();
}
function boardForm(title,description,labels,submitCaption,submit) {
  const modal=document.createElement('dialog'),form=document.createElement('form'),heading=element('h2',title),id='board-form-heading';heading.id=id;modal.setAttribute('aria-labelledby',id);modal.id='board-form';
  form.append(heading,element('p',description,'muted'));const inputs={};
  for(const [name,caption,initial]of labels){const label=element('label',caption),input=document.createElement('input');input.name=name;input.required=true;input.maxLength=100;input.value=initial||'';label.append(input);form.append(label);inputs[name]=input;}
  const message=element('p','','board-form-error');message.setAttribute('role','alert');const actions=element('div','','actions');
  const save=element('button',submitCaption);save.type='submit';actions.append(button('取消',()=>modal.close()),save);form.append(message,actions);modal.append(form);document.body.append(modal);
  form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;message.textContent='';
    try{await submit(Object.fromEntries(Object.entries(inputs).map(([name,input])=>[name,input.value.trim()])));modal.close();}
    catch(err){message.textContent = readErrorText(err);}finally{save.disabled=false;}
  });modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
}
function boardSaveAs(group=boardState.group) {
  const groupName={bot_stage:'我的看板',repository:'按仓库',execution_status:'按执行状态',category:'按工作类型'}[group]||boardCustomField()?.name+'看板';
  boardForm('另存视图','筛选、查看维度和折叠的列仅为当前账号保存，所有工作类型共用。',[['name','视图名称',groupName]],'创建视图',async({name})=>{
    const result=await api('/api/board/views','POST',{name,group_by:group,filters:boardOwnFilters(),hidden_columns:group===boardState.group?boardState.hidden:[]});
    boardState.viewId=result.view.id;await renderBoard(renderVersion,true);
  });
}
function boardAddColumn() {
  if(boardState.group==='bot_stage'){
    boardForm('新建自定义字段','bot 执行的六列跟随任务，不能增加或改名。创建单选字段后，将另存一个视图；加列就是为这个字段添加选项。',
      [['name','字段名称',''],['option','第一列名称','']],'创建字段和视图',async({name,option})=>{
        const {field}=await api('/api/board/fields','POST',{name});await api(`/api/board/fields/${field.id}/options`,'POST',{name:option});
        const {view}=await api('/api/board/views','POST',{name:name.slice(0,98)+'看板',group_by:field.id,filters:boardOwnFilters(),hidden_columns:[]});
        boardState.viewId=view.id;await renderBoard(renderVersion,true);
      });
  }else{
    const field=boardState.fields.find(f=>f.id===boardState.group);
    boardForm('添加列',`为“${field.name}”添加一个单选选项，空列也会显示。`,[['name','列名称','']],'添加列',async({name})=>{
      const {option}=await api(`/api/board/fields/${field.id}/options`,'POST',{name});field.options.push(option);boardRenderCards(true);
    });
  }
}
async function boardOpen(item) {
  if(item.card_type==='task'){await openTask(item.task_id);return;}
  if(item.card_type==='release'){openProject(item.repository_id,'release');return;}
  const owner=me.id,label=`${boardTypeName(item.object_type)} #${item.object_number}`,conditions=[];
  const category=item.card_category;
  if(category)conditions.push({field:'category',value:category});
  let offset=0;const tasks=[];
  const load=async()=>{
    const params=new URLSearchParams({offset:String(offset),limit:'100',filters:JSON.stringify(conditions)});
    const page=await api('/api/board/cards/'+boardKey(item)+'/tasks?'+params);tasks.push(...page.tasks);return page;
  };
  const page=await load();if(me?.id!==owner)return;
  if(tasks.length===1&&!page.has_more){await openTask(tasks[0].id);return;}
  const more=async()=>{offset+=100;const next=await load();return {tasks,hasMore:next.has_more};};
  openTaskChoices(label,tasks,page.has_more,more);
}
// Close the view menu on an outside click or Escape, like other popovers.
document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.board-menu.open'))if(!menu.contains(event.target))boardOpenMenu(menu,false);});
document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const menu of document.querySelectorAll('.board-menu.open'))boardOpenMenu(menu,false);});

boardMedia.addEventListener('change',()=>{if(boardState?.cards&&tab==='board'){boardState.filterOpen=!boardMedia.matches;boardShell();boardRenderCards(true);}});
