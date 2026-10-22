import { type Store, type Row } from '../storage/database.js';
import { type Actor, repository, scope, superAdmin } from '../app/auth.js';
import { fail, fields, randomId, text, type Json } from '../core/security.js';
import { TokenBroker } from './broker.js';
import { Forwarder } from './forward.js';
import { targetUrl } from './target.js';
import { trustConfig, publicKey, fingerprint, tokenAudience, audienceUrl } from './identity.js';
import { type JWTVerifyGetKey } from 'jose';

function clientView(row:Row){return {id:row.id,repository_id:row.repository_id,name:row.name,auth_type:row.auth_type,trust:JSON.parse(row.trust),enabled:!!row.enabled,version:row.version,created_at:row.created_at,
  public_key:row.public_key||null,key_configured:!!row.public_key,key_fingerprint:fingerprint(row.public_key)};}
function subView(row:Row){return {id:row.id,client_id:row.client_id,repository_id:row.repository_id,name:row.name,url:row.url,filters:JSON.parse(row.filters),enabled:!!row.enabled,version:row.version,created_at:row.created_at,secret_configured:true};}
function filters(value:unknown):Json{
  if(!value||typeof value!=='object'||Array.isArray(value))return fail(400,'invalid_event_filters');const v=value as Json;fields(v,['events','actions','exclude_drafts']);
  for(const key of ['events','actions'])if(!Array.isArray(v[key])||(v[key] as unknown[]).length>30||(v[key] as unknown[]).some(x=>typeof x!=='string'||!/^[a-z_]{1,64}$/.test(x)))fail(400,'invalid_event_filters');
  if(!(v.events as unknown[]).length||typeof v.exclude_drafts!=='boolean')fail(400,'invalid_event_filters');return v;
}
export interface ExternalOptions{githubUrl?:string;privateHosts?:string[];oidcKeys?:JWTVerifyGetKey;}
export class ExternalService{
  readonly broker:TokenBroker;readonly forwarder:Forwarder;
  constructor(readonly store:Store,readonly options:ExternalOptions={}){this.broker=new TokenBroker(store,options.githubUrl,options.oidcKeys);this.forwarder=new Forwarder(store,options.privateHosts);}
  row(user:Actor,table:'external_clients'|'external_subscriptions',id:string):Row{
    const filter=scope(user,'repository_id'),row=this.store.get(`SELECT * FROM ${table} WHERE id=? AND ${filter.sql}`,id,...filter.args);
    if(!row)return fail(404,'external_resource_not_found');return row;
  }
  async publicApi(path:string,body:Json,authorization:string):Promise<Json>{
    if(path==='/external/token')return this.broker.issue(body,authorization);
    if(path==='/external/revoke')return this.broker.revoke(body);
    return fail(404,'not_found');
  }
  api(user:Actor,method:string,url:URL,body:Json):Json|undefined{
    const path=url.pathname;if(!path.startsWith('/api/external/'))return undefined;
    if(path==='/api/external/settings'){
      if(method==='GET')return {settings:{token_audience:tokenAudience(this.store)||null}};
      if(method==='PUT'){
        superAdmin(user);fields(body,['token_audience']);const value=audienceUrl(body.token_audience);
        return this.store.transaction(()=>{this.store.run("INSERT INTO settings(key,value) VALUES('external_token_audience',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",value);
          this.store.audit(user.id,'external.audience.updated','external_token_audience');return {settings:{token_audience:value}};});
      }
      return fail(405,'method_not_allowed');
    }
    const filter=scope(user,'repository_id'),repo=url.searchParams.get('repository_id');if(repo)repository(this.store,user,repo);
    const clauses=filter.sql+(repo?' AND repository_id=?':''),args=[...filter.args,...(repo?[repo]:[])];
    if(method==='GET'){
      if(path==='/api/external/clients')return {clients:this.store.all(`SELECT * FROM external_clients WHERE ${clauses} ORDER BY created_at`,...args).map(clientView)};
      if(path==='/api/external/subscriptions')return {subscriptions:this.store.all(`SELECT * FROM external_subscriptions WHERE ${clauses} ORDER BY created_at`,...args).map(subView)};
      if(path==='/api/external/deliveries')return {deliveries:this.store.all(`SELECT id,subscription_id,repository_id,source_id,state,attempts,http_status,error,created_at FROM external_deliveries WHERE ${clauses} ORDER BY created_at DESC LIMIT 100`,...args)};
      if(path==='/api/external/grants')return {grants:this.store.all(`SELECT g.id,g.client_id,c.repository_id,g.state,g.created_at,g.expires_at FROM external_grants g JOIN external_clients c ON c.id=g.client_id WHERE ${scope(user,'c.repository_id').sql}${repo?' AND c.repository_id=?':''} ORDER BY g.created_at DESC LIMIT 100`,...scope(user,'c.repository_id').args,...(repo?[repo]:[]))};
    }
    if(path==='/api/external/clients'&&method==='POST'){
      fields(body,['name','repository_id','auth_type','trust','public_key']);const repo=text(body.repository_id);repository(this.store,user,repo);
      if(!this.store.get("SELECT 1 FROM repositories r JOIN accounts a ON a.id=r.account_id WHERE r.id=? AND a.type='github_app'",repo))fail(409,'github_app_required');
      const type=text(body.auth_type);if(!['private_key_jwt','github_actions_oidc'].includes(type))fail(400,'invalid_auth_type');
      if(type==='github_actions_oidc'&&body.public_key!==undefined||type==='private_key_jwt'&&body.trust!==undefined)fail(400,'invalid_client_config');
      const trust=type==='github_actions_oidc'?trustConfig(body.trust):{},id=randomId(),key=type==='private_key_jwt'?publicKey(body.public_key):null;
      return this.store.transaction(()=>{
        this.store.run('INSERT INTO external_clients(id,repository_id,name,auth_type,trust,created_at,public_key) VALUES(?,?,?,?,?,?,?)',id,repo,text(body.name),type,JSON.stringify(trust),new Date().toISOString(),key);this.store.audit(user.id,'external.client.created',id,repo);
        return {client:clientView(this.row(user,'external_clients',id))};
      });
    }
    const client=/^\/api\/external\/clients\/([a-f0-9]{48})$/.exec(path);
    if(client){const row=this.row(user,'external_clients',client[1]!);if(method==='GET')return {client:clientView(row)};
      if(method==='PATCH'){
        fields(body,['enabled','public_key']);if(body.enabled!==undefined&&typeof body.enabled!=='boolean')fail(400,'invalid_client_update');
        if(body.public_key!==undefined&&row.auth_type!=='private_key_jwt')fail(400,'client_uses_oidc');const key=body.public_key===undefined?row.public_key:publicKey(body.public_key);
        return this.store.transaction(()=>{this.store.run('UPDATE external_clients SET enabled=?,public_key=?,secret_hash=NULL,version=version+1 WHERE id=?',body.enabled===undefined?row.enabled:Number(body.enabled),key,row.id);
          this.store.run("UPDATE external_deliveries SET state='cancelled',error='client_changed' WHERE state IN ('pending','retry') AND subscription_id IN (SELECT id FROM external_subscriptions WHERE client_id=?)",row.id);
          this.store.audit(user.id,'external.client.updated',row.id,row.repository_id);return {client:clientView(this.row(user,'external_clients',row.id))};});
      }
    }
    if(path==='/api/external/subscriptions'&&method==='POST'){
      fields(body,['client_id','name','url','filters']);const client=this.row(user,'external_clients',text(body.client_id)),url=targetUrl(body.url,this.options.privateHosts||[]).href,filter=filters(body.filters),id=randomId(),secret=randomId();
      return this.store.transaction(()=>{this.store.run('INSERT INTO external_subscriptions(id,client_id,repository_id,name,url,secret,filters,created_at) VALUES(?,?,?,?,?,?,?,?)',id,client.id,client.repository_id,text(body.name),url,this.store.secrets.seal({value:secret},'external-subscription:'+id),JSON.stringify(filter),new Date().toISOString());
        this.store.audit(user.id,'external.subscription.created',id,client.repository_id);return {subscription:subView(this.row(user,'external_subscriptions',id)),signing_secret:secret};});
    }
    const subscription=/^\/api\/external\/subscriptions\/([a-f0-9]{48})$/.exec(path);
    if(subscription){const row=this.row(user,'external_subscriptions',subscription[1]!);if(method==='GET')return {subscription:subView(row)};
      if(method==='PATCH'){
        fields(body,['name','enabled','url','filters','rotate_secret']);if(body.enabled!==undefined&&typeof body.enabled!=='boolean'||body.rotate_secret!==undefined&&body.rotate_secret!==true)fail(400,'invalid_subscription_update');
        const url=body.url===undefined?row.url:targetUrl(body.url,this.options.privateHosts||[]).href,filter=body.filters===undefined?row.filters:JSON.stringify(filters(body.filters)),secret=body.rotate_secret?randomId():null;
        return this.store.transaction(()=>{this.store.run('UPDATE external_subscriptions SET name=?,url=?,filters=?,enabled=?,secret=?,version=version+1 WHERE id=?',body.name===undefined?row.name:text(body.name),url,filter,body.enabled===undefined?row.enabled:Number(body.enabled),secret?this.store.secrets.seal({value:secret},'external-subscription:'+row.id):row.secret,row.id);
          this.store.run("UPDATE external_deliveries SET state='cancelled',error='subscription_changed' WHERE subscription_id=? AND state IN ('pending','retry')",row.id);this.store.audit(user.id,'external.subscription.updated',row.id,row.repository_id);
          return {subscription:subView(this.row(user,'external_subscriptions',row.id)),...(secret?{signing_secret:secret}:{})};});
      }
    }
    const retry=/^\/api\/external\/deliveries\/([a-f0-9]{48})\/retry$/.exec(path);
    if(retry&&method==='POST'){
      fields(body,[]);const row=this.store.get(`SELECT * FROM external_deliveries WHERE id=? AND ${filter.sql}`,retry[1]!,...filter.args);if(!row)fail(404,'external_resource_not_found');
      if(row!.state!=='failed')fail(409,'forward_not_retryable');this.store.run("UPDATE external_deliveries SET state='retry',attempts=0,next_at=0,error=NULL WHERE id=?",row!.id);this.store.audit(user.id,'external.delivery.retry',row!.id,row!.repository_id);return {ok:true};
    }
    return fail(404,'not_found');
  }
}
