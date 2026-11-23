import type { Store } from '../storage/database.js';
import { digest, HttpError } from '../core/security.js';
import { resolvePrincipalActor, revision, type ActorContext } from '../identity/authorization.js';
import type { ManagementService } from '../management/service.js';
import type { ChannelServiceBindings } from '../channels/service-bindings.js';
import type { AssistantHomes, ComputerOwner, HomeFacts } from './assistant-computers.js';
import type { OwnTaskOwner } from './own-tasks.js';

export interface ServiceRoleMemoryMigrationResult {
  status: 'noop' | 'deferred' | 'migrated';
  migrated: number;
  skipped_stale: number;
  skipped_invalid: number;
  table_dropped: boolean;
}

const migrationSettingKey = 'migration:assistant-memory-files';

function memoryFilename(ownerScope: string, key: string): string {
  const slug = key.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'item';
  const suffix = digest(`${ownerScope}:${key}`).slice(0, 8);
  return `memory/migrated/${slug}-${suffix}.md`;
}

function formatMigratedMarkdown(key: string, content: string, updatedAt: unknown): string {
  const title = key.replace(/[\r\n]+/g, ' ').trim() || 'Migrated Memory';
  const timestamp = Number(updatedAt);
  const updatedIso = Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : 'unknown';
  return `# ${title}\n\n<!-- Migrated from legacy service_role_memory (updated_at: ${updatedIso}) -->\n\n${content}\n`;
}

/**
 * One-time startup migration for deployments upgrading from SQLite `service_role_memory` to file-based assistant
 * private memory under each owner's persistent `~/memory/` directory.
 *
 * Only entries whose live authorization fence still holds are written out; stale/revoked or corrupt rows are isolated
 * and skipped so revoked data is never resurrected into a fresh HOME. The legacy SQLite table is dropped only after
 * every active entry has been safely persisted (or when the table is already empty); if `assistant-homes` is not mounted
 * while rows remain, migration defers without dropping data.
 */
