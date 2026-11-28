import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { ChannelService } from './service.js';
import type { Json } from '../core/security.js';
import { configuredRedactor, publicText } from '../core/redaction.js';
import type { Store } from '../storage/database.js';
type Connection = Pick<WSClient, 'start' | 'close' | 'getConnectionStatus'>;
/** A terminal long connection retries at 1s, 2s, 4s … capped at five minutes: every attempt logs in to Feishu. */
const maxRebuildDelayMs = 5 * 60 * 1000;
/**
 * The SDK's logger. Its debug level prints whole events (message bodies) and the socket URL, and objects it passes may be request
 * configurations, so only warnings and errors are logged, as text: an error by its message, any other object not at all, and
 * whatever credential the deployment knows removed (#1399).
 */
export function sdkLogger(store: Store, connector: string) {
  const write = (level: 'warn' | 'error') => (...args: unknown[]) => {
    const text = args.map(arg => typeof arg === 'string' ? arg : arg instanceof Error ? arg.message : ['number', 'boolean'].includes(typeof arg) ? String(arg) : '[object]').join(' ');
    let line: string;
    try { line = publicText(text, configuredRedactor(store)); } catch { line = '[unavailable]'; }
    console[level](`[channels] feishu sdk ${level} on connector ${connector}: ${line.slice(0, 500)}`);
  };
  return { trace() {}, debug() {}, info() {}, warn: write('warn'), error: write('error') };
}

