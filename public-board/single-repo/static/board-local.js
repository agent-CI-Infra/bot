/* Browser-local custom fields. GitHub snapshots remain shared and read-only. */
(() => {
  'use strict';
  let snapshot, state, key, storageWarning='';
  const clone=value=>JSON.parse(JSON.stringify(value));
  const itemId=/^(issue|pr):\d+$/;
  const text=(value,max)=>value==null?null:String(value).trim().slice(0,max)||null;
  const now=()=>new Date().toISOString();
  const base=()=>({version:1,repo:snapshot.repo,fields:clone(snapshot.board.fields),rules:clone(snapshot.board.rules),items:{},aliases:{},history:[]});
  function validate(doc){
    if(!doc || typeof doc!=='object' || Array.isArray(doc) || (doc.repo && doc.repo!==snapshot.repo))throw Error('文件不属于当前仓库或格式无效');
    const out=base();
    if(doc.fields){
      const options=doc.fields?.status?.options;
      if(!Array.isArray(options)||!options.length||options.length>30)throw Error('需要 1～30 个状态列');
      const seen=new Set();
      out.fields.status.options=options.map(o=>{
        const name=text(o.name,40);if(!name||seen.has(name.toLowerCase()))throw Error('状态列名称不能为空或重复');seen.add(name.toLowerCase());
        const limit=Number(o.limit);return {name,color:/^s[1-8]$/.test(o.color)?o.color:'s1',description:text(o.description,120)||'',limit:Number.isInteger(limit)&&limit>0?limit:null};
      });
      out.fields.iterations=Array.isArray(doc.fields.iterations)?[...new Set(doc.fields.iterations.map(v=>text(v,40)).filter(Boolean))].slice(0,100):[];
    }
    for(const k of Object.keys(out.rules))if(doc.rules && k in doc.rules)out.rules[k]=k.endsWith('_status')?text(doc.rules[k],40):k==='closed_window_days'?Math.max(1,Math.min(365,Number(doc.rules[k])||30)):!!doc.rules[k];
    for(const [id,item] of Object.entries(doc.items||{}).slice(0,10000)){
      if(!itemId.test(id)||!item||typeof item!=='object')continue;
      out.items[id]={status:text(item.status,40),status_by:text(item.status_by,40),status_at:text(item.status_at,40),priority:['P0','P1','P2','P3'].includes(item.priority)?item.priority:null,iteration:text(item.iteration,40),note:text(item.note,2000),order:Number.isFinite(item.order)?item.order:null};
    }
    for(const [login,alias] of Object.entries(doc.aliases||{}))if(/^[a-z\d-]{1,60}$/i.test(login))out.aliases[login]=text(alias,60);
    out.history=Array.isArray(doc.history)?doc.history.slice(-300).map(h=>Object.fromEntries(['at','kind','item','actor','from','to','reason'].filter(k=>typeof h[k]==='string').map(k=>[k,h[k].slice(0,120)]))):[];
    return out;
  }
  function save(strict=false){
    try {localStorage.setItem(key,JSON.stringify(state));storageWarning='';}
    catch(e){storageWarning='浏览器存储不可用；当前字段无法持久保存。';if(strict)throw Error(storageWarning);}
  }
  function record(kind,id,from,to,actor='user'){state.history.push({at:now(),kind,item:id,from,to,actor});state.history=state.history.slice(-300);}
  function payload(persist=true){
    const result=clone(snapshot.board),names=state.fields.status.options.map(o=>o.name),rules=state.rules;
    const cutoff=Date.now()-rules.closed_window_days*86400000;
    result.items=result.items.filter(i=>(rules.include_prs||i.kind!=='pr') && (i.state!=='closed'||new Date(i.closed_at).getTime()>=cutoff));
    for(const i of result.items){
      const s=state.items[i.id] ||= {};
      let target=s.status,by=s.status_by;
      const defined=k=>names.includes(rules[k])?rules[k]:null;
      if(i.state==='closed'){
        if(rules.closed_to_done && defined('done_status') && !(by==='manual'&&new Date(s.status_at)>new Date(i.closed_at))){target=defined('done_status');by='auto:closed';}
      }else{
        if(!target){target=defined('default_status')||names[0];by='auto:added';}
        if(s.status_by==='auto:closed'&&rules.reopened_to_default){target=defined('default_status')||names[0];by='auto:reopened';}
        if(by!=='manual'){
          if(rules.linked_pr_to_review&&i.kind==='issue'&&i.linked.some(l=>l.state==='open')&&names.indexOf(defined('review_status'))>names.indexOf(target)){target=defined('review_status');by='auto:linked-pr';}
          else if(rules.assigned_to_doing&&i.assignees.length&&names.indexOf(defined('doing_status'))>names.indexOf(target)&&names.indexOf(target)<=names.indexOf(defined('default_status'))){target=defined('doing_status');by='auto:assigned';}
        }
      }
      if(target!==s.status){record('status',i.id,s.status,target,'rule');Object.assign(s,{status:target,status_by:by,status_at:now()});}
      Object.assign(i,{status:s.status,status_by:s.status_by,priority:s.priority||null,iteration:s.iteration||null,note:s.note||null,order:s.order??null});
      const alias=login=>Object.hasOwn(state.aliases,login)?state.aliases[login]||login:login;
      i.author_name=alias(i.author);i.assignee_names=i.assignees.map(alias);
    }
    result.items.sort((a,b)=>(a.order??1e9)-(b.order??1e9)||new Date(b.updated_at)-new Date(a.updated_at));
    const uniq=values=>[...new Set(values.filter(Boolean))].sort();
    result.fields=clone(state.fields);result.rules=clone(rules);result.aliases=clone(state.aliases);result.history=clone(state.history).reverse().slice(0,40);
    result.facets={labels:uniq(result.items.flatMap(i=>i.labels.map(l=>l.name))),assignees:uniq(result.items.flatMap(i=>i.assignees)),authors:uniq(result.items.map(i=>i.author)),milestones:uniq(result.items.map(i=>i.milestone)),iterations:uniq([...state.fields.iterations,...result.items.map(i=>i.iteration)]),priorities:['P0','P1','P2','P3'],statuses:names};
    result.counts={total:result.items.length,issues:result.items.filter(i=>i.kind==='issue').length,prs:result.items.filter(i=>i.kind==='pr').length,open:result.items.filter(i=>i.state==='open').length};
    if(persist)save();result.storage_warning=storageWarning;return result;
  }
  function updateItem(id,changes){
    if(!snapshot.board.items.some(i=>i.id===id))throw Error('找不到该工作项');
    const s=state.items[id] ||= {};
    for(const [field,value] of Object.entries(changes)){
      if(!['status','priority','iteration','note'].includes(field))throw Error('不支持的字段');
      if(field==='status'&&value&&!state.fields.status.options.some(o=>o.name===value))throw Error('状态列不存在');
      if(field==='priority'&&value&&!['P0','P1','P2','P3'].includes(value))throw Error('优先级无效');
      const cleaned=text(value,field==='note'?2000:40);
      if(s[field]!==cleaned)record(field,id,s[field],cleaned);
      s[field]=cleaned;
      if(field==='status')Object.assign(s,{status_by:'manual',status_at:now()});
      if(field==='iteration'&&cleaned&&!state.fields.iterations.includes(cleaned))state.fields.iterations.push(cleaned);
    }
  }
  async function request(url,opts={}){
    if(!snapshot)throw Error('快照尚未加载');
    const parts=url.split('/').filter(Boolean);
    if(opts.method!=='POST'){
      if(parts[2]==='item')return clone(snapshot.details[parts[3]+':'+parts[4]]||{body:'此项正文不在快照中，请在 GitHub 打开。',cross_references:[]});
      return payload();
    }
    const previous=clone(state),body=JSON.parse(opts.body||'{}');
    try{
      if(parts[2]==='items')updateItem(parts[3],body);
      else if(parts[2]==='move'){
        updateItem(body.id,{status:body.status});
        const ids=payload(false).items.filter(i=>i.id!==body.id&&i.status===body.status).map(i=>i.id);
        const index=ids.includes(body.before)?ids.indexOf(body.before):ids.includes(body.after)?ids.indexOf(body.after)+1:0;
        ids.splice(index,0,body.id);ids.forEach((id,n)=>state.items[id].order=n);
      }else if(parts[2]==='fields'){
        const renames=new Map((body.status_options||[]).filter(o=>o.rename_from).map(o=>[o.rename_from,o.name]));
        const next=clone(state);
        next.fields.status.options=body.status_options||next.fields.status.options;
        next.fields.iterations=body.iterations||next.fields.iterations;
        next.rules={...next.rules,...body.rules};
        for(const s of Object.values(next.items))if(renames.has(s.status))s.status=renames.get(s.status);
        for(const k of Object.keys(next.rules))if(k.endsWith('_status')&&renames.has(next.rules[k]))next.rules[k]=renames.get(next.rules[k]);
        state=validate(next);record('fields',null,null,'列与规则已更新');
      }else if(parts[2]==='aliases'){
        if(!/^[a-z\d-]{1,60}$/i.test(body.login))throw Error('登录名无效');
        if(body.alias)state.aliases[body.login]=text(body.alias,60);else delete state.aliases[body.login];
      }else throw Error('不支持的操作');
      save(true);return {board:payload()};
    }catch(e){state=previous;throw e;}
  }
  window.GSBLocalBoard={
    setSnapshot(doc){snapshot=doc;const next='gsb.board.state.v1:'+doc.repo.toLowerCase();if(key!==next){key=next;try{state=validate(JSON.parse(localStorage.getItem(key)||'null'));}catch(e){state=base();}}},
    request,
    export(){return JSON.stringify(state,null,2);},
    import(raw){const next=validate(JSON.parse(raw));const previous=state;state=next;try{save(true);}catch(e){state=previous;throw e;}return payload();}
  };
})();
