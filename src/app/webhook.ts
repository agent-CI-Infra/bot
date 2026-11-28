import { boardWebhook } from '../public-board/state.js';
import type { IncomingHttpHeaders } from 'node:http';
import { type Store } from '../storage/database.js';
import { randomId, verifySignature, type Json } from '../core/security.js';
import { pullRequestNeeded, queueWebhook } from '../review/queue.js';
import { botWakePreflightPlan, collectBotWakePreflight, type BotWakePreflight } from '../review/bot-pr-wake.js';
import { GitHub } from '../github/client.js';
import { Redactor } from '../agent/common.js';
import { recordInstallationEvent } from './installations.js';
import { enqueueForwards } from '../external/forward.js';
import { actionsWebhook } from '../actions/storage.js';
import { recordCheckWebhook } from '../tasks/external-links.js';
import { archiveInstallationEvent, isInstallationControlEvent, numericId } from '../installations/archive.js';
import { dropUninstalledIntegrations } from '../projects/integrations.js';
import { activeScopes, invalidate, invalidateIfLost } from '../identity/authorization.js';
import { markInstallationMemberCacheDirty, markRepositoryMemberCacheDirty } from '../identity/storage.js';
import { pruneRejectedArchive, rejectionHeaders, rejectionSummary } from './delivery-audit.js';
import { covers, projectCeiling } from '../projects/ceiling.js';
import { matchWebhookSubscriptions, shouldFallbackWebhookToManager } from '../tasks/event-subscriptions.js';
import { queueSubscriptionFallbackEvent } from '../dispatch/store.js';
import { deliverySummary, inlineDeliveryBytes, removeDeliveryBody, writeDeliveryBody, type StoredBody } from '../storage/webhook-bodies.js';

function markWebhookMemberCacheDirty(store: Store, accountId: string, event: string, payload: Json): string[] {
  if (!['member', 'organization', 'membership', 'team', 'installation', 'installation_repositories', 'installation_target'].includes(event)) {
    return [];
  }
  const refs = new Set<string>();
  const installationId = numericId((payload.installation as Json | undefined)?.id);
  const repoId = numericId((payload.repository as Json | undefined)?.id);
  const orgId = numericId((payload.organization as Json | undefined)?.id) ||
    numericId(((payload.installation as Json | undefined)?.account as Json | undefined)?.id);

  if (installationId) {
    for (const row of store.all(`SELECT g.ref FROM github_installations g
      LEFT JOIN accounts a ON a.app_id=g.app_id AND a.type='github_app'
      WHERE g.github_host='github.com' AND g.installation_id=? AND (g.account_id=? OR a.id=?)`, installationId, accountId, accountId)) {
      refs.add(String(row.ref));
    }
  }
  if (!refs.size && orgId && ['organization', 'membership', 'team'].includes(event)) {
    for (const row of store.all(`SELECT g.ref FROM github_installations g
      LEFT JOIN accounts a ON a.app_id=g.app_id AND a.type='github_app'
      WHERE g.github_host='github.com' AND g.target_id=? AND (g.account_id=? OR a.id=?)`, orgId, accountId, accountId)) {
      refs.add(String(row.ref));
    }
  }

  if (event === 'member' || (event === 'team' && repoId)) {
    if (repoId) {
      if (refs.size) {
        for (const ref of refs) markRepositoryMemberCacheDirty(store, repoId, ref);
      } else {
        for (const ref of markRepositoryMemberCacheDirty(store, repoId)) refs.add(ref);
      }
    }
    return [...refs];
  }

  if (event === 'organization' || event === 'installation' || event === 'installation_target') {
    for (const ref of refs) markInstallationMemberCacheDirty(store, ref, event === 'organization' || event === 'installation');
    return [...refs];
  }

  if (event === 'membership' || event === 'team') {
    for (const ref of refs) markInstallationMemberCacheDirty(store, ref, true);
    return [...refs];
  }

  if (event === 'installation_repositories') {
    for (const ref of refs) {
      markInstallationMemberCacheDirty(store, ref, false);
      for (const added of Array.isArray(payload.repositories_added) ? payload.repositories_added : []) {
        const id = numericId((added as Json | undefined)?.id);
        if (id) markRepositoryMemberCacheDirty(store, id, ref);
      }
    }
  }
  return [...refs];
}

