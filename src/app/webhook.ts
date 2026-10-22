import type { IncomingHttpHeaders } from 'node:http';
import { type Store } from '../storage/database.js';
import { randomId, verifySignature, type Json } from '../core/security.js';

export function ingest(store: Store, accountId: string, endpointId: string, headers: IncomingHttpHeaders, bytes: Buffer, complete: boolean) {
  const endpoint = store.get('SELECT id,account_id,secret FROM endpoints WHERE id=? AND account_id=?', endpointId, accountId);
  const secret = endpoint ? store.secrets.open(endpoint.secret, `endpoint:${endpointId}`).value : '';
  const signature = String(headers['x-hub-signature-256'] || '');
  let status = 200, outcome = 'accepted', payload: Json | null = null;
  if (!complete) { status = 413; outcome = 'payload_too_large'; }
  else if (!endpoint) { status = 404; outcome = 'unknown_endpoint'; }
  else if (!verifySignature(bytes, String(secret || ''), signature)) { status = 401; outcome = 'invalid_signature'; }
  else {
    try {
      const parsed = JSON.parse(bytes.toString('utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      payload = parsed;
    } catch { status = 400; outcome = 'invalid_payload'; }
  }
  const deliveryId = String(headers['x-github-delivery'] || '').slice(0, 200);
  const event = String(headers['x-github-event'] || '').slice(0, 100);
  if (status === 200 && (!deliveryId || !/^[a-z_]+$/.test(event))) { status = 400; outcome = 'missing_event_or_delivery'; }
  // Control/installation events and unknown repositories remain visible only to the super administrator.
  const candidate = payload?.repository;
  const repoId = candidate && typeof candidate === 'object' ? String((candidate as Json).id || '') : '';
  const owner = status === 200 && event !== 'installation' && event !== 'installation_repositories'
    ? store.get('SELECT id FROM repositories WHERE id=? AND account_id=?', repoId, accountId) : undefined;
  const action = typeof payload?.action === 'string' ? payload.action.slice(0, 100) : '';
  const kind = event === 'issues' ? 'issue' : event;
  const route = kind + (action ? `.${action}` : '');
  const safeHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key,
    /authorization|cookie|token|secret|signature|key/i.test(key) ? '[REDACTED]' : value]));
  return store.transaction(() => {
    const duplicate = status === 200 && !!store.get('SELECT 1 FROM processed_deliveries WHERE account_id=? AND endpoint_id=? AND delivery_id=?', accountId, endpointId, deliveryId);
    const id = randomId();
    const response = status === 200 ? { ok: true, record_id: id, duplicate, tasks_created: 0 }
      : { ok: false, error: outcome, record_id: id };
    store.run(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,
      http_status,request_headers,payload,body_complete,response) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, endpoint ? accountId : null,
      endpoint ? endpointId : null, owner?.id || null, deliveryId, event, route, outcome, Number(duplicate), new Date().toISOString(),
      status, JSON.stringify(safeHeaders), bytes, Number(complete), JSON.stringify(response));
    if (status === 200 && !duplicate) store.run('INSERT INTO processed_deliveries VALUES(?,?,?)', accountId, endpointId, deliveryId);
    if (status === 200 && !duplicate && event === 'installation' && ['deleted','suspend'].includes(action)) {
      const installation = payload?.installation as Json | undefined, account = installation?.account as Json | undefined;
      const ownerId = String(account?.id || '');
      store.run('UPDATE policies SET enabled=0 WHERE repository_id IN (SELECT id FROM repositories WHERE account_id=? AND owner_id=?)', accountId, ownerId);
    }
    if (status === 200 && !duplicate && event === 'installation_repositories' && Array.isArray(payload?.repositories_removed)) {
      for (const removed of payload.repositories_removed) if (removed && typeof removed === 'object')
        store.run('UPDATE policies SET enabled=0 WHERE repository_id IN (SELECT id FROM repositories WHERE account_id=? AND id=?)', accountId, String(removed.id || ''));
    }
    // No review/development scheduler is installed in the control-plane release.
    return { status, response };
  });
}
