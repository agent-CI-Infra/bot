function deliveryCaption(row){return {tasks_created:'已创建任务',draft:'因草稿跳过',not_trigger:'不是触发事件',duplicate:'重复，不重复建任务',review_disabled:'检视未开启，仅归档',project_disabled:'项目已禁用，仅归档',unregistered_repository:'仓库未启动，仅归档'}[row.processing_result]||row.processing_result||'已归档';}
// #238: reception, signature verification and processing are read as separate facts. Archive outcomes keep their own
// neutral wording, so duplicate/draft/disabled/untriggered rows never borrow the refusal styling of a bad signature.
const deliveryOutcomes = {
  // Wording stays the archive contract the existing trial spec reads: these are archive outcomes, not failures.
  tasks_created:['已创建任务','success'], duplicate:['重复，不重复建任务','info'], draft:['因草稿跳过','info'], not_trigger:['不是触发事件',''],
  review_disabled:['检视未开启，仅归档',''], project_disabled:['项目已禁用，仅归档',''], unregistered_repository:['仓库未启动，仅归档',''],
  invalid_signature:['未处理：签名无效','danger'], invalid_payload:['未处理：正文无效','danger'], payload_too_large:['未处理：正文过大','danger'],
  unknown_endpoint:['未处理：入口不存在','danger'], missing_event_or_delivery:['未处理：投递信息不全','danger'] };
const deliveryIgnoreReasons = {
  duplicate:'同一入口已经处理过这个 delivery ID，未再次分派。', draft:'草稿 PR 不交给 Manager。',
  project_disabled:'项目已禁用，事件只归档，未交给 Manager。', review_disabled:'检视未开启，事件只归档，未交给 Manager。',
  not_trigger:'这个事件或动作不触发任务，未交给 Manager。', unregistered_repository:'仓库未启动，事件只归档，未交给 Manager。',
  invalid_signature:'签名无效，未通过验签，未进入处理。', invalid_payload:'正文不是合法 JSON，未进入处理。',
  payload_too_large:'正文超过大小上限，未读取签名与入口。', unknown_endpoint:'账号下没有这个 Webhook 入口，未验签、未处理。',
  missing_event_or_delivery:'缺少事件名或 delivery ID，未进入处理。' };
function deliveryOutcome(row){ const result=row.processing_result; return deliveryOutcomes[result]||[deliveryCaption(row),'']; }
function deliveryFacet(kind,row){
  const reception=row.reception||{}, signature=row.signature||{};
  const [caption,tone]=kind==='reception'?(reception.accepted?['已接收','success']:['已拒收'+(reception.http_status?'（HTTP '+reception.http_status+'）':''),'danger'])
    :kind==='signature'?(signature.state==='verified'?['签名有效','success']:signature.state==='invalid'?['签名无效','danger']:['未验签',''])
    :deliveryOutcome(row);
  const node=element('span',caption,'status'+(tone?' status-'+tone:''));
  node.dataset.deliveryFacet=kind;
  node.dataset.deliveryState=kind==='reception'?(reception.accepted?'accepted':'rejected'):kind==='signature'?(signature.state||'unchecked'):String(row.processing_result||'');
  node.title=kind==='reception'?'接收':kind==='signature'?'验签':'处理结果'; return node;
}
function dispatchCaption(event){ return ({create:'新建任务',continue:'续接任务',ignore:'不处理'})[event.decision]||event.decision||event.state||'待分派'; }
function deliverySection(name,title,rows){ const section=element('section','','detail-section'); section.dataset.detailSection=name;
  section.append(element('h3',title), facts(rows)); return section; }
