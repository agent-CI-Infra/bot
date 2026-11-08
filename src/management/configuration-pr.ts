import { GitHub, revokeInstallationToken } from '../github/client.js';
import { Redactor, blobSha } from '../agent/common.js';
import { fail, type Json } from '../core/security.js';
import { resolveRules } from '../rules/service.js';
import { type ManagementCommand, type ManagementExtension, ManagementService } from './service.js';
import type { ActorContext } from '../identity/authorization.js';

/** App-only, scoped publication. The durable command ID is the branch/PR reconciliation identity. */
export class ConfigurationPR implements ManagementExtension {
  constructor(readonly service:ManagementService,readonly githubUrl?:string){}
  private async client(actor:ActorContext,command:ManagementCommand):Promise<GitHub>{
    const repo=this.service.scope(actor,command.target.project_id,'config.write');
    if(this.service.store.get('SELECT type FROM accounts WHERE id=?',repo.account_id)?.type!=='github_app')fail(409,'configuration_pr_requires_app');
    const github=new GitHub(this.service.store,repo,new Redactor(),async()=>this.service.check(actor,command),this.githubUrl);
    await github.connect(true,{contents:'write',pull_requests:'write'},undefined,false);return github;
  }
  private branch(key:string){return 'bot/configuration-'+key;}
  private marker(key:string){return '<!-- bot-management:'+key+' -->';}
  private async find(github:GitHub,key:string):Promise<Json|null>{
    const prs=await github.pages(github.path('/pulls?state=all&head='+encodeURIComponent(github.fullName.split('/')[0]+':'+this.branch(key))));
    const pr=prs.find(p=>p.head?.ref===this.branch(key)&&String(p.body??'').includes(this.marker(key))&&Number.isSafeInteger(p.number)&&p.number>0&&typeof p.html_url==='string');
    return pr?{pr_url:pr.html_url,pr_number:pr.number,state:pr.merged_at?'merged':'pending_merge',effective:false,notice:'配置 PR 已创建；未合入默认分支并刷新来源前，不能声称已生效。'}:null;
  }
  async reconcile(actor:ActorContext,command:ManagementCommand,key:string):Promise<Json|null>{
    const gh=await this.client(actor,command);try{return await this.find(gh,key);}finally{await revokeInstallationToken(gh.apiUrl,gh.token).catch(()=>{});}
  }
  async execute(actor:ActorContext,command:ManagementCommand,key:string):Promise<Json>{
    const path=String(command.arguments.path),content=String(command.arguments.content);
    if(!/^(?:\.bot\/(?:guide\.md|rules\/[a-z][a-z-]*\.md)|\.agents\/skills\/[a-zA-Z0-9_-]+\/SKILL\.md)$/.test(path))fail(400,'invalid_configuration_pr_path');
    const gh=await this.client(actor,command);
    try{
      const existing=await this.find(gh,key);if(existing)return existing;
      const source=this.service.store.get('SELECT * FROM repository_rule_sources WHERE repository_id=?',command.target.project_id);
      const ref=await gh.ref(gh.defaultBranch);
      if(!source||!ref||source.sha!==ref.object?.sha)fail(409,'refresh_repository_sources_first');
      resolveRules(this.service.store.get('SELECT * FROM policies WHERE repository_id=?',command.target.project_id)!,{...JSON.parse(source!.files),[path]:content});
      gh.beforeWrite=()=>{
        this.service.check(actor,command);
        if(this.service.revision(command.target)!==command.expected_revision)fail(409,'management_revision_conflict');
      };
      // A branch collision is not permission to overwrite another publication. Unknown results only call reconcile.
      if(await gh.ref(this.branch(key)))fail(409,'configuration_branch_requires_reconciliation');
      const file=await gh.request('GET',gh.path('/contents/'+path.split('/').map(encodeURIComponent).join('/')+'?ref='+encodeURIComponent(ref.object.sha)),undefined,true);
      await gh.request('POST',gh.path('/git/refs'),{ref:'refs/heads/'+this.branch(key),sha:ref.object.sha});
      const updated=await gh.request('PUT',gh.path('/contents/'+path.split('/').map(encodeURIComponent).join('/')),{message:'Update project configuration',content:Buffer.from(content).toString('base64'),branch:this.branch(key),...(file?.sha?{sha:file.sha}:{})});
      if(!/^[a-f0-9]{40}$/.test(updated?.commit?.sha??'')||updated?.content?.sha!==blobSha(Buffer.from(content)))fail(409,'configuration_write_unconfirmed');
      const pr=await gh.request('POST',gh.path('/pulls'),{title:'Update project configuration',head:this.branch(key),base:gh.defaultBranch,body:'Update `'+path+'`. This configuration becomes effective after merging into the default branch.\n\n'+this.marker(key)});
      if(!Number.isSafeInteger(pr?.number)||pr.number<1||typeof pr.html_url!=='string'||!/^https?:\/\//.test(pr.html_url))fail(409,'configuration_pr_unconfirmed');
      return {pr_url:pr.html_url,pr_number:pr.number,state:'pending_merge',effective:false,path,base_revision:ref.object.sha,notice:'待合入默认分支；当前实际行为尚未改变。'};
    }finally{await revokeInstallationToken(gh.apiUrl,gh.token).catch(()=>{});}
  }
}
