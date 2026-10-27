let costState=null,costRequest=0;
const money=(value,currency)=>currency+' '+(value>0&&value<0.000001?'< 0.000001':Number(value).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6}));
function costColor(id) { let hash=0;for(const char of id)hash=(hash*31+char.charCodeAt(0))>>>0;hash=Math.imul(hash^(hash>>>16),0x45d9f3b)>>>0;return `hsl(${hash%360} 57% 44%)`; }
function costControl(caption,control) { const label=element('label',caption);label.append(control);return label; }
const costTokenFields=[['input_tokens','输入 token'],['output_tokens','输出 token'],['cached_input_tokens','缓存命中 token']];
function addCostTokens(total,row) { for(const [key]of costTokenFields)if(row[key]!=null)total[key]=(total[key]??0)+row[key]; }
function costTokenCells(row) { return costTokenFields.map(([key])=>element('td',metricNumber(row[key]))); }
async function renderCosts(request) {
  const owner=me.id,panel=$('costs-panel');panel.replaceChildren();
  if(costState?.owner!==owner){const to=new Date().toISOString().slice(0,10);costState={owner,to,from:new Date(Date.parse(to+'T00:00:00Z')-29*86400000).toISOString().slice(0,10),currency:'USD',repository_id:''};}
  if(costState.repository_id&&!repositories.some(r=>r.id===costState.repository_id))costState.repository_id='';
  const form=element('form','','cost-filters');
  for(const [name,caption]of [['from','开始日期（UTC）'],['to','结束日期（UTC）']]){
    const input=document.createElement('input');Object.assign(input,{name,type:'date',required:true,value:costState[name]});form.append(costControl(caption,input));
  }
  const currency=document.createElement('select');currency.name='currency';currency.setAttribute('aria-label','费用币种');
  [['USD','美元 USD'],['CNY','人民币 CNY']].forEach(([value,name])=>currency.add(new Option(name,value)));currency.value=costState.currency;form.append(costControl('费用币种',currency));
  const repo=document.createElement('select');repo.name='repository_id';repo.setAttribute('aria-label','成本项目');repo.add(new Option('所有有权访问的项目',''));repositories.forEach(r=>repo.add(new Option(r.full_name,r.id)));repo.value=costState.repository_id;form.append(costControl('成本项目',repo));
  const submit=element('button','查看费用','quiet');submit.type='submit';form.append(submit);
  const body=element('div','','cost-body');body.id='cost-body';panel.append(form,body);
  form.addEventListener('submit',async event=>{event.preventDefault();Object.assign(costState,Object.fromEntries(new FormData(form)));submit.disabled=true;try{await loadCosts(request);}catch(err){error(err);}finally{submit.disabled=false;}});
  await loadCosts(request);
}
async function loadCosts(version) {
  const request=++costRequest,owner=me.id,params=new URLSearchParams({from:costState.from,to:costState.to,currency:costState.currency});if(costState.repository_id)params.set('repository_id',costState.repository_id);
  $('cost-body').replaceChildren(element('p','正在加载费用…','muted'));
  const data=await api('/api/costs?'+params);
  if(request!==costRequest||version!==renderVersion||me?.id!==owner||tab!=='costs')return;
  const body=$('cost-body');body.replaceChildren();$('count').textContent=`${data.from} 至 ${data.to} · UTC`;
  const summary=element('div','','cost-summary');
  const known=data.summary.requests-data.summary.unpriced_requests;
  for(const [label,value]of [['已计价费用',known||!data.summary.requests?money(data.summary.cost,data.currency):'暂无可计价记录'],['模型请求',metricNumber(data.summary.requests)],['未计价请求',metricNumber(data.summary.unpriced_requests)],['用量不完整请求',metricNumber(data.summary.usage_missing_requests)]]){
    const item=element('div','','cost-stat');item.append(element('span',label,'muted'),element('strong',value));summary.append(item);
  }
  const tokens=element('div','','cost-token-summary');
  for(const [key,label]of costTokenFields){const item=element('div','','cost-stat');item.append(element('span',label,'muted'),element('strong',metricNumber(data.summary[key])));tokens.append(item);}
  body.append(summary,tokens,element('p','输入包含缓存命中 token。— 表示没有可靠记录；用量不完整时仅汇总已记录的 token。','cost-note'),element('p','按 UTC 请求日期汇总。费用按请求发生时保存的模型单价估算；不同币种分别展示，不作汇率换算。单价可在项目“使用的模型”中配置。','cost-note'));
  if(data.summary.unpriced_requests)body.append(element('p',`有 ${data.summary.unpriced_requests} 次请求缺少单价或完整用量，未计入柱状图金额。占比仅针对已计价费用。`,'cost-incomplete'));
  body.append(element('p','统计开始于 '+timestamp(data.collection_started_at)+'；此前未记录的用量与费用无法补算。','cost-note'));
  const byProject=new Map(),byDate=new Map();
  for(let time=Date.parse(data.from+'T00:00:00Z');time<=Date.parse(data.to+'T00:00:00Z');time+=86400000)byDate.set(new Date(time).toISOString().slice(0,10),{cost:0,requests:0,unpriced_requests:0,rows:[]});
  for(const row of data.days){
    const day=byDate.get(row.date);day.cost+=row.cost||0;day.requests+=row.requests;day.unpriced_requests+=row.unpriced_requests;day.rows.push(row);addCostTokens(day,row);
    const project=byProject.get(row.repository_id)||{...row,cost:0,requests:0,unpriced_requests:0,input_tokens:null,output_tokens:null,cached_input_tokens:null};project.cost+=row.cost||0;project.requests+=row.requests;project.unpriced_requests+=row.unpriced_requests;addCostTokens(project,row);byProject.set(row.repository_id,project);
  }
  const projects=[...byProject.values()].sort((a,b)=>b.cost-a.cost||a.full_name.localeCompare(b.full_name));
  const chart=element('section','','cost-chart-section');chart.append(element('h2','每日费用 · 按项目堆叠'));
  if(!data.summary.requests)chart.append(element('p','这个日期范围内没有模型请求记录。','cost-empty'));
  else if(!known)chart.append(element('p','该范围内的请求暂时无法计价。配置模型单价后，新请求会产生费用记录。','cost-empty'));
  costChart(chart,byDate,projects,data.currency);body.append(chart);
  if(data.prices?.length){
    const prices=element('section','','cost-breakdown'),table=costTable(['模型','币种','输入 / 百万 token','输出 / 百万 token','缓存命中 / 百万 token']);
    prices.append(element('h2','范围内已保存的单价'),element('p','按请求发生时的单价逐组列出；同一模型的多组单价分别展示。','cost-note'));
    for(const price of data.prices){const row=document.createElement('tr');row.append(element('td',price.model_name),element('td',price.currency),...['input_per_million','output_per_million','cache_per_million'].map(key=>element('td',Number(price[key]).toLocaleString('zh-CN',{maximumFractionDigits:20}))));table.body.append(row);}
    prices.append(table.wrap);body.append(prices);
  }
  const projectTable=costTable(['项目','已计价费用','已计价费用占比',...costTokenFields.map(([,label])=>label),'未计价请求']);
  for(const project of projects){
    const row=document.createElement('tr'),name=element('td',''),dot=element('span','','cost-color');dot.style.backgroundColor=costColor(project.repository_id);name.append(dot,document.createTextNode(project.full_name));
    row.append(name,element('td',project.requests===project.unpriced_requests?'—':money(project.cost,data.currency)),element('td',data.summary.cost>0?(project.cost/data.summary.cost*100).toFixed(1)+'%':'—'),...costTokenCells(project),element('td',String(project.unpriced_requests)));projectTable.body.append(row);
  }
  const breakdown=element('section','','cost-breakdown');breakdown.append(element('h2','项目占比'),projectTable.wrap);if(!projects.length)breakdown.append(element('p','暂无项目费用记录。','muted'));body.append(breakdown);
  const detail=element('details','','cost-breakdown'),daily=costTable(['日期（UTC）','已计价费用','模型请求',...costTokenFields.map(([,label])=>label),'未计价请求']);detail.append(element('summary','每日明细'));
  for(const [date,day]of byDate){const row=document.createElement('tr');row.append(element('td',date),element('td',day.requests&&day.requests===day.unpriced_requests?'—':money(day.cost,data.currency)),element('td',String(day.requests)),...costTokenCells(day),element('td',String(day.unpriced_requests)));daily.body.append(row);}detail.append(daily.wrap);body.append(detail);
}
function costTable(headers) {
  const wrap=element('div','','cost-table-scroll'),table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr');headers.forEach(name=>{const th=element('th',name);th.scope='col';row.append(th);});head.append(row);const body=document.createElement('tbody');table.append(head,body);wrap.append(table);return {wrap,body};
}
function costChart(container,byDate,projects,currency) {
  const ns='http://www.w3.org/2000/svg',width=Math.max(800,byDate.size*30+100),height=350,left=90,bottom=45,top=20,plot=height-bottom-top;
  const svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.setAttribute('width',String(width));svg.setAttribute('height',String(height));svg.setAttribute('role','img');svg.setAttribute('aria-label','每日模型估算费用，柱内不同颜色代表各项目');
  const add=(tag,attributes,text)=>{const node=document.createElementNS(ns,tag);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));if(text!==undefined)node.textContent=text;svg.append(node);return node;};
  const dates=[...byDate],max=Math.max(...dates.map(([,d])=>d.cost),0),ceiling=max>0?max*1.1:1,step=(width-left-20)/dates.length;
  for(let i=0;i<=4;i++){const y=top+plot*(1-i/4),value=ceiling*i/4;add('line',{x1:left,y1:y,x2:width-20,y2:y,stroke:'#dce6ed'});add('text',{x:left-8,y:y+4,'text-anchor':'end',fill:'#637c89','font-size':12},value>0&&value<0.000001?value.toExponential(1):value.toLocaleString('zh-CN',{maximumFractionDigits:6}));}
  add('text',{x:left,y:14,fill:'#637c89','font-size':12},currency);
  const hover=element('p','悬停或聚焦色块，可查看该项目当天的费用和占比。','cost-chart-detail');hover.setAttribute('aria-live','polite');
  dates.forEach(([date,day],index)=>{
    let total=0;
    for(const project of projects){const row=day.rows.find(r=>r.repository_id===project.repository_id);if(!row?.cost)continue;
      const h=row.cost/ceiling*plot,y=top+plot-(total+row.cost)/ceiling*plot,label=`${date} · ${project.full_name} · ${money(row.cost,currency)} · 当日 ${(row.cost/day.cost*100).toFixed(1)}%`;
      const rect=add('rect',{x:left+index*step+step*.12,y,width:step*.76,height:h,fill:costColor(project.repository_id),tabindex:0,role:'img','aria-label':label,'data-project':project.repository_id,'data-date':date});
      const title=document.createElementNS(ns,'title');title.textContent=label;rect.append(title);rect.addEventListener('mouseenter',()=>hover.textContent=label);rect.addEventListener('focus',()=>hover.textContent=label);total+=row.cost;
    }
    if(index%Math.max(1,Math.ceil(dates.length/15))===0||index===dates.length-1)add('text',{x:left+index*step+step/2,y:height-18,'text-anchor':'middle',fill:'#637c89','font-size':12},date.slice(5));
  });
  const scroll=element('div','','cost-chart-scroll');scroll.tabIndex=0;scroll.setAttribute('aria-label','可横向滚动的费用图');scroll.append(svg);container.append(scroll,hover);
  const legend=element('div','','cost-legend');for(const project of projects){const entry=element('span',''),dot=element('span','','cost-color');dot.style.backgroundColor=costColor(project.repository_id);entry.append(dot,document.createTextNode(project.full_name));legend.append(entry);}container.append(legend);
}
