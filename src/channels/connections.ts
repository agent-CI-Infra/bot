import { EventDispatcher, WSClient } from '@larksuiteoapi/node-sdk';
import type { ChannelService } from './service.js';
import type { Json } from '../core/security.js';
type Connection = Pick<WSClient, 'start' | 'close' | 'getConnectionStatus'>;

/** The SDK authenticates the socket with this connector's app credentials. HTTP cannot call this ingress. */
export class ChannelConnections {
  private readonly sockets = new Map<string, { revision: number; client: Connection; state?: string }>();
  constructor(readonly service: ChannelService, private readonly create: (options: ConstructorParameters<typeof WSClient>[0]) => Connection = options => new WSClient(options)) {}
  reconcile(): void {
    const store = this.service.store, rows = store.all("SELECT * FROM channel_connectors WHERE enabled=1 AND transport='websocket' AND application_type='enterprise'");
    for (const [id, socket] of this.sockets) {
      if (!rows.some(r => r.id === id && r.revision === socket.revision)) {
        socket.client.close({ force: true }); this.sockets.delete(id);
        store.run("UPDATE channel_connectors SET connection_state='idle' WHERE id=?", id);
      } else {
        const state = socket.client.getConnectionStatus().state;
        if (state === 'connected' && socket.state !== state) {
          for (const chat of store.all("SELECT id FROM channel_chats WHERE connector_id=? AND state='active'", id)) this.service.ledger.resync(chat.id);
        }
        socket.state = state;
        store.run('UPDATE channel_connectors SET connection_state=? WHERE id=? AND connection_state<>?', state, id, state);
      }
    }
    for (const c of rows) {
      if (this.sockets.has(c.id)) continue;
      const ref = store.get('SELECT sealed FROM channel_credentials WHERE id=?', c.credential_ref);
      if (!ref) continue;
      const secret = store.secrets.open(ref.sealed, 'channel-credential:' + c.credential_ref);
      // SDK diagnostics may include request configuration. Persist only our stable health codes.
      const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
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
        if (this.sockets.get(c.id)?.client === client) store.run("UPDATE channel_connectors SET last_error='channel_connection_failed',connection_state='failed' WHERE id=?", c.id);
      });
    }
  }
  close(): void { for (const socket of this.sockets.values()) socket.client.close({ force: true }); this.sockets.clear(); }
}