export async function ingest(
  store: Store,
  accountId: string,
  endpointId: string,
  headers: IncomingHttpHeaders,
  bytes: Buffer,
  complete: boolean,
  githubUrl?: string,
) {
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
  const owner = status === 200 && !isInstallationControlEvent(event)
    ? store.get('SELECT * FROM repositories WHERE id=? AND account_id=?', repoId, accountId) : undefined;
  const action = typeof payload?.action === 'string' ? payload.action.slice(0, 100) : '';
  const kind = event === 'issues' ? 'issue' : event;
  const route = kind + (action ? `.${action}` : '');
  const safeHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key,
    /authorization|cookie|token|secret|signature|key/i.test(key) ? '[REDACTED]' : value]));
  let currentPullRequest: Json | undefined;
  let botWakePreflight: BotWakePreflight | undefined;
  const freshDelivery = status === 200 && !!owner && !!payload
    && !store.get('SELECT 1 FROM processed_deliveries WHERE account_id=? AND endpoint_id=? AND delivery_id=?', accountId, endpointId, deliveryId);
  // A PR conversation comment (a mention or an update) is reviewed at the PR's current head, which the comment does not carry.
  if (freshDelivery && pullRequestNeeded(store, repoId, event, payload!)) {
    // Read before the synchronous archive transaction; actor lookup is unnecessary for this read-only request.
    const github = new GitHub(store, owner!, new Redactor(), async () => {}, githubUrl);
    await github.connect(false, { pull_requests: 'read' }, undefined, false);
    currentPullRequest = await github.object('review.pr', Number((payload!.issue as Json).number));
  }
  const wakePlan = freshDelivery ? botWakePreflightPlan(store, repoId, event, payload!) : null;
  if (wakePlan) {
    botWakePreflight = await collectBotWakePreflight(store, owner!, wakePlan, githubUrl, deliveryId);
  }
  const id = randomId();
  const appControl = isInstallationControlEvent(event) && store.get("SELECT 1 FROM accounts WHERE id=? AND type='github_app'", accountId);
  // An accepted body goes to its own file before the row that points to it is written (#1403); the write waits for the
  // disk off the event loop. A body the transaction below does not end up pointing to is removed again.
  const body: StoredBody | null = status === 200 && !appControl && bytes.length > inlineDeliveryBytes ? await writeDeliveryBody(store, owner?.id, id, bytes) : null;
  try { return store.transaction(() => {
    const duplicate = status === 200 && (!!store.get('SELECT 1 FROM processed_deliveries WHERE account_id=? AND endpoint_id=? AND delivery_id=?', accountId, endpointId, deliveryId)
      || isInstallationControlEvent(event) && !!store.get(`SELECT 1 FROM installation_events e JOIN github_installations g ON g.ref=e.installation_ref
        JOIN accounts a ON a.app_id=g.app_id WHERE a.id=? AND e.delivery_id=?`, accountId, deliveryId));
    const response = status === 200 ? { ok: true, record_id: id, duplicate, tasks_created: 0 }
      : { ok: false, error: outcome, record_id: id };
    // A refused request is archived as a bounded digest; only an accepted one keeps its body for replay and audit.
    const accepted = status === 200;
    if (!accepted) pruneRejectedArchive(store, Date.now());
    const archivedPayload = !accepted ? rejectionSummary(outcome, bytes, !complete)
      : appControl ? Buffer.from(JSON.stringify({ installation_evidence_archived: true, event, action })) : bytes;
    store.run(`INSERT INTO deliveries(id,account_id,endpoint_id,repository_id,delivery_id,event,route,status,duplicate,received_at,
      http_status,request_headers,payload,body_complete,response,payload_ref,payload_sha256,payload_bytes,payload_summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, endpoint ? accountId : null,
      endpoint ? endpointId : null, owner?.id || null, deliveryId, event, route, outcome, Number(duplicate), new Date().toISOString(),
      status, JSON.stringify(accepted ? safeHeaders : rejectionHeaders(headers)), body ? Buffer.alloc(0) : archivedPayload, Number(complete), JSON.stringify(response),
      body?.ref ?? null, body?.sha256 ?? null, body?.bytes ?? null, body ? deliverySummary(bytes) : null);
    if (status === 200 && !duplicate) store.run('INSERT INTO processed_deliveries VALUES(?,?,?)', accountId, endpointId, deliveryId);
    if (status === 200 && !duplicate && payload) boardWebhook(store, accountId, event, payload);
    if (status === 200 && !duplicate && payload && event === 'github_app_authorization' && action === 'revoked') {
      const id = String((payload.sender as Json)?.id || '');
      for (const identity of store.all("SELECT * FROM external_identities WHERE provider='github' AND external_actor=? AND status<>'revoked'", id)) {
        store.run("UPDATE external_identities SET status='revoked',credentials=NULL WHERE id=?", identity.id);
        store.run("UPDATE scoped_grants SET revoked_at=? WHERE principal_id=? AND source='github_derived'", Date.now(), identity.principal_id);
        store.run('DELETE FROM sessions WHERE identity_id=?', identity.id);
        invalidate(store, identity.principal_id, 'github.authorization_revoked');
      }
    }
    if (status === 200 && !duplicate && payload && (event === 'organization' && action === 'member_removed' || event === 'member' && action === 'removed')) {
      const subject = ((payload.membership as Json)?.user || payload.member || payload.user) as Json | undefined;
      for (const identity of store.all("SELECT * FROM external_identities WHERE provider='github' AND external_actor=? AND status='active'", String(subject?.id || ''))) {
        const before = activeScopes(store, identity.principal_id), now = Date.now();
        store.run("UPDATE scoped_grants SET expires_at=? WHERE principal_id=? AND source='github_derived' AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)", now, identity.principal_id, now);
        invalidateIfLost(store, identity.principal_id, before, 'github.membership_changed');
      }
    }
    const sync = status === 200 && !!payload && (appControl
      ? archiveInstallationEvent(store, accountId, endpointId, deliveryId, id, event, payload, bytes)
      : !duplicate && recordInstallationEvent(store, accountId, event, payload));
    const memberSync = status === 200 && !duplicate && payload ? markWebhookMemberCacheDirty(store, accountId, event, payload) : [];
    if (status === 200 && appControl) dropUninstalledIntegrations(store);
    if (status === 200 && !duplicate && event === 'installation' && ['deleted','suspend'].includes(action)) {
      const installation = payload?.installation as Json | undefined, account = installation?.account as Json | undefined;
      const ownerId = String(account?.id || '');
      store.run('UPDATE policies SET enabled=0 WHERE repository_id IN (SELECT id FROM repositories WHERE account_id=? AND owner_id=?)', accountId, ownerId);
    }
    if (status === 200 && !duplicate && event === 'installation_repositories' && Array.isArray(payload?.repositories_removed)) {
      for (const removed of payload.repositories_removed) if (removed && typeof removed === 'object')
        store.run('UPDATE policies SET enabled=0 WHERE repository_id IN (SELECT id FROM repositories WHERE account_id=? AND id=?)', accountId, String(removed.id || ''));
    }
    if (status === 200 && !duplicate && owner && payload) {
      actionsWebhook(store, String(owner.id), event, payload);
      recordCheckWebhook(store, String(owner.id), event, payload);
      if(['issues','pull_request'].includes(event)){
        store.run('DELETE FROM external_events WHERE received_at<=?',new Date(Date.now()-86400000).toISOString());
        // Cross-endpoint redeliveries must not restart the first delivery's 24-hour window.
        store.run(`INSERT OR IGNORE INTO external_events(source_id,repository_id,delivery_id,received_at)
          SELECT d.id,d.repository_id,d.delivery_id,d.received_at FROM deliveries d WHERE d.id=?
          AND NOT EXISTS(SELECT 1 FROM deliveries first WHERE first.repository_id=d.repository_id AND first.delivery_id=d.delivery_id
            AND first.status='accepted' AND first.rowid<d.rowid)`,id);
      }
      const policy=store.get('SELECT * FROM policies WHERE repository_id=?',String(owner.id)),pr=payload.pull_request as Json|undefined;
      // A disabled project archives everything, whatever its review switch says; the deliveries page says which one held it back.
      Object.assign(response,{review_outcome:pr?.draft===true?'draft':policy&&!policy.enabled?'project_disabled':!covers(projectCeiling(store,String(owner.id),policy),'comment')?'review_disabled':'not_trigger'});
      const subscriptionMatch = policy?.enabled
        ? matchWebhookSubscriptions(store, String(owner.id), event, payload, id)
        : { matched: [], tasksWoken: [] };
      if (subscriptionMatch.matched.length) {
        Object.assign(response, { subscriptions_matched: subscriptionMatch.matched.length, tasks_woken: subscriptionMatch.tasksWoken.length });
      }
      response.tasks_created = queueWebhook(store, String(owner.id), event, payload, id, currentPullRequest, botWakePreflight);
      if (
        policy?.enabled &&
        !subscriptionMatch.matched.length &&
        shouldFallbackWebhookToManager(store, String(owner.id), event, payload) &&
        !store.get("SELECT 1 FROM dispatch_events WHERE repository_id=? AND delivery_id=? AND state='pending' LIMIT 1", String(owner.id), id)
      ) {
        const fallbackQueued = queueSubscriptionFallbackEvent(store, String(owner.id), event, payload, id);
        if (fallbackQueued) Object.assign(response, { subscription_fallback_queued: fallbackQueued });
      }
      Object.assign(response, { forwards_created: enqueueForwards(store,String(owner.id),event,payload,id) });
      store.run('UPDATE deliveries SET response=? WHERE id=?', JSON.stringify(response), id);
    }
    let branchCleanup: { repositoryId: string; prNumber: number } | null = null;
    if (status === 200 && !duplicate && owner && payload && event === 'pull_request' && action === 'closed') {
      const pr = payload.pull_request as any;
      const prNumber = Number(pr?.number);
      const isMerged = pr?.merged === true || (typeof pr?.merged_at === 'string' && Number.isFinite(Date.parse(pr.merged_at)));
      if (isMerged && Number.isSafeInteger(prNumber) && prNumber >= 1 && store.hasTable('bot_pr_states')) {
        const st = store.get(
          'SELECT state,merged,branch_cleanup_status FROM bot_pr_states WHERE repository_id=? AND number=?',
          String(owner.id),
          prNumber,
        );
        if (st && String(st.state || '').toLowerCase() === 'closed' && Number(st.merged) === 1 && st.branch_cleanup_status === 'pending') {
          branchCleanup = { repositoryId: String(owner.id), prNumber };
        }
      }
    }
    return { status, response, sync, memberSync, branchCleanup };
  }); } catch (error) { if (body) try { removeDeliveryBody(store, body.ref); } catch {} throw error; }
}
