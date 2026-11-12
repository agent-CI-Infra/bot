import type { IncomingHttpHeaders } from 'node:http';
import type { Json } from '../core/security.js';

export interface ChannelMention { key: string; actor_id: string; name: string; is_self: boolean; }
export interface ChannelEvent {
  provider: 'feishu'; connector_id: string; connector_revision: number; app_id: string; installation_tenant: string;
  actor_tenant: string; actor_id: string; chat_id: string; chat_type: 'p2p' | 'group';
  message_id: string; event_id: string; thread_id: string; created_at: number;
  kind: 'message' | 'message_recalled' | 'bot_added' | 'bot_removed' | 'chat_archived' | 'card' | 'audience_changed' | 'uninstalled' | 'app_ticket'; content: string; card_token?: string;
  received_at?: number; message_type?: string; sender_type?: string; parent_id?: string; root_id?: string;
  updated_at?: number; deleted?: boolean; addressed?: boolean; raw_content?: string;
  mentions?: ChannelMention[];
  /** Binding commands omit the bot mention; displayed text and model requests retain it. */
  command_text?: string;
}
export interface ChannelDelivery {
  receive_id: string; receive_id_type: 'chat_id' | 'open_id'; content: Json;
  message_id?: string; message_type?: 'interactive' | 'post' | 'image' | 'file'; reply_to?: string; reply_in_thread?: boolean;
  resources?: string[];
  format_version?: 2;
}
export interface ChannelAdapter {
  readonly capabilities: { messages: boolean; cards: boolean; update: boolean; group_history: boolean };
  verify(headers: IncomingHttpHeaders, body: Buffer): Json;
  normalize(envelope: Json): ChannelEvent | null;
  send(delivery: ChannelDelivery, idempotencyKey: string): Promise<string>;
  update(delivery: ChannelDelivery): Promise<string>;
}

export interface StoredMessage {
  message_id: string; sender_id: string; sender_tenant: string; sender_type: string; message_type: string;
  created_at: number; updated_at: number; content: string; raw_content: string;
  parent_id: string; root_id: string; thread_id: string; deleted: boolean;
  mentions?: ChannelMention[];
  command_text?: string;
}
export interface HistoryPage { items: StoredMessage[]; has_more: boolean; page_token: string; }
