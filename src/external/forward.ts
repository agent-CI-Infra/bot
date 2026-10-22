import { createHmac } from 'node:crypto';
import { type Store, type Row } from '../storage/database.js';
import { randomId, HttpError, type Json } from '../core/security.js';
import { sendWebhook } from './target.js';

export function enqueueForwards(store:Store,repositoryId:string,event:string,payload:Json,sourceId:string):number{
  if(!store.get('SELECT 1 FROM policies WHERE repository_id=? AND enabled=1',repositoryId))return 0;
  let count=0;
  for(const sub of store.all('SELECT s.* FROM external_subscriptions s JOIN external_clients c ON c.id=s.client_id WHERE s.repository_id=? AND s.enabled=1 AND c.enabled=1',repositoryId)){
    const filter=JSON.parse(sub.filters),pull=payload.pull_request as Json|undefined;
    if(!filter.events.includes(event)||filter.actions.length&&!filter.actions.includes(String(payload.action||''))||filter.exclude_drafts&&event==='pull_request'&&pull?.draft===true)continue;
    const changes=store.run('INSERT INTO external_deliveries(id,subscription_id,repository_id,source_id,version,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',randomId(),sub.id,repositoryId,sourceId,sub.version,new Date().toISOString());count+=Number(changes.changes);
  }
  return count;
}
export class Forwarder{
  private timer?:ReturnType<typeof setInterval>;private active=new Map<string,Promise<void>>();private closing=false;
  constructor(readonly store:Store,readonly privateHosts:string[]=[],readonly sender=sendWebhook){}
  start(){this.store.run("UPDATE external_deliveries SET state='retry',next_at=0 WHERE state='sending'");this.timer=setInterval(()=>this.tick(),1000);this.tick();}
  tick(){
    if(this.closing)return;
    for(const row of this.store.all("SELECT * FROM (SELECT d.*,row_number() OVER (PARTITION BY subscription_id ORDER BY created_at,id) AS ordinal FROM external_deliveries d WHERE state IN ('pending','retry') AND next_at<=?) WHERE ordinal=1 ORDER BY created_at,id LIMIT 100",Date.now())){
      if(this.active.has(row.subscription_id))continue;
      const work=this.deliver(row).catch(()=>{this.store.run("UPDATE external_deliveries SET state='failed',error='forward_internal_failure' WHERE id=?",row.id);}).finally(()=>this.active.delete(row.subscription_id));this.active.set(row.subscription_id,work);
    }
  }
  async close(){this.closing=true;if(this.timer)clearInterval(this.timer);await Promise.allSettled(this.active.values());}
  async deliver(row:Row){
    const sub=this.store.get('SELECT s.* FROM external_subscriptions s JOIN external_clients c ON c.id=s.client_id JOIN policies p ON p.repository_id=s.repository_id WHERE s.id=? AND s.enabled=1 AND c.enabled=1 AND p.enabled=1',row.subscription_id);
    if(!sub||sub.version!==row.version){this.store.run("UPDATE external_deliveries SET state='cancelled',error='subscription_changed' WHERE id=?",row.id);return;}
    const source=this.store.get("SELECT * FROM deliveries WHERE id=? AND status='accepted' AND duplicate=0",row.source_id);
    if(!source){this.store.run("UPDATE external_deliveries SET state='failed',error='source_unavailable' WHERE id=?",row.id);return;}
    const claimed=this.store.run("UPDATE external_deliveries SET state='sending',attempts=attempts+1 WHERE id=? AND state IN ('pending','retry')",row.id);if(!claimed.changes)return;
    const payload={version:1,id:row.id,subscription_id:sub.id,client_id:sub.client_id,repository_id:row.repository_id,event:source.event,
      delivery_id:source.delivery_id,received_at:source.received_at,payload:JSON.parse(Buffer.from(source.payload).toString('utf8'))};
    const body=Buffer.from(JSON.stringify(payload)),secret=String(this.store.secrets.open(sub.secret,'external-subscription:'+sub.id).value),signature='sha256='+createHmac('sha256',secret).update(body).digest('hex');
    let status=0,error:string|null=null,blocked=false;
    try{status=await this.sender(sub.url,body,{'Content-Type':'application/json','X-Bot-Delivery':row.id,'X-Bot-Event':source.event,'X-Bot-Signature-256':signature},this.privateHosts);}catch(cause){blocked=cause instanceof HttpError;error=blocked?(cause as HttpError).code:'forward_unavailable';}
    const attempts=Number(row.attempts)+1,success=status>=200&&status<300,retry=!success&&!blocked&&attempts<5&&(status===0||status===408||status===429||status>=500);
    this.store.run('UPDATE external_deliveries SET state=?,next_at=?,http_status=?,error=? WHERE id=?',success?'succeeded':retry?'retry':'failed',Date.now()+Math.min(300000,1000*2**attempts),status||null,success?null:error||'receiver_http_'+status,row.id);
  }
}
