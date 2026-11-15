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
  // Signing out or leaving the board ends the chain; the next render of the board starts it again.
  if(!me||tab!=='board'||!boardState||boardState.owner!==me.id){boardPollStop();return;}
  const columns=$('board-columns');
  if(!columns||columns.hasAttribute('aria-busy')||columns.contains(document.activeElement)||document.querySelector('dialog[open],.board-menu.open')
    ||projectRoute()||document.hidden||boardDragging){boardPollSchedule();return;}
  const request=boardRequest,owner=me.id;let result;
  try{result=await api('/api/board/cards?'+boardParams(0));}
  catch(err){
    if(boardAccessLost(err,request,owner))return;
    // #789 review: only signing out or leaving the board ends the chain. A newer read (the toolbar's 刷新, a view or
    // filter change) bumps boardRequest, and this poll's answer is then stale — but the chain still has to keep going,
    // or the quiet refresh stops for good until the board is rendered again.
    if(me?.id!==owner||tab!=='board'){boardPollStop();return;}
    if(request!==boardRequest||boardDragging){boardPollSchedule();return;}
    const answer=pollAfterError(err,boardPollBackoff);
    if(answer.terminal){boardPollStopped(err);return;}
    // Anything else may clear on its own: keep the cards, say how long the next read waits, and leave the same control.
    boardPollBackoff=answer.delay;
    $('board-status')?.replaceChildren(element('span',`刷新失败，保留上次读取结果。${Math.round(answer.delay/1000)} 秒后自动重试…`),
      boardButton('重新读取看板',()=>renderBoard(++renderVersion),'board-link'));
    boardPollSchedule(answer.delay);
    return;
  }
  // Same rule on the success path: a superseded answer is dropped, the chain is not.
  if(me?.id!==owner||tab!=='board'){boardPollStop();return;}
  if(request!==boardRequest||boardDragging){boardPollSchedule();return;}
  boardPollBackoff=0;boardPollSchedule();
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
