import type { Row, Store } from '../storage/database.js';
import { digest, fail, randomId, type Json } from '../core/security.js';
import { traceClean } from '../tasks/trace.js';
import type { ChannelEvent, StoredMessage } from './types.js';
import { mediaStorage, mergeResources, resourceMetadata } from './media.js';

export function ledgerStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS channel_chats(id TEXT PRIMARY KEY,provider TEXT NOT NULL,app_id TEXT NOT NULL,
      installation_tenant TEXT NOT NULL,chat_id TEXT NOT NULL,chat_type TEXT NOT NULL,connector_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,
      last_received_at INTEGER NOT NULL,retention_days INTEGER,retained_after INTEGER NOT NULL DEFAULT 0,
      UNIQUE(provider,app_id,installation_tenant,chat_id));
    CREATE TABLE IF NOT EXISTS channel_messages(chat_id TEXT NOT NULL REFERENCES channel_chats(id),message_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,sender_tenant TEXT NOT NULL,sender_type TEXT NOT NULL,message_type TEXT NOT NULL,
      created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,observed_at INTEGER NOT NULL,source TEXT NOT NULL,
      parent_id TEXT NOT NULL,root_id TEXT NOT NULL,thread_id TEXT NOT NULL,deleted INTEGER NOT NULL,
      sensitive INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(chat_id,message_id));
    CREATE INDEX IF NOT EXISTS channel_messages_time ON channel_messages(chat_id,created_at,message_id);
    CREATE TABLE IF NOT EXISTS channel_sync_jobs(id TEXT PRIMARY KEY,chat_id TEXT NOT NULL REFERENCES channel_chats(id),
      container_type TEXT NOT NULL,container_id TEXT NOT NULL,state TEXT NOT NULL,page_token TEXT NOT NULL DEFAULT '',
      start_time INTEGER NOT NULL,end_time INTEGER NOT NULL,covered_until INTEGER NOT NULL DEFAULT 0,
      generation INTEGER NOT NULL DEFAULT 1,pages INTEGER NOT NULL DEFAULT 0,messages INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,next_attempt INTEGER NOT NULL DEFAULT 0,last_error TEXT,
      lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,
      UNIQUE(chat_id,container_type,container_id));
    CREATE TABLE IF NOT EXISTS channel_sync_cursors(job_id TEXT NOT NULL REFERENCES channel_sync_jobs(id),
      generation INTEGER NOT NULL,token_hash TEXT NOT NULL,PRIMARY KEY(job_id,generation,token_hash));
    CREATE TABLE IF NOT EXISTS channel_sync_ranges(job_id TEXT NOT NULL REFERENCES channel_sync_jobs(id),generation INTEGER NOT NULL,
      start_time INTEGER NOT NULL,end_time INTEGER NOT NULL,PRIMARY KEY(job_id,generation));
    CREATE TABLE IF NOT EXISTS channel_chat_summaries(chat_id TEXT PRIMARY KEY REFERENCES channel_chats(id),
      revision INTEGER NOT NULL,authorization_revision INTEGER NOT NULL,through_time INTEGER NOT NULL,
      through_id TEXT NOT NULL,sources TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS channel_message_scopes(chat_id TEXT NOT NULL,message_id TEXT NOT NULL,project_id TEXT NOT NULL,
      PRIMARY KEY(chat_id,message_id),FOREIGN KEY(chat_id,message_id) REFERENCES channel_messages(chat_id,message_id) ON DELETE CASCADE);
  `);
  if (!store.all('PRAGMA table_info(channel_chats)').some(c => c.name === 'context_revision')) store.db.exec('ALTER TABLE channel_chats ADD COLUMN context_revision INTEGER NOT NULL DEFAULT 1');
  if (!store.all('PRAGMA table_info(channel_chats)').some(c => c.name === 'type_verified')) store.db.exec('ALTER TABLE channel_chats ADD COLUMN type_verified INTEGER NOT NULL DEFAULT 0');
  if (!store.all('PRAGMA table_info(channel_chats)').some(c => c.name === 'display_name')) store.db.exec("ALTER TABLE channel_chats ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  if (!store.all('PRAGMA table_info(channel_message_scopes)').some(c => c.name === 'fence')) store.db.exec('ALTER TABLE channel_message_scopes ADD COLUMN fence TEXT');
  mediaStorage(store);
}

export interface MessageQuery {
  message_id?: string; sender_id?: string; reply_to?: string; thread_id?: string;
  from?: number; to?: number; keyword?: string; cursor?: string; limit?: number;
  direction?: 'older';
}
const sensitive = (message: StoredMessage): boolean =>
  // Self mentions may touch a binding command; inspect the same text that command parsing receives.
  [message.content, message.command_text ?? ''].some(value => /(?:^|\s)(?:\/bind|\/confirm|\/reauth|确认绑定|绑定|重新认证)(?:\s|$)/i.test(value)) ||
  /(?:app_secret|encrypt_key|verification_token|api[_ -]?key|password|密码|凭据|私钥)\s*[:=：]/i.test(message.raw_content) ||
  JSON.stringify(traceClean(message)) !== JSON.stringify(message);

/** Only local persistence and reads. This repository deliberately has no provider client. */
export class ChannelLedger {
  constructor(readonly store: Store) {}
  chat(event: ChannelEvent): Row {
    const existing = this.store.get('SELECT * FROM channel_chats WHERE provider=? AND app_id=? AND installation_tenant=? AND chat_id=?',
      event.provider, event.app_id, event.installation_tenant, event.chat_id);
    if (existing) {
      // Recall events omit chat_type. Only an authenticated message establishes a private/group audience.
      if(event.kind==='message'&&existing.type_verified&&existing.chat_type!==event.chat_type)fail(403,'channel_chat_type_changed');
      this.store.run('UPDATE channel_chats SET connector_id=?,last_received_at=?,chat_type=?,type_verified=? WHERE id=?', event.connector_id, Date.now(),
        event.kind==='message'?event.chat_type:existing.chat_type,event.kind==='message'?1:existing.type_verified,existing.id);
      return this.store.get('SELECT * FROM channel_chats WHERE id=?', existing.id)!;
    }
    const id = randomId();
    this.store.run('INSERT INTO channel_chats(id,provider,app_id,installation_tenant,chat_id,chat_type,connector_id,created_at,last_received_at,type_verified) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, event.provider, event.app_id, event.installation_tenant, event.chat_id, event.chat_type, event.connector_id, Date.now(), Date.now(),event.kind==='message'?1:0);
    const row = this.store.get('SELECT * FROM channel_chats WHERE id=?', id)!;
    this.schedule(row, 'chat', event.chat_id);
    return row;
  }
  accept(event: ChannelEvent): Row | undefined {
    if (!event.chat_id || event.kind === 'card') return;
    const chat = this.chat(event);
    if (event.kind === 'bot_added') {
      this.store.run("UPDATE channel_chats SET state='active',revision=revision+1,context_revision=context_revision+1 WHERE id=?", chat.id);
      this.resync(chat.id);
    } else if (event.kind === 'audience_changed') {
      this.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', chat.id);
    } else if (['bot_removed', 'chat_archived'].includes(event.kind)) {
      this.store.run('UPDATE channel_chats SET state=?,revision=revision+1,context_revision=context_revision+1 WHERE id=?', event.kind === 'chat_archived' ? 'archived' : 'removed', chat.id);
      this.store.run("UPDATE channel_sync_jobs SET state='paused',lease_token=NULL,lease_until=0,last_error=? WHERE chat_id=?", event.kind, chat.id);
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', chat.id);
    } else if (event.kind === 'message' || event.kind === 'message_recalled') {
      this.merge(chat, { message_id: event.message_id, sender_id: event.actor_id, sender_tenant: event.actor_tenant,
        sender_type: event.sender_type ?? 'user', message_type: event.message_type ?? 'text', created_at: event.created_at,
        updated_at: event.updated_at ?? event.created_at, content: event.content, command_text: event.command_text, mentions: event.mentions, raw_content: event.raw_content ?? JSON.stringify({ text: event.content }),
        parent_id: event.parent_id ?? '', root_id: event.root_id ?? '', thread_id: event.thread_id,
        deleted: event.kind === 'message_recalled' || !!event.deleted }, 'live');
    }
    return chat;
  }
  merge(chat: Row, message: StoredMessage, source: 'live' | 'history'): boolean {
    const old = this.store.get('SELECT * FROM channel_messages WHERE chat_id=? AND message_id=?', chat.id, message.message_id);
    // Recall is permanent. A delayed page/event must never restore deleted content.
    if (old?.deleted) {
      // A recall may arrive first, without its sender or original timestamp. Late history
      // can fill that metadata, while both the sealed payload and query stay tombstoned.
      if (message.deleted) return false;
      const metadata = { sender_id: old.sender_id || message.sender_id, sender_tenant: old.sender_tenant || message.sender_tenant,
        sender_type: old.sender_id ? old.sender_type : message.sender_type, message_type: old.sender_id ? old.message_type : message.message_type,
        created_at: Math.min(old.created_at, message.created_at), parent_id: old.parent_id || message.parent_id,
        root_id: old.root_id || message.root_id, thread_id: old.thread_id || message.thread_id };
      if (Object.entries(metadata).every(([key, value]) => old[key] === value)) return false;
      const payload = this.store.secrets.open(old.payload, 'channel-message:' + chat.id + ':' + message.message_id);
      this.store.run(`UPDATE channel_messages SET sender_id=?,sender_tenant=?,sender_type=?,message_type=?,created_at=?,parent_id=?,root_id=?,thread_id=?,payload=? WHERE chat_id=? AND message_id=?`,
        ...Object.values(metadata), this.store.secrets.seal({ ...payload, ...metadata, content: '', command_text: '', raw_content: '', mentions: [], deleted: true }, 'channel-message:' + chat.id + ':' + message.message_id), chat.id, message.message_id);
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', chat.id);
      this.store.run('UPDATE channel_chats SET revision=revision+1,context_revision=context_revision+1 WHERE id=?', chat.id);
      if (metadata.thread_id) this.schedule(chat, 'thread', metadata.thread_id);
      return true;
    }
    if (message.created_at < chat.retained_after && !message.deleted) return false;
    if (old && !message.deleted && (message.updated_at < old.updated_at || message.updated_at === old.updated_at && (source === 'history' || old.source === 'live'))) return false;
    const data = message.deleted ? { ...message, content: '', command_text: '', raw_content: '', mentions: [] } : message;
    const sealed = this.store.secrets.seal(data, 'channel-message:' + chat.id + ':' + message.message_id);
    this.store.run(`INSERT INTO channel_messages VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(chat_id,message_id) DO UPDATE SET sender_id=excluded.sender_id,sender_tenant=excluded.sender_tenant,
      sender_type=excluded.sender_type,message_type=excluded.message_type,created_at=excluded.created_at,updated_at=excluded.updated_at,
      observed_at=excluded.observed_at,source=excluded.source,parent_id=excluded.parent_id,root_id=excluded.root_id,
      thread_id=excluded.thread_id,deleted=excluded.deleted,sensitive=excluded.sensitive,payload=excluded.payload`,
      chat.id, data.message_id, old && message.deleted ? old.sender_id : data.sender_id,
      old && message.deleted ? old.sender_tenant : data.sender_tenant, old && message.deleted ? old.sender_type : data.sender_type,
      old && message.deleted ? old.message_type : data.message_type, old && message.deleted ? old.created_at : data.created_at,
      Math.max(data.updated_at, old?.updated_at ?? 0), Date.now(), source, data.parent_id || old?.parent_id || '',
      data.root_id || old?.root_id || '', data.thread_id || old?.thread_id || '', Number(data.deleted), Number(sensitive(data)), sealed);
    mergeResources(this.store, chat, data, sensitive(data));
    if (old || this.store.get('SELECT 1 FROM channel_chat_summaries WHERE chat_id=? AND through_time>=?', chat.id, data.created_at)) {
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', chat.id);
      this.store.run('UPDATE channel_chats SET context_revision=context_revision+1 WHERE id=?', chat.id);
    }
    this.store.run('UPDATE channel_chats SET revision=revision+1 WHERE id=?', chat.id);
    if (message.thread_id) this.schedule(chat, 'thread', message.thread_id);
    return true;
  }
  schedule(chat: Row, type: 'chat' | 'thread', container: string): void {
    this.store.run(`INSERT OR IGNORE INTO channel_sync_jobs(id,chat_id,container_type,container_id,state,start_time,end_time,updated_at)
      VALUES(?,?,?,?,'pending',0,?,?)`, randomId(), chat.id, type, container, Math.ceil(Date.now() / 1000), Date.now());
  }
  /** Explicit resync/reconnect work is separate from searches, and never resets an unfinished page cursor. */
  resync(id: string, full = false): void {
    const chat = this.store.get("SELECT * FROM channel_chats WHERE id=? AND state='active'", id);
    if (!chat) return fail(409, 'channel_chat_inactive');
    this.store.transaction(() => {
      this.schedule(chat, 'chat', chat.chat_id);
      for (const job of this.store.all("SELECT * FROM channel_sync_jobs WHERE chat_id=? AND state IN ('complete','blocked','paused')", id)) {
        this.store.run(`UPDATE channel_sync_jobs SET state='pending',page_token='',start_time=?,end_time=?,generation=generation+1,
          pages=0,messages=0,attempts=0,next_attempt=0,last_error=NULL,lease_token=NULL,lease_until=0,updated_at=? WHERE id=?`,
          full || job.state !== 'complete' || job.container_type === 'thread' ? 0 : Math.max(0, job.covered_until - 60), Math.ceil(Date.now() / 1000), Date.now(), job.id);
      }
    });
  }
  diagnostics(id: string): Json {
    const chat = this.store.get('SELECT * FROM channel_chats WHERE id=?', id);
    if (!chat) return fail(404, 'channel_chat_not_found');
    const jobs = this.store.all('SELECT * FROM channel_sync_jobs WHERE chat_id=? ORDER BY container_type,container_id', id);
    const complete = jobs.length > 0 && jobs.every(j => j.state === 'complete');
    const connector = this.store.get('SELECT * FROM channel_connectors WHERE id=?', chat.connector_id);
    const active = connector?.enabled && connector.app_id === chat.app_id && connector.installation_tenant === chat.installation_tenant;
    return { sync_state: chat.state !== 'active' ? chat.state : !active ? 'paused' : complete ? 'visible_range_complete' : jobs.some(j => j.state === 'blocked') ? 'blocked' : 'syncing',
      coverage: jobs.map(j => ({ container_type: j.container_type, container_id: j.container_id, state: j.state,
        from: j.start_time, to: j.covered_until, requested_to: j.end_time, pages: j.pages, messages: j.messages,
        next_attempt: j.next_attempt, last_error: j.last_error, lease_until: j.lease_until,
        completed_ranges: this.store.all('SELECT start_time,end_time FROM channel_sync_ranges WHERE job_id=? ORDER BY generation', j.id) })),
      gaps: [...jobs.filter(j => j.state !== 'complete').map(j => ({ container_id: j.container_id, reason: j.last_error ?? 'sync_pending' })),
        { reason: 'platform_visibility_not_verified' }, { reason: 'message_edit_event_unavailable' },
        ...(jobs.some(j => j.container_type === 'thread') ? [{ reason: 'thread_time_boundary_unsupported' }] : []),
        ...(chat.retained_after ? [{ reason: 'retention', before: chat.retained_after }] : [])],
      retention: { days: chat.retention_days, policy: chat.retention_days === null ? 'hold_until_explicit_cleanup' : 'configured', retained_after: chat.retained_after } };
  }
  retain(id: string, days: number | null, revision: number): Json {
    if (days !== null && (!Number.isSafeInteger(days) || days < 1 || days > 3650)) fail(400, 'channel_retention_invalid');
    if (!this.store.run('UPDATE channel_chats SET retention_days=?,revision=revision+1 WHERE id=? AND revision=?', days, id, revision).changes) fail(409, 'channel_revision_conflict');
    return this.diagnostics(id);
  }
  cleanup(id: string, before: number, revision: number): void {
    if (!Number.isSafeInteger(before) || before < 0 || before > Date.now()) fail(400, 'channel_retention_invalid');
    this.store.transaction(() => {
      const chat = this.store.get('SELECT * FROM channel_chats WHERE id=? AND revision=?', id, revision);
      if (!chat) return fail(409, 'channel_revision_conflict');
      this.store.run('DELETE FROM channel_messages WHERE chat_id=? AND created_at<?', id, before);
      this.store.run('DELETE FROM channel_chat_summaries WHERE chat_id=?', id);
      this.store.run('UPDATE channel_chats SET retained_after=max(retained_after,?),revision=revision+1,context_revision=context_revision+1 WHERE id=?', before, id);
      // Inbox is an authorization receipt too. Keep trusted source IDs, erase the retained message body.
      const management=new Set<string>();
      for (const row of this.store.all('SELECT * FROM channel_inbox WHERE connector_id=?', chat.connector_id)) {
        const event = this.store.secrets.open(row.payload, 'channel-event:' + row.id);
        if(event.chat_id === chat.chat_id && event.installation_tenant === chat.installation_tenant && event.app_id === chat.app_id){
          if(row.context_revision!==null&&row.conversation_id)management.add(row.conversation_id);
          if(Number(event.created_at)<before)this.store.run('UPDATE channel_inbox SET payload=? WHERE id=?', this.store.secrets.seal({ ...event, content: '', raw_content: '', command_text: '', mentions: [] }, 'channel-event:' + row.id), row.id);
        }
      }
      // Personal management context is derived from the same local sources. Keep command audit/receipts.
      for(const conversation of management){
        this.store.run('DELETE FROM management_events WHERE message_id IN (SELECT id FROM management_messages WHERE conversation_id=?)',conversation);
        for(const message of this.store.all('SELECT id,source_message FROM management_messages WHERE conversation_id=?',conversation))
          this.store.run("UPDATE management_messages SET input=?,state=CASE WHEN state IN ('pending','running') THEN 'interrupted' ELSE state END WHERE id=?",
            JSON.stringify({source_message:message.source_message,content:'本地保留范围已清理。'}),message.id);
        this.store.run('UPDATE model_requests SET request_snapshot=NULL,response_snapshot=NULL,request_ref=NULL,response_ref=NULL WHERE conversation_id=?',conversation);
        this.store.trajectories.remove({conversation_id:conversation});
      }
      if(this.store.hasTable('channel_service_turns'))
        this.store.run("UPDATE channel_service_turns SET reply=NULL,updated_at=CASE WHEN state='running' THEN ? ELSE updated_at END,state=CASE WHEN state='running' THEN 'interrupted' ELSE state END,error=CASE WHEN state='running' THEN 'conversation_history_cleaned' ELSE error END WHERE chat_id=?",Date.now(),id);
      if(this.store.hasTable('channel_service_events')) this.store.run('DELETE FROM channel_service_events WHERE turn_id IN (SELECT id FROM channel_service_turns WHERE chat_id=?)', id);
      if(this.store.hasTable('role_conversation_turns')){
        this.store.run("UPDATE role_conversation_turns SET reply=NULL,updated_at=CASE WHEN state='running' THEN ? ELSE updated_at END,state=CASE WHEN state='running' THEN 'interrupted' ELSE state END,error=CASE WHEN state='running' THEN 'conversation_history_cleaned' ELSE error END WHERE conversation_id=?",Date.now(),id);
        this.store.run('DELETE FROM role_conversation_events WHERE turn_id IN (SELECT id FROM role_conversation_turns WHERE conversation_id=?)',id);
        this.store.run('DELETE FROM role_conversation_operations WHERE turn_id IN (SELECT id FROM role_conversation_turns WHERE conversation_id=?)',id);
        this.store.run('UPDATE model_requests SET request_snapshot=NULL,response_snapshot=NULL,request_ref=NULL,response_ref=NULL WHERE conversation_id=?',id);
        this.store.trajectories.remove({conversation_id:id});
      }
      for(const row of this.store.all('SELECT id,payload,state FROM channel_outbox WHERE connector_id=?',chat.connector_id)){
        const payload=this.store.secrets.open(row.payload,'channel-outbox:'+row.id) as any;
        if(payload.event?.chat_id===chat.chat_id&&payload.event?.app_id===chat.app_id&&payload.event?.installation_tenant===chat.installation_tenant&&
          (payload.protection?.turn_id||payload.protection?.personal_chat===id||payload.event.created_at<before)){
          payload.event={...payload.event,content:'',raw_content:'',command_text:'',mentions:[]};payload.delivery.content={elements:[{tag:'div',text:{tag:'plain_text',content:'本地保留范围已清理。'}}]};
          payload.delivery.resources=[];
          for(const part of this.store.all('SELECT part,state FROM channel_outbox_parts WHERE outbox_id=?',row.id))this.store.run('UPDATE channel_outbox_parts SET payload=?,state=? WHERE outbox_id=? AND part=?',
            this.store.secrets.seal({},'channel-outbox-part:'+row.id+':'+part.part),part.state==='sent'?'sent':'failed',row.id,part.part);
          this.store.run('UPDATE channel_outbox SET payload=?,state=?,last_error=? WHERE id=?',this.store.secrets.seal(payload,'channel-outbox:'+row.id),row.state==='sent'?'sent':'failed','history_cleaned',row.id);
        }
      }
    });
  }
  private view(row:Row):Json {
    const payload=this.store.secrets.open(row.payload,'channel-message:'+row.chat_id+':'+row.message_id);
    // Older ledgers kept authenticated raw references only. Materialize their metadata on an authorized local read.
    if(!row.deleted&&!row.sensitive)mergeResources(this.store,{id:row.chat_id},payload as unknown as StoredMessage,false);
    return {message_id:row.message_id,sender_id:row.sender_id,sender_tenant:row.sender_tenant,sender_type:row.sender_type,message_type:row.message_type,
      created_at:row.created_at,updated_at:row.updated_at,parent_id:row.parent_id,root_id:row.root_id,thread_id:row.thread_id,deleted:!!row.deleted,sensitive:!!row.sensitive,
      content:row.deleted?'[消息已撤回]':row.sensitive?'[敏感消息已隐藏]':String(payload.content),
      ...(!row.deleted&&!row.sensitive&&Array.isArray(payload.mentions)&&payload.mentions.length?{mentions:payload.mentions}:{}),
      resources:row.deleted||row.sensitive?null:this.store.all("SELECT * FROM channel_resources WHERE chat_id=? AND message_id=? AND kind='incoming' ORDER BY id",row.chat_id,row.message_id).map(resource=>resourceMetadata(this.store,resource)),resource_state:row.message_type==='text'?'text':'scoped_resources'};
  }
  private visibility(projects?:string[],fence?:string):{sql:string;args:string[]} {
    if(projects===undefined&&fence===undefined)return {sql:'',args:[]};
    const denied=projects===undefined?'0':projects.length?'s.project_id NOT IN ('+projects.map(()=>'?').join(',')+')':'1';
    return {sql:` AND NOT EXISTS(SELECT 1 FROM channel_message_scopes s WHERE s.chat_id=channel_messages.chat_id AND s.message_id=channel_messages.message_id AND (${denied}${fence!==undefined?' OR (s.fence IS NOT NULL AND s.fence<>?)':''}))`,args:[...(projects??[]),...(fence!==undefined?[fence]:[])]};
  }
  query(id: string, query: MessageQuery = {}, projects?:string[],fence?:string): Json {
    const diagnostics = this.diagnostics(id), limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || [query.from, query.to].some(v => v !== undefined && (!Number.isSafeInteger(v) || v < 0)) ||
      query.keyword !== undefined && (typeof query.keyword !== 'string' || query.keyword.length > 200) || query.from !== undefined && query.to !== undefined && query.from > query.to) fail(400, 'invalid_pagination');
    if (query.direction !== undefined && query.direction !== 'older') fail(400, 'invalid_pagination');
    const descending = query.direction === 'older', comparison = descending ? '<' : '>', order = descending ? 'DESC' : 'ASC';
    let after = descending ? Number.MAX_SAFE_INTEGER : -1, afterId = '';
    if (query.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (!Number.isSafeInteger(cursor.time) || cursor.time < 0 || typeof cursor.id !== 'string' || cursor.scope !== digest(JSON.stringify({ id, ...query, cursor: undefined, limit: undefined,projects,fence }))) throw new Error();
        after = cursor.time; afterId = cursor.id;
      } catch { fail(400, 'invalid_pagination'); }
    }
    const args: (string | number)[] = [id], conditions = ['chat_id=?'];
    for (const key of ['message_id', 'sender_id', 'thread_id'] as const) if (query[key] !== undefined) { conditions.push(key + '=?'); args.push(query[key]!); }
    if (query.reply_to !== undefined) { conditions.push('(parent_id=? OR root_id=?)'); args.push(query.reply_to, query.reply_to); }
    if (query.from !== undefined) { conditions.push('created_at>=?'); args.push(query.from); }
    if (query.to !== undefined) { conditions.push('created_at<=?'); args.push(query.to); }
    const visible=this.visibility(projects,fence);
    const messages: Json[] = [];
    let scanTime = after, scanId = afterId, exhausted = false;
    // Sealed text is searched in bounded batches; plaintext is never duplicated into a SQL index.
    while (messages.length <= limit) {
      const batch = this.store.all(`SELECT * FROM channel_messages WHERE ${conditions.join(' AND ')}${visible.sql} AND
        (created_at${comparison}? OR (created_at=? AND message_id${comparison}?)) ORDER BY created_at ${order},message_id ${order} LIMIT 200`, ...args,...visible.args, scanTime, scanTime, scanId);
      if (!batch.length) { exhausted = true; break; }
      for (const row of batch) {
        scanTime = row.created_at; scanId = row.message_id;
        const message=this.view(row),content=String(message.content);
        if (query.keyword && (row.sensitive || row.deleted || !content.toLocaleLowerCase().includes(query.keyword.toLocaleLowerCase()))) continue;
        messages.push(message);
        if (messages.length > limit) break;
      }
      if (messages.length > limit) break;
      if (batch.length < 200) { exhausted = true; break; }
    }
    const more = !exhausted && messages.length > limit, items = messages.slice(0, limit), last = items.at(-1);
    const cursor = more && last ? Buffer.from(JSON.stringify({ time: last.created_at, id: last.message_id,
      scope: digest(JSON.stringify({ id, ...query, cursor: undefined, limit: undefined,projects,fence })) })).toString('base64url') : null;
    return { chat_id: id, messages: items, next_cursor: cursor, has_more: more, ...diagnostics };
  }
  /** Bounded prompt windows and compaction use the same sealed local records as searches. */
  recent(id: string, limit = 40, projects?:string[],fence?:string,excludePending=false): Json[] {
    const visible=this.visibility(projects,fence);
    return this.store.all(`SELECT * FROM channel_messages WHERE chat_id=?${visible.sql}${excludePending?this.pendingFilter():''} ORDER BY created_at DESC,message_id DESC LIMIT ?`,id,...visible.args,limit).reverse().map(row=>this.view(row));
  }
  private pendingFilter():string {
    return ` AND NOT EXISTS(SELECT 1 FROM channel_inbox i WHERE i.chat_ref=channel_messages.chat_id AND i.dedup_key='message:'||channel_messages.message_id AND i.state IN ('queued','merged'))`;
  }
  before(id: string, boundary: Json, after?: Json, projects?:string[],fence?:string,excludePending=false): Json[] {
    const visible=this.visibility(projects,fence);
    return this.store.all(`SELECT * FROM channel_messages WHERE chat_id=?${visible.sql}${excludePending?this.pendingFilter():''} AND (created_at<? OR (created_at=? AND message_id<?))
      AND (created_at>? OR (created_at=? AND message_id>?)) ORDER BY created_at,message_id LIMIT 100`, id,
      ...visible.args,
      Number(boundary.created_at), Number(boundary.created_at), String(boundary.message_id), Number(after?.created_at??-1),Number(after?.created_at??-1),String(after?.message_id??''))
      .map(row => this.view(row));
  }
}
