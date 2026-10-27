function metricNumber(value) { return value==null?'—':Number(value).toLocaleString('zh-CN'); }
function metricDuration(value) {
  if(value==null)return '—';const seconds=Math.floor(value/1000);
  if(seconds<60)return seconds+' 秒';if(seconds<3600)return Math.floor(seconds/60)+' 分 '+seconds%60+' 秒';
  return Math.floor(seconds/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分';
}
function metricRuntime(metrics) {
  if(!metrics||!metrics.complete&&!metrics.runtime_ms)return '—';
  return (metrics.complete?'':'至少 ')+metricDuration(metrics.runtime_ms);
}
function taskMetricsLine(task) {
  const m=task.metrics||{},line=element('p','','task-metrics');
  const values=[['运行',metricRuntime(m)],['输入',metricNumber(m.input_tokens)],['输出',metricNumber(m.output_tokens)],
    ['缓存',metricNumber(m.cached_input_tokens)],['命中率',m.cache_hit_rate==null?'—':(m.cache_hit_rate*100).toFixed(1)+'%']];
  for(const [name,value]of values)line.append(element('span',name+' '+value));
  if(m.complete===false||m.usage_missing_requests||m.cache_missing_requests)line.append(element('span','统计不完整','metric-incomplete'));
  line.title='运行时长不含排队和等待。输入包含缓存命中 token；命中率为累计缓存命中 token ÷ 累计输入 token。— 表示没有可靠记录。';
  return line;
}
function taskMetricsCard(task) {
  const m=task.metrics||{},section=card('用量统计');section.append(taskMetricsLine(task));
  section.append(facts([['模型请求',m.requests??'—'],['未返回完整用量',m.usage_missing_requests||null],['未计价请求',m.unpriced_requests||null]]));
  for(const cost of m.costs||[])section.append(element('p','已计价费用 '+cost.currency+' '+(cost.amount>0&&cost.amount<0.000001?'< 0.000001':Number(cost.amount).toFixed(6)),'muted'));
  if(m.complete===false)section.append(note('历史执行或中断期间的统计不完整，这里只显示已观测的记录。'));
  return section;
}
// `after` redraws the model list once the prices are saved or cleared (see modelActions).
function modelPricing(model, after = reloadProject) {
  const modal=document.createElement('dialog');modal.id='model-pricing';
  const heading=element('h2',model.model_name+' · 计费单价');heading.id='model-pricing-title';modal.setAttribute('aria-labelledby',heading.id);
  const form=document.createElement('form');form.append(heading,note('每百万 token 的单价，仅用于估算费用。输入单价用于未命中的输入；缓存命中 token 单独计价。保存后只影响新请求。'));
  const label=element('label','币种'),currency=document.createElement('select');currency.name='currency';currency.setAttribute('aria-label','币种');
  [['USD','美元 USD'],['CNY','人民币 CNY']].forEach(([value,name])=>currency.add(new Option(name,value)));currency.value=model.pricing?.currency||'USD';label.append(currency);form.append(label);
  for(const [name,caption]of [['input_per_million','输入单价 / 百万 token'],['output_per_million','输出单价 / 百万 token'],['cache_per_million','缓存命中单价 / 百万 token']]){
    const label=element('label',caption),input=document.createElement('input');Object.assign(input,{name,type:'number',required:true,min:'0',max:'1000000',step:'any',value:model.pricing?.[name]??''});label.append(input);form.append(label);
  }
  const message=element('p','','view-error');message.setAttribute('role','alert');
  const actions=element('div','','actions'),save=element('button','保存单价');save.type='submit';actions.append(button('取消',()=>modal.close()),save);
  if(model.pricing)actions.append(button('清除单价',async()=>{try{await api('/api/models/'+model.id,'PATCH',{version:model.version,pricing:null});modal.close();await after(`已清除 ${model.model_name} 的计费单价`);}catch(err){message.textContent=err.message;}}));
  form.append(message,actions);form.addEventListener('submit',async event=>{event.preventDefault();save.disabled=true;const data=Object.fromEntries(new FormData(form));
    try{await api('/api/models/'+model.id,'PATCH',{version:model.version,pricing:{currency:data.currency,input_per_million:Number(data.input_per_million),output_per_million:Number(data.output_per_million),cache_per_million:Number(data.cache_per_million)}});modal.close();await after(`已保存 ${model.model_name} 的计费单价`);}
    catch(err){message.textContent=err.message;}finally{save.disabled=false;}
  });modal.append(form);document.body.append(modal);modal.addEventListener('close',()=>modal.remove(),{once:true});modal.showModal();
}
