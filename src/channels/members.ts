import type { Row, Store } from '../storage/database.js';
import { fail } from '../core/security.js';
import type { FeishuAdapter } from './feishu.js';

// Display names of the people in a chat, best effort, so an assistant can tell its speakers apart by name. The open_id is the
// identity; a name is display data only: it can repeat, change, or be missing (external members outside the installation's
// directory). Sources, in order: the directory (contact API, internal users only), then the group's own member list.
const directoryTtl = 24 * 3600_000, directoryRetry = 3600_000, rosterTtl = 10 * 60_000, rosterRetry = 60_000;
// A turn waits at most this long for missing names before it starts; lookups still running finish into the cache.
const resolveWait = 2500, lookupBatch = 20;
export interface ChatPerson { id: string; tenant: string }
export interface ChatMember extends ChatPerson { name?: string }

export class ChannelMembers {
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly store: Store, private readonly adapter: (c: Row, guard: () => void) => FeishuAdapter, private readonly clock = () => Date.now()) {
    // name NULL records a failed directory lookup, retried after directoryRetry. Rosters are sealed like the audience snapshot.
    store.db.exec(`CREATE TABLE IF NOT EXISTS channel_user_names(connector_id TEXT NOT NULL,tenant TEXT NOT NULL,actor_id TEXT NOT NULL,
        name TEXT,refreshed_at INTEGER NOT NULL,PRIMARY KEY(connector_id,tenant,actor_id));
      CREATE TABLE IF NOT EXISTS channel_chat_rosters(chat_id TEXT PRIMARY KEY,members TEXT,refreshed_at INTEGER NOT NULL DEFAULT 0,
        attempted_at INTEGER NOT NULL DEFAULT 0,last_error TEXT)`);
  }
  /** The best known display name: the directory's, else the group member list's. Read the roster once per namer. */
  namer(chat: Row): (person: ChatPerson) => string | undefined {
    let roster: ChatMember[] | undefined | null = null;
    return person => {
      const directory = this.store.get('SELECT name FROM channel_user_names WHERE connector_id=? AND tenant=? AND actor_id=?', chat.connector_id, person.tenant, person.id)?.name;
      if (directory) return String(directory);
      if (roster === null) roster = this.cached(chat);
      return roster?.find(m => m.id === person.id && m.tenant === person.tenant)?.name;
    };
  }
  private cached(chat: Row): ChatMember[] | undefined {
    const row = this.store.get('SELECT members FROM channel_chat_rosters WHERE chat_id=?', chat.id);
    return row?.members ? this.store.secrets.open(row.members, 'channel-roster:' + chat.id).members as unknown as ChatMember[] : undefined;
  }
  /** Cached members of a group, directory names preferred, and when the list was read; undefined before the first read. */
  roster(chat: Row): { members: ChatMember[]; refreshed_at: number; last_error?: string } | undefined {
    const row = this.store.get('SELECT refreshed_at,last_error FROM channel_chat_rosters WHERE chat_id=?', chat.id), members = this.cached(chat);
    if (!row || !members) return undefined;
    const name = this.namer(chat);
    return { members: members.map(m => { const known = name(m); return known ? { ...m, name: known } : m; }), refreshed_at: row.refreshed_at, ...(row.last_error ? { last_error: row.last_error } : {}) };
  }
  /** Mark a group's member list stale (members changed, bot removed); names stay usable until the next read. */
  stale(chat: string): void { this.store.run('UPDATE channel_chat_rosters SET refreshed_at=0,attempted_at=0 WHERE chat_id=?', chat); }
  forgetConnector(connector: string): void {
    this.store.run('DELETE FROM channel_user_names WHERE connector_id=?', connector);
    this.store.run('DELETE FROM channel_chat_rosters WHERE chat_id IN (SELECT id FROM channel_chats WHERE connector_id=?)', connector);
  }
  /**
   * Fill in missing or stale names for these people. Never throws: names only help reading. Waits at most `wait` ms; work still
   * in flight completes into the cache for later steps and turns.
   */
  async resolve(chat: Row, people: ChatPerson[], wait = resolveWait): Promise<void> {
    const work = this.lookup(chat, people).catch(() => {});
    if (wait <= 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, wait); })]);
    clearTimeout(timer);
  }
  /** The group's member list for the assistant, re-read from Feishu when older than rosterTtl. */
  async members(chat: Row): Promise<{ members: ChatMember[]; refreshed_at: number; error?: string }> {
    if (chat.chat_type !== 'group') fail(400, 'channel_group_required');
    const cached = this.store.get('SELECT refreshed_at,attempted_at FROM channel_chat_rosters WHERE chat_id=?', chat.id);
    if (!cached || this.clock() - cached.refreshed_at > rosterTtl && this.clock() - cached.attempted_at > rosterRetry) await this.refreshRoster(chat).catch(() => {});
    const roster = this.roster(chat);
    if (!roster) return { members: [], refreshed_at: 0, error: this.store.get('SELECT last_error FROM channel_chat_rosters WHERE chat_id=?', chat.id)?.last_error ?? 'channel_members_unavailable' };
    return { members: roster.members, refreshed_at: roster.refreshed_at, ...(roster.last_error ? { error: roster.last_error } : {}) };
  }
  private async lookup(chat: Row, people: ChatPerson[]): Promise<void> {
    const now = this.clock(), unique = [...new Map(people.filter(p => p.id && p.tenant).map(p => [p.tenant + ':' + p.id, p])).values()];
    const record = (p: ChatPerson) => this.store.get('SELECT name,refreshed_at FROM channel_user_names WHERE connector_id=? AND tenant=? AND actor_id=?', chat.connector_id, p.tenant, p.id);
    // The installation's token reads only its own directory: external members are never looked up there.
    const due = unique.filter(p => p.tenant === chat.installation_tenant).filter(p => {
      const row = record(p);
      return !row || (row.name ? now - row.refreshed_at > directoryTtl : now - row.refreshed_at > directoryRetry);
    }).slice(0, lookupBatch);
    for (let i = 0; i < due.length; i += 5) await Promise.all(due.slice(i, i + 5).map(p => this.directory(chat, p)));
    // Whoever the directory could not name (external members, a missing permission) falls back to the group's member list.
    const name = this.namer(chat);
    if (chat.chat_type === 'group' && unique.some(p => !name(p))) {
      const cached = this.store.get('SELECT refreshed_at,attempted_at FROM channel_chat_rosters WHERE chat_id=?', chat.id);
      if (!cached || now - cached.refreshed_at > rosterTtl && now - cached.attempted_at > rosterRetry) await this.refreshRoster(chat);
    }
  }
  private connector(chat: Row): { connector: Row; guard: () => void } {
    const connector = this.store.get('SELECT * FROM channel_connectors WHERE id=? AND enabled=1', chat.connector_id);
    if (!connector) return fail(403, 'channel_connector_inactive');
    // A name read with a replaced credential or app must not land in this connector's cache.
    return { connector, guard: () => {
      const current = this.store.get('SELECT revision,credential_ref FROM channel_connectors WHERE id=? AND enabled=1', chat.connector_id);
      if (!current || current.revision !== connector.revision || current.credential_ref !== connector.credential_ref) fail(409, 'channel_configuration_changed');
    } };
  }
  private directory(chat: Row, person: ChatPerson): Promise<void> {
    const key = chat.connector_id + ':' + person.tenant + ':' + person.id, running = this.pending.get(key);
    if (running) return running;
    const work = (async () => {
      let name: string | null = null;
      try { const { connector, guard } = this.connector(chat); name = await this.adapter(connector, guard).userName(person.id); }
      catch { name = null; }
      this.store.run(`INSERT INTO channel_user_names VALUES(?,?,?,?,?) ON CONFLICT(connector_id,tenant,actor_id) DO UPDATE SET
        name=COALESCE(excluded.name,channel_user_names.name),refreshed_at=excluded.refreshed_at`, chat.connector_id, person.tenant, person.id, name, this.clock());
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  private refreshRoster(chat: Row): Promise<void> {
    const key = 'roster:' + chat.id, running = this.pending.get(key);
    if (running) return running;
    const work = (async () => {
      this.store.run(`INSERT INTO channel_chat_rosters(chat_id,attempted_at) VALUES(?,?) ON CONFLICT(chat_id) DO UPDATE SET attempted_at=excluded.attempted_at`, chat.id, this.clock());
      try {
        const { connector, guard } = this.connector(chat);
        const members = await this.adapter(connector, guard).audience(chat.chat_id);
        this.store.run('UPDATE channel_chat_rosters SET members=?,refreshed_at=?,last_error=NULL WHERE chat_id=?',
          this.store.secrets.seal({ members }, 'channel-roster:' + chat.id), this.clock(), chat.id);
      } catch (error) {
        this.store.run('UPDATE channel_chat_rosters SET last_error=? WHERE chat_id=?', (error as any)?.code ?? 'channel_members_unavailable', chat.id);
        throw error;
      }
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
}
