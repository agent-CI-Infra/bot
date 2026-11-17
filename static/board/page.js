// Coming back to the tab keeps unsaved filter edits; creating, switching or deleting a view loads that view.
async function renderBoard(request,useView=false) {
  const owner=me.id,position=!useView&&boardState?.owner===me.id?boardState.positions?.[boardState.layout]:null;
  if(boardState?.owner!==owner){boardState=null;$('board-panel').replaceChildren();}
  // #689: the list loading state lives in hidden #rows on this tab, so an empty
  // panel must show its own loading state until /api/board returns. A refresh
  // that still has the previous board keeps that UI instead of flashing blank.
  const panel=$('board-panel');
  if(panel&&!panel.childElementCount){
    panel.replaceChildren(consoleState('正在加载看板','正在读取视图与当前范围的工作。',{tone:'loading'}));
  }
  let data;try{data=await api('/api/board');}
  catch(err){
    if(request!==renderVersion||me?.id!==owner)return;
    if(!boardAccessLost(err,boardRequest,owner)){
      boardRequest++;boardState=null;
      $('board-panel').replaceChildren(consoleState('看板未能读取','视图和工作数量未知，请重新读取。',{tone:'error'}),
        boardButton('重新读取看板',()=>renderBoard(++renderVersion)));
    }
    return;
  }
  if(request!==renderVersion||me?.id!==owner)return;
  if(!boardState)boardState={owner,viewId:'default',type:'all',layout:'columns'};
  Object.assign(boardState,data);
  // The quiet refresh starts with the page it refreshes, not with the module being loaded; a full read also proves the
  // earlier failure is over, so the next failure waits the first step again.
  boardPollBackoff=0;boardPollSchedule();
  if(!boardState.views.some(v=>v.id===boardState.viewId)){boardState.viewId='default';useView=true;}
  if(useView||!boardState.filters)boardUseView();else boardShell();
  const category=boardAddressCategory();if(category){
    history.replaceState(null,'','#/board');boardSetFilter('category',category);boardShell();
  }
  // A board read failure must not bubble into the successful sign-in's boot failure screen.
  try{await boardLoadCards();}catch{return;}
  if(position&&request===renderVersion&&me?.id===owner&&tab==='board'){
    $('board-columns').scrollTop=position.top;$('board-columns').scrollLeft=position.left;
  }
}
function boardUseView() {
  const view=boardView(),filters=structuredClone(view.filters);
  Object.assign(boardState,{group:view.group_by,filters:filters.filter(f=>f.field!=='object_type'||f.value!=='all'),hidden:[...view.hidden_columns],
    type:filters.find(f=>f.field==='object_type')?.value||'all',mobileColumn:null,dirty:false,offset:0,cards:[],hasMore:false,columnCounts:{},signature:''});
  boardShell();
}
function boardSetType(type) {
  boardState.type=['issue','pr'].includes(type)?type:'all';boardSetFilter('object_type',boardState.type==='all'?'':boardState.type);
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
  const panel=$('board-panel');panel.replaceChildren();
  const toolbar=element('div','','board-toolbar'),category=boardCategory();
  const filters=document.createElement('details');filters.className='board-filter-details';
  // #482: a board rendered on the desktop keeps its filters open; narrowing the window to the phone layout folds them, so
  // the toolbar the reader sees matches the width they are at instead of the width the page was built on.
  const syncFilterOpen=()=>{filters.open=boardMedia.matches?boardState.filterOpen===true:true;};
  syncFilterOpen();filters.addEventListener('toggle',()=>{if(filters.isConnected)boardState.filterOpen=filters.open;});
  const summary=element('summary','筛选');summary.addEventListener('click',()=>{boardState.filterOpen=!filters.open;});filters.append(summary);
  const controls=element('div','','board-filter-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label','筛选');
  const apply=async(field,value,rebuild=false)=>{boardSetFilter(field,value);if(rebuild)boardShell();else boardChips();await boardLoadCards().catch(error);};
  const categories=boardSelect('工作类型',boardCategories(),category==='all'?'':category);categories.label.classList.add('board-field');
  categories.select.addEventListener('change',()=>apply('category',categories.select.value,true));
  const execution=boardOptions('执行状态',[['','全部状态'],...boardExecutionStatuses],boardFilter('execution_status')||'',value=>apply('execution_status',value));
  const types=boardOptions('对象类型',boardTypes,boardState.type==='all'?'':boardState.type,async value=>{
    boardSetType(value);boardShell();await boardLoadCards();
  });types.hidden=category==='release'||boardObjectWorkflow(category);
  const search=element('label','搜索','board-search'),input=document.createElement('input');
  input.type='search';input.maxLength=200;input.placeholder='编号、标题或版本';input.setAttribute('aria-label','搜索编号或标题');input.value=boardFilter('text')||'';
  let timer;input.addEventListener('input',event=>{if(event.isComposing)return;clearTimeout(timer);timer=setTimeout(()=>{
    if((boardFilter('text')||'')===input.value.trim())return;apply('text',input.value.trim());},300);});search.append(input);
  const closed=element('label','','board-check'),check=document.createElement('input');check.type='checkbox';check.checked=boardFilter('include_closed')===true;
  check.addEventListener('change',()=>apply('include_closed',check.checked));closed.append(check,document.createTextNode('含已关闭'));closed.hidden=category==='release';
  controls.append(categories.label,execution,types,search,closed);filters.append(controls);
  const chips=element('div','','board-chips');chips.id='board-chips';chips.setAttribute('aria-label','当前筛选');
  const arrangement=element('div','','board-arrangement');arrangement.setAttribute('role','group');arrangement.setAttribute('aria-label','排列与视图');
  // #482: grouping stays one compact select; choosing a dimension the builtin view does not store opens the save dialog.
  const groups=boardSelect('按…分列',[['bot_stage','bot 执行阶段'],...(!projectRoute()?[['repository','仓库']]:[]),['execution_status','执行状态'],['category','工作类型'],...boardState.fields.map(f=>[f.id,f.name])],boardGrouping());
  groups.label.className='board-field board-grouping';groups.select.id='board-grouping';
  groups.select.addEventListener('change',async()=>{
    const value=groups.select.value,previous=boardState.group;groups.select.value=previous;
    try{
      if(!boardView().builtin||boardStandardGroups.includes(value)){
        boardState.group=value;boardState.hidden=[];boardState.mobileColumn=null;boardDirty();boardShell();await boardLoadCards();
      }else boardSaveAs(value);
    }catch(err){groups.select.value=previous;error(err);}
  });
  // #482: the active view, its unsaved state and the save action are readable without opening `⋯`.
  const views=boardSelect('视图',boardState.views.map(v=>[v.id,v.name]),boardState.viewId);views.label.className='board-field board-view-choice';views.select.id='board-view-select';
  // #482: the caption is its own node so the narrow toolbar can drop it and keep the selector, state and save in one row.
  views.label.replaceChildren(element('span','视图','board-view-label'),views.select);
  views.select.addEventListener('change',()=>{boardState.viewId=views.select.value;boardUseView();boardLoadCards().catch(error);});
  const viewState=element('span','','board-view-state');viewState.id='board-view-state';viewState.textContent='未保存';viewState.hidden=true;
  const save=boardButton('保存视图',boardSave,'quiet board-save');save.id='board-save';save.hidden=true;
  const viewControls=element('div','','board-view-controls');viewControls.append(views.label,viewState,save);
  if(projectRoute()&&boardFilter('repository_id'))viewControls.append(element('span','此视图的仓库条件在单项目范围内不生效','muted board-view-scope-note'));
  const more=boardMenu('⋯','更多视图操作');more.menu.id='board-view-menu';
  const status=element('div','','board-status');status.id='board-status';status.setAttribute('role','status');
  const create=consoleLink(consolePageAddress('new-task'),'新建任务');create.id='board-create-task';create.classList.add('board-create-task');
  arrangement.append(groups.label,viewControls,more.menu,element('span','','board-spacer'),status,create,boardButton('刷新',()=>boardLoadCards()));
  toolbar.append(filters,chips,arrangement);
  const mobile=boardSelect('当前分组',[],'');mobile.label.className='board-mobile-group';mobile.select.id='board-mobile-group';
  mobile.select.addEventListener('change',()=>{boardState.mobileColumn=mobile.select.value;boardRenderCards();});
  const zero=element('div','','board-zero-counts');zero.id='board-zero-counts';
  const scroll=element('div','','board-scroll');scroll.id='board-columns';scroll.setAttribute('aria-label','看板工作');
  scroll.addEventListener('scroll',()=>{if(scroll.isConnected&&tab==='board'&&scroll.clientHeight>0&&boardState?.owner===me?.id){
    (boardState.positions??={})[boardState.layout]={top:scroll.scrollTop,left:scroll.scrollLeft};
  }},{passive:true});
  panel.append(toolbar,mobile.label,zero,scroll);boardViewControls();boardChips();
}
function boardViewControls() {
  const save=$('board-save'),panel=document.querySelector('#board-view-menu .board-menu-panel'),state=$('board-view-state');
  if(state)state.hidden=!boardState.dirty;
  // #482: the save action lives next to the view selector; the menu keeps only the secondary view operations.
  if(save)save.hidden=!boardState.dirty;
  if(!panel)return;
  panel.querySelectorAll('button').forEach(b=>b.remove());
  panel.append(boardButton(boardState.layout==='list'?'切换为分栏':'切换为列表',()=>{
    boardOpenMenu($('board-view-menu'),false);boardState.layout=boardState.layout==='list'?'columns':'list';
    const position=boardState.positions?.[boardState.layout];boardRenderCards(true);
    if(position){$('board-columns').scrollTop=position.top;$('board-columns').scrollLeft=position.left;}
    boardViewControls();document.querySelector('#board-view-menu .board-menu-toggle')?.focus();
  },'quiet board-menu-item'));
  panel.append(boardButton('另存视图',()=>{boardOpenMenu($('board-view-menu'),false);boardSaveAs();},'quiet board-menu-item'));
  if(boardState.group==='bot_stage'||boardCustomField())panel.append(boardButton(boardCustomField()?'加列':'新建自定义字段',()=>{boardOpenMenu($('board-view-menu'),false);boardAddColumn();},'quiet board-menu-item'));
  if(!boardView().builtin)panel.append(boardButton('删除视图',async()=>{
    await api('/api/board/views/'+boardState.viewId,'DELETE',{});boardState.viewId='default';await renderBoard(renderVersion,true);
  },'board-menu-item danger'));
}
function boardChips() {
  const chips=$('board-chips');if(!chips)return;chips.replaceChildren();
  const choices={repository_id:['仓库',repositories.map(r=>[r.id,r.full_name])],category:['工作类型',boardCategories()],
    execution_status:['执行状态',boardExecutionStatuses],object_type:['对象类型',boardTypes],
    bot_stage:['阶段',boardState.stages.map(s=>[s.id,boardStage(s).name])],text:['搜索',[]],include_closed:['含已关闭',[]]};
  for(const filter of boardOwnFilters().filter(filter=>!projectRoute()||filter.field!=='repository_id')){
    const [prefix,options]=choices[filter.field]||[filter.field,[]],value=options.find(([id])=>id===filter.value)?.[1]||(filter.field==='repository_id'?'仓库不可访问':filter.value);
    const caption=filter.field==='include_closed'?prefix:prefix+'：'+value,chip=element('span','','board-chip');
    chip.append(element('span',caption));
    const remove=button('×',async()=>{boardSetFilter(filter.field,'');if(filter.field==='object_type')boardState.type='all';boardShell();await boardLoadCards().catch(error);},'quiet board-chip-remove');remove.setAttribute('aria-label','移除筛选 '+caption);
    chip.append(remove);chips.append(chip);
  }
}
