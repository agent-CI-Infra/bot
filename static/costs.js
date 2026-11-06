let costState=null,costRequest=0;
const money=(value,currency)=>currency+' '+(value>0&&value<0.000001?'< 0.000001':Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6}));
function costColor(id) { let hash=0;for(const char of id)hash=(hash*31+char.charCodeAt(0))>>>0;hash=Math.imul(hash^(hash>>>16),0x45d9f3b)>>>0;return `hsl(${hash%360} 57% 44%)`; }
function costControl(caption,control) { const label=element('label',caption);label.append(control);return label; }
const costTokenFields=[['input_tokens','输入 token'],['output_tokens','输出 token'],['cached_input_tokens','缓存命中 token']];
function addCostTokens(total,row) { for(const [key]of costTokenFields)if(row[key]!=null)total[key]=(total[key]??0)+row[key]; }
function costTokenCells(row) { return costTokenFields.map(([key])=>element('td',metricNumber(row[key]))); }
// Cached input is already included in input_tokens; never add it to the total again.
function costChartValue(row,tokens) {
  if(!tokens)return row.cost||0;
  return row.input_tokens==null&&row.output_tokens==null?null:(row.input_tokens??0)+(row.output_tokens??0);
}
async function renderCosts(request) {
  const owner=me.id,panel=$('costs-panel');panel.replaceChildren();
  if(costState?.owner!==owner){const to=timestamp(Date.now()).slice(0,10);costState={owner,to,from:new Date(Date.parse(to+'T00:00:00Z')-29*86400000).toISOString().slice(0,10),currency:'USD',repository_id:''};}
  if(costState.repository_id&&!repositories.some(r=>r.id===costState.repository_id))costState.repository_id='';
  const form=element('form','','cost-filters');
  for(const [name,caption]of [['from','开始日期（本地）'],['to','结束日期（本地）']]){
    const input=document.createElement('input');Object.assign(input,{name,type:'date',required:true,value:costState[name]});form.append(costControl(caption,input));
  }
  const currency=document.createElement('select');currency.name='currency';currency.setAttribute('aria-label','费用币种');
  [['USD','美元 USD'],['CNY','人民币 CNY']].forEach(([value,name])=>currency.add(new Option(name,value)));currency.value=costState.currency;form.append(costControl('费用币种',currency));
  const repo=document.createElement('select');repo.name='repository_id';repo.setAttribute('aria-label','统计项目');repo.add(new Option('所有有权访问的项目',''));repositories.forEach(r=>repo.add(new Option(r.full_name,r.id)));repo.value=costState.repository_id;form.append(costControl('统计项目',repo));
  const submit=element('button','查看统计','quiet');submit.type='submit';form.append(submit);
  const body=element('div','','cost-body');body.id='cost-body';panel.append(form,body);
  form.addEventListener('submit',async event=>{event.preventDefault();Object.assign(costState,Object.fromEntries(new FormData(form)));submit.disabled=true;try{await loadCosts(request);}catch(err){error(err);}finally{submit.disabled=false;}});
  await loadCosts(request);
}
async function loadCosts(version) {
  const request=++costRequest,owner=me.id,params=new URLSearchParams({from:costState.from,to:costState.to,currency:costState.currency,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone});if(costState.repository_id)params.set('repository_id',costState.repository_id);
  $('cost-body').replaceChildren(element('p','正在加载统计…','muted'));
  const data=await api('/api/costs?'+params);
  if(request!==costRequest||version!==renderVersion||me?.id!==owner||tab!=='costs')return;
  const body=$('cost-body');body.replaceChildren();$('count').textContent=`${data.from} 至 ${data.to} · 浏览器本地日期`;
  const summary=element('div','','cost-summary');
  // A recorded zero cost is priced; only the absence of priced requests switches the chart.
  const known=data.summary.requests-data.summary.unpriced_requests,tokenMode=known===0;
  for(const [label,value]of [['已计价费用',known||!data.summary.requests?money(data.summary.cost,data.currency):'暂无可计价记录'],['模型请求',metricNumber(data.summary.requests)],['未计价请求',metricNumber(data.summary.unpriced_requests)],['用量不完整请求',metricNumber(data.summary.usage_missing_requests)]]){
    const item=element('div','','cost-stat');item.append(element('span',label,'muted'),element('strong',value));summary.append(item);
  }
  const tokens=element('div','','cost-token-summary');
  for(const [key,label]of costTokenFields){const item=element('div','','cost-stat');item.append(element('span',label,'muted'),element('strong',metricNumber(data.summary[key])));tokens.append(item);}
  body.append(summary,tokens,element('p','输入包含缓存命中 token。— 表示没有可靠记录；用量不完整时仅汇总已记录的 token。','cost-note'),element('p','费用和 token 按请求发生时的浏览器本地日期汇总。费用按当时保存的模型单价估算；不同币种分别展示，不作汇率换算。币种筛选仅影响费用和 token，不影响任务统计。项目专属模型的单价在项目「模型」页配置；部署共享模型的单价在「全局设置 → 模型」配置。','cost-note'));
  if(data.summary.unpriced_requests)body.append(element('p',`有 ${data.summary.unpriced_requests} 次请求缺少单价或完整用量，`+(tokenMode?'当前按已记录的 token 绘图。':'未计入柱状图金额。占比仅针对已计价费用。'),'cost-incomplete'));
  body.append(element('p','统计开始于 '+timestamp(data.collection_started_at)+'；此前未记录的用量与费用无法补算。','cost-note'));
  body.append(element('p','范围：费用和 token 只统计经控制面代理的模型请求，任务只统计控制面自己的任务；不含外部执行端自行发起的模型调用及项目容器内其他服务。','cost-note'));
  if(data.tasks)renderTaskStatistics(body,data);
  const byProject=new Map(),byDate=new Map();
  for(let time=Date.parse(data.from+'T00:00:00Z');time<=Date.parse(data.to+'T00:00:00Z');time+=86400000)byDate.set(new Date(time).toISOString().slice(0,10),{cost:0,requests:0,unpriced_requests:0,rows:[]});
  for(const row of data.days){
    const day=byDate.get(row.date);day.cost+=row.cost||0;day.requests+=row.requests;day.unpriced_requests+=row.unpriced_requests;day.rows.push(row);addCostTokens(day,row);
    const project=byProject.get(row.repository_id)||{...row,cost:0,requests:0,unpriced_requests:0,input_tokens:null,output_tokens:null,cached_input_tokens:null};project.cost+=row.cost||0;project.requests+=row.requests;project.unpriced_requests+=row.unpriced_requests;addCostTokens(project,row);byProject.set(row.repository_id,project);
  }
  const projects=[...byProject.values()].sort((a,b)=>(costChartValue(b,tokenMode)||0)-(costChartValue(a,tokenMode)||0)||a.full_name.localeCompare(b.full_name));
  const chart=element('section','','cost-chart-section');chart.append(element('h2',tokenMode?'每日 token · 按项目堆叠':'每日费用 · 按项目堆叠'));
  if(!data.summary.requests)chart.append(element('p','这个日期范围内没有模型请求记录。','cost-empty'));
  else if(tokenMode&&costChartValue(data.summary,true)==null)chart.append(element('p','这些请求没有可靠的 token 记录，暂时无法绘制用量柱状图。','cost-empty'));
  else{
    if(tokenMode)chart.append(element('p','当前范围没有费用信息，按输入 + 输出 token 展示；缓存命中已包含在输入中，不重复相加。','cost-note'));
    costChart(chart,byDate,projects,data.currency,tokenMode);
  }
  body.append(chart);
  if(data.prices?.length){
    const prices=element('section','','cost-breakdown'),table=costTable(['模型','币种','输入 / 百万 token','输出 / 百万 token','缓存命中 / 百万 token']);
    prices.append(element('h2','范围内已保存的单价'),element('p','按请求发生时的单价逐组列出；同一模型的多组单价分别展示。','cost-note'));
    for(const price of data.prices){const row=document.createElement('tr');row.append(element('td',price.model_name),element('td',price.currency),...['input_per_million','output_per_million','cache_per_million'].map(key=>element('td',Number(price[key]).toLocaleString('zh-CN',{maximumFractionDigits:20}))));table.body.append(row);}
    prices.append(table.wrap);body.append(prices);
  }
  const projectTable=costTable(['项目','已计价费用',tokenMode?'token 占比':'已计价费用占比',...costTokenFields.map(([,label])=>label),'未计价请求']);
  for(const project of projects){
    const row=document.createElement('tr'),name=element('td',''),dot=element('span','','cost-color');dot.style.backgroundColor=costColor(project.repository_id);name.append(dot,document.createTextNode(project.full_name));
    const amount=costChartValue(project,tokenMode),total=costChartValue(data.summary,tokenMode);
    row.append(name,element('td',project.requests===project.unpriced_requests?'—':money(project.cost,data.currency)),element('td',amount!=null&&total>0?(amount/total*100).toFixed(1)+'%':'—'),...costTokenCells(project),element('td',String(project.unpriced_requests)));projectTable.body.append(row);
  }
  const breakdown=element('section','','cost-breakdown');breakdown.append(element('h2','项目占比'),projectTable.wrap);if(!projects.length)breakdown.append(element('p','暂无项目费用记录。','muted'));body.append(breakdown);
  const detail=element('details','','cost-breakdown'),daily=costTable(['日期（本地）','已计价费用','模型请求',...costTokenFields.map(([,label])=>label),'未计价请求']);detail.append(element('summary','每日费用与 token 明细'));
  for(const [date,day]of byDate){const row=document.createElement('tr');row.append(element('td',date),element('td',day.requests&&day.requests===day.unpriced_requests?'—':money(day.cost,data.currency)),element('td',String(day.requests)),...costTokenCells(day),element('td',String(day.unpriced_requests)));daily.body.append(row);}detail.append(daily.wrap);body.append(detail);
}
// The four kinds every project has always get a row; any other workflow that ran tasks in the range gets one by its name.
const statisticsKinds=['review.issue','review.pr','development.issue','development.pr'];
const statisticsKey=row=>row.workflow??row.kind;
function statisticsWorkflows(data) {
  const listed=new Map(statisticsKinds.map(kind=>[kind,{key:kind,name:kindLabels[kind]}]));
  for(const row of data.tasks.summary){const key=statisticsKey(row);listed.set(key,{key,name:row.name||kindLabels[row.kind]||row.kind});}
  return [...listed.values()];
}
function taskStatisticsDuration(row) {
  if(!row)return metricDuration(0);
  const value=metricRuntime({runtime_ms:row.runtime_ms,complete:!row.incomplete_tasks});
  return value+(row.incomplete_tasks?` · ${row.incomplete_tasks} 项耗时不完整`:'')+(row.running_tasks?` · ${row.running_tasks} 项执行中`:'');
}
function renderTaskStatistics(body,data) {
  const section=element('section','','cost-breakdown statistics-tasks'),summary=costTable(['任务类别','任务数','累计执行耗时']);
  summary.wrap.classList.add('statistics-task-summary');
  section.append(element('h2','任务统计'),element('p','按任务创建时的浏览器本地日期归日，整段累计执行耗时都计入创建日，不跨日拆分。耗时不含排队和等待，执行中任务含已观测到的当前时长；历史缺失或中断的耗时保留不完整提示。','cost-note'));
  const workflows=statisticsWorkflows(data);
  for(const workflow of workflows){const item=data.tasks.summary.find(r=>statisticsKey(r)===workflow.key),row=document.createElement('tr');row.dataset.kind=workflow.key;row.append(element('td',workflow.name),element('td',metricNumber(item?.count??0)),element('td',taskStatisticsDuration(item)));summary.body.append(row);}
  section.append(summary.wrap);
  if(!data.tasks.summary.length)section.append(element('p','这个日期范围内没有任务记录。','cost-empty'));
  const detail=element('details','','cost-breakdown'),daily=costTable(['日期（本地）',...workflows.flatMap(workflow=>[workflow.name+' · 数量',workflow.name+' · 耗时'])]);detail.append(element('summary','每日任务明细'));
  const days=new Map();
  for(const item of data.tasks.days){const day=days.get(item.date)||new Map(),total=day.get(statisticsKey(item))||{count:0,runtime_ms:null,incomplete_tasks:0,running_tasks:0};
    for(const key of ['count','incomplete_tasks','running_tasks'])total[key]+=item[key];if(item.runtime_ms!=null)total.runtime_ms=(total.runtime_ms??0)+item.runtime_ms;
    day.set(statisticsKey(item),total);days.set(item.date,day);
  }
  // These UTC values enumerate date labels only; attribution itself is performed in the browser's time zone by the API.
  for(let time=Date.parse(data.from+'T00:00:00Z');time<=Date.parse(data.to+'T00:00:00Z');time+=86400000){
    const date=new Date(time).toISOString().slice(0,10),day=days.get(date),row=document.createElement('tr');row.append(element('td',date));
    for(const workflow of workflows){const item=day?.get(workflow.key);row.append(element('td',metricNumber(item?.count??0)),element('td',taskStatisticsDuration(item)));}daily.body.append(row);
  }
  detail.append(daily.wrap);section.append(detail);
  if(data.tasks.undated.length){
    const unknown=element('section','','cost-breakdown statistics-undated'),table=costTable(['项目','任务类别','任务数','累计执行耗时']);
    unknown.append(element('h2','日期不明的历史任务'),element('p','以下任务没有可靠的创建日期，沿用所选项目范围，单独列出，不计入日期范围内的任务总数或任何一天。','cost-incomplete'));
    for(const item of data.tasks.undated){const row=document.createElement('tr');row.append(element('td',item.full_name),element('td',item.name||kindLabels[item.kind]||item.kind),element('td',metricNumber(item.count)),element('td',taskStatisticsDuration(item)));table.body.append(row);}unknown.append(table.wrap);section.append(unknown);
  }
  body.append(section);
}
function costTable(headers) {
  const wrap=element('div','','cost-table-scroll'),table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr');headers.forEach(name=>{const th=element('th',name);th.scope='col';row.append(th);});head.append(row);const body=document.createElement('tbody');table.append(head,body);wrap.append(table);return {wrap,body};
}
function costChart(container,byDate,projects,currency,tokens=false) {
  const unit=tokens?'token':currency,value=row=>costChartValue(row,tokens)||0;
  const ns='http://www.w3.org/2000/svg',width=Math.max(800,byDate.size*30+100),height=350,left=90,bottom=45,top=20,plot=height-bottom-top;
  const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.setAttribute('role','img');svg.setAttribute('aria-label',tokens?'每日模型 token 用量，柱内不同颜色代表各项目':'每日模型估算费用，柱内不同颜色代表各项目');svg.dataset.metric=tokens?'tokens':'cost';
  const add=(tag,attributes,text)=>{const node=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;svg.append(node);return node;};
  const dates=[...byDate],max=Math.max(...dates.map(([,d])=>value(d)),0),ceiling=max>0?max*1.1:1,step=(width-left-20)/dates.length;
  for(let i=0;i<=4;i++){const y=top+plot*(1-i/4),value=ceiling*i/4;add('line',{x1:left,y1:y,x2:width-20,y2:y,stroke:'#dce6ed'});add('text',{x:left-8,y:y+4,'text-anchor':'end',fill:'#637c89','font-size':12},value>0&&value<0.000001?value.toExponential(1):value.toLocaleString('zh-CN',{maximumFractionDigits:6}));}
  add('text',{x:left,y:14,fill:'#637c89','font-size':12},unit);
  const hover=element('p',tokens?'悬停或聚焦色块，可查看该项目当天的 token 用量和占比。':'悬停或聚焦色块，可查看该项目当天的费用和占比。','cost-chart-detail');hover.setAttribute('aria-live','polite');
  dates.forEach(([date,day],index)=>{
    let total=0;
    for(const project of projects){const row=day.rows.find(r=>r.repository_id===project.repository_id);if(!row||!value(row))continue;
      const amount=value(row),h=amount/ceiling*plot,y=top+plot-(total+amount)/ceiling*plot;
      const measurement=tokens?`${metricNumber(amount)} token（输入 ${metricNumber(row.input_tokens)}，输出 ${metricNumber(row.output_tokens)}）`:money(amount,currency);
      const label=`${date} · ${project.full_name} · ${measurement} · 当日 ${(amount/value(day)*100).toFixed(1)}%`;
      const rect=add('rect',{x:left+index*step+step*.12,y,width:step*.76,height:h,fill:costColor(project.repository_id),tabindex:0,role:'img','aria-label':label,'data-project':project.repository_id,'data-date':date,'data-value':amount});
      const title=document.createElementNS(ns,'title');title.textContent=label;rect.append(title);rect.addEventListener('mouseenter',()=>hover.textContent=label);rect.addEventListener('focus',()=>hover.textContent=label);total+=amount;
    }
    if(index%Math.max(1,Math.ceil(dates.length/15))===0||index===dates.length-1)add('text',{x:left+index*step+step/2,y:height-18,'text-anchor':'middle',fill:'#637c89','font-size':12},date.slice(5));
  });
  const scroll=element('div','','cost-chart-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label',tokens?'可横向滚动的 token 用量图':'可横向滚动的费用图');scroll.append(svg);container.append(scroll,hover);
  const legend=element('div','','cost-legend');for(const project of projects){const entry=element('span',''),dot=element('span','','cost-color');dot.style.backgroundColor=costColor(project.repository_id);entry.append(dot,document.createTextNode(project.full_name));legend.append(entry);}container.append(legend);
}