export async function migrateServiceRoleMemory(
  store: Store,
  management: ManagementService,
  serviceBindings: ChannelServiceBindings,
  homes?: AssistantHomes,
): Promise<ServiceRoleMemoryMigrationResult> {
  if (!store.hasTable('service_role_memory')) {
    return { status: 'noop', migrated: 0, skipped_stale: 0, skipped_invalid: 0, table_dropped: false };
  }
  const rows = store.all('SELECT owner, key, body, updated_at FROM service_role_memory ORDER BY updated_at ASC, owner ASC, key ASC');
  if (!rows.length) {
    store.transaction(() => {
      store.db.exec('DROP TABLE IF EXISTS service_role_memory');
      store.run(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        migrationSettingKey,
        JSON.stringify({ migrated: 0, skipped_stale: 0, skipped_invalid: 0, at: new Date().toISOString() }),
      );
    });
    return { status: 'migrated', migrated: 0, skipped_stale: 0, skipped_invalid: 0, table_dropped: true };
  }
  if (!homes) {
    console.warn(`[assistant-memory] deferred migration of ${rows.length} legacy service_role_memory row(s): assistant-homes volume is not mounted`);
    return { status: 'deferred', migrated: 0, skipped_stale: 0, skipped_invalid: 0, table_dropped: false };
  }

  let migrated = 0;
  let skippedStale = 0;
  let skippedInvalid = 0;
  const touchedOwners = new Set<string>();

  for (const row of rows) {
    const rawOwner = typeof row.owner === 'string' ? row.owner : '';
    const key = typeof row.key === 'string' ? row.key : '';
    if (!rawOwner || !key || typeof row.body !== 'string') {
      skippedInvalid++;
      continue;
    }
    let owner: OwnTaskOwner;
    try {
      owner = JSON.parse(rawOwner) as OwnTaskOwner;
    } catch {
      skippedInvalid++;
      continue;
    }
    if (!owner || typeof owner !== 'object' || typeof owner.kind !== 'string' || typeof owner.owner_id !== 'string' || typeof owner.principal_id !== 'string' || typeof owner.fence !== 'string') {
      skippedInvalid++;
      continue;
    }

    let content: string;
    try {
      const opened = store.secrets.open(row.body, 'service-memory:' + rawOwner + ':' + key);
      if (typeof opened?.content !== 'string') {
        skippedInvalid++;
        continue;
      }
      content = opened.content;
    } catch {
      skippedInvalid++;
      continue;
    }

    let computerOwner: ComputerOwner | null = null;
    let facts: HomeFacts | null = null;

    if (owner.kind === 'management') {
      const conversation = store.get('SELECT id, principal_id, tenant_id FROM management_conversations WHERE id=?', owner.owner_id);
      if (!conversation || conversation.principal_id !== owner.principal_id) {
        skippedStale++;
        continue;
      }
      const currentRevision = revision(store, owner.principal_id);
      if (!currentRevision || String(currentRevision) !== String(owner.fence)) {
        skippedStale++;
        continue;
      }
      const tenant = String(conversation.tenant_id ?? '');
      let actor: ActorContext;
      try {
        actor = resolvePrincipalActor(store, owner.principal_id, tenant || null, undefined, 'web');
      } catch {
        skippedStale++;
        continue;
      }
      const projects = management.projects(actor);
      const pendingRepositories = management.pendingRepositories(actor);
      const eligible = management.user(actor).role === 'super_admin'
        || pendingRepositories.length > 0
        || projects.some(project => {
          try { management.scope(actor, project, 'tasks.write'); return true; }
          catch (error) { if (error instanceof HttpError && error.status === 403) return false; throw error; }
        });
      if (!eligible) {
        skippedStale++;
        continue;
      }
      const repositories = [...new Set([...projects, ...pendingRepositories.map(r => r.id)])];
      computerOwner = { kind: 'person', subject: owner.principal_id, tenant };
      facts = { repositories };
    } else if (owner.kind === 'channel') {
      const chat = store.get('SELECT id, installation_tenant FROM channel_chats WHERE id=?', owner.owner_id);
      const binding = chat ? serviceBindings.get(chat.id) : undefined;
      if (!chat || !binding || !binding.enabled || binding.principal_id !== owner.principal_id || binding.service_role_id !== owner.service_role_id) {
        skippedStale++;
        continue;
      }
      try {
        serviceBindings.assertUsable(binding);
      } catch {
        skippedStale++;
        continue;
      }
      if (serviceBindings.fence(chat.id) !== owner.fence) {
        skippedStale++;
        continue;
      }
      const repositories = serviceBindings.reach(binding).projects.map(p => p.id);
      if (!repositories.length) {
        skippedStale++;
        continue;
      }
      computerOwner = { kind: 'group', subject: chat.id, tenant: String(chat.installation_tenant ?? '') };
      facts = { binding: binding.id, role: binding.service_role_id, repositories };
    } else {
      skippedInvalid++;
      continue;
    }

    const prepared = await homes.prepare(computerOwner, facts);
    const rel = memoryFilename(rawOwner, key);
    const markdown = formatMigratedMarkdown(key, content, row.updated_at);
    await homes.write(prepared.directory, rel, Buffer.from(markdown, 'utf8'));
    touchedOwners.add(prepared.id);
    migrated++;
  }

  for (const owner of touchedOwners) {
    await homes.measure(owner).catch(() => {});
  }

  store.transaction(() => {
    store.db.exec('DROP TABLE IF EXISTS service_role_memory');
    store.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      migrationSettingKey,
      JSON.stringify({ migrated, skipped_stale: skippedStale, skipped_invalid: skippedInvalid, at: new Date().toISOString() }),
    );
    store.audit('system', 'service_role_memory.migrated', `migrated:${migrated},stale:${skippedStale},invalid:${skippedInvalid}`);
  });

  return { status: 'migrated', migrated, skipped_stale: skippedStale, skipped_invalid: skippedInvalid, table_dropped: true };
}