/** The SDK authenticates the socket with this connector's app credentials. HTTP cannot call this ingress. */
export class ChannelConnections {
  private readonly sockets = new Map<string, { revision: number; client: Connection; state?: string }>();
  // Terminal failures are remembered per connector so a bad app secret does not rebuild (and re-authenticate) every tick.
  private readonly rebuilds = new Map<string, { attempts: number; revision: number; nextAttempt: number }>();
  constructor(readonly service: ChannelService, private readonly create: (options: ConstructorParameters<typeof WSClient>[0]) => Connection = options => new WSClient(options)) {}
  reconcile(now = Date.now()): void {
    const store = this.service.store, rows = store.all("SELECT * FROM channel_connectors WHERE enabled=1 AND transport='websocket' AND application_type='enterprise'");
    // A socket the SDK already gave up on is rebuilt on a later tick, after one tick that keeps `failed` visible.
    const retry = new Set<string>();
    for (const [id, socket] of this.sockets) {
      if (!rows.some(r => r.id === id && r.revision === socket.revision)) {
        socket.client.close({ force: true }); this.sockets.delete(id);
        // A disabled connector or a new credential revision starts over with a clean retry schedule.
        this.rebuilds.delete(id);
        store.run("UPDATE channel_connectors SET connection_state='idle' WHERE id=?", id);
      } else {
        const state = socket.client.getConnectionStatus().state;
        if (state === 'failed') {
          // The pinned SDK calls reConnect() without awaiting or returning it, so a refused connection, a failed
          // handshake or a non-retryable credential error leaves start() resolved and only surfaces here (#533).
          // Drop the terminal client or every later tick skips the connector on the "already in sockets" check and
          // only re-saving the credentials brings the channel back. `failed`/`last_error` stay for the console, and
          // the next tick builds a fresh client instead of rebuilding inside this one.
          socket.client.close({ force: true }); this.sockets.delete(id);
          store.run("UPDATE channel_connectors SET last_error='channel_connection_failed',connection_state='failed' WHERE id=?", id);
          this.scheduleRebuild(id, socket.revision, now);
          retry.add(id); continue;
        }
        if (state === 'connected') {
          // A healthy socket (including one that recovered by itself) forgets earlier terminal attempts.
          this.rebuilds.delete(id);
          if (socket.state !== state) {
            for (const chat of store.all("SELECT id FROM channel_chats WHERE connector_id=? AND state='active'", id)) this.service.ledger.resync(chat.id);
          }
        }
        socket.state = state;
        // A connector that came back drops the error our own failure paths wrote — and only that value, so nothing
        // another writer recorded is lost. The clear rides the same update as the healthy state (#533): otherwise the
        // console keeps reporting a healed connection as broken long after it reconnected.
        store.run("UPDATE channel_connectors SET connection_state=?,last_error=CASE WHEN ?='connected' AND last_error='channel_connection_failed' THEN NULL ELSE last_error END WHERE id=? AND connection_state<>?", state, state, id, state);
      }
    }
    for (const c of rows) {
      if (this.sockets.has(c.id) || retry.has(c.id)) continue;
      const wait = this.rebuilds.get(c.id);
      if (wait && wait.revision !== c.revision) this.rebuilds.delete(c.id);
      else if (wait && now < wait.nextAttempt) continue;
      const ref = store.get('SELECT sealed FROM channel_credentials WHERE id=?', c.credential_ref);
      if (!ref) continue;
      const secret = store.secrets.open(ref.sealed, 'channel-credential:' + c.credential_ref);
      // SDK diagnostics may include request configuration: the console keeps only our stable health codes, the log redacted text.
      const logger = sdkLogger(store, c.id);
      const client = this.create({ appId: c.app_id, appSecret: String(secret.app_secret), logger });
      const handlers = Object.fromEntries(['im.message.receive_v1', 'im.message.recalled_v1', 'im.chat.member.bot.added_v1', 'im.chat.member.bot.deleted_v1',
        'im.chat.disbanded_v1', 'card.action.trigger', 'app.uninstalled', 'app_uninstalled', 'app_status_change', 'im.chat.member.user.added_v1', 'im.chat.member.user.deleted_v1'].map(type => [type, async (data: any) => {
        if (['app_uninstalled', 'app_status_change'].includes(type)) return this.service.receiveLongConnection(c.id, { uuid: data.uuid, event: { ...data, type } });
        const { event_id, app_id, tenant_key, create_time, ...event } = data;
        // The official dispatcher flattens the verified header and event. Never invent missing source IDs.
        return this.service.receiveLongConnection(c.id, { header: { event_id, app_id, tenant_key, create_time, event_type: type }, event } as Json);
      }]));
      const dispatcher = new EventDispatcher({ logger }).register(handlers);
      this.sockets.set(c.id, { revision: c.revision, client });
      store.run("UPDATE channel_connectors SET connection_state='connecting' WHERE id=?", c.id);
      void client.start({ eventDispatcher: dispatcher }).catch(() => {
        // Defense in depth: the pinned SDK resolves start() for connection failures, so this path is not the one that
        // recovers #533; if a future version does reject, release the client before dropping it like the failed-state
        // path above does.
        if (this.sockets.get(c.id)?.client !== client) return;
        client.close({ force: true }); this.sockets.delete(c.id);
        // A rejected start is the same terminal outcome, so it shares the retry schedule (wall clock, since the
        // rejection arrives after the reconcile tick that created the client).
        this.scheduleRebuild(c.id, c.revision, Date.now());
        store.run("UPDATE channel_connectors SET last_error='channel_connection_failed',connection_state='failed' WHERE id=?", c.id);
      });
    }
  }
  /** Records one terminal failure: the next rebuild is 1s, 2s, 4s … away, capped at five minutes. */
  private scheduleRebuild(id: string, revision: number, now: number): void {
    const prior = this.rebuilds.get(id);
    const attempts = (prior && prior.revision === revision ? prior.attempts : 0) + 1;
    this.rebuilds.set(id, { attempts, revision, nextAttempt: now + Math.min(maxRebuildDelayMs, 1000 * 2 ** Math.min(attempts - 1, 20)) });
  }
  close(): void { for (const socket of this.sockets.values()) socket.client.close({ force: true }); this.sockets.clear(); this.rebuilds.clear(); }
}
