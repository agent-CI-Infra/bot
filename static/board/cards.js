function boardToggleColumn(id) {
  boardState.hidden=boardState.hidden.includes(id)?boardState.hidden.filter(c=>c!==id):[...boardState.hidden,id];boardDirty();boardRenderCards(true);
}
function boardCardCategory(item) { return item.card_category; }
function boardColumnValue(item) {
  if(boardGrouping()==='bot_stage')return item.bot_stage;
  if(boardGrouping()==='repository')return item.repository_id;
  if(boardGrouping()==='execution_status')return item.execution_status;
  if(boardGrouping()==='category')return boardCardCategory(item);
  return item.field_value||'unassigned';
}
function boardRenderCards(keepScroll=false) {
  const columns=$('board-columns');if(!columns)return;
  const left=columns.scrollLeft,top=columns.scrollTop,tops=new Map([...columns.querySelectorAll('.board-column')].map(c=>[c.dataset.columnId,c.querySelector('.board-column-list')?.scrollTop||0]));
  columns.classList.toggle('board-list-layout',boardState.layout==='list');
  columns.replaceChildren();const stageMode=boardGrouping()==='bot_stage',customMode=!!boardCustomField(),visible=boardState.cards,allColumns=boardColumns();
  const total=id=>boardState.columnCounts?.[id]||0;
  if(!allColumns.some(c=>c.id===boardState.mobileColumn))boardState.mobileColumn=allColumns.find(c=>total(c.id)>0)?.id||allColumns[0]?.id;
  const mobile=$('board-mobile-group');mobile.replaceChildren();allColumns.forEach(c=>mobile.add(new Option(c.name+' · '+total(c.id),c.id)));mobile.value=boardState.mobileColumn||'';
  $('board-zero-counts').textContent=customMode?'':allColumns.filter(c=>!total(c.id)).map(c=>c.name+' 0').join(' · ');
  const displayed=allColumns.filter(c=>customMode||total(c.id)>0||boardMedia.matches&&c.id===boardState.mobileColumn);
  for(const column of displayed){
    const collapsed=boardState.layout!=='list'&&!boardMedia.matches&&boardState.hidden.includes(column.id),cards=visible.filter(c=>boardColumnValue(c)===column.id);
    const section=element('section','','board-column'+(collapsed?' board-collapsed':''));section.dataset.columnId=column.id;section.dataset.dimension=boardGrouping();section.classList.toggle('board-mobile-selected',column.id===boardState.mobileColumn);
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
// another reason (a revoked claim, a disabled project) keeps its badge alone. #713: so does a task the bot moved out of
// 待处理 as obsolete, which is the card's newest task when nothing newer took over.
function boardStopNote(item) {
  if(item.card_type==='release')return '';
  const thing=item.object_type==='pr'?'PR':'Issue',work=(item.card_category||'').startsWith('development.')?'开发':'检视';
  if(item.task_error_code==='object_closed_or_draft')return `${thing} ${item.github_state==='closed'?'已关闭':'已转草稿'}，已自动停止${work}`;
  // A task card has no Issue or PR of its own: the sweep dismissed it for the one its source task works on.
  if(item.task_error_code==='obsolete_closed')return `${item.card_type==='task'?'来源 Issue 或 PR':thing} 已关闭或合入，已自动移出待处理`;
  if(item.task_error_code==='obsolete_superseded')return `已有更新的${work}任务接手，已自动移出待处理`;
  if(item.task_error_code==='obsolete_expired')return '很久以前的平台类失败，之后没有新动静，已自动移出待处理';
  return '';
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
  await api('/api/board/cards/'+boardKey(item),'PATCH',{field_id:boardGrouping(),option_id:option});
  // Custom fields describe the GitHub object and are shared by its work cards.
  boardState.cards.filter(c=>boardKey(c)===boardKey(item)).forEach(c=>c.field_value=option);await boardLoadCards();
}
