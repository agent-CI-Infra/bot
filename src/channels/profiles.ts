import type { Store } from '../storage/database.js';
import type { Json } from '../core/security.js';
import { tenantName } from './applications.js';

/** Local presentation metadata only; names never participate in identity or authorization. */
export function chatProfile(store: Store, id: string): Json {
  const chat = store.get('SELECT * FROM channel_chats WHERE id=?', id);
  if (!chat) return {};
  const connector = store.get('SELECT * FROM channel_connectors WHERE id=? AND app_id=? AND installation_tenant=?', chat.connector_id, chat.app_id, chat.installation_tenant);
  const owner = chat.chat_type === 'p2p' ? store.get('SELECT * FROM channel_personal_owners WHERE chat_id=?', id) : undefined;
  const identity = owner && store.get(`SELECT id,display_name,external_actor,external_tenant FROM external_identities WHERE principal_id=?
    AND provider='feishu' AND host='open.feishu.cn' AND connector=? AND external_actor=? AND external_tenant=?
    AND status='active' AND (expires_at IS NULL OR expires_at>?)`, owner.principal_id, chat.connector_id + ':' + chat.app_id, owner.actor_id, owner.actor_tenant, Date.now());
  const displayName = chat.chat_type === 'group' ? chat.display_name : identity?.display_name !== identity?.external_actor ? identity?.display_name : '';
  return { display_name: displayName || '', app_name: connector?.app_name || '', tenant_name: connector?.tenant_name || '',
    organization_name: connector?.owner_tenant ? tenantName(store, connector.owner_tenant) : '',
    // Installation enterprise labels describe the robot, not the private-chat user's enterprise.
    ...(chat.chat_type === 'p2p' ? { binding_id: identity?.id || null } : {}),
    can_refresh_name: !!(connector?.enabled && chat.state === 'active' && (chat.chat_type === 'group' || identity?.external_tenant === connector.installation_tenant)) };
}
