import { type Store } from '../storage/database.js';
import { GitHub } from '../github/client.js';
import { Redactor } from '../agent/common.js';
import { digest, fail, fields, randomId, text, type Json } from '../core/security.js';
import { authenticate } from './identity.js';
import { type JWTVerifyGetKey } from 'jose';

export const reviewPermissions={contents:'read',issues:'write',pull_requests:'write'};
export class TokenBroker {
  constructor(readonly store:Store,readonly githubUrl?:string,readonly oidcKeys?:JWTVerifyGetKey){}
  async issue(body:Json,authorization:string):Promise<Json>{
    fields(body,['client_id','request_id']);const id=text(body.client_id),request=text(body.request_id,128);
    if(!/^[a-zA-Z0-9_-]{16,128}$/.test(request))fail(400,'invalid_request_id');
    const client=this.store.get('SELECT * FROM external_clients WHERE id=?',id),identity=await authenticate(this.store,client,authorization,this.oidcKeys);
    const repo=this.store.get('SELECT * FROM repositories WHERE id=?',client!.repository_id)!;
    const account=this.store.get('SELECT * FROM accounts WHERE id=?',repo.account_id);
    if(account?.type!=='github_app')fail(409,'github_app_required');
    const guard=async()=>{
      if(!this.store.get('SELECT 1 FROM external_clients c JOIN policies p ON p.repository_id=c.repository_id WHERE c.id=? AND c.enabled=1 AND c.version=? AND p.enabled=1',id,client!.version))fail(403,'external_grant_disabled');
      if(this.store.get('SELECT account_id FROM repositories WHERE id=?',repo.id)?.account_id!==repo.account_id)fail(403,'external_account_changed');
    };
    await guard();const grant=randomId();
    this.store.transaction(()=>{
      if(this.store.get('SELECT 1 FROM external_grants WHERE client_id=? AND request_id=?',id,request)||identity&&this.store.get('SELECT 1 FROM external_grants WHERE identity=?',identity))fail(409,'identity_already_exchanged');
      if(this.store.get('SELECT count(*) n FROM external_grants WHERE client_id=? AND created_at>?',id,Date.now()-3600000)!.n>=20)fail(429,'external_rate_limited');
      this.store.run("INSERT INTO external_grants(id,client_id,request_id,identity,created_at,state) VALUES(?,?,?,?,?,'issuing')",grant,id,request,identity,Date.now());
    });
    const github=new GitHub(this.store,repo,new Redactor(),guard,this.githubUrl);
    try{
      if(!Number.isSafeInteger(Number(repo.id)))fail(400,'repository_id_out_of_range');
      await github.connect(false,reviewPermissions);await guard();
      const expires=Date.parse(github.expiresAt);
      if(!Number.isFinite(expires)||expires<=Date.now()||expires>Date.now()+65*60000)throw new Error('invalid_expiry');
      this.store.run("UPDATE external_grants SET state='issued',token_hash=?,expires_at=? WHERE id=?",digest(github.token),github.expiresAt,grant);
      return {grant_id:grant,token:github.token,token_type:'Bearer',expires_at:github.expiresAt,repository_id:repo.id,permissions:reviewPermissions};
    }catch{
      // The GitHub request may already have minted a token. Consume this identity even after an unknown result.
      if(github.token){try{await github.request('DELETE','/installation/token');}catch{}}
      this.store.run("UPDATE external_grants SET state='failed' WHERE id=?",grant);return fail(502,'external_token_unavailable');
    }
  }
  async revoke(body:Json):Promise<Json>{
    fields(body,['grant_id','token']);const id=text(body.grant_id),token=text(body.token,16384);
    const row=this.store.get("SELECT g.*,c.repository_id FROM external_grants g JOIN external_clients c ON c.id=g.client_id WHERE g.id=? AND g.token_hash=?",id,digest(token));
    if(!row)fail(401,'external_unauthorized');if(row!.state==='revoked')return {ok:true};
    let response:Response;try{response=await fetch((this.githubUrl||'https://api.github.com').replace(/\/$/,'')+'/installation/token',{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json'}});}catch{return fail(502,'external_revoke_unavailable');}
    if(![204,401].includes(response.status))fail(502,'external_revoke_unavailable');
    this.store.run("UPDATE external_grants SET state='revoked' WHERE id=?",id);return {ok:true};
  }
}
