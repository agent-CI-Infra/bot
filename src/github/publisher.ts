import { type Store, type Row } from '../storage/database.js';
import { GitHub } from './client.js';
import { blobSha, operationId, stop, TaskError, treeSha } from '../agent/common.js';
import { implementationText, reviewText } from './text.js';
import { inlineLocation } from '../review/findings.js';

export class Publisher {
  constructor(readonly store:Store,readonly github:GitHub,readonly task:Row,readonly validate:()=>Promise<void>, readonly headDelays = [0, 250, 750, 1500, 2500],readonly onHeadWait:(value:any)=>void=()=>{}){}
  // replayable effects (such as adding a label) are idempotent on GitHub, so an unknown response may be sent again.
  async effect(key:string,kind:string,request:any,send:()=>Promise<any>,find:()=>Promise<any>,replayable=false){
    const id=operationId(this.task.id+':'+key),marker=`<!-- dept-bot:${id} -->`;
    let row=this.store.get('SELECT * FROM github_effects WHERE id=?',id);
    if(!row){this.store.run("INSERT INTO github_effects VALUES(?,?,?,?, 'pending',NULL,?)",id,this.task.id,kind,JSON.stringify(request),marker);row=this.store.get('SELECT * FROM github_effects WHERE id=?',id);}
    if(row!.state==='sent')return JSON.parse(row!.response);
    await this.validate();
    const existing=await find();
    if(existing){this.store.run("UPDATE github_effects SET state='sent',response=? WHERE id=?",JSON.stringify(existing),id);return existing;}
    if(!replayable&&['unknown','inflight'].includes(row!.state))return stop('github_publication_unknown','waiting_publication');
    this.store.run("UPDATE github_effects SET state='inflight' WHERE id=?",id);
    try{await this.validate();const result=await send();this.store.run("UPDATE github_effects SET state='sent',response=? WHERE id=?",JSON.stringify(result),id);return result;}
    catch(error){this.store.run('UPDATE github_effects SET state=? WHERE id=?',error instanceof TaskError&&error.code==='github_response_unknown'?'unknown':'pending',id);throw error;}
  }
  marker(key:string){return `<!-- dept-bot:${operationId(this.task.id+':'+key)} -->`;}
  async discussion(key:string,body:string){
    const path=this.github.path(`/issues/${this.task.object_number}/comments`),marker=this.marker(key),payload={body:body+'\n\n'+marker};
    return this.effect(key,'comment',payload,()=>this.github.request('POST',path,payload),async()=>
      (await this.github.pages(path)).find(c=>String(c.user?.id)===this.github.actorId&&String(c.body).includes(marker)));
  }
  async review(result:any,files:any[]){
    const inline:any[]=[], locations = new Map<string, any>();
    for (const finding of result.findings) { const location = this.task.kind==='review.pr' && finding.format==='inline' ? inlineLocation(finding,files) : null; if(location)locations.set(finding.id,location); }
    const text = reviewText(result.summary, result.findings, new Set(locations.keys()));
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
    // Every review publishes one summary discussion comment, even when all findings are inline.
    outputs.push(await this.discussion('discussion',[text.overview,text.discussion.join('\n\n---\n\n'),coverage].filter(Boolean).join('\n\n')));
    await this.validate();return outputs;
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
    if(!branch||branch.task_id!==candidate.owner_task_id||candidate.branch===this.github.defaultBranch||!candidate.branch.startsWith('bot/issue-'))stop('branch_not_owned','waiting_permission');
    await this.validate();
    if(candidate.remote_sha && this.store.get("SELECT state FROM github_effects WHERE id=?",operationId(this.task.id+':branch'))?.state==='sent'){
      if((await this.github.ref(candidate.branch))?.object?.sha!==candidate.remote_sha)stop('branch_head_changed','superseded');
      return candidate.remote_sha;
    }
    for(const file of candidate.files){
      if(file.base64===undefined)continue; // Verified object already belongs to the source snapshot.
      const data=Buffer.from(file.base64,'base64');if(blobSha(data)!==file.sha)stop('candidate_blob_mismatch');
      const blob=await this.github.request('POST',this.github.path('/git/blobs'),{content:file.base64,encoding:'base64'});
      if(blob.sha!==file.sha)stop('github_blob_mismatch');
    }
    const entries=candidate.files.map((f:any)=>({path:f.path,mode:f.mode,type:'blob',sha:f.sha}));
    let expected=candidate.tree_sha;
    if(candidate.skipped_files?.length){
      // Keep excluded upstream entries, including blobs GitHub will not let us download.
      // Hashing the merged manifest also rejects a candidate that overwrites an excluded path.
      expected=treeSha([...candidate.files,...candidate.skipped_files]);
      const paths=new Set(candidate.files.map((f:any)=>f.path));
      for(const file of candidate.snapshot_files)if(!paths.has(file.path))entries.push({path:file.path,mode:file.mode,type:'blob',sha:null});
    }
    const tree=await this.github.request('POST',this.github.path('/git/trees'),{...(candidate.skipped_files?.length?{base_tree:candidate.source_tree}:{}),tree:entries});
    if(tree.sha!==expected)stop('github_tree_mismatch');
    candidate.published_tree_sha=expected;
    const author={name:'Department Bot',email:this.github.authorEmail(),date:candidate.date};
    const commit=await this.github.request('POST',this.github.path('/git/commits'),{message:implementationText(candidate,this.task.object_number).title,
      tree:expected,parents:[candidate.base_sha],author,committer:author});
    if(commit.tree?.sha!==expected)stop('github_commit_tree_mismatch');
    candidate.remote_sha=commit.sha;
    this.store.run('UPDATE development_candidates SET data=? WHERE task_id=?',JSON.stringify(candidate),this.task.id);
    await this.validate();
    const current=await this.github.ref(candidate.branch);
    if(current&&current.object.sha!==commit.sha&&current.object.sha!==candidate.expected_sha)stop('branch_head_changed','superseded');
    if(!current&&candidate.expected_sha)stop('branch_disappeared','superseded');
    const path=this.github.path('/git/refs'+(candidate.expected_sha?'/heads/'+encodeURIComponent(candidate.branch):''));
    const request=candidate.expected_sha?{sha:commit.sha,force:false}:{ref:'refs/heads/'+candidate.branch,sha:commit.sha};
    const ref=await this.effect('branch','branch',request,()=>this.github.request(candidate.expected_sha?'PATCH':'POST',path,request),async()=>{
      const state=await this.github.ref(candidate.branch);return state?.object?.sha===commit.sha?state:null;
    });
    if(ref.object?.sha!==commit.sha)stop('branch_not_confirmed');
    return commit.sha;
  }
  async pullRequest(candidate:any,sha:string){
    if(candidate.pr_number){
      const owned=this.store.get('SELECT * FROM bot_pull_requests WHERE repository_id=? AND number=?',this.task.repository_id,candidate.pr_number);
      let pr:any;
      for(const delay of this.headDelays){
        if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
        await this.validate(); pr=await this.github.object('review.pr',candidate.pr_number);
        assertOwnedPR(owned,pr,this.github.actorId,this.task.repository_id);
        if(pr.head.sha===sha)break;
        this.onHeadWait({type:'pr_head_wait',expected_sha:sha,observed_sha:pr.head.sha,pr_number:candidate.pr_number});
      }
      if(pr?.head.sha!==sha)stop('pr_head_pending','waiting_pr_head');
      const source=this.store.get('SELECT object_number FROM tasks WHERE id=?',owned!.source_task_id);
      const content=implementationText(candidate,Number(source?.object_number||this.task.object_number));
      const marker=this.marker('pr-update'),payload={...content,body:content.body+'\n\n'+(this.store.get("SELECT marker FROM github_effects WHERE task_id=? AND kind='pull_request'",owned!.source_task_id)?.marker||'')+'\n\n'+marker};
      await this.effect('pr-update','pull_request',payload,()=>this.github.request('PATCH',this.github.path('/pulls/'+pr.number),payload),async()=>{
        const current=await this.github.object('review.pr',pr.number);assertOwnedPR(owned,current,this.github.actorId,this.task.repository_id);
        return current.head.sha===sha&&current.title===payload.title&&current.body===payload.body?current:null;
      },true);
      // Only count a confirmed head and its refreshed description, once across retries.
      this.store.run('UPDATE bot_pull_requests SET revisions=revisions+CASE WHEN sha<>? THEN 1 ELSE 0 END,sha=? WHERE repository_id=? AND number=?',sha,sha,this.task.repository_id,candidate.pr_number);
      return {...pr,...payload};
    }
    const marker=this.marker('pr'),path=this.github.path('/pulls'),body=implementationText(candidate,this.task.object_number).body+'\n\n'+marker;
    const request={head:candidate.branch,base:candidate.base_branch,...implementationText(candidate,this.task.object_number),body};
    const pr=await this.effect('pr','pull_request',request,()=>this.github.request('POST',path,request),async()=>
      (await this.github.pages(path+'?state=all&head='+encodeURIComponent(this.github.fullName.split('/')[0]+':'+candidate.branch))).find(p=>p.head?.ref===candidate.branch&&String(p.head?.repo?.id)===this.task.repository_id&&String(p.body).includes(marker)));
    if(String(pr.user?.id)!==this.github.actorId||String(pr.head?.repo?.id)!==this.task.repository_id||pr.head?.ref!==candidate.branch||pr.head.sha!==sha)stop('bot_pr_ownership_unconfirmed','waiting_permission');
    this.store.run(`INSERT INTO bot_pull_requests VALUES(?,?,?,?,?,?,?,?,0) ON CONFLICT(repository_id,number) DO NOTHING`,this.task.repository_id,pr.number,String(pr.id),String(pr.user.id),String(pr.head.repo.id),candidate.branch,sha,this.task.id);
    return pr;
  }
}

export function assertOwnedPR(owned:Row|undefined,pr:any,actorId:string,repositoryId:string): asserts owned is Row {
  if(!owned)throw new TaskError('bot_pr_identity_changed','waiting_permission');
  if(String(pr.id)!==owned.pr_id)stop('bot_pr_identity_changed','waiting_permission');
  if(String(pr.user?.id)!==owned.author_id||owned.author_id!==actorId)stop('bot_pr_author_changed','waiting_permission');
  if(String(pr.head?.repo?.id)!==owned.head_repository_id||owned.head_repository_id!==repositoryId)stop('bot_pr_head_repository_changed','waiting_permission');
  if(pr.head?.ref!==owned.branch)stop('bot_pr_branch_changed','waiting_permission');
}
