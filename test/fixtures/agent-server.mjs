import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
const objectHash=(type,data)=>createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex');
export function treeHash(files){
  const root={};for(const f of files){let node=root;const parts=f.path.split('/');for(const part of parts.slice(0,-1))node=node[part]||(node[part]={});node[parts.at(-1)]={leaf:f};}
  function walk(node){const entries=Object.entries(node).map(([name,value])=>value.leaf?{name,mode:value.leaf.mode,sha:value.leaf.sha}:{name,mode:'40000',sha:walk(value)});
    entries.sort((a,b)=>Buffer.compare(Buffer.from(a.name+(a.mode==='40000'?'/':'')),Buffer.from(b.name+(b.mode==='40000'?'/':''))));
    return objectHash('tree',Buffer.concat(entries.map(e=>Buffer.concat([Buffer.from(`${e.mode} ${e.name}\0`),Buffer.from(e.sha,'hex')]))));}
  return walk(root);
}
const blobs=new Map(),trees=new Map(),commits=new Map(),repositories=new Map(),models=[];
const baseBody=id=>`export const add = (a, b) => a - b; // REPO_${id}_ONLY\n`;
const goodBody=id=>`export const add = (a, b) => a + b; // REPO_${id}_ONLY\n`;
function blob(data){const bytes=Buffer.from(data),sha=objectHash('blob',bytes);blobs.set(sha,bytes);return sha;}
function commit(files,parent=null,message='fixture'){const tree=treeHash(files);trees.set(tree,files);const sha=objectHash('commit',Buffer.from(JSON.stringify({tree,parent,message})));commits.set(sha,{sha,tree:{sha:tree},parents:parent?[{sha:parent}]:[]});return sha;}
function makeRepo(id){
  const files=[{path:'calc.mjs',mode:'100644',type:'blob',sha:blob(baseBody(id))},{path:'calc.test.mjs',mode:'100644',type:'blob',sha:blob("import test from 'node:test';import assert from 'node:assert/strict';import {add} from './calc.mjs';test('addition',()=>assert.equal(add(2,3),5));\n")},
    {path:'README.md',mode:'100644',type:'blob',sha:blob(`REPO_${id}_ONLY. Run tests with node --test. Fix implementation; preserve tests.\n`)}];
  const base=commit(files),foreign=commit(files.map(f=>f.path==='calc.mjs'?{...f,sha:blob(baseBody(id).trim()+' // contributor\n')}:f),base,'contributor');
  const repo={id:Number(id),full_name:'fixture/project-'+id,owner:{id:10,login:'fixture'},default_branch:'trunk',refs:{trunk:base,contributor:foreign},issues:new Map(),pulls:new Map(),comments:new Map(),reviews:new Map(),labels:new Map(),refWrites:[],createdPrs:[],nextPr:70};
  for(const [number,body] of [[1,'Fix add to sum both numbers.'],[2,'Explain the addition implementation.'],[3,'Fix add to sum both numbers.'],[4,'Explain the addition implementation.'],[6,'Fix add to sum both numbers.'],[8,'Explain the addition implementation.'],[10,'Explain recovery behavior.'],[12,'Fix add to sum both numbers.']])repo.issues.set(number,{id:1000+number,number,title:body,body,state:'open',assignees:[],labels:body.startsWith('Fix')?[{name:'bot-develop'}]:[]});
  for(const number of [42,43,44,99])repo.pulls.set(number,{id:4000+number,number,title:'Review contributor change',body:'Please review this pull request.',state:'open',draft:number===99,user:{id:800,login:'contributor'},head:{sha:foreign,ref:'contributor',repo:{id:Number(id)}},base:{sha:base,ref:'trunk',repo:{id:Number(id)}},html_url:`https://github.invalid/${id}/pull/${number}`});
  return repo;
}
for(const id of ['101','202','303'])repositories.set(id,makeRepo(id));
let config={github_token:'',model_key:''},treeMismatch=false,staled=false,dropComment=true;
const stats={requests:[],models,refWrites:[],reviews:[],comments:[],prs:[],labels:[]};
const call=(name,args,id)=>({id:'call-'+id,type:'function',function:{name,arguments:JSON.stringify(args)}});
function model(input){
  const raw=input.messages.find(m=>m.role==='user').content,context=JSON.parse(Array.isArray(raw)?raw.map(c=>c.text||'').join(''):raw),repoId=context.repository.split('-').at(-1),repo=repositories.get(repoId),number=context.object.number;
  models.push({repository:repoId,number,mode:context.mode,messages:input.messages,model:input.model});
  const tools=input.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]),names=tools.map(t=>t.function.name);
  let result;
  if(context.mode==='review'){
    if(!names.includes('read_file'))return call('read_file',{path:'calc.mjs'},'read');
    if(number===10&&!names.includes('run_command'))return call('run_command',{command:"node -e \"require('node:fs').writeFileSync('recovery-marker.txt','started');setTimeout(()=>console.log('recovered'),5000)\""},'recovery');
    const issue=!context.object.head,requested=issue&&String(context.object.body).startsWith('Fix');
    if(!issue&&number===43&&!staled){
      staled=true;const current=repo.pulls.get(43),files=trees.get(commits.get(current.head.sha).tree.sha).map(f=>f.path==='calc.mjs'?{...f,sha:blob(goodBody(repoId))}:f);
      current.head.sha=commit(files,current.head.sha,'new head');
    }
    result={summary:number===8?'Do not echo '+config.model_key:'Reviewed project material',requires_code_change:requested||!issue,issue_requests_code:requested,clarification_required:false,implementation_goal:'Fix addition and document numeric behavior',request_quote:requested?context.object.body:'',
      findings:[{body:'The arithmetic implementation requires attention.',format:issue?'discussion':'inline',actionable:true,within_goal:true,requires_human_decision:false,selection_reason:issue?'Issue has no inline diff.':'Evidence is on the changed arithmetic line.',path:'calc.mjs',line:number===44?999:1,side:'RIGHT'}]};
    return call('finish_review',result,'finish');
  }
  if(!names.includes('write_file')){
    const own=Boolean(context.object.head),content=number===6?baseBody(repoId).replace('a - b','a * b'):own?`// Normalize numeric inputs.\nexport const add = (a, b) => Number(a) + Number(b); // REPO_${repoId}_ONLY\n`:goodBody(repoId);
    return call('write_file',{path:'calc.mjs',content},'write');
  }
  if(!names.includes('run_command'))return call('run_command',{command:'node --test'},'test');
  return call('finish_development',{summary:'Fix addition behavior',change_title:'Fix addition behavior',test_command:'node --test'},'finish');
}
const publicRepo=repo=>({id:repo.id,full_name:repo.full_name,owner:repo.owner,default_branch:repo.default_branch});
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://fixtures'),method=req.method;let bytes='';for await(const c of req)bytes+=c;
  let body;try{body=bytes?JSON.parse(bytes):{};}catch{res.writeHead(400);res.end('{}');return;}
  const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  try{
    if(url.pathname==='/fixture/config'&&method==='POST'){config={...config,...body};return send({ok:true});}
    if(url.pathname==='/fixture/faults'&&method==='POST'){treeMismatch=!!body.tree_mismatch;return send({ok:true});}
    if(url.pathname==='/fixture/pr'&&method==='POST'){const pr=repositories.get(String(body.repository_id)).pulls.get(Number(body.number));Object.assign(pr,body.values);return send(pr);}
    if(url.pathname==='/fixture/state')return send({...stats,repositories:[...repositories.values()].map(r=>({...publicRepo(r),refs:r.refs,createdPrs:r.createdPrs}))});
    if(url.pathname==='/model/chat/completions'){
      if(req.headers.authorization!=='Bearer '+config.model_key)return send({error:'bad key'},401);
      return send({choices:[{message:{role:'assistant',content:null,tool_calls:[model(body)]}}]});
    }
    if(!url.pathname.startsWith('/github/'))return send({},404);
    const path=decodeURIComponent(url.pathname.slice(7));stats.requests.push({method,path});
    if(req.headers.authorization!=='Bearer '+config.github_token)return send({},401);
    if(path==='/user')return send({id:999,login:'department-bot'});
    if(path==='/user/repos')return send(Number(url.searchParams.get('page')||1)===1?[...repositories.values()].map(r=>({...publicRepo(r),private:false})):[]);
    const byId=/^\/repositories\/(\d+)$/.exec(path);if(byId)return send(publicRepo(repositories.get(byId[1])));
    const match=/^\/repos\/fixture\/project-(\d+)(.*)$/.exec(path);if(!match)return send({},404);
    const repo=repositories.get(match[1]),suffix=match[2];if(!repo)return send({},404);
    if(!suffix)return send(publicRepo(repo));
    let m;
    if((m=/^\/issues\/(\d+)\/comments$/.exec(suffix))){
      const number=Number(m[1]),comments=repo.comments.get(number)||[];
      if(method==='GET')return send(Number(url.searchParams.get('page')||1)===1?comments:[]);
      if(number===12)return send({message:'Injected comment permission failure'},403);
      const value={id:stats.comments.length+1,body:body.body,user:{id:999},html_url:'https://github.invalid/comment/'+(stats.comments.length+1)};comments.push(value);repo.comments.set(number,comments);stats.comments.push({repository_id:repo.id,number,...value});
      if(number===4&&dropComment){dropComment=false;res.destroy();return;}return send(value,201);
    }
    if((m=/^\/issues\/(\d+)\/labels$/.exec(suffix))){
      const number=Number(m[1]),labels=repo.labels.get(number)||[];
      if(method==='POST'){for(const name of body.labels)if(!labels.includes(name))labels.push(name);repo.labels.set(number,labels);stats.labels.push({repository_id:repo.id,number,labels:body.labels});}
      return send(method==='POST'||Number(url.searchParams.get('page')||1)===1?labels.map(name=>({name})):[]);
    }
    // A maintainer added the development label to every Issue that asks for a fix.
    if((m=/^\/issues\/(\d+)\/events$/.exec(suffix))){const labels=repo.issues.get(Number(m[1]))?.labels||[];return send(Number(url.searchParams.get('page')||1)===1?labels.map(label=>({event:'labeled',label,actor:{id:700,login:'maintainer',type:'User'}})):[]);}
    if((m=/^\/issues\/(\d+)$/.exec(suffix)))return send(repo.issues.get(Number(m[1]))||{},repo.issues.has(Number(m[1]))?200:404);
    if((m=/^\/pulls\/(\d+)\/files$/.exec(suffix))){
      if(Number(url.searchParams.get('page')||1)>1)return send([]);
      return send([{filename:'calc.mjs',status:'modified',patch:'@@ -1 +1 @@\n-export const add = (a, b) => a - b;\n+export const add = (a, b) => a + b;'}]);
    }
    if((m=/^\/pulls\/(\d+)\/reviews$/.exec(suffix))){
      const number=Number(m[1]),reviews=repo.reviews.get(number)||[];if(method==='GET')return send(Number(url.searchParams.get('page')||1)===1?reviews:[]);
      const value={id:stats.reviews.length+1,...body,user:{id:999}};reviews.push(value);repo.reviews.set(number,reviews);stats.reviews.push({repository_id:repo.id,number,...value});return send(value,201);
    }
    if((m=/^\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(suffix))){
      const review=(repo.reviews.get(Number(m[1]))||[]).find(r=>r.id===Number(m[2]));
      return send(Number(url.searchParams.get('page')||1)===1?(review?.comments||[]).map((c,index)=>({...c,id:Number(m[2])*1000+index,html_url:'https://github.invalid/review-comment/'+index,commit_id:review.commit_id})):[]);
    }
    if((m=/^\/pulls\/(\d+)$/.exec(suffix))){const pr=repo.pulls.get(Number(m[1]));if(pr&&method==='PATCH')Object.assign(pr,body);return send(pr||{},pr?200:404);}
    if(suffix==='/pulls'){
      if(method==='GET'){const branch=(url.searchParams.get('head')||'').split(':')[1];return send(Number(url.searchParams.get('page')||1)===1?[...repo.pulls.values()].filter(p=>!branch||p.head.ref===branch):[]);}
      const number=repo.nextPr++,value={id:5000+number,number,title:body.title,body:body.body,state:'open',draft:false,user:{id:999},
        head:{ref:body.head,sha:repo.refs[body.head],repo:{id:repo.id}},base:{ref:body.base,sha:repo.refs[body.base],repo:{id:repo.id}},html_url:`https://github.invalid/${repo.id}/pull/${number}`};
      repo.pulls.set(number,value);repo.createdPrs.push(value);stats.prs.push({repository_id:repo.id,...value});return send(value,201);
    }
    if((m=/^\/git\/ref\/heads\/(.+)$/.exec(suffix)))return repo.refs[m[1]]?send({ref:'refs/heads/'+m[1],object:{sha:repo.refs[m[1]]}}):send({},404);
    if(suffix==='/git/refs'||suffix.startsWith('/git/refs/heads/')){
      const branch=body.ref?body.ref.slice(11):suffix.slice('/git/refs/heads/'.length);stats.refWrites.push({repository_id:repo.id,branch,method,...body});
      if(!branch.startsWith('bot/issue-')||body.force===true)return send({},403);
      if(method==='POST'&&repo.refs[branch])return send({},422);
      if(method==='PATCH'&&!commits.get(body.sha).parents.some(p=>p.sha===repo.refs[branch]))return send({},422);
      repo.refs[branch]=body.sha;for(const pr of repo.pulls.values())if(pr.head.ref===branch)pr.head.sha=body.sha;
      return send({ref:'refs/heads/'+branch,object:{sha:body.sha}},201);
    }
    if((m=/^\/git\/commits\/(.+)$/.exec(suffix)))return send(commits.get(m[1])||{},commits.has(m[1])?200:404);
    if((m=/^\/git\/trees\/(.+)$/.exec(suffix))){const files=trees.get(m[1]);return send({sha:m[1],tree:files.map(f=>({...f,size:blobs.get(f.sha).length})),truncated:false});}
    if((m=/^\/git\/blobs\/(.+)$/.exec(suffix))){const data=blobs.get(m[1]);return send({sha:m[1],size:data.length,encoding:'base64',content:data.toString('base64')});}
    if(suffix==='/git/blobs')return send({sha:blob(Buffer.from(body.content,'base64'))},201);
    if(suffix==='/git/trees'){const hash=treeHash(body.tree);trees.set(hash,body.tree);return send({sha:treeMismatch?'f'.repeat(40):hash},201);}
    if(suffix==='/git/commits'){const sha=objectHash('commit',Buffer.from(JSON.stringify(body))),value={sha,tree:{sha:body.tree},parents:body.parents.map(sha=>({sha}))};commits.set(sha,value);return send(value,201);}
    if(suffix.startsWith('/compare/'))return send({status:'ahead'});
    return send({},404);
  }catch{send({error:'fixture_failure'},500);}
});
if(process.argv[1]&&import.meta.url.endsWith(process.argv[1].split('/').at(-1)))server.listen(9100,'0.0.0.0');
