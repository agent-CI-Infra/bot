// Saved views and custom fields belong to the signed-in user. Execution stages remain read-only.
// A card is one work type's work on one object (or a release); saved views include object scope as well as grouping.
let boardState = null, boardRequest = 0, boardDragging = false;
// #503: one page read at a time, and a failed page stops the auto-loading until the reader asks for it again.
let boardPending = 0, boardLoadFailed = false;
function resetBoard() { boardRequest++;boardState=null;boardDragging=false;$('board-panel')?.replaceChildren(); }
const boardPageSize = 100, boardTypes = [['', '全部对象'], ['issue', 'Issue'], ['pr', 'PR'], ['task', '通用任务']];
const boardMedia = matchMedia('(max-width:760px)');
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
function boardOptions(labelText,choices,value,change) {
  const group=element('div','','board-options'),list=element('div','','board-options-list');
  group.setAttribute('role','group');group.setAttribute('aria-label',labelText);
  group.append(element('span',labelText,'board-options-label'),list);
  const select=next=>{value=next;for(const control of list.children)control.setAttribute('aria-pressed',String(control.dataset.value===value));};
  for(const [id,name]of choices){
    const control=boardButton(name,async()=>{
      if(id===value)return;const previous=value;select(id);
      // Creating a custom view can defer activation until the dialog is submitted.
      try{if(await change(id)===false)select(previous);}catch(err){select(previous);throw err;}
    },'quiet board-option');
    control.dataset.value=id;control.title=name;list.append(control);
  }
  select(value);return group;
}
function boardView() { return boardState.views.find(v=>v.id===boardState.viewId); }
function boardTypeName(type=boardState.type) { return type==='task'?'任务':type==='pr'?'PR':type==='release'?'发版本':'Issue'; }
// The work types with cards. A view saved before the board listed them may filter a family (every review or every
// development), offered while it is selected; one saved with a former custom workflow shows the reply cards.
const boardFamilies={review:'检视（Issue 与 PR）',development:'开发与跟进（Issue 与 PR）'};
const boardObjectWorkflow=id=>/^(review|development)\.(issue|pr)$/.test(id||'');
function boardCategories() {
  const list=boardState.workflows||[],names=list.map(w=>w.name),category=boardCategory();
  const choices=list.map(w=>[w.id,w.repository&&names.filter(n=>n===w.name).length>1?`${w.name}（${w.repository}）`:w.name]);
  return [['','全部工作类型'],...(boardFamilies[category]?[[category,boardFamilies[category]]]:[]),...choices];
}
const boardInCategory=id=>{const category=boardCategory();return category==='all'||id===category||!!boardFamilies[category]&&id.startsWith(category+'.');};
const boardExecutionStatuses=[['running','正在执行'],['queued','排队'],['failed','失败'],['completed','已完成'],['waiting','等待处理'],['other','其他 / 未开始']];
const boardStandardGroups=['bot_stage','repository','execution_status','category'];
// The PR board renames development stages: there the bot revises its own PR after a review.
// A reply card moves through the review stages; their names say it ran rather than reviewed.
function boardStage(stage,type=boardState.type) {
  const category=boardCategory();if(boardObjectWorkflow(category))type=category.split('.')[1];
  const mixed=(category==='release'?{developing:'发版本中',developed:'发版本完成'}:category==='reply'||/^custom\./.test(category)?{unreviewed:'未执行',reviewing:'正在执行',reviewed:'已执行'}
    :type==='all'?{developing:'开发 / 跟进 / 发版中',developed:'开发 / 跟进 / 发版完成'}:{})[stage.id];
  return {...stage,...(type==='pr'?stage.pr:{}),...(mixed?{name:mixed}:{})};
}
function boardCustomField() { return boardState.fields.find(f=>f.id===boardState.group); }
function boardColumns() {
  if(boardState.group==='bot_stage')return boardState.stages.map(s=>boardStage(s));
  if(boardState.group==='repository')return repositories.filter(r=>!boardFilter('repository_id')||r.id===boardFilter('repository_id')).map(r=>({id:r.id,name:r.full_name,hint:'仅列出你有权访问的仓库'}));
  if(boardState.group==='execution_status')return boardExecutionStatuses.map(([id,name])=>({id,name}));
  if(boardState.group==='category'){
    // Cards of any other category keep a column of their own.
    const columns=boardCategories().slice(1).filter(([id])=>!boardFamilies[id]&&boardInCategory(id)).map(([id,name])=>({id,name}));
    for(const id of Object.keys(boardState.columnCounts||{}))if(!columns.some(c=>c.id===id)&&boardInCategory(id))
      columns.push({id,name:boardState.cards.find(c=>c.card_category===id)?.card_category_name||'已删除的工作类型'});
    return columns;
  }
  return [{id:'unassigned',name:'未设置',hint:'还没有为这个字段选值'},...(boardCustomField()?.options||[])];
}
function boardFilter(field) { return boardState.filters.find(f=>f.field===field)?.value; }
// #480: an explicit board filter wins; otherwise the shell picker's project is the effective scope. The default is never
// written into the saved view, so a saved view keeps exactly the filters it was saved with.
function boardDefaultScope() {
  const shared=typeof consoleDefaultProject==='function'?consoleDefaultProject():null;
  return shared&&repositories.some(r=>String(r.id)===String(shared))?String(shared):'';
}
function boardEffectiveScope() { return String(boardFilter('repository_id')||'')||boardDefaultScope(); }
// Choosing the default's own project on this page is still the default: it keeps following the picker, and the chip and the
// sentence must not call the same scope both "an override" and "the shell default".
function boardFollowsDefault() { const shared=boardDefaultScope(),explicit=String(boardFilter('repository_id')||''); return !explicit||(!!shared&&explicit===shared); }
function boardScopeCaption() {
  const name=id=>repositories.find(r=>String(r.id)===id)?.full_name||('仓库 '+id),explicit=boardFilter('repository_id'),shared=boardDefaultScope();
  if(!shared)return '生效范围：'+(explicit?name(String(explicit))+'（本页覆盖）':'全部仓库（顶栏未选项目）');
  if(!boardFollowsDefault())return `生效范围：${name(String(explicit))}（本页覆盖；顶栏默认：${name(shared)}）`;
  return `生效范围：${name(shared)}（顶栏默认）`;
}
function boardCategory() { return boardFilter('category')||'all'; }
function boardSetFilter(field,value) {
  boardState.mobileColumn=null;
  boardState.filters=boardState.filters.filter(f=>f.field!==field);
  if(value!==''&&value!==undefined&&value!==false)boardState.filters.push({field,value});
  if(field==='repository_id'&&$('board-create-task'))$('board-create-task').href='#/new-task'+(boardEffectiveScope()?'/'+boardEffectiveScope():'');
  boardDirty();
}
// What the reader actually filtered on this page. Saved views store exactly this, never the shell default, so clearing the
// picker later cannot leave a view pinned to a project the reader never selected in it.
function boardOwnFilters() { return boardState.filters.filter(f=>f.value!==''&&f.value!==undefined); }
// What the board queries with: the page's own filters plus the shared default when the page names no repository.
function boardConditions() {
  const conditions=boardOwnFilters();
  if(!conditions.some(f=>f.field==='repository_id')&&boardDefaultScope())conditions.push({field:'repository_id',value:boardDefaultScope()});
  return conditions;
}
// Unsaved means different from the stored view, so undoing a change hides the save button again.
function boardViewShape(filters,hidden,group) {
  const sorted=list=>[...list].map(f=>JSON.stringify([f.field,f.value])).sort();
  return JSON.stringify([sorted(filters.filter(f=>f.value!==''&&f.value!==undefined&&f.value!==false&&!(f.field==='object_type'&&f.value==='all'))),[...hidden].sort(),group]);
}
function boardDirty() {
  const view=boardView();
  boardState.dirty=boardViewShape(boardState.filters,boardState.hidden,boardState.group)!==boardViewShape(view.filters,view.hidden_columns,view.group_by);boardViewControls();
}
// Invalidate older reads as well as the visible cards when current access is revoked.
function boardAccessLost(err,request,owner) {
  if(![401,403].includes(err.status)||request!==boardRequest||owner!==me?.id||tab!=='board')return false;
  boardRequest++;boardState=null;
  $('board-panel').replaceChildren(consoleState('看板访问权限已变化','旧卡片和视图缓存已清除，请重新读取当前可访问的工作。',{tone:'error'}),
    boardButton('重新读取看板',()=>renderBoard(++renderVersion)));
  return true;
}
function boardAddressCategory() { return {'#/reviews':'review','#/developments':'development'}[location.hash]||''; }
// Coming back to the tab keeps unsaved filter edits; creating, switching or deleting a view loads that view.
async function renderBoard(request,useView=false) {
  const owner=me.id,position=!useView&&boardState?.owner===me.id?boardState.positions?.[boardState.layout]:null;
  if(boardState?.owner!==owner){boardState=null;$('board-panel').replaceChildren();}
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
  boardMedia.addEventListener('change',()=>{if(filters.isConnected)syncFilterOpen();});
  const summary=element('summary','筛选');summary.addEventListener('click',()=>{boardState.filterOpen=!filters.open;});filters.append(summary);
  const controls=element('div','','board-filter-controls');controls.setAttribute('role','group');controls.setAttribute('aria-label','筛选');
  const apply=async(field,value,rebuild=false)=>{boardSetFilter(field,value);if(rebuild)boardShell();else boardChips();await boardLoadCards().catch(error);};
  const repoChoices=[['','全部仓库'],...repositories.map(r=>[r.id,r.full_name])],repo=boardEffectiveScope();
  if(repo&&!repoChoices.some(c=>c[0]===repo))repoChoices.push([repo,'仓库不可访问']);
  // #482: repositories and work types grow with the account, so they are compact selects instead of rows of buttons.
  const repository=boardSelect('仓库',repoChoices,repo||'');repository.label.classList.add('board-field');
  repository.select.addEventListener('change',()=>apply('repository_id',repository.select.value));
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
  controls.append(repository.label,categories.label,execution,types,search,closed);filters.append(controls);
  const chips=element('div','','board-chips');chips.id='board-chips';chips.setAttribute('aria-label','当前筛选');
  const scopeNote=element('p',boardScopeCaption(),'board-scope');scopeNote.id='board-scope';
  const arrangement=element('div','','board-arrangement');arrangement.setAttribute('role','group');arrangement.setAttribute('aria-label','排列与视图');
  // #482: grouping stays one compact select; choosing a dimension the builtin view does not store opens the save dialog.
  const groups=boardSelect('按…分列',[['bot_stage','bot 执行阶段'],['repository','仓库'],['execution_status','执行状态'],['category','工作类型'],...boardState.fields.map(f=>[f.id,f.name])],boardState.group);
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
  const more=boardMenu('⋯','更多视图操作');more.menu.id='board-view-menu';
  const status=element('div','','board-status');status.id='board-status';status.setAttribute('role','status');
  const create=consoleLink('#/new-task'+(repo?'/'+repo:''),'新建任务');create.id='board-create-task';create.classList.add('board-create-task');
  arrangement.append(groups.label,viewControls,more.menu,element('span','','board-spacer'),status,create,boardButton('刷新',()=>boardLoadCards()));
  toolbar.append(filters,scopeNote,chips,arrangement);
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
  const scopeNote=$('board-scope');if(scopeNote)scopeNote.textContent=boardScopeCaption();
  const choices={repository_id:['仓库',repositories.map(r=>[r.id,r.full_name])],category:['工作类型',boardCategories()],
    execution_status:['执行状态',boardExecutionStatuses],object_type:['对象类型',boardTypes],
    bot_stage:['阶段',boardState.stages.map(s=>[s.id,boardStage(s).name])],text:['搜索',[]],include_closed:['含已关闭',[]]};
  for(const filter of boardConditions()){
    const [prefix,options]=choices[filter.field]||[filter.field,[]],value=options.find(([id])=>id===filter.value)?.[1]||(filter.field==='repository_id'?'仓库不可访问':filter.value);
    const caption=filter.field==='include_closed'?prefix:prefix+'：'+value+(filter.field==='repository_id'&&boardFollowsDefault()?'（顶栏默认）':''),chip=element('span','','board-chip');
    chip.append(element('span',caption));
    // A scope that comes from the shell picker is cleared there, not by a chip that would silently restore all projects.
    if(filter.field==='repository_id'&&boardFollowsDefault()){chips.append(chip);continue;}
    const remove=button('×',async()=>{boardSetFilter(filter.field,'');if(filter.field==='object_type')boardState.type='all';boardShell();await boardLoadCards().catch(error);},'quiet board-chip-remove');remove.setAttribute('aria-label','移除筛选 '+caption);
    chip.append(remove);chips.append(chip);
  }
}
function boardParams(offset) {
  return new URLSearchParams({view_id:boardState.viewId,group_by:boardState.group,offset:String(offset),limit:String(boardPageSize),
    filters:JSON.stringify(boardConditions())});
}
// #503: the scroll areas that actually scroll the cards in the current layout. Desktop columns scroll one by one;
// the list and the phone board scroll the board container itself. The nodes are rebuilt with every render.
function boardScrollAreas() {
  const columns=$('board-columns');if(!columns||!boardState)return [];
  if(boardState.layout==='list'||boardMedia.matches)return [columns];
  return [...columns.querySelectorAll('.board-column:not(.board-collapsed) .board-column-list')];
}
const boardEndReached=area=>area.scrollHeight-area.scrollTop-area.clientHeight<=200;
// A page is read in two cases: the reader scrolled an area that really overflows to its end, or the board cannot scroll
// at all yet while pages remain — a group whose first card sits on a later page must not leave a dead 「请加载更多」 line.
// A short column that merely overflows by a few pixels never counts as «the reader reached the end»: only a real scroll
// does, so the first page of a long board is not read to its end before the reader touches it.
async function boardContinue(fromScroll=false) {
  if(!me||tab!=='board'||boardPending||boardLoadFailed||!boardState?.hasMore||boardState.owner!==me.id)return;
  // A render that happens before the board has its height (a hidden tab, the first frame of a layout switch) measures 0.
  const areas=boardScrollAreas().filter(area=>area.clientHeight>0);
  if(!areas.length)return;
  const scrollable=areas.filter(area=>area.scrollHeight>area.clientHeight+1);
  if(fromScroll){if(!scrollable.some(boardEndReached))return;}
  else if(scrollable.length)return;
  try{await boardLoadCards(true);}catch{/* boardLoadCards reports the failure and keeps the loaded cards */}
}
async function boardLoadCards(more=false) {
  if(more&&boardPending)return;
  const request=++boardRequest,owner=me.id,offset=more?boardState.offset+boardPageSize:0;
  boardPending++;if(!more)boardLoadFailed=false;
  $('board-columns').setAttribute('aria-busy','true');if(!more)$('board-status').textContent='正在加载…';
  try {
    const result=await api('/api/board/cards?'+boardParams(offset));
    if(request!==boardRequest||me?.id!==owner||tab!=='board')return;
    // A task can move between pages while loading; deduplicate by object and work family.
    const known=more?boardState.cards:[],keys=new Set(known.map(boardCardKey));
    Object.assign(boardState,{cards:[...known,...result.cards.filter(c=>!keys.has(boardCardKey(c)))],offset,hasMore:result.has_more,counts:result.counts,releaseCount:result.release_count,workCount:result.work_count,columnCounts:result.column_counts,
      signature:more?'':JSON.stringify([result.cards,result.has_more,result.counts,result.release_count,result.column_counts])});
    boardRenderCards(more);
  }catch(err){
    if(!boardAccessLost(err,request,owner)&&request===boardRequest&&owner===me?.id&&tab==='board'){
      // A first read that fails with nothing on screen is a failure too: the count is unknown, not zero.
      if(more||!boardState.cards?.length)boardLoadFailed=true;
      $('board-status').textContent=boardState.cards?.length?'读取失败，保留上次读取结果。':'工作数量未知，读取失败。';
    }
    throw err;
  }
  finally{
    boardPending--;
    if(request===boardRequest)$('board-columns')?.removeAttribute('aria-busy');
    boardSummary();
    // The page that just arrived can leave the board still unable to scroll: keep reading, one page at a time.
    if(!boardLoadFailed)void boardContinue();
  }
}
// Stages change while the bot works. Refresh the first page quietly unless the person is in the middle of something.
async function boardPoll() {
  if(!me||tab!=='board'||projectRoute()||document.hidden||boardDragging||boardState?.owner!==me.id)return;
  const columns=$('board-columns');
  if(!columns||columns.hasAttribute('aria-busy')||columns.contains(document.activeElement)||document.querySelector('dialog[open],.board-menu.open'))return;
  const request=boardRequest,owner=me.id;let result;
  try{result=await api('/api/board/cards?'+boardParams(0));}
  catch(err){
    if(!boardAccessLost(err,request,owner)&&request===boardRequest&&owner===me?.id&&tab==='board')
      $('board-status').textContent='刷新失败，保留上次读取结果。可点击刷新重试。';
    return;
  }
  if(request!==boardRequest||me?.id!==owner||tab!=='board'||boardDragging)return;
  // #503: a quiet read that succeeds proves the failure is over. Without this the summary keeps
  // 「读取失败，保留上次读取结果。」 over live cards and boardContinue() stays blocked on the flag.
  boardLoadFailed=false;
  // #503: once the reader has paged past the first page the quiet refresh only refreshes the counts. Replacing the cards
  // would drop the appended pages and the reading position, so the loaded cards stay exactly where they are.
  if(boardState.offset>0){
    Object.assign(boardState,{counts:result.counts,releaseCount:result.release_count,workCount:result.work_count,columnCounts:result.column_counts});
    boardSummary();
    // The failure flag is gone, so paging may resume: the reader can keep reading without clicking 重试.
    void boardContinue();return;
  }
  const signature=JSON.stringify([result.cards,result.has_more,result.counts,result.release_count,result.column_counts]);if(signature===boardState.signature){boardSummary();return;}
  Object.assign(boardState,{cards:result.cards,hasMore:result.has_more,counts:result.counts,releaseCount:result.release_count,workCount:result.work_count,columnCounts:result.column_counts,signature});boardRenderCards(true);
}
setInterval(()=>boardPoll().catch(()=>{}),15000);
function boardToggleColumn(id) {
  boardState.hidden=boardState.hidden.includes(id)?boardState.hidden.filter(c=>c!==id):[...boardState.hidden,id];boardDirty();boardRenderCards(true);
}
function boardCardCategory(item) { return item.card_category; }
function boardColumnValue(item) {
  if(boardState.group==='bot_stage')return item.bot_stage;
  if(boardState.group==='repository')return item.repository_id;
  if(boardState.group==='execution_status')return item.execution_status;
  if(boardState.group==='category')return boardCardCategory(item);
  return item.field_value||'unassigned';
}
function boardRenderCards(keepScroll=false) {
  const columns=$('board-columns');if(!columns)return;
  const left=columns.scrollLeft,top=columns.scrollTop,tops=new Map([...columns.querySelectorAll('.board-column')].map(c=>[c.dataset.columnId,c.querySelector('.board-column-list')?.scrollTop||0]));
  columns.classList.toggle('board-list-layout',boardState.layout==='list');
  columns.replaceChildren();const stageMode=boardState.group==='bot_stage',customMode=!!boardCustomField(),visible=boardState.cards,allColumns=boardColumns();
  const total=id=>boardState.columnCounts?.[id]||0;
  if(!allColumns.some(c=>c.id===boardState.mobileColumn))boardState.mobileColumn=allColumns.find(c=>total(c.id)>0)?.id||allColumns[0]?.id;
  const mobile=$('board-mobile-group');mobile.replaceChildren();allColumns.forEach(c=>mobile.add(new Option(c.name+' · '+total(c.id),c.id)));mobile.value=boardState.mobileColumn||'';
  $('board-zero-counts').textContent=customMode?'':allColumns.filter(c=>!total(c.id)).map(c=>c.name+' 0').join(' · ');
  const displayed=allColumns.filter(c=>customMode||total(c.id)>0||boardMedia.matches&&c.id===boardState.mobileColumn);
  for(const column of displayed){
    const collapsed=boardState.layout!=='list'&&!boardMedia.matches&&boardState.hidden.includes(column.id),cards=visible.filter(c=>boardColumnValue(c)===column.id);
    const section=element('section','','board-column'+(collapsed?' board-collapsed':''));section.dataset.columnId=column.id;section.dataset.dimension=boardState.group;section.classList.toggle('board-mobile-selected',column.id===boardState.mobileColumn);
    if(stageMode)section.dataset.stage=column.id;section.setAttribute('aria-label',column.name);
    const heading=element('div','','board-column-heading'),dot=element('span','','board-column-dot'),count=element('span',String(total(column.id)),'board-column-count');
    if(column.hint)heading.title=column.hint;dot.setAttribute('aria-hidden','true');count.setAttribute('aria-label',total(column.id)+' 项工作');
    const toggle=button(collapsed?'›':'‹',()=>boardToggleColumn(column.id),'board-collapse');
    toggle.hidden=boardState.layout==='list';
    toggle.setAttribute('aria-label',(collapsed?'展开 ':'折叠 ')+column.name);toggle.setAttribute('aria-expanded',String(!collapsed));
    heading.append(dot,element('h2',column.name),count,toggle);section.append(heading);
    section.addEventListener('dragover',event=>{if(customMode&&boardState.layout!=='list'){event.preventDefault();event.dataTransfer.dropEffect='move';section.classList.add('board-drop-target');}});
    section.addEventListener('dragleave',event=>{if(!section.contains(event.relatedTarget))section.classList.remove('board-drop-target');});
    section.addEventListener('drop',async event=>{
      event.preventDefault();section.classList.remove('board-drop-target');boardDragging=false;if(!customMode||boardState.layout==='list')return;
      const key=event.dataTransfer.getData('application/x-bot-board');const item=boardState.cards.find(c=>boardCardKey(c)===key&&c.card_type!=='release');
      if(item&&(item.field_value||'unassigned')!==column.id)await boardMove(item,column.id==='unassigned'?null:column.id).catch(error);
    });
    if(collapsed)section.addEventListener('click',event=>{if(!event.target.closest('button'))boardToggleColumn(column.id);});
    else{
      const list=element('div','','board-column-list');cards.forEach(item=>list.append(boardCard(item)));
      if(!cards.length)list.append(element('p',total(column.id)?'这一分组的工作还在后面几页里，继续向下滚动就会读到。':'当前筛选和分组下没有条目','board-empty'));section.append(list);
    }
    columns.append(section);
  }
  if(!displayed.length)columns.append(element('p','当前筛选和分组下没有条目','board-empty'));
  if(keepScroll){columns.scrollLeft=left;columns.scrollTop=top;for(const list of columns.querySelectorAll('.board-column-list'))list.scrollTop=tops.get(list.closest('.board-column').dataset.columnId)||0;}
  else{columns.scrollLeft=0;columns.scrollTop=0;}
  // A desktop column list is rebuilt by every render, so its listener drops with the old node. The phone and list
  // layouts scroll the board container itself, which survives a render: bind it once, or every render adds a listener
  // and a single scroll reports itself several times.
  for(const area of boardScrollAreas()){if(area.boardScrollBound)continue;area.boardScrollBound=true;area.addEventListener('scroll',()=>{void boardContinue(true);},{passive:true});}
  boardSummary();
  // A layout switch can leave a phone column empty and the container short; that still has to read on until it can scroll.
  void boardContinue();
}
// #503: the next page is read by scrolling, so the summary reports progress instead of offering a permanent button.
// A failed page offers one 「重试」 that asks for the same offset again and disappears as soon as it succeeds.
function boardSummary() {
  const status=$('board-status');if(!status||!boardState)return;
  const clearFilters=()=>{if(!boardState.cards.length&&boardOwnFilters().length)status.append(boardButton('清除筛选',async()=>{
    boardState.filters=[];boardState.type='all';boardDirty();boardShell();await boardLoadCards();
  },'board-link'));};
  // Nothing loaded and the first read failed: the work count is unknown, not zero.
  if(boardLoadFailed&&!boardState.cards.length){status.replaceChildren(element('span','工作数量未知，读取失败。'));clearFilters();return;}
  status.replaceChildren(element('span',`共 ${boardState.workCount||0} 项工作`));
  // A board that fits one page keeps the bare count it has always shown; the progress line is for boards with pages.
  if(!boardState.hasMore&&boardState.offset===0){clearFilters();return;}
  if(boardState.cards.length)status.append(element('span',`已加载 ${boardState.cards.length} 项`));
  if(boardPending)status.append(element('span',`正在加载${boardState.cards.length?'更多':''}…`));
  else if(boardLoadFailed)status.append(element('span','读取失败，保留上次读取结果。'),boardButton('重试',()=>{boardLoadFailed=false;boardLoadCards(true).catch(()=>{});},'board-link'));
  else if(!boardState.hasMore)status.append(element('span','已全部加载'));
  clearFilters();
}
function boardKey(item) { return `${item.repository_id}/${item.object_type}/${item.card_type==='release'?item.release_id:item.card_type==='task'?item.task_id:item.object_number}`; }
function boardCardKey(item) { return boardKey(item)+'/'+(item.card_category||''); }
function boardGithub(item,type=item.object_type,number=item.object_number) {
  if(item.card_type==='task')return null;
  if(item.card_type==='release')return item.release_url||null;
  return /^[\w.-]+\/[\w.-]+$/.test(item.full_name||'')?`https://github.com/${item.full_name}/${type==='pr'?'pull':'issues'}/${number}`:null;
}
function boardTime(value) {
  const date=new Date(value),pad=n=>String(n).padStart(2,'0');if(Number.isNaN(date.getTime()))return '';
  return `${date.getFullYear()===new Date().getFullYear()?'':date.getFullYear()+'-'}${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// The latest task of the card's work type explains why it sits in its stage, e.g. which task failed.
function boardTaskBadge(prefix,status) { const [caption,tone]=states[status]||[status,''],b=badge(`${prefix} ${caption}`,tone);b.title=status;return b; }
// #655: only the stop the bot makes because its object no longer needs work gets the plain sentence; a cancellation for
// another reason (a revoked claim, a disabled project) keeps its badge alone.
function boardStopNote(item) {
  if(item.card_type==='release'||item.task_error_code!=='object_closed_or_draft')return '';
  const thing=item.object_type==='pr'?'PR':'Issue',work=(item.card_category||'').startsWith('development.')?'开发':'检视';
  return `${thing} ${item.github_state==='closed'?'已关闭':'已转草稿'}，已自动停止${work}`;
}
// The next move is stated only when the recorded state names it; a status without one, or no status at all, stays silent.
const boardNextSteps={waiting_configuration:'补齐配置后重试',waiting_environment:'修复环境后重试',waiting_permission:'处理权限后重试',
  waiting_pr_head:'等 PR 更新后继续',waiting_publication:'确认发布',retry_wait:'等待自动重试',needs_replan:'补充信息后重试',
  paused:'确认后继续',failed:'查看失败原因后重试',result_ready:'核对结果后发布'};
function boardNextStep(item) {
  if(item.card_type==='release')return '';
  // A closed object cannot be acted on any more, so it never carries a next step — not even retry advice for a
  // task that is still in an attention status.
  if(item.github_state==='closed')return '';
  const step=boardNextSteps[item.task_status];if(step)return step;
  if(item.task_status)return '';
  return item.draft?'等待作者标记为可评审':'';
}
function boardCard(item) {
  const release=item.card_type==='release',customMode=!!boardCustomField()&&item.card_type!=='task',category=boardCardCategory(item);
  const label=release?`发版本 ${item.version}`:item.card_type==='task'?`任务 ${shortId(item.task_id)}`:`${boardTypeName(item.object_type)} #${item.object_number}`;
  const card=element('article','','board-card'+(release?' board-release-card':''));card.dataset.cardKey=boardKey(item);card.draggable=customMode&&!release&&boardState.layout!=='list';
  if(item.card_category)card.dataset.cardCategory=item.card_category;
  card.addEventListener('dragstart',event=>{if(!customMode||release||boardState.layout==='list'){event.preventDefault();return;}boardDragging=true;event.dataTransfer.setData('application/x-bot-board',boardCardKey(item));event.dataTransfer.effectAllowed='move';});
  card.addEventListener('dragend',()=>{boardDragging=false;});
  card.addEventListener('click',event=>{if(!event.target.closest('a,button,select,label,input'))boardOpen(item).catch(error);});
  const heading=element('div','','board-card-heading'),title=boardButton('',()=>boardOpen(item),'quiet board-card-title');title.title=item.title||label;
  // Keep the object type and number beside a title that can wrap to its full length.
  const caption=element('span','','board-card-caption');title.append(caption);
  if(release)caption.append(element('span','发版本','board-card-number'),document.createTextNode(' '),element('span',item.version,'board-card-text'));
  else if(item.title)caption.append(element('span',item.card_type==='task'?'任务 '+shortId(item.task_id):boardTypeName(item.object_type)+' #'+item.object_number,'board-card-number'),document.createTextNode(' '),element('span',item.title,'board-card-text'));
  else caption.append(element('span',label,'board-card-text'));
  heading.append(title);
  const url=boardGithub(item);if(url){const a=link(url,'↗','board-card-link');a.setAttribute('aria-label','在 GitHub 打开 '+label);a.title='在 GitHub 打开';heading.append(a);}
  if(customMode&&!release&&boardState.layout!=='list'){const handle=element('span','⠿','board-drag-handle');handle.draggable=true;handle.setAttribute('aria-label','拖动卡片');handle.title='拖动卡片到其他列';heading.append(handle);}
  const meta=element('div','','board-card-meta'),time=element('span',boardTime(item.last_seen),'board-card-time');time.title='最近活动 '+timestamp(item.last_seen);
  const repoName=element('span',item.full_name||'仓库 '+item.repository_id,'board-card-repo');repoName.title=item.full_name||`仓库 ${item.repository_id}`;meta.append(repoName,time);
  const badges=element('div','','board-card-badges');
  if(release){const tone=item.execution_status==='failed'?'danger':item.execution_status==='waiting'?'warning':item.execution_status==='completed'?'success':'info';badges.append(badge(releaseStages[item.release_stage]||item.release_stage,tone));}
  else{
    const workflow=item.card_category_name||'检视';
    if(!item.task_id)badges.append(badge(workflow+' 未开始',''));
    if(item.draft)badges.append(badge('草稿','warning'));
    if(item.github_state==='closed')badges.append(badge('已关闭',''));
    if(item.task_status)badges.append(boardTaskBadge(workflow,item.task_status));
    if(item.object_type==='issue'&&item.development_pr_number&&category==='development.issue'){
      const pr=boardGithub(item,'pr',item.development_pr_number),caption='→ PR #'+item.development_pr_number;badges.append(pr?link(pr,caption,'board-card-pr'):element('span',caption,'board-card-pr'));
    }
  }
  const stopNote=release?'':boardStopNote(item);
  card.append(heading,meta);
  if(stopNote){const note=element('p',stopNote,'muted board-card-note');note.dataset.cardNote='auto-stop';card.append(note);}
  if(item.origin)card.append(element('p',taskOriginCaption(item.origin),'muted'));if(badges.childElementCount)card.append(badges);
  const next=boardNextStep(item);if(next)card.append(element('p','下一步：'+next,'board-card-next'));
  if(customMode&&!release){
    const custom=boardCustomField(),control=boardSelect(custom.name,[['','未设置'],...custom.options.map(o=>[o.id,o.name])],item.field_value||'');
    control.label.className='board-card-field';control.label.replaceChildren(control.select);
    control.select.addEventListener('change',async()=>{control.select.disabled=true;try{await boardMove(item,control.select.value||null);}catch(err){control.select.value=item.field_value||'';error(err);}finally{control.select.disabled=false;}});card.append(control.label);
  }
  return card;
}
async function boardMove(item,option) {
  if(!boardCustomField()||item.card_type==='release')return;
  await api('/api/board/cards/'+boardKey(item),'PATCH',{field_id:boardState.group,option_id:option});
  // Custom fields describe the GitHub object and are shared by its work cards.
  boardState.cards.filter(c=>boardKey(c)===boardKey(item)).forEach(c=>c.field_value=option);await boardLoadCards();
}
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
    catch(err){message.textContent=err.message;}finally{save.disabled=false;}
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
