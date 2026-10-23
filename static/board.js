// Saved views and custom fields belong to the signed-in user. Execution stages remain read-only.
// Issues and PRs are two boards switched at the top; both read the same saved view (filters, grouping, collapsed columns).
let boardState = null, boardRequest = 0, boardDragging = false;
const boardPageSize = 100, boardTypes = [['issue', 'Issue'], ['pr', 'PR']];
function boardButton(name, action, className = 'quiet') {
  return button(name, async event => { const control=event.currentTarget; control.disabled=true;
    try { await action(); } catch(err) { error(err); } finally { control.disabled=false; }
  }, className);
}
function boardSelect(labelText, choices, value) {
  const label=element('label',labelText), select=document.createElement('select');
  select.setAttribute('aria-label',labelText);
  choices.forEach(([id,name])=>select.add(new Option(name,id))); select.value=value; label.append(select); return {label,select};
}
function boardView() { return boardState.views.find(v=>v.id===boardState.viewId); }
function boardTypeName(type=boardState.type) { return type==='pr'?'PR':'Issue'; }
// The PR board renames development stages: there the bot revises its own PR after a review.
function boardStage(stage,type=boardState.type) { return {...stage,...(type==='pr'?stage.pr:{})}; }
function boardColumns() {
  if(boardState.group==='bot_stage')return boardState.stages.map(s=>boardStage(s));
  return [{id:'unassigned',name:'未设置',hint:'还没有为这个字段选值'},...(boardState.fields.find(f=>f.id===boardState.group)?.options||[])];
}
function boardFilter(field) { return boardState.filters.find(f=>f.field===field)?.value; }
function boardSetFilter(field,value) {
  boardState.filters=boardState.filters.filter(f=>f.field!==field);
  if(value!==''&&value!==undefined&&value!==false)boardState.filters.push({field,value});
  boardDirty();
}
function boardConditions() { return boardState.filters.filter(f=>f.value!==''&&f.value!==undefined); }
// Unsaved means different from the stored view, so undoing a change hides the save button again.
function boardViewShape(filters,hidden,group) {
  const sorted=list=>[...list].map(f=>JSON.stringify([f.field,f.value])).sort();
  return JSON.stringify([sorted(filters.filter(f=>f.field!=='object_type'&&f.value!==''&&f.value!==undefined&&f.value!==false)),[...hidden].sort(),group]);
}
function boardDirty() {
  const view=boardView();
  boardState.dirty=boardViewShape(boardState.filters,boardState.hidden,boardState.group)!==boardViewShape(view.filters,view.hidden_columns,view.group_by);boardViewControls();
}
// Coming back to the tab keeps unsaved filter edits; creating, switching or deleting a view loads that view.
async function renderBoard(request,useView=false) {
  const owner=me.id;
  if(boardState?.owner!==owner){boardState=null;$('board-panel').replaceChildren();}
  const data=await api('/api/board');
  if(request!==renderVersion||me?.id!==owner)return;
  if(!boardState)boardState={owner,viewId:'default',type:localStorage.getItem('bot-board-type:'+owner)==='pr'?'pr':'issue'};
  Object.assign(boardState,data);
  if(!boardState.views.some(v=>v.id===boardState.viewId)){boardState.viewId='default';useView=true;}
  if(useView||!boardState.filters)boardUseView();else boardShell();
  await boardLoadCards();
}
function boardUseView() {
  const view=boardView(),filters=structuredClone(view.filters);
  // Views saved before the Issue/PR split may carry the type as a filter; it now selects the board instead.
  const typed=filters.find(f=>f.field==='object_type');if(typed)boardSetType(typed.value);
  Object.assign(boardState,{group:view.group_by,filters:filters.filter(f=>f.field!=='object_type'),hidden:[...view.hidden_columns],
    dirty:false,offset:0,cards:[],hasMore:false,signature:''});
  boardShell();
}
function boardSetType(type) {
  boardState.type=type==='pr'?'pr':'issue';localStorage.setItem('bot-board-type:'+boardState.owner,boardState.type);
  document.querySelectorAll('#board-types [data-type]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.type===boardState.type)));
}
function boardMenu(caption,label) {
  const menu=element('div','','board-menu'),panel=element('div','','board-menu-panel');panel.hidden=true;
  const toggle=button(caption,()=>boardOpenMenu(menu,panel.hidden),'quiet board-menu-toggle');
  toggle.setAttribute('aria-label',label);toggle.setAttribute('aria-expanded','false');toggle.title=label;menu.append(toggle,panel);return {menu,panel};
}
function boardOpenMenu(menu,open) {
  menu.classList.toggle('open',open);menu.querySelector('.board-menu-panel').hidden=!open;menu.querySelector('.board-menu-toggle').setAttribute('aria-expanded',String(open));
}
function boardShell() {
  const panel=$('board-panel'); panel.replaceChildren();
  const toolbar=element('div','','board-toolbar');
  const types=element('div','','board-types');types.id='board-types';types.setAttribute('role','group');types.setAttribute('aria-label','对象类型');
  for(const [type,name]of boardTypes){
    const b=button('',()=>{if(boardState.type===type)return;boardSetType(type);boardLoadCards().catch(error);},'board-type');
    b.dataset.type=type;b.setAttribute('aria-pressed',String(boardState.type===type));b.append(element('span',name),document.createTextNode(' '),element('span','','board-type-count'));types.append(b);
  }
  const search=element('label','','board-search'),icon=element('span','⌕'),input=document.createElement('input');icon.setAttribute('aria-hidden','true');
  input.type='search';input.maxLength=200;input.placeholder='搜索编号或标题';input.setAttribute('aria-label','搜索编号或标题');input.value=boardFilter('text')||'';
  let timer;input.addEventListener('input',event=>{if(event.isComposing)return;clearTimeout(timer);timer=setTimeout(()=>{
    if((boardFilter('text')||'')===input.value.trim())return;boardSetFilter('text',input.value.trim());boardLoadCards().catch(error);},300);});
  search.append(icon,input);
  // A revoked grant may remain in a saved view; never show the former repository's name or its cards.
  const repoChoices=[['','全部仓库'],...repositories.map(r=>[r.id,r.full_name])],repo=boardFilter('repository_id');
  if(repo&&!repoChoices.some(c=>c[0]===repo))repoChoices.push([repo,'仓库不可访问']);
  const repoSelect=boardSelect('仓库',repoChoices,repo||'').select;repoSelect.classList.add('board-repository');
  repoSelect.addEventListener('change',()=>{boardSetFilter('repository_id',repoSelect.value);boardLoadCards().catch(error);});
  const closed=element('label','','board-check'),check=document.createElement('input');check.type='checkbox';check.checked=boardFilter('include_closed')===true;
  check.addEventListener('change',()=>{boardSetFilter('include_closed',check.checked);boardLoadCards().catch(error);});closed.append(check,document.createTextNode('含已关闭'));
  const chips=element('div','','board-chips');chips.id='board-chips';
  const views=boardSelect('视图',boardState.views.map(v=>[v.id,v.name]),boardState.viewId);views.label.className='board-field';
  views.select.addEventListener('change',()=>{boardState.viewId=views.select.value;boardUseView();boardLoadCards().catch(error);});
  const save=boardButton('保存视图',boardSave,'board-save');save.id='board-save';
  const more=boardMenu('⋯','更多视图操作');more.menu.id='board-view-menu';
  const groups=boardSelect('分列',[['bot_stage','bot 执行阶段'],...boardState.fields.map(f=>[f.id,f.name])],boardState.group);groups.label.className='board-field';
  groups.select.title='执行阶段由任务自动计算，拖动不会改变阶段或启动 bot；自定义字段的列可以拖动卡片。';
  groups.select.addEventListener('change',async()=>{
    if(boardView().builtin&&groups.select.value!=='bot_stage'){
      const target=groups.select.value;groups.select.value='bot_stage';boardSaveAs(target);return;
    }
    boardState.group=groups.select.value;boardState.hidden=[];boardDirty();await boardLoadCards().catch(error);
  });
  const status=element('div','','board-status');status.id='board-status';status.setAttribute('role','status');
  toolbar.append(types,search,repoSelect,closed,chips,element('span','','board-divider'),views.label,save,more.menu,groups.label,
    boardButton('加列',boardAddColumn),element('span','','board-spacer'),status,boardButton('刷新',()=>boardLoadCards()));
  const scroll=element('div','','board-scroll');scroll.id='board-columns';scroll.setAttribute('aria-label','看板列');
  panel.append(toolbar,scroll);boardViewControls();boardChips();
}
// Saving is offered only while the working view differs from the stored one.
function boardViewControls() {
  const save=$('board-save'),panel=document.querySelector('#board-view-menu .board-menu-panel');if(!save||!panel)return;
  save.hidden=!boardState.dirty;panel.replaceChildren(boardButton('另存视图',()=>{boardOpenMenu($('board-view-menu'),false);boardSaveAs();},'board-menu-item'));
  if(!boardView().builtin)panel.append(boardButton('删除视图',async()=>{
    await api('/api/board/views/'+boardState.viewId,'DELETE',{});boardState.viewId='default';await renderBoard(renderVersion,true);
  },'board-menu-item danger'));
}
// Older saved views may filter by stage; the stage columns replace that filter, but it stays visible and removable.
function boardChips() {
  const chips=$('board-chips');if(!chips)return;chips.replaceChildren();
  for(const filter of boardState.filters.filter(f=>f.field==='bot_stage')){
    const name=boardStage(boardState.stages.find(s=>s.id===filter.value)||{name:filter.value}).name,chip=element('span','','board-chip');
    const remove=button('×',()=>{boardSetFilter('bot_stage','');boardChips();boardLoadCards().catch(error);},'board-chip-remove');remove.setAttribute('aria-label','移除筛选 阶段：'+name);
    chip.append(element('span','阶段：'+name),remove);chips.append(chip);
  }
}
function boardParams(offset) {
  return new URLSearchParams({view_id:boardState.viewId,group_by:boardState.group,offset:String(offset),limit:String(boardPageSize),
    filters:JSON.stringify([...boardConditions(),{field:'object_type',value:boardState.type}])});
}
async function boardLoadCards(more=false) {
  const request=++boardRequest,owner=me.id,offset=more?boardState.offset+boardPageSize:0;
  $('board-columns').setAttribute('aria-busy','true');if(!more)$('board-status').textContent='正在加载…';
  try {
    const result=await api('/api/board/cards?'+boardParams(offset));
    if(request!==boardRequest||me?.id!==owner||tab!=='board')return;
    // Later pages can repeat a card whose activity moved it while paging; one object keeps one card.
    const known=more?boardState.cards:[],keys=new Set(known.map(boardKey));
    Object.assign(boardState,{cards:[...known,...result.cards.filter(c=>!keys.has(boardKey(c)))],offset,hasMore:result.has_more,counts:result.counts,
      signature:more?'':JSON.stringify([result.cards,result.has_more,result.counts])});
    boardRenderCards(more);
  }catch(err){if(request===boardRequest)boardSummary();throw err;}
  finally{if(request===boardRequest)$('board-columns')?.removeAttribute('aria-busy');}
}
// Stages change while the bot works. Refresh the first page quietly unless the person is in the middle of something.
async function boardPoll() {
  if(!me||tab!=='board'||projectRoute()||document.hidden||boardDragging||boardState?.owner!==me.id||boardState.offset>0)return;
  const columns=$('board-columns');
  if(!columns||columns.hasAttribute('aria-busy')||columns.contains(document.activeElement)||document.querySelector('dialog[open],.board-menu.open'))return;
  const request=boardRequest,owner=me.id,result=await api('/api/board/cards?'+boardParams(0));
  if(request!==boardRequest||me?.id!==owner||tab!=='board'||boardDragging)return;
  const signature=JSON.stringify([result.cards,result.has_more,result.counts]);if(signature===boardState.signature)return;
  Object.assign(boardState,{cards:result.cards,hasMore:result.has_more,counts:result.counts,signature});boardRenderCards(true);
}
setInterval(()=>boardPoll().catch(()=>{}),15000);
function boardToggleColumn(id) {
  boardState.hidden=boardState.hidden.includes(id)?boardState.hidden.filter(c=>c!==id):[...boardState.hidden,id];boardDirty();boardRenderCards(true);
}
function boardRenderCards(keepScroll=false) {
  const columns=$('board-columns');if(!columns)return;
  const left=columns.scrollLeft,tops=new Map([...columns.querySelectorAll('.board-column')].map(c=>[c.dataset.columnId,c.querySelector('.board-column-list')?.scrollTop||0]));
  columns.replaceChildren();const stageMode=boardState.group==='bot_stage';
  for(const column of boardColumns()){
    const collapsed=boardState.hidden.includes(column.id),cards=boardState.cards.filter(c=>(stageMode?c.bot_stage:c.field_value||'unassigned')===column.id);
    const section=element('section','','board-column'+(collapsed?' board-collapsed':''));section.dataset.columnId=column.id;
    if(stageMode)section.dataset.stage=column.id;section.setAttribute('aria-label',column.name);
    const heading=element('div','','board-column-heading'),dot=element('span','','board-column-dot'),count=element('span',String(cards.length),'board-column-count');
    if(column.hint)heading.title=column.hint;dot.setAttribute('aria-hidden','true');count.setAttribute('aria-label',cards.length+' 张卡片');
    const toggle=button(collapsed?'›':'‹',()=>boardToggleColumn(column.id),'board-collapse');
    toggle.setAttribute('aria-label',(collapsed?'展开 ':'折叠 ')+column.name);toggle.setAttribute('aria-expanded',String(!collapsed));
    heading.append(dot,element('h2',column.name),count,toggle);section.append(heading);
    section.addEventListener('dragover',event=>{if(!stageMode){event.preventDefault();event.dataTransfer.dropEffect='move';section.classList.add('board-drop-target');}});
    section.addEventListener('dragleave',event=>{if(!section.contains(event.relatedTarget))section.classList.remove('board-drop-target');});
    section.addEventListener('drop',async event=>{
      event.preventDefault();section.classList.remove('board-drop-target');boardDragging=false;if(stageMode)return;
      const key=event.dataTransfer.getData('application/x-bot-board');const item=boardState.cards.find(c=>boardKey(c)===key);
      if(item&&(item.field_value||'unassigned')!==column.id)await boardMove(item,column.id==='unassigned'?null:column.id).catch(error);
    });
    if(collapsed)section.addEventListener('click',event=>{if(!event.target.closest('button'))boardToggleColumn(column.id);});
    else{
      const list=element('div','','board-column-list');cards.forEach(item=>list.append(boardCard(item)));
      if(!cards.length)list.append(element('p','暂无','board-empty'));section.append(list);
    }
    columns.append(section);
  }
  if(keepScroll){columns.scrollLeft=left;for(const list of columns.querySelectorAll('.board-column-list'))list.scrollTop=tops.get(list.closest('.board-column').dataset.columnId)||0;}
  boardSummary();
}
function boardSummary() {
  for(const b of document.querySelectorAll('#board-types [data-type]'))b.querySelector('.board-type-count').textContent=String(boardState.counts?.[b.dataset.type]??'');
  const status=$('board-status');status.replaceChildren();const total=boardState.counts?.[boardState.type]??boardState.cards.length;
  if(boardState.hasMore){
    status.append(element('span',`已显示 ${boardState.cards.length} / ${total} 个 ${boardTypeName()}`),boardButton('加载更多',()=>boardLoadCards(true),'board-link'));
  }else if(!total&&boardState.filters.some(f=>f.field!=='include_closed')){
    status.append(element('span',`没有符合条件的 ${boardTypeName()}`),boardButton('清除筛选',async()=>{
      boardState.filters=boardState.filters.filter(f=>f.field==='include_closed');boardDirty();boardShell();await boardLoadCards();
    },'board-link'));
  }
}
function boardKey(item) { return `${item.repository_id}/${item.object_type}/${item.object_number}`; }
function boardGithub(item,type=item.object_type,number=item.object_number) {
  return /^[\w.-]+\/[\w.-]+$/.test(item.full_name||'')?`https://github.com/${item.full_name}/${type==='pr'?'pull':'issues'}/${number}`:null;
}
function boardTime(value) {
  const date=new Date(value),pad=n=>String(n).padStart(2,'0');if(Number.isNaN(date.getTime()))return '';
  return `${date.getFullYear()===new Date().getFullYear()?'':date.getFullYear()+'-'}${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// The latest review and development statuses explain why a card sits in its stage, e.g. which task failed.
function boardTaskBadge(prefix,status) { const [caption,tone]=states[status]||[status,''],b=badge(`${prefix} ${caption}`,tone);b.title=status;return b; }
function boardCard(item) {
  const stageMode=boardState.group==='bot_stage',label=`${boardTypeName(item.object_type)} #${item.object_number}`;
  const card=element('article','','board-card');card.dataset.cardKey=boardKey(item);card.draggable=!stageMode;
  card.addEventListener('dragstart',event=>{if(stageMode){event.preventDefault();return;}boardDragging=true;event.dataTransfer.setData('application/x-bot-board',boardKey(item));event.dataTransfer.effectAllowed='move';});
  card.addEventListener('dragend',()=>{boardDragging=false;});
  card.addEventListener('click',event=>{if(!event.target.closest('a,button,select,label,input'))boardObject(item).catch(error);});
  const heading=element('div','','board-card-heading'),title=boardButton('',()=>boardObject(item),'board-card-title');
  // The clamp wrapper keeps long titles to three lines with the number leading the first one.
  const caption=element('span','','board-card-caption');title.append(caption);
  if(item.title)caption.append(element('span','#'+item.object_number,'board-card-number'),document.createTextNode(' '),element('span',item.title,'board-card-text'));
  else caption.append(element('span',label,'board-card-text'));
  heading.append(title);
  const url=boardGithub(item);if(url){const a=link(url,'↗','board-card-link');a.setAttribute('aria-label','在 GitHub 打开 '+label);a.title='在 GitHub 打开';heading.append(a);}
  if(!stageMode){const handle=element('span','⠿','board-drag-handle');handle.draggable=true;handle.setAttribute('aria-label','拖动卡片');handle.title='拖动卡片到其他列';heading.append(handle);}
  const meta=element('div','','board-card-meta'),time=element('span',boardTime(item.last_seen),'board-card-time');time.title='最近活动 '+timestamp(item.last_seen);
  meta.append(element('span',item.full_name||'仓库 '+item.repository_id,'board-card-repo'),time);
  const badges=element('div','','board-card-badges');
  if(!stageMode){const stage=boardState.stages.find(s=>s.id===item.bot_stage);if(stage)badges.append(badge(boardStage(stage,item.object_type).name,item.bot_stage==='attention'?'warning':'info'));}
  if(item.draft)badges.append(badge('草稿','warning'));
  if(item.github_state==='closed')badges.append(badge('已关闭',''));
  if(item.review_status)badges.append(boardTaskBadge('检视',item.review_status));
  if(item.development_status)badges.append(boardTaskBadge(item.object_type==='pr'?'跟进':'开发',item.development_status));
  if(item.object_type==='issue'&&item.development_pr_number){
    const pr=boardGithub(item,'pr',item.development_pr_number),caption='→ PR #'+item.development_pr_number;badges.append(pr?link(pr,caption,'board-card-pr'):element('span',caption,'board-card-pr'));
  }
  card.append(heading,meta);if(badges.childElementCount)card.append(badges);
  if(!stageMode){
    const custom=boardState.fields.find(f=>f.id===boardState.group),control=boardSelect(custom.name,[['','未设置'],...custom.options.map(o=>[o.id,o.name])],item.field_value||'');
    control.label.className='board-card-field';control.label.replaceChildren(control.select);
    control.select.addEventListener('change',async()=>{control.select.disabled=true;try{await boardMove(item,control.select.value||null);}catch(err){control.select.value=item.field_value||'';error(err);}finally{control.select.disabled=false;}});card.append(control.label);
  }
  return card;
}
async function boardMove(item,option) {
  if(boardState.group==='bot_stage')return;
  await api('/api/board/cards/'+boardKey(item),'PATCH',{field_id:boardState.group,option_id:option});
  item.field_value=option;boardRenderCards(true);
}
async function boardSave() {
  const view=boardView(),body={filters:boardConditions(),hidden_columns:boardState.hidden};
  if(!view.builtin)body.group_by=boardState.group;
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
    catch(err){message.textContent=err.message;}finally{save.disabled=false;}
  });modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
}
function boardSaveAs(group=boardState.group) {
  boardForm('另存视图','筛选、分列字段和折叠的列仅为当前账号保存，Issue 和 PR 看板共用。',[['name','视图名称',group==='bot_stage'?'我的看板':boardState.fields.find(f=>f.id===group)?.name+'看板']],'创建视图',async({name})=>{
    const result=await api('/api/board/views','POST',{name,group_by:group,filters:boardConditions(),hidden_columns:group===boardState.group?boardState.hidden:[]});
    boardState.viewId=result.view.id;await renderBoard(renderVersion,true);
  });
}
function boardAddColumn() {
  if(boardState.group==='bot_stage'){
    boardForm('新建自定义字段','bot 执行的六列跟随任务，不能增加或改名。创建单选字段后，将另存一个视图；加列就是为这个字段添加选项。',
      [['name','字段名称',''],['option','第一列名称','']],'创建字段和视图',async({name,option})=>{
        const {field}=await api('/api/board/fields','POST',{name});await api(`/api/board/fields/${field.id}/options`,'POST',{name:option});
        const {view}=await api('/api/board/views','POST',{name:name.slice(0,98)+'看板',group_by:field.id,filters:boardConditions(),hidden_columns:[]});
        boardState.viewId=view.id;await renderBoard(renderVersion,true);
      });
  }else{
    const field=boardState.fields.find(f=>f.id===boardState.group);
    boardForm('添加列',`为“${field.name}”添加一个单选选项，空列也会显示。`,[['name','列名称','']],'添加列',async({name})=>{
      const {option}=await api(`/api/board/fields/${field.id}/options`,'POST',{name});field.options.push(option);boardRenderCards(true);
    });
  }
}
async function boardObject(item) {
  if(document.getElementById('board-object'))return;
  const owner=me.id,modal=document.createElement('dialog'),label=`${boardTypeName(item.object_type)} #${item.object_number}`,heading=element('h2',item.title||label);
  heading.id='board-object-heading';modal.setAttribute('aria-labelledby',heading.id);modal.id='board-object';
  const head=element('div','','heading');head.append(heading,button('关闭',()=>modal.close()));modal.append(head);
  const stage=boardState.stages.find(s=>s.id===item.bot_stage),summary=element('div','','board-object-meta');
  summary.append(element('span',`${label} · ${item.full_name||'仓库 '+item.repository_id}`));
  if(stage){const info=boardStage(stage,item.object_type);summary.append(badge(info.name,item.bot_stage==='attention'?'warning':'info'),element('span',info.hint||'','muted'));}
  const url=boardGithub(item);if(url)summary.append(link(url,'在 GitHub 打开'));
  const taskList=element('div','正在加载关联任务…','board-object-tasks');modal.append(summary,element('h3','关联任务'),taskList);document.body.append(modal);
  modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
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
// Close the view menu on an outside click or Escape, like other popovers.
document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.board-menu.open'))if(!menu.contains(event.target))boardOpenMenu(menu,false);});
document.addEventListener('keydown',event=>{if(event.key==='Escape')for(const menu of document.querySelectorAll('.board-menu.open'))boardOpenMenu(menu,false);});
