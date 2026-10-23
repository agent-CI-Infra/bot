import { type Store } from '../storage/database.js';
import { digest, fail, type Json } from '../core/security.js';

export class EventPoller {
  private pending=new Map<string,Promise<void>>();
  constructor(readonly store:Store){}
  private grant(authorization:string){
    const token=/^Bearer ([^\s]{1,16384})$/i.exec(authorization)?.[1];
    if(!token)return fail(401,'external_unauthorized');
    const grants=this.store.all(`SELECT g.*,c.repository_id FROM external_grants g
      JOIN external_clients c ON c.id=g.client_id JOIN policies p ON p.repository_id=c.repository_id
      WHERE g.token_hash=? AND g.state='issued' AND c.enabled=1 AND p.enabled=1`,digest(token));
    const grant=grants.find(row=>Number.isFinite(Date.parse(row.expires_at))&&Date.parse(row.expires_at)>Date.now());
    if(!grant||grants.some(row=>row.client_id!==grant.client_id))return fail(401,'external_unauthorized');
    return grant;
  }
  async poll(authorization:string,write:(value:Json)=>Promise<void>):Promise<void>{
    const client=this.grant(authorization).client_id,previous=this.pending.get(client);
    let release!:()=>void;const done=new Promise<void>(resolve=>{release=resolve;});this.pending.set(client,done);
    try{
      // Serialize requests across all tokens of this client until the response finishes.
      await previous;
      const grant=this.grant(authorization),cutoff=new Date(Date.now()-86400000).toISOString();
      this.store.run('DELETE FROM external_events WHERE received_at<=?',cutoff);
      const cursor=this.store.get('SELECT last_sequence FROM external_event_cursors WHERE client_id=?',client)?.last_sequence||0;
      const rows=this.store.all(`SELECT e.sequence,d.* FROM external_events e JOIN deliveries d ON d.id=e.source_id
        WHERE e.repository_id=? AND e.sequence>? AND e.received_at>? ORDER BY e.sequence LIMIT 100`,grant.repository_id,cursor,cutoff);
      const events=rows.map(row=>{
        const payload=JSON.parse(Buffer.from(row.payload).toString('utf8')) as Json;
        const object=payload[row.event==='issues'?'issue':'pull_request'] as Json|undefined;
        return {id:row.id,event:row.event,delivery_id:row.delivery_id,action:payload.action||'',repository_id:row.repository_id,
          object_number:object?.number??payload.number??null,received_at:row.received_at,payload};
      });
      // The HTTP writer resolves only on finish; a close/error must leave the cursor untouched.
      await write({events});
      const last=rows.at(-1)?.sequence;
      if(last!==undefined)this.store.run(`INSERT INTO external_event_cursors(client_id,last_sequence) VALUES(?,?)
        ON CONFLICT(client_id) DO UPDATE SET last_sequence=max(last_sequence,excluded.last_sequence)`,client,last);
    }finally{release();if(this.pending.get(client)===done)this.pending.delete(client);}
  }
}
