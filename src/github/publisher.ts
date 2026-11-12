import { publicationFact } from '../tasks/publication.js';
import { assertPublicationStages } from '../roles/schedule.js';
import { type Store, type Row } from '../storage/database.js';
import { GitHub } from './client.js';
import { blobSha, operationId, sha, stop, TaskError, treeSha } from '../agent/common.js';
import { implementationText, reviewText, summaryComment, humanItems, markHuman, type HumanItem, type Place, type Prompted, type DevelopmentWait } from './text.js';
import { inlineLocation } from '../review/findings.js';
import { applyReleaseCategory, releaseCategory } from './release-label.js';
import { assertTaskExternalEffect } from '../tasks/management.js';

/**
 * A bot pull request now at `sha`. Only a confirmed head and its refreshed description count, once across retries. The revision
 * budget limits what the bot starts from its own reviews, so a revision people or other review bots asked for does not use it.
 */
export function recordRevision(store:Store,task:Row,number:number,sha:string){
  const requested=JSON.parse(task.input||'{}').revision?.source==='request';
  store.run('UPDATE bot_pull_requests SET revisions=revisions+CASE WHEN sha<>? AND ? THEN 1 ELSE 0 END,sha=? WHERE repository_id=? AND number=?',sha,requested?0:1,sha,task.repository_id,number);
}
export class Publisher {
  constructor(readonly store:Store,readonly github:GitHub,readonly task:Row,readonly validate:()=>Promise<void>, readonly headDelays = [0, 250, 750, 1500, 2500],readonly log:(value:any)=>void=()=>{},readonly beforeWrite?:()=>void){}
  // replayable effects (such as adding a label) are idempotent on GitHub, so an unknown response may be sent again.
  async effect(key:string,kind:string,request:any,send:()=>Promise<any>,find:()=>Promise<any>,replayable=false){
    assertTaskExternalEffect(this.store,this.task,kind);
    const id=operationId(this.task.id+':'+key),marker=`<!-- dept-bot:${id} -->`;
    let row=this.store.get('SELECT * FROM github_effects WHERE id=?',id);
    if(!row){this.store.run("INSERT INTO github_effects VALUES(?,?,?,?, 'pending',NULL,?)",id,this.task.id,kind,JSON.stringify(request),marker);row=this.store.get('SELECT * FROM github_effects WHERE id=?',id);}
    if(kind==='branch' && row!.request!==JSON.stringify(request))stop('publication_receipt_mismatch','needs_replan','Publication request differs from its retained receipt. Query read_publication_context before deciding how to continue.');
    if(row!.state==='sent')return JSON.parse(row!.response);
    // pending means never sent, or refused for certain: only an inflight or unknown request can have landed, so only then
    // is GitHub searched for it. recheck is an unconfirmed write a person released with 重试: it is searched for once
    // more (it may have appeared since the pause) and sent only if still missing. The task is validated right before
    // sending either way.
    const existing=row!.state==='pending'?null:await find();
    if(existing){this.store.run("UPDATE github_effects SET state='sent',response=? WHERE id=?",JSON.stringify(existing),id);return existing;}
    if(!replayable&&['unknown','inflight'].includes(row!.state))return stop('github_publication_unknown','waiting_publication',`GitHub 发布操作 ${key}（${kind}）上次请求没有得到确定结果（状态=${row!.state}），在 GitHub 上也没找到这次写入，已暂停以免重复发布。`);
    this.store.run("UPDATE github_effects SET state='inflight' WHERE id=?",id);
    // Withdrawal must remain available even when a delivery gate no longer permits advancement.
    const checkStages=()=>{if(kind!=='dequeue')assertPublicationStages(this.store,this.task.id);};
    const previous=this.github.beforeWrite;
    try{await this.validate();checkStages();assertTaskExternalEffect(this.store,this.task,kind);this.github.beforeWrite=()=>{checkStages();assertTaskExternalEffect(this.store,this.task,kind);previous?.();this.beforeWrite?.();};const result=await send();this.store.run("UPDATE github_effects SET state='sent',response=? WHERE id=?",JSON.stringify(result),id);return result;}
    catch(error){this.store.run('UPDATE github_effects SET state=? WHERE id=?',error instanceof TaskError&&error.code==='github_response_unknown'?'unknown':'pending',id);throw error;}
    finally{this.github.beforeWrite=previous;}
  }
  marker(key:string){return `<!-- dept-bot:${operationId(this.task.id+':'+key)} -->`;}
  async discussion(key:string,body:string){
    const path=this.github.path(`/issues/${this.task.object_number}/comments`),marker=this.marker(key),payload={body:body+'\n\n'+marker};
    return this.effect(key,'comment',payload,()=>this.github.request('POST',path,payload),async()=>
      (await this.github.pages(path)).find(c=>String(c.user?.id)===this.github.actorId&&String(c.body).includes(marker)));
  }
  // A custom workflow's reply: a comment of its own, plus one COMMENT review for findings with a real position on a pull
  // request. It never edits the review summary comment, labels anything or resolves threads; those belong to reviews.
  async reply(result:any,files:any[]){
    const inline:any[]=[],locations=new Map<string,any>(),pr=String(this.task.kind).endsWith('.pr');
    for(const finding of result.findings){const location=pr&&finding.format==='inline'?inlineLocation(finding,files):null;if(location)locations.set(finding.id,location);}
    const text=reviewText(result.summary,result.findings,new Set(locations.keys()));
    for(const finding of text.findings){const location=locations.get(finding.id);if(location)inline.push({body:finding.body+`\n\n<!-- dept-bot-finding:${finding.id} -->`,...location});}
    const coverage=`Reviewed commit: ${result.reviewed_sha}\nCoverage: ${result.coverage.join('; ')}`,outputs:any[]=[];
    if(inline.length){
      const path=this.github.path(`/pulls/${this.task.object_number}/reviews`),marker=this.marker('inline');
      const payload={commit_id:result.reviewed_sha,event:'COMMENT',body:coverage+'\n\n'+marker,comments:inline};
      outputs.push(await this.effect('inline','review',payload,()=>this.github.request('POST',path,payload),async()=>
        (await this.github.pages(path)).find(r=>String(r.user?.id)===this.github.actorId&&r.commit_id===result.reviewed_sha&&String(r.body).includes(marker))));
    }
    outputs.push(await this.discussion('discussion',[text.overview,text.discussion.join('\n\n---\n\n'),coverage].filter(Boolean).join('\n\n')));
    await this.validate();return outputs;
  }
  // language: the words of the summary comment; trigger: the person's comment this review answers, if any; development: why
  // an Issue ready for development is not being developed.
  async review(result:any,files:any[],options:{language:'zh'|'en',trigger?:{actor?:string|null,url?:string|null,what?:Prompted},development?:DevelopmentWait|null}={language:'en'}){
    const inline:any[]=[], locations = new Map<string, any>(), language=options.language,pr=this.task.kind==='review.pr';
    // The bot's earlier top-level inline comments, when the review refers to them: a finding that is one of them still
    // applying (comment_id) is not posted again, and the ones it says are fixed (resolved_comments) get their threads resolved.
    const refers=pr&&((result.resolved_comments||[]).length||result.findings.some((f:any)=>f.comment_id!==undefined));
    const earlier=new Map<number,any>(refers?(await this.github.pages(this.github.path(`/pulls/${this.task.object_number}/comments`)))
      .filter(c=>String(c.user?.id)===this.github.actorId&&!c.in_reply_to_id).map(c=>[Number(c.id),c]):[]);
    const kept=new Map<string,any>();for(const f of result.findings){const c=earlier.get(Number(f.comment_id));if(c)kept.set(f.id,c);}
    for (const finding of result.findings) { const location = pr && finding.format==='inline' && !kept.has(finding.id) ? inlineLocation(finding,files) : null; if(location)locations.set(finding.id,location); }
    const text = reviewText(result.summary, result.findings.map((finding:any)=>({...finding,body:markHuman(language,finding)})), new Set([...locations.keys(),...kept.keys()]));
    for(const finding of text.findings){
      const location=locations.get(finding.id);
      if(location)inline.push({body:finding.body+`\n\n<!-- dept-bot-finding:${finding.id} -->`,...location});
    }
    const coverage=`Reviewed commit: ${result.reviewed_sha}\nCoverage: ${result.coverage.join('; ')}`;
    const outputs:any[]=[];
    if(inline.length){
      const path=this.github.path(`/pulls/${this.task.object_number}/reviews`),marker=this.marker('inline');
      const payload={commit_id:result.reviewed_sha,event:'COMMENT',body:coverage+'\n\n'+marker,comments:inline};
      const review=await this.effect('inline','review',payload,()=>this.github.request('POST',path,payload),async()=>
        (await this.github.pages(path)).find(r=>String(r.user?.id)===this.github.actorId&&r.commit_id===result.reviewed_sha&&String(r.body).includes(marker)));
      const comments=await this.github.pages(path+'/'+review.id+'/comments');
      const output={...review,inline_comments:comments.map(c=>({id:c.id,html_url:c.html_url,path:c.path,line:c.line,commit_id:c.commit_id,
        finding_id:result.findings.find((f:any)=>String(c.body).includes('dept-bot-finding:'+f.id))?.id||null}))};
      this.store.run('UPDATE github_effects SET response=? WHERE id=?',JSON.stringify(output),operationId(this.task.id+':inline'));outputs.push(output);
    }
    const urls=new Map<string,string>([...(outputs[0]?.inline_comments||[]).filter((c:any)=>c.finding_id).map((c:any)=>[c.finding_id,c.html_url]),
      ...[...kept].map(([id,c]):[string,string]=>[id,String(c.html_url||'')])]);
    const shown=new Set(text.findings.map((f:any)=>f.id)),human:HumanItem[]=humanItems(language,{...result,findings:result.findings.filter((f:any)=>shown.has(f.id))},urls);
    const still=new Set([...kept.values()].map(c=>Number(c.id))),place=(c:any):Place=>({path:String(c.path||''),line:c.line??c.original_line??null,html_url:String(c.html_url||'')});
    const resolved=await this.resolveFixed((result.resolved_comments||[]).map(Number).filter((id:number)=>!still.has(id)).map((id:number)=>earlier.get(id)).filter(Boolean),result.reviewed_sha);
    // Every review publishes one summary discussion comment, even when all findings are inline; later reviews of the same
    // Issue or PR edit it.
    const count=this.earlierReviews(),body=summaryComment({language,overview:text.overview,discussion:text.discussion,coverage,human,resolved,open:[...kept.values()].map(place),development:options.development,
      review:{count:count+1,at:new Date().toISOString().replace('T',' ').slice(0,16)+' UTC',sha:result.reviewed_sha,actor:options.trigger?.actor,url:options.trigger?.url,what:options.trigger?.what}});
    outputs.push({...await this.summary(body),...(resolved.length?{resolved_threads:resolved.map(r=>r.id)}:{})});
    await this.validate();return outputs;
  }
  // How many other reviews of this Issue or PR published a summary comment.
  earlierReviews():number{
    return Number(this.store.get(`SELECT count(DISTINCT e.task_id) AS n FROM github_effects e JOIN tasks t ON t.id=e.task_id WHERE t.repository_id=? AND t.object_number=?
      AND t.kind IN ('review.issue','review.pr') AND e.kind='comment' AND e.state='sent' AND e.task_id<>?`,this.task.repository_id,this.task.object_number,this.task.id)!.n);
  }
  // The summary comment later reviews edit: the one recorded for the object, or for objects reviewed before that was
  // recorded, the earliest summary comment a review of it published.
  summaryAnchor():string|null{
    const row=this.store.get('SELECT comment_id FROM review_summaries WHERE repository_id=? AND object_number=?',this.task.repository_id,this.task.object_number);
    if(row)return String(row.comment_id);
    const first=this.store.get(`SELECT e.response FROM github_effects e JOIN tasks t ON t.id=e.task_id WHERE t.repository_id=? AND t.object_number=?
      AND t.kind IN ('review.issue','review.pr') AND e.kind='comment' AND e.state='sent' AND e.task_id<>? ORDER BY t.created_at,t.rowid LIMIT 1`,this.task.repository_id,this.task.object_number,this.task.id);
    const id=first?.response?JSON.parse(first.response)?.id:null;return /^[1-9]\d*$/.test(String(id??''))?String(id):null;
  }
  // The first review posts the summary comment; later ones replace its body (an edit, so it is safe to repeat). A comment
  // that is gone is posted again and becomes the one later reviews edit.
  async summary(body:string){
    const issues=this.github.path(`/issues/${this.task.object_number}/comments`),marker=this.marker('discussion'),payload={body:body+'\n\n'+marker};
    const anchor=this.summaryAnchor(),comment=(id:string)=>this.github.path('/issues/comments/'+id);
    const result=await this.effect('discussion','comment',payload,async()=>{
      if(anchor){const updated=await this.github.request('PATCH',comment(anchor),payload,true);if(updated)return updated;}
      return this.github.request('POST',issues,payload);
    },async()=>{
      if(anchor){const current=await this.github.request('GET',comment(anchor),undefined,true);if(current&&String(current.body).includes(marker))return current;}
      return (await this.github.pages(issues)).find(c=>String(c.user?.id)===this.github.actorId&&String(c.body).includes(marker));
    },!!anchor);
    if(/^[1-9]\d*$/.test(String(result?.id??'')))this.store.run(`INSERT INTO review_summaries VALUES(?,?,?,?) ON CONFLICT(repository_id,object_number)
      DO UPDATE SET comment_id=excluded.comment_id,updated_at=excluded.updated_at`,this.task.repository_id,this.task.object_number,String(result.id),new Date().toISOString());
    return result;
  }
  // The bot's earlier inline comments that the reviewed head fixes, as the review judged, get their threads resolved. Only
  // comments made on an earlier commit qualify (the author changed the code after them). GitHub lets an App resolve a
  // thread only with contents: write, which review tokens do not have: a token with it is made for these writes alone.
  // An installation that does not grant it leaves the threads open and the review is published anyway; the log says why.
  async resolveFixed(comments:any[],reviewedSha:string):Promise<(Place&{id:number})[]>{
    const fixed=comments.filter(c=>c.original_commit_id&&c.original_commit_id!==reviewedSha);
    if(!fixed.length)return [];
    try{
      const threads=await this.reviewThreads(),open=fixed.filter(c=>threads.get(Number(c.id))?.isResolved===false);
      if(!open.length)return [];
      const resolved=await this.github.withPermissions({contents:'write',pull_requests:'write'},async token=>{
        const done:any[]=[];
        for(const c of open){
          const thread=threads.get(Number(c.id))!;
          await this.effect('resolve:'+c.id,'resolve',{thread_id:thread.id},()=>this.github.graphql('mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{id isResolved}}}',{id:thread.id},token),
            async()=>(await this.reviewThreads()).get(Number(c.id))?.isResolved?{thread_id:thread.id}:null,true);
          done.push(c);
        }
        return done;
      });
      this.log({type:'review_threads_resolved',comments:resolved.map(c=>c.id)});
      return resolved.map(c=>({id:c.id,path:String(c.path||''),line:c.line??c.original_line??null,html_url:String(c.html_url||'')}));
    }catch(error){
      if(!(error instanceof TaskError)||!(error.code.startsWith('github_permission_')||['github_graphql_failed','github_http_422'].includes(error.code)))throw error;
      this.log({type:'review_threads_unresolved',code:error.code,detail:error.detail||null});return [];
    }
  }
  // The pull request's review threads, keyed by the database id of each thread's first comment.
  async reviewThreads(){
    const [owner,name]=this.github.fullName.split('/'),threads=new Map<number,{id:string,isResolved:boolean}>();let after:string|null=null;
    for(let page=0;page<20;page++){
      const data=await this.github.graphql(`query($owner:String!,$name:String!,$number:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        reviewThreads(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id isResolved comments(first:1){nodes{databaseId}}}}}}}`,{owner,name,number:Number(this.task.object_number),after});
      const list=data?.repository?.pullRequest?.reviewThreads;
      for(const node of list?.nodes||[]){const first=node?.comments?.nodes?.[0]?.databaseId;if(Number.isSafeInteger(first))threads.set(first,{id:String(node.id),isResolved:node.isResolved===true});}
      if(!list?.pageInfo?.hasNextPage)break;after=list.pageInfo.endCursor;
    }
    return threads;
  }
  async label(name:string){return this.labels([name]);}
  // Issues and pull requests share the issue labels endpoint; GitHub creates a missing repository label on first use,
  // which only the policy's review label can reach: classification labels are checked against the repository first.
  async labels(names:string[]){
    const path=this.github.path(`/issues/${this.task.object_number}/labels`),payload={labels:names},wanted=names.map(name=>name.toLowerCase());
    return this.effect('label','label',payload,()=>this.github.request('POST',path,payload),async()=>{
      const labels=await this.github.pages(path),have=new Set(labels.map(l=>String(l.name).toLowerCase()));return wanted.every(name=>have.has(name))?labels:null;
    },true);
  }
  async branch(candidate:any){
    const branch=this.store.get('SELECT * FROM bot_branches WHERE repository_id=? AND branch=?',this.task.repository_id,candidate.branch);
    const direct=this.store.get("SELECT 1 FROM tasks WHERE id=? AND repository_id=? AND kind IN ('task.request','task.development')",candidate.owner_task_id,this.task.repository_id)&&candidate.branch==='bot/task-'+candidate.owner_task_id;
    if(!branch||branch.task_id!==candidate.owner_task_id||candidate.branch===this.github.defaultBranch||!candidate.branch.startsWith('bot/issue-')&&!direct)stop('branch_not_owned','waiting_permission',`分支 ${candidate.branch} 不属于已登记的任务分支，禁止发布。`);
    await this.validate();
    // Operation identity belongs to this exact candidate, not a task attempt or a previous QA revision.
    const expected=(candidate.skipped_files||[]).length?treeSha([...candidate.files,...candidate.skipped_files]):candidate.tree_sha;
    const identity=sha(JSON.stringify({branch:candidate.branch,tree:expected,base:candidate.base_sha,previous:candidate.expected_sha??null,title:implementationText(candidate,this.task.object_number).title,date:candidate.date}));
    const key='branch:v2:'+identity;
    const save=()=>this.store.run('UPDATE development_candidates SET data=? WHERE task_id=?',JSON.stringify(candidate),this.task.id);
    const observe=async()=>{const ref=await this.github.ref(candidate.branch);publicationFact(this.store,this.task,'branch_observed',{operation_key:key,branch:candidate.branch,expected_sha:candidate.expected_sha??null,target_sha:candidate.created_commit_sha??null,observed_sha:ref?.object?.sha??null});return ref;};
    // Legacy remote_sha can mean only "commit created". It is not evidence of a confirmed branch update.
    if(candidate.publication_identity!==identity){candidate.publication_identity=identity;delete candidate.created_commit_sha;delete candidate.remote_sha;delete candidate.branch_confirmed;delete candidate.published_tree_sha;save();}
    if(candidate.created_commit_sha){
      const current=await observe(),actual=current?.object?.sha;
      if(actual===candidate.created_commit_sha){candidate.remote_sha=actual;candidate.published_tree_sha=expected;candidate.branch_confirmed={sha:actual,observed_at:new Date().toISOString()};save();this.store.run("UPDATE github_effects SET state='sent',response=? WHERE id=?",JSON.stringify(current),operationId(this.task.id+':'+key));publicationFact(this.store,this.task,'branch_confirmed',{operation_key:key,branch:candidate.branch,commit_sha:actual,tree_sha:expected});return actual;}
      if(candidate.branch_confirmed || actual && actual!==candidate.expected_sha || !actual && candidate.expected_sha)stop('branch_head_changed','needs_replan','Publication branch differs from the expected head. Query read_publication_context; choose investigation, coordination, integration or help.');
    }
    for(const file of candidate.files){
      if(file.base64===undefined)continue; // Verified object already belongs to the source snapshot.
      const data=Buffer.from(file.base64,'base64');if(blobSha(data)!==file.sha)stop('candidate_blob_mismatch',undefined,`发布前校验候选文件 ${file.path} 失败，内容与预期 SHA ${file.sha} 不一致。`);
      const blob=await this.github.request('POST',this.github.path('/git/blobs'),{content:file.base64,encoding:'base64'});
      if(blob.sha!==file.sha)stop('github_blob_mismatch',undefined,`GitHub 写入文件 ${file.path} 后返回的 SHA 不一致：预期 ${file.sha}，实际 ${blob.sha}。`);
    }
    // Skipped upstream entries (submodules, blobs GitHub will not let us download) stay as they are in the source tree.
    // Hashing the merged manifest also rejects a candidate that overwrites an excluded path.
    const skipped=candidate.skipped_files||[];
    const entry=(f:any,sha=f.sha)=>({path:f.path,mode:f.mode,type:'blob',sha});
    const snapshot=candidate.snapshot_files||[],upstream=new Map<string,any>(snapshot.map((f:any)=>[f.path,f])),paths=new Set(candidate.files.map((f:any)=>f.path));
    const deletions=snapshot.filter((f:any)=>!paths.has(f.path)).map((f:any)=>entry(f,null));
    const changes=candidate.files.filter((f:any)=>upstream.get(f.path)?.sha!==f.sha||upstream.get(f.path)?.mode!==f.mode).map((f:any)=>entry(f));
    // Rebuilding a large repository's tree from every path can take GitHub longer than its 10-second request limit,
    // which answers 502/504 on every retry, so only the changes go on top of the source tree. A path that turns from a
    // file into a directory or back is not an update GitHub applies the same way; it, and any tree GitHub builds
    // differently, falls back to the complete listing.
    const before=[...upstream.keys(),...skipped.map((f:any)=>f.path)],files=new Set(before),directories=new Set(before.flatMap(parents));
    const reshaped=changes.some((f:any)=>directories.has(f.path)||parents(f.path).some(path=>files.has(path)));
    const create=(body:any)=>this.github.request('POST',this.github.path('/git/trees'),body);
    let tree=candidate.source_tree&&changes.length+deletions.length&&!reshaped?await create({base_tree:candidate.source_tree,tree:[...changes,...deletions]}):null;
    if(tree?.sha!==expected)tree=await create(skipped.length?{base_tree:candidate.source_tree,tree:[...candidate.files.map((f:any)=>entry(f)),...deletions]}:{tree:candidate.files.map((f:any)=>entry(f))});
    if(tree.sha!==expected)stop('github_tree_mismatch',undefined,`GitHub 创建的文件树不一致：预期 ${expected}，实际 ${tree.sha}。`);
    candidate.created_tree_sha=expected;
    const author={name:'Department Bot',email:this.github.authorEmail(),date:candidate.date};
    const commit=candidate.created_commit_sha?{sha:candidate.created_commit_sha,tree:{sha:expected}}:await this.github.request('POST',this.github.path('/git/commits'),{message:implementationText(candidate,this.task.object_number).title,
      tree:expected,parents:[candidate.base_sha,...(candidate.expected_sha&&candidate.expected_sha!==candidate.base_sha?[candidate.expected_sha]:[])],author,committer:author});
    if(commit.tree?.sha!==expected)stop('github_commit_tree_mismatch',undefined,`GitHub 提交 ${commit.sha} 的文件树不一致：预期 ${expected}，实际 ${commit.tree?.sha}。`);
    candidate.created_commit_sha=commit.sha;save();
    publicationFact(this.store,this.task,'commit_created',{operation_key:key,branch:candidate.branch,commit_sha:commit.sha,tree_sha:expected,expected_sha:candidate.expected_sha??null});
    await this.validate();
    const current=await observe();
    if(current&&current.object.sha!==commit.sha&&current.object.sha!==candidate.expected_sha)stop('branch_head_changed','needs_replan',`发布分支 ${candidate.branch} 前发现 head 已变化，当前提交=${current.object.sha}。`);
    if(!current&&candidate.expected_sha)stop('branch_disappeared','needs_replan',`待更新的分支 ${candidate.branch} 已不存在。`);
    const path=this.github.path('/git/refs'+(candidate.expected_sha?'/heads/'+encodeURIComponent(candidate.branch):''));
    const request=candidate.expected_sha?{sha:commit.sha,force:false}:{ref:'refs/heads/'+candidate.branch,sha:commit.sha};
    const find=async()=>{const state=await this.github.ref(candidate.branch);return state?.object?.sha===commit.sha?state:null;};
    // Pointing the bot's own branch at one commit is idempotent and GitHub reports the result exactly: a create that
    // already landed answers 422 with the ref in place, a fast-forward to the same commit is a no-op. So an unknown answer
    // (a 5xx or a dropped connection) is checked and sent again, instead of waiting for a person to release it.
    const send=async()=>{
      try{return await this.github.request(candidate.expected_sha?'PATCH':'POST',path,request);}
      catch(error){if(error instanceof TaskError&&error.code==='github_http_422'){const state=await find();if(state)return state;}throw error;}
    };
    publicationFact(this.store,this.task,'branch_update_requested',{operation_key:key,branch:candidate.branch,target_sha:commit.sha,expected_sha:candidate.expected_sha??null});
    const ref=await this.effect(key,'branch',request,send,find,true);
    if(ref.object?.sha!==commit.sha)stop('branch_not_confirmed',undefined,`分支 ${candidate.branch} 发布未确认：预期提交 ${commit.sha}，返回 ${ref.object?.sha||'无提交'}。`);
    const confirmed=await observe();
    if(confirmed?.object?.sha!==commit.sha)stop('branch_not_confirmed',undefined,'Branch update receipt exists, but the current remote head is not confirmed. Query read_publication_context.');
    candidate.remote_sha=commit.sha;candidate.published_tree_sha=expected;candidate.branch_confirmed={sha:commit.sha,observed_at:new Date().toISOString()};save();
    publicationFact(this.store,this.task,'branch_confirmed',{operation_key:key,branch:candidate.branch,commit_sha:commit.sha,tree_sha:expected});
    return commit.sha;
  }
  async pullRequest(candidate:any,sha:string){
    const releaseLabel = await releaseCategory(this.github, candidate.release_label);
    if(candidate.pr_number){
      const owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',this.task.repository_id,candidate.pr_number);
      let pr:any;
      for(const delay of this.headDelays){
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        await this.validate(); pr=await this.github.object('review.pr',candidate.pr_number);
        assertOwnedPR(owned,pr,this.github.actorId,this.task.repository_id);
        if(pr.head.sha===sha)break;
        this.log({type:'pr_head_wait',expected_sha:sha,observed_sha:pr.head.sha,pr_number:candidate.pr_number});
      }
      if(pr?.head.sha!==sha)stop('pr_head_pending','waiting_pr_head',`PR #${candidate.pr_number} 尚未更新到提交 ${sha}，当前 head=${pr?.head.sha||'未知'}。`);
      const source=this.store.get('SELECT object_number FROM tasks WHERE id=?',owned!.source_task_id);
      const content=implementationText(candidate,Number(source?.object_number||this.task.object_number));
      const updateKey='pr-update:'+sha+':'+operationId(JSON.stringify(implementationText(candidate,Number(source?.object_number||this.task.object_number)))) ,marker=this.marker(updateKey),payload={...content,body:content.body+'\n\n'+(this.store.get("SELECT marker FROM github_effects WHERE task_id=? AND kind='pull_request'",owned!.source_task_id)?.marker||'')+'\n\n'+marker};
      await this.effect(updateKey,'pull_request',payload,()=>this.github.request('PATCH',this.github.path('/pulls/'+pr.number),payload),async()=>{
        const current=await this.github.object('review.pr',pr.number);assertOwnedPR(owned,current,this.github.actorId,this.task.repository_id);
        return current.head.sha===sha&&current.title===payload.title&&current.body===payload.body?current:null;
      },true);
      recordRevision(this.store,this.task,candidate.pr_number,sha);
      await applyReleaseCategory(this.github, pr.number, releaseLabel);
      publicationFact(this.store,this.task,'pr_confirmed',{pr_number:pr.number,commit_sha:sha});
      return {...pr,...payload};
    }
    const marker=this.marker('pr'),path=this.github.path('/pulls'),body=implementationText(candidate,this.task.object_number).body+'\n\n'+marker;
    const request={head:candidate.branch,base:candidate.base_branch,...implementationText(candidate,this.task.object_number),body};
    const pr=await this.effect('pr','pull_request',request,()=>this.github.request('POST',path,request),async()=>
      (await this.github.pages(path+'?state=all&head='+encodeURIComponent(this.github.fullName.split('/')[0]+':'+candidate.branch))).find(p=>p.head?.ref===candidate.branch&&String(p.head?.repo?.id)===this.task.repository_id&&String(p.body).includes(marker)));
    if(String(pr.user?.id)!==this.github.actorId||String(pr.head?.repo?.id)!==this.task.repository_id||pr.head?.ref!==candidate.branch||pr.head.sha!==sha)stop('bot_pr_ownership_unconfirmed','waiting_permission',`新建 PR #${pr.number} 的作者、来源仓库、分支或提交与候选分支 ${candidate.branch} 不一致。`);
    this.store.run(`INSERT INTO bot_pull_requests VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(repository_id,number) DO NOTHING`,this.task.repository_id,pr.number,String(pr.id),String(pr.user.id),String(pr.head.repo.id),candidate.branch,sha,this.task.id);
    await applyReleaseCategory(this.github, pr.number, releaseLabel);
    publicationFact(this.store,this.task,'pr_confirmed',{pr_number:pr.number,commit_sha:sha});
    return pr;
  }
}

