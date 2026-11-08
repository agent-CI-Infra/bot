import type { IncomingHttpHeaders } from 'node:http';
import type { Json } from '../core/security.js';

export interface ChannelEvent {
  provider: 'feishu'; connector_id: string; connector_revision: number; app_id: string; installation_tenant: string;
  actor_tenant: string; actor_id: string; chat_id: string; chat_type: 'p2p' | 'group';
  message_id: string; event_id: string; thread_id: string; created_at: number;
  kind: 'message' | 'card' | 'audience_changed' | 'uninstalled' | 'app_ticket'; content: string; card_token?: string;
}
export interface ChannelDelivery {
  receive_id: string; receive_id_type: 'chat_id' | 'open_id'; content: Json;
  message_id?: string;
}
export interface ChannelAdapter {
  readonly capabilities: { messages: boolean; cards: boolean; update: boolean; group_history: false };
  verify(headers: IncomingHttpHeaders, body: Buffer): Json;
  normalize(envelope: Json): ChannelEvent | null;
  send(delivery: ChannelDelivery, idempotencyKey: string): Promise<string>;
  update(delivery: ChannelDelivery): Promise<string>;
}