// The detail keeps the same three facts as sections, then the Manager dispatch and the archived raw request, which stays
// collapsed because it is evidence rather than the conclusion.
function deliveryDetail(value){
  const event=value.event, source=event.source||{}, reception=event.reception||{}, signature=event.signature||{};
  const delivery=element('code',String(event.delivery_id||'')); delivery.dataset.deliveryId='';
  const nodes=[], origin=element('section','','detail-section'); origin.dataset.detailSection='source';
  origin.append(element('h3','来源与引用'), facts([['GitHub delivery ID',delivery],['归档引用',source.reference||('deliveries:'+event.id)],
    ['事件',event.event],['路由',event.route],['账号 / 入口',[event.account_id,event.endpoint_id].filter(Boolean).join(' / ')],
    ['仓库',event.full_name||event.repository_id],['接收时间',timestamp(event.received_at)]])); nodes.push(origin);
  nodes.push(deliverySection('reception','接收',[['HTTP 状态',reception.http_status],['正文完整',reception.body_complete?'是':'否'],
    ['结果',reception.accepted?'已接收':'已拒收'+(reception.code?' · '+reception.code:'')]]));
  // "Unchecked" is not a failed verification: a body over the limit or an unknown endpoint never reaches the signature
  // check, so the basis says that instead of claiming the request failed it.
  const signatureBasis=signature.state==='verified'?'签名凭据、正文与入口都核验通过'
    :signature.state==='invalid'?'未通过验签，请求没有进入处理'
    :signature.reason==='payload_too_large'?'正文超过大小上限，验签没有执行'
    :signature.reason==='unknown_endpoint'?'账号下没有这个 Webhook 入口，验签没有执行'
    :'这次请求没有做验签';
  nodes.push(deliverySection('signature','验签',[['结果',signature.state==='verified'?'签名有效':signature.state==='invalid'?'签名无效':'未验签'],
    ['依据',signatureBasis]]));
  const processing=element('section','','detail-section'); processing.dataset.detailSection='processing';
  const [caption]=deliveryOutcome(event), rows=[['处理结果',caption]];
  if(deliveryIgnoreReasons[event.processing_result])rows.push(['说明',deliveryIgnoreReasons[event.processing_result]]);
  // response.review_outcome is computed before the Manager decides whether to create a task, so it can contradict the
  // row that did create one (a task is created for an event whose review_outcome still says not_trigger). It never adds
  // anything the archive outcome above does not already say, so it stays out of the page rather than being explained.
  processing.append(element('h3','处理'), facts(rows));
  // The created task is the point of the row, so its name opens the task instead of printing a dead label (#357).
  if((event.tasks||[]).length){ const tasks=element('ul','','delivery-tasks');
    for(const task of event.tasks){ const item=element('li','');
      item.append(button(`${kindLabels[task.kind]||task.kind} #${task.object_number} · 查看任务`,()=>openTask(task.id).catch(error),'quiet linkish'),
        element('span',' · '+task.status,'muted')); tasks.append(item); }
    processing.append(tasks); }
  nodes.push(processing);
  const dispatch=element('section','','detail-section'); dispatch.dataset.detailSection='dispatch'; dispatch.append(element('h3','Manager 分派'));
  if((event.dispatch||[]).length)for(const item of event.dispatch){
    const entry=element('div','','dispatch-entry'); entry.append(element('p',`${dispatchCaption(item)} · ${item.type||item.source||'事件'}`),
      element('p',item.reason?'原因：'+item.reason:'没有记录原因','muted'), element('p',timestamp(item.decided_at||item.created_at),'muted')); dispatch.append(entry); }
  else dispatch.append(element('p','未交给 Manager：'+(deliveryIgnoreReasons[event.processing_result]||'这个投递没有分派记录。'),'muted'));
  nodes.push(dispatch);
  // The read path replaces the closed set of credential keys (token, secret, password, authorization, cookie,
  // private_key) at every depth of request_headers, payload and response, and a body it cannot filter comes back as a
  // placeholder instead of the raw bytes. The summary says that, so it never promises a sanitiser this exit does not
  // have; a header removed at ingest is already gone before the body is read.
  const raw=element('details','','fold raw-payload'); raw.append(element('summary','原始请求与响应（凭据字段已脱敏；无法脱敏的正文不显示）'),
    element('pre',JSON.stringify({request_headers:event.request_headers,payload:event.payload,response:event.response},null,2),'output')); nodes.push(raw);
  return nodes;
}