// a/b/c.txt -> ['a','a/b']
function parents(path:string):string[]{const parts=path.split('/');return parts.slice(1).map((_,index)=>parts.slice(0,index+1).join('/'));}

export function assertOwnedPR(owned:Row|undefined,pr:any,actorId:string,repositoryId:string): asserts owned is Row {
  if(!owned)throw new TaskError('bot_pr_identity_changed','waiting_permission',`PR #${pr.number} 没有对应的机器人归属记录。`);
  if(String(pr.id)!==owned.pr_id)stop('bot_pr_identity_changed','waiting_permission',`PR #${pr.number} 的标识与已登记的 PR ${owned.pr_id} 不一致。`);
  if(String(pr.user?.id)!==owned.author_id||owned.author_id!==actorId)stop('bot_pr_author_changed','waiting_permission',`PR #${pr.number} 的作者与登记作者或当前机器人账号不一致。`);
  if(String(pr.head?.repo?.id)!==owned.head_repository_id||owned.head_repository_id!==repositoryId)stop('bot_pr_head_repository_changed','waiting_permission',`PR #${pr.number} 的来源仓库与登记仓库 ${owned.head_repository_id} 或目标仓库 ${repositoryId} 不一致。`);
  if(pr.head?.ref!==owned.branch)stop('bot_pr_branch_changed','waiting_permission',`PR #${pr.number} 的来源分支已变化：预期 ${owned.branch}，当前 ${pr.head?.ref}。`);
}
