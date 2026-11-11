import type { ActorContext } from '../identity/authorization.js';
import { assertCurrent, authorize } from '../identity/authorization.js';
import { fail, fields, HttpError, randomId, text, type Json } from '../core/security.js';
import { ChannelService } from './service.js';
import { FeishuAdapter } from './feishu.js';

export class ChannelApi {
  constructor(readonly service: ChannelService) {}
  async api(actor: ActorContext, method: string, url: URL, input: Json): Promise<Json> {
    const store = this.service.store, path = url.pathname;
    assertCurrent(actor);
    if (path === '/api/channels/employees' && method === 'GET') return this.service.employees.list(actor);
    const employee = /^\/api\/channels\/chats\/([a-f0-9]{48})\/employee$/.exec(path);
    const personal=/^\/api\/channels\/chats\/([a-f0-9]{48})\/personal-role$/.exec(path);
    if(personal&&method==='PUT')return this.service.employees.configurePersonal(actor,personal[1]!,input);
    const conversation=/^\/api\/channels\/chats\/([a-f0-9]{48})\/conversation$/.exec(path);
    if(conversation&&method==='GET')return this.service.conversationView(actor,conversation[1]!,Number(url.searchParams.get('offset')??0));
    if (employee && method === 'PUT') {
      const result = await this.service.employees.configure(actor, employee[1]!, input);
      if (input.enabled) this.service.ledger.resync(employee[1]!);
      return result;
    }
    if (path === '/api/channels/chats' && method === 'GET') {
      authorize(actor, 'platform.manage');
      const connector = url.searchParams.get('connector_id');
      return { chats: store.all(`SELECT * FROM channel_chats ${connector ? 'WHERE connector_id=?' : ''} ORDER BY last_received_at DESC`,
        ...(connector ? [connector] : [])).map(chat => ({ ...chat, ...this.service.ledger.diagnostics(chat.id) })) };
    }
    const local = /^\/api\/channels\/chats\/([a-f0-9]{48})\/(messages|sync|retention)$/.exec(path);
    if (local) {
      // Project access alone does not authorize reading a group's messages or personal chats.
      if (local[2] === 'messages' && method === 'GET' || local[2] === 'sync' && method === 'POST') this.service.employees.authorizeHistory(actor, local[1]!);
      else authorize(actor, 'platform.manage');
      const id = local[1]!, chat = store.get('SELECT * FROM channel_chats WHERE id=?', id);
      if (!chat) return fail(404, 'channel_chat_not_found');
      if (local[2] === 'messages' && method === 'GET') {
        const query = Object.fromEntries(url.searchParams);
        fields(query, ['message_id', 'sender_id', 'reply_to', 'thread_id', 'from', 'to', 'keyword', 'cursor', 'limit']);
        let projects:string[]|undefined;
        try{authorize(actor,'platform.manage');}catch{projects=this.service.employees.visibleProjects(id,actor);}
        return this.service.ledger.query(id, { ...query, ...Object.fromEntries(['from', 'to', 'limit'].filter(k => query[k] !== undefined).map(k => [k, Number(query[k])])) },projects);
      }
      if (local[2] === 'sync' && method === 'POST') {
        fields(input, ['full']);
        if (input.full !== undefined && typeof input.full !== 'boolean') fail(400, 'channel_sync_invalid');
        this.service.connector(chat.connector_id);
        this.service.ledger.resync(id, input.full === true);
        store.audit(actor.principal_id, 'channel.history.resync', id);
        return { state: 'queued', ...this.service.ledger.diagnostics(id) };
      }
      if (local[2] === 'retention') {
        if (method === 'PUT') {
          fields(input, ['days', 'expected_revision']);
          if (input.days !== null && typeof input.days !== 'number' || !Number.isSafeInteger(input.expected_revision)) fail(400, 'channel_retention_invalid');
          this.service.ledger.retain(id, input.days as number | null, Number(input.expected_revision));
          store.audit(actor.principal_id, 'channel.retention.updated', id);
        } else if (method === 'DELETE') {
          fields(input, ['before', 'expected_revision']);
          this.service.ledger.cleanup(id, Number(input.before), Number(input.expected_revision));
          store.audit(actor.principal_id, 'channel.history.cleaned', id);
        } else if (method !== 'GET') return fail(405, 'method_not_allowed');
        return this.service.ledger.diagnostics(id);
      }
      return fail(405, 'method_not_allowed');
    }
    if (path === '/api/channels/setup' && method === 'GET') {
      authorize(actor, 'platform.manage');
      return { ...await this.api(actor, 'GET', new URL('/api/channels/connectors', url), {}), origin: this.service.options.origin || null };
    }
    if (path === '/api/channels/feishu/probe' && method === 'POST') {
      authorize(actor, 'platform.manage');
      fields(input, ['connector_id', 'expected_revision', 'app_id', 'app_secret']);
      const guard = () => authorize(actor, 'platform.manage');
      let adapter: FeishuAdapter;
      if (input.connector_id !== undefined) {
        if (input.app_id !== undefined || input.app_secret !== undefined) fail(400, 'unknown_field');
        const c = store.get('SELECT * FROM channel_connectors WHERE id=?', text(input.connector_id));
        if (!c) return fail(404, 'channel_connector_not_found');
        const current = () => {
          guard();
          if (store.get('SELECT revision FROM channel_connectors WHERE id=?', c.id)?.revision !== input.expected_revision) fail(409, 'channel_revision_conflict');
        };
        current(); adapter = this.service.adapter(c, current);
        const facts = await adapter.probe();
        let tenantName = c.tenant_name, tenantError = '';
        try {
          const info = await adapter.installationInfo();
          if (info.tenant_key !== c.installation_tenant) fail(403, 'channel_source_mismatch');
          tenantName = info.tenant_name || tenantName;
        } catch (error) {
          // A display-name lookup must not invalidate working bot credentials or swallow a live permission/revision change.
          if (!(error instanceof HttpError) || !['channel_tenant_unavailable', 'channel_delivery_failed', 'channel_auth_failed', 'channel_rate_limited'].includes(error.code)) throw error;
          tenantError = error.code;
        }
        let revision = c.revision;
        // Preserve a newer application label on lookup failure, while bot-only connections can still refresh their name.
        const preserve = facts.app_error && c.app_name_source === 'application' && c.app_name;
        const name = String(preserve ? c.app_name : facts.name || c.app_name);
        const nameSource = preserve || !facts.name ? c.app_name_source : String(facts.name_source);
        store.transaction(() => {
          current();
          store.run('UPDATE channel_connectors SET app_name=?,tenant_name=?,app_name_source=? WHERE id=?', name, tenantName, nameSource, c.id);
          if (c.bot_open_id !== facts.bot_open_id) {
            store.run('UPDATE channel_connectors SET bot_open_id=?,revision=revision+1 WHERE id=? AND revision=?', String(facts.bot_open_id), c.id, c.revision);
            store.audit(actor.principal_id, 'channel.connector.bot_detected', c.id);
            revision++;
          }
        });
        return { ...facts, name, name_source: nameSource, tenant_name: tenantName, ...(tenantError ? { tenant_error: tenantError } : {}), revision, state: 'verified', event_delivery_verified: false };
      } else {
        // Only enterprise apps can authenticate before their first installation ticket arrives.
        adapter = new FeishuAdapter({ app_id: text(input.app_id, 200), application_type: 'enterprise' },
          { app_secret: text(input.app_secret, 4096) }, this.service.options.fetch, guard);
      }
      return { ...await adapter.probe(), state: 'verified', event_delivery_verified: false };
    }
    const receipt = /^\/api\/channels\/operations\/([a-f0-9]{48})$/.exec(path);
    if (receipt && method === 'GET') {
      const row = store.get('SELECT * FROM channel_control_operations WHERE id=?', receipt[1]!);
      if (!row) return fail(404, 'channel_operation_not_found');
      if (row.project_id) authorize(actor, 'config.write', { project_id: row.project_id });
      else authorize(actor, 'platform.manage');
      return JSON.parse(row.receipt);
    }
    const profile = /^\/api\/channels\/bindings\/([a-f0-9]{48})\/name$/.exec(path);
    if (profile && method === 'POST') {
      fields(input, []);
      const identity = store.get("SELECT * FROM external_identities WHERE id=? AND principal_id=? AND provider='feishu' AND host='open.feishu.cn' AND status='active'", profile[1]!, actor.principal_id);
      if (!identity) return fail(404, 'identity_not_found');
      const c = store.get("SELECT * FROM channel_connectors WHERE id||':'||app_id=? AND provider='feishu' AND enabled=1", identity.connector);
      if (!c) return fail(403, 'channel_connector_inactive');
      // An installation token cannot look up another enterprise's external users.
      if (identity.external_tenant !== c.installation_tenant) return fail(403, 'channel_user_name_unavailable');
      const guard = () => {
        assertCurrent(actor);
        const current = this.service.connector(c.id);
        if (current.revision !== c.revision) fail(409, 'channel_configuration_changed');
        if (!store.get("SELECT 1 FROM external_identities WHERE id=? AND principal_id=? AND provider='feishu' AND host=? AND status='active' AND connector=? AND external_tenant=? AND external_actor=?",
          identity.id, actor.principal_id, identity.host, identity.connector, identity.external_tenant, identity.external_actor)) fail(403, 'external_binding_required');
      };
      let name: string;
      try { name = await this.service.adapter(c, guard).userName(identity.external_actor); }
      catch (error) {
        if (!(error instanceof HttpError) || !['channel_delivery_rejected', 'channel_delivery_failed', 'channel_auth_failed', 'channel_rate_limited'].includes(error.code)) throw error;
        return fail(502, 'channel_user_name_unavailable');
      }
      store.transaction(() => { guard(); store.run('UPDATE external_identities SET display_name=? WHERE id=?', name, identity.id); });
      return { id: identity.id, display_name: name };
    }
    if (path === '/api/channels/bindings' && method === 'GET') return {
      bindings: store.all(`SELECT e.id,e.provider,e.connector,e.external_tenant,e.external_actor,e.display_name,e.status,e.verified_at,
        c.app_name,c.tenant_name,c.enabled AS connection_enabled,
        CASE WHEN e.status='active' AND e.host='open.feishu.cn' AND c.enabled=1 AND e.external_tenant=c.installation_tenant THEN 1 ELSE 0 END AS can_read_name
        FROM external_identities e LEFT JOIN channel_connectors c ON c.id||':'||c.app_id=e.connector
        WHERE e.principal_id=? AND e.provider='feishu'`, actor.principal_id),
      pending: this.service.bindings.pending(actor.principal_id),
      // Public identifiers let users bind before receiving any project grants.
      applications: store.all('SELECT id,app_id,app_name,tenant_name FROM channel_connectors WHERE enabled=1').map(c => ({ ...c,
        chat_url: 'https://applink.feishu.cn/client/bot/open?appId=' + encodeURIComponent(c.app_id) })),
    };
    if (path === '/api/channels/connectors' && method === 'GET') {
      authorize(actor, 'platform.manage');
      const rows = store.all('SELECT * FROM channel_connectors');
      return { connectors: rows.map(c => ({ ...c, capabilities: this.service.adapter(c).capabilities,
        callback_path: '/hooks/feishu/' + c.id, health: { enabled: !!c.enabled, connection_state: c.connection_state, last_received_at: c.last_received_at, last_error: c.last_error,
          queued: store.get("SELECT count(*) n FROM channel_inbox WHERE connector_id=? AND state IN ('queued','submitted')", c.id)!.n,
          failed: store.get("SELECT count(*) n FROM channel_outbox WHERE connector_id=? AND state='failed'", c.id)!.n } })) };
    }
    const match = /^\/api\/channels\/connectors\/([a-f0-9]{48})(?:\/(groups|outbox|events))?$/.exec(path);
    if (path === '/api/channels/connectors' && method === 'POST' || match && !match[2] && method === 'PATCH') {
      authorize(actor, 'platform.manage');
      // Accept the retired actor_tenants field from older clients without applying an enterprise restriction.
      fields(input, ['app_id', 'installation_tenant', 'actor_tenants', 'bot_open_id', 'application_type', 'transport', 'enabled', 'credentials', 'expected_revision']);
      const current = match ? store.get('SELECT * FROM channel_connectors WHERE id=?', match[1]!) : undefined;
      if (match && !current) return fail(404, 'channel_connector_not_found');
      const expected = current?.revision ?? 0;
      if (input.expected_revision !== expected) fail(409, 'channel_revision_conflict');
      const get = (key: string) => input[key] ?? current?.[key];
      const app = text(get('app_id'), 200);
      const type = get('application_type'), transport = get('transport'), enabled = input.enabled ?? (current ? !!current.enabled : false);
      if (!['enterprise', 'saas'].includes(String(type)) || !['http', 'websocket'].includes(String(transport)) || transport === 'websocket' && type !== 'enterprise') fail(400, 'channel_transport_invalid');
      if (typeof enabled !== 'boolean') fail(400, 'channel_enabled_invalid');
      let credential = current?.credential_ref;
      const id = current?.id ?? randomId(), operation = randomId();
      const guard = () => {
        authorize(actor, 'platform.manage');
        if (current && store.get('SELECT revision FROM channel_connectors WHERE id=?', id)?.revision !== expected) fail(409, 'channel_revision_conflict');
      };
      const previous = current ? store.get('SELECT sealed FROM channel_credentials WHERE id=?', current.credential_ref) : undefined;
      const secret: Json = previous ? store.secrets.open(previous.sealed, 'channel-credential:' + current!.credential_ref) : {};
      if (input.credentials !== undefined) {
        const value = input.credentials as Json;
        if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'channel_credentials_required');
        fields(value, ['app_secret', 'verification_token', 'encrypt_key']);
        for (const key of ['app_secret', 'verification_token', 'encrypt_key']) if (value[key] !== undefined) secret[key] = text(value[key], 4096);
      }
      if (!previous && input.credentials === undefined) fail(400, 'channel_credentials_required');
      text(secret.app_secret, 4096);
      if (transport === 'http' && (!secret.verification_token || !secret.encrypt_key)) fail(400, 'channel_http_credentials_required');
      if (current && current.app_id !== app) { delete secret.app_ticket; delete secret.app_ticket_time; }
      // An enterprise token identifies its installation; store apps need an explicit installation before token exchange.
      const changedApp = current && (current.app_id !== app || current.application_type !== type);
      const suppliedInstallation = input.installation_tenant ?? (changedApp ? undefined : current?.installation_tenant);
      const installationInfo = suppliedInstallation === undefined && type === 'enterprise'
        ? await new FeishuAdapter({ app_id: app, application_type: type }, secret, this.service.options.fetch, guard).installationInfo()
        : undefined;
      const installation = installationInfo?.tenant_key ?? text(suppliedInstallation);
      // Older API clients may supply an ID; the wizard always discovers it from the effective credentials.
      let bot = input.bot_open_id === undefined ? current?.bot_open_id ?? '' : text(input.bot_open_id);
      const changedSource = current && (current.app_id !== app || current.installation_tenant !== installation || current.application_type !== type);
      let appName = changedSource ? '' : current?.app_name ?? '';
      let appNameSource = changedSource ? '' : current?.app_name_source ?? '';
      const tenantName = installationInfo?.tenant_name ?? (changedSource ? '' : current?.tenant_name ?? '');
      if (input.bot_open_id === undefined && (!current || input.credentials !== undefined || changedSource || !bot)) {
        if (type === 'enterprise') {
          const facts = await new FeishuAdapter({ app_id: app, application_type: type }, secret, this.service.options.fetch, guard).probe();
          bot = String(facts.bot_open_id);
          if (!facts.app_error || appNameSource !== 'application' || !appName) {
            appName = String(facts.name || appName);
            if (facts.name) appNameSource = String(facts.name_source);
          }
        }
        // A store app must first save its callback configuration and receive an installation ticket.
        else if (!current || changedSource) bot = '';
      }
      return store.transaction(() => {
        guard();
        if (store.get('SELECT 1 FROM channel_connectors WHERE app_id=? AND installation_tenant=? AND id<>?', app, installation, id)) fail(409, 'channel_installation_conflict');
        if (input.credentials !== undefined || current && current.app_id !== app) {
          credential = randomId(); store.run('INSERT INTO channel_credentials VALUES(?,?)', credential, store.secrets.seal(secret, 'channel-credential:' + credential));
        }
        if (!credential) fail(400, 'channel_credentials_required');
        if (current) {
          store.run('UPDATE channel_connectors SET app_id=?,installation_tenant=?,bot_open_id=?,application_type=?,transport=?,credential_ref=?,enabled=?,revision=revision+1 WHERE id=? AND revision=?',
            app, installation, bot, String(type), String(transport), credential, Number(enabled), id, expected);
          if (current.credential_ref !== credential) store.run('DELETE FROM channel_credentials WHERE id=?', current.credential_ref);
        } else store.run('INSERT INTO channel_connectors(id,provider,app_id,installation_tenant,bot_open_id,application_type,transport,credential_ref,enabled,revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
          id, 'feishu', app, installation, bot, String(type), String(transport), credential, Number(enabled), 1, Date.now());
        store.run('UPDATE channel_connectors SET app_name=?,tenant_name=?,app_name_source=? WHERE id=?', appName, tenantName, appNameSource, id);
        store.audit(actor.principal_id, 'channel.connector.updated', id);
        const result = { operation_id: operation, state: 'succeeded', connector_id: id, revision: expected + 1 };
        store.run('INSERT INTO channel_control_operations(id,project_id,receipt) VALUES(?,NULL,?)', operation, JSON.stringify(result));
        return result;
      });
    }
    if (!match) return fail(404, 'channel_endpoint_not_found');
    const c = store.get('SELECT * FROM channel_connectors WHERE id=?', match[1]!);
    if (!c) return fail(404, 'channel_connector_not_found');
    if (match[2] === 'groups') {
      if (method === 'GET') return { groups: store.all('SELECT * FROM channel_group_scopes WHERE connector_id=?', c.id).filter(s => {
        try { authorize(actor, 'config.write', { project_id: s.project_id }); return true; } catch { return false; }
      }).map(s => ({ ...s, fields: JSON.parse(s.fields) })) };
      if (method !== 'PUT') return fail(405, 'method_not_allowed');
      fields(input, ['chat_id', 'project_id', 'fields', 'sensitivity', 'audience_verified_until', 'enabled', 'expected_revision']);
      const project = text(input.project_id), chat = text(input.chat_id);
      authorize(actor, 'config.write', { project_id: project });
      if (!Array.isArray(input.fields) || !input.fields.length || input.fields.some(f => !['summary', 'status', 'operation', 'result'].includes(String(f))) ||
        !['public', 'private'].includes(String(input.sensitivity)) || typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.audience_verified_until) ||
        Number(input.audience_verified_until) < 0 || Number(input.audience_verified_until) > Date.now() + 3600_000) fail(400, 'channel_group_scope_invalid');
      const row = store.get('SELECT * FROM channel_group_scopes WHERE connector_id=? AND installation_tenant=? AND chat_id=? AND project_id=?', c.id, c.installation_tenant, chat, project);
      if (input.expected_revision !== (row?.revision ?? 0)) fail(409, 'channel_revision_conflict');
      const id = row?.id ?? randomId(), result = { operation_id: randomId(), state: 'succeeded', group_id: id, revision: (row?.revision ?? 0) + 1 };
      store.transaction(() => {
        if (store.get('SELECT revision FROM channel_connectors WHERE id=?', c.id)?.revision !== c.revision) fail(409, 'channel_revision_conflict');
        const locked = store.get('SELECT revision FROM channel_group_scopes WHERE connector_id=? AND installation_tenant=? AND chat_id=? AND project_id=?', c.id, c.installation_tenant, chat, project);
        if ((locked?.revision ?? 0) !== input.expected_revision) fail(409, 'channel_revision_conflict');
        store.run(`INSERT INTO channel_group_scopes VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fields=excluded.fields,sensitivity=excluded.sensitivity,
          audience_verified_until=excluded.audience_verified_until,enabled=excluded.enabled,revision=excluded.revision`, id, c.id, c.installation_tenant, chat, project,
          JSON.stringify(input.fields), String(input.sensitivity), Number(input.audience_verified_until), Number(input.enabled), (row?.revision ?? 0) + 1);
        store.audit(actor.principal_id, 'channel.group.updated', id, project);
        store.run('INSERT INTO channel_control_operations(id,project_id,receipt) VALUES(?,?,?)', result.operation_id, project, JSON.stringify(result));
      });
      return result;
    }
    authorize(actor, 'platform.manage');
    if (method === 'GET' && match[2] === 'outbox') return { deliveries: store.all('SELECT id,state,attempts,last_error,remote_message_id,created_at FROM channel_outbox WHERE connector_id=? ORDER BY created_at DESC LIMIT 100', c.id) };
    if (method === 'GET' && match[2] === 'events') return { operations: store.all('SELECT id AS operation_id,state,error,conversation_id,message_id,created_at FROM channel_inbox WHERE connector_id=? ORDER BY created_at DESC LIMIT 100', c.id) };
    return fail(404, 'channel_endpoint_not_found');
  }
}
