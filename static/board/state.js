// Saved views and custom fields belong to the signed-in user. Execution stages remain read-only.
// A card is one work type's work on one object (or a release); saved views include object scope as well as grouping.
let boardState = null, boardRequest = 0, boardDragging = false;
// #503: one page read at a time, and a failed page stops the auto-loading until the reader asks for it again.
let boardPending = 0, boardLoadFailed = false;
// #789: the quiet refresh runs on a chain of its own instead of an unconditional interval, so a terminal answer can stop
// it and a failure can back off. The delay in millis is kept for the next poll.js decision.
let boardPollTimer = null, boardPollBackoff = 0;
function boardPollStop() { if (boardPollTimer !== null) { clearTimeout(boardPollTimer); boardPollTimer = null; } }
// One tick at a time: the next is scheduled only after this one is answered, so a slow server never stacks requests.
function boardPollSchedule(delay = 15000) {
  boardPollStop();
  boardPollTimer = setTimeout(() => { boardPollTimer = null; boardPoll().catch(() => {}); }, delay);
}
// A 404 (or 401/403) answers the same way however often it is asked: stop, say so once and leave the reader a control.
function boardPollStopped(err) {
  boardPollStop(); boardPollBackoff = 0;
  $('board-status')?.replaceChildren(element('span', `看板刷新已停止：服务端返回 ${err.status}。`),
    boardButton('重新读取看板', () => renderBoard(++renderVersion), 'board-link'));
}
// #789 review: a new session starts at the first step of the backoff, not at whatever delay the previous one ended on.
function resetBoard() { boardPollStop();boardPollBackoff=0;boardRequest++;boardState=null;boardDragging=false;$('board-panel')?.replaceChildren(); }
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
function boardCustomField() { return boardState.fields.find(f=>f.id===boardGrouping()); }
function boardColumns() {
  if(boardGrouping()==='bot_stage')return boardState.stages.map(s=>boardStage(s));
  if(boardGrouping()==='repository')return repositories.filter(r=>!boardFilter('repository_id')||r.id===boardFilter('repository_id')).map(r=>({id:r.id,name:r.full_name,hint:'仅列出你有权访问的仓库'}));
  if(boardGrouping()==='execution_status')return boardExecutionStatuses.map(([id,name])=>({id,name}));
  if(boardGrouping()==='category'){
    // Cards of any other category keep a column of their own.
    const columns=boardCategories().slice(1).filter(([id])=>!boardFamilies[id]&&boardInCategory(id)).map(([id,name])=>({id,name}));
    for(const id of Object.keys(boardState.columnCounts||{}))if(!columns.some(c=>c.id===id)&&boardInCategory(id))
      columns.push({id,name:boardState.cards.find(c=>c.card_category===id)?.card_category_name||'已删除的工作类型'});
    return columns;
  }
  return [{id:'unassigned',name:'未设置',hint:'还没有为这个字段选值'},...(boardCustomField()?.options||[])];
}
function boardFilter(field) { return boardState.filters.find(f=>f.field===field)?.value; }
// A saved repository condition applies only to All projects. A project address always owns the query scope.
function boardEffectiveScope() { return projectRoute()?.id || String(boardFilter('repository_id') || ''); }
function boardGrouping() { return projectRoute() && boardState.group === 'repository' ? 'bot_stage' : boardState.group; }
function boardCategory() { return boardFilter('category')||'all'; }
function boardSetFilter(field,value) {
  boardState.mobileColumn=null;
  boardState.filters=boardState.filters.filter(f=>f.field!==field);
  if(value!==''&&value!==undefined&&value!==false)boardState.filters.push({field,value});
  boardDirty();
}
// Saving a view never adds the address's project. Legacy repository conditions remain part of that view.
function boardOwnFilters() { return boardState.filters.filter(f=>f.value!==''&&f.value!==undefined); }
function boardConditions() {
  const project = projectRoute()?.id;
  const conditions = boardOwnFilters().filter(filter => !project || filter.field !== 'repository_id');
  if (project) conditions.push({field:'repository_id',value:project});
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
