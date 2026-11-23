import { configuredRedactor } from '../core/redaction.js';
import type { Store, Row } from '../storage/database.js';

export interface NotesManagerLike {
  call: (method: string, path: string, body?: any) => Promise<any>;
}

export interface LegacyMigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  items: { memory_id: string; repository_id: string; status: string; note_path: string | null }[];
}

const MIGRATION_DIR = 'migrated-memories';
const MIGRATION_ACTOR = 'migration:legacy-project-memory';
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

export function memoryMigrationStorage(store: Store): void {
  store.db.exec(`CREATE TABLE IF NOT EXISTS project_memory_migrations(
    memory_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL,
    note_path TEXT,
    status TEXT NOT NULL,
    migrated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_memory_migrations_repo ON project_memory_migrations(repository_id);`);
}

function sanitizeStem(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[/\\]/g, '-')
    .replace(CONTROL_CHARS, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120);
  if (!cleaned || ['.', '..', '.git'].includes(cleaned.toLowerCase()) || /^\.(?:write|expired)-/.test(cleaned)) {
    return 'memory';
  }
  return cleaned;
}

function formatMigratedMarkdown(row: Row, data: Record<string, any>, redact: (text: string) => string): string {
  const title = redact(String(data.catalog?.title || row.fact_key || row.id).replace(CONTROL_CHARS, ' ').trim());
  const key = redact(String(row.fact_key || row.id));
  const kind = typeof data.kind === 'string' ? data.kind : 'experience';
  const status = typeof data.status === 'string' ? data.status : 'active';
  const updatedAt = typeof row.updated_at === 'string' && row.updated_at ? row.updated_at : new Date().toISOString();
  const body = redact(String(data.body));
  const meta: string[] = [
    `- Key: \`${key}\``,
    `- Kind: ${kind}`,
    `- Status: ${status}`,
    `- Updated: ${updatedAt}`,
  ];
  const moduleName = data.catalog?.module ?? data.scope?.module;
  if (typeof moduleName === 'string' && moduleName.trim()) meta.push(`- Module: ${redact(moduleName.trim())}`);
  const tags = Array.isArray(data.catalog?.tags) ? data.catalog.tags.filter((t: unknown) => typeof t === 'string' && t.trim()) : [];
  if (tags.length) meta.push(`- Tags: ${tags.map((t: string) => redact(t.trim())).join(', ')}`);
  return `<!-- legacy-project-memory: ${String(row.id)} -->\n# ${title}\n\n${meta.join('\n')}\n\n${body}\n`;
}

function isConflictError(error: unknown): boolean {
  const code = String((error as any)?.code ?? (error as any)?.message ?? '');
  return (error as any)?.status === 409 && code === 'note_path_conflict';
}

/**
 * Safely and idempotently migrates active non-repository rows from legacy SQLite `project_memories`
 * into physical Markdown files under `../notes/migrated-memories/`.
 * Never overwrites existing files and isolates corrupt rows so one bad entry cannot block others.
 */
export async function migrateLegacyProjectMemories(
  store: Store,
  manager: NotesManagerLike | undefined,
  repositoryId?: string,
): Promise<LegacyMigrationResult> {
  const result: LegacyMigrationResult = { migrated: 0, skipped: 0, failed: 0, items: [] };
  if (!manager || !store.hasTable('project_memories')) return result;
  memoryMigrationStorage(store);

  const sql = repositoryId
    ? `SELECT m.id, m.repository_id, m.fact_key, m.revision, m.data, m.updated_at
       FROM project_memories m
       JOIN repositories r ON r.id = m.repository_id
       WHERE m.repository_id = ?
         AND NOT EXISTS (SELECT 1 FROM project_memory_migrations g WHERE g.memory_id = m.id)
       ORDER BY m.fact_key, m.id`
    : `SELECT m.id, m.repository_id, m.fact_key, m.revision, m.data, m.updated_at
       FROM project_memories m
       JOIN repositories r ON r.id = m.repository_id
       WHERE NOT EXISTS (SELECT 1 FROM project_memory_migrations g WHERE g.memory_id = m.id)
       ORDER BY m.repository_id, m.fact_key, m.id`;
  const rows = repositoryId ? store.all(sql, repositoryId) : store.all(sql);
  if (!rows.length) return result;

  const redactor = configuredRedactor(store);
  const ensuredDirs = new Set<string>();
  const record = (memoryId: string, repoId: string, notePath: string | null, status: string) => {
    store.run(
      'INSERT OR IGNORE INTO project_memory_migrations(memory_id, repository_id, note_path, status, migrated_at) VALUES(?,?,?,?,?)',
      memoryId, repoId, notePath, status, new Date().toISOString(),
    );
    result.items.push({ memory_id: memoryId, repository_id: repoId, status, note_path: notePath });
  };

  for (const row of rows) {
    const memoryId = String(row.id), repoId = String(row.repository_id);
    let data: Record<string, any> | null = null;
    try {
      const parsed = JSON.parse(String(row.data ?? 'null'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch { /* corrupt JSON isolated below */ }

    if (!data) {
      record(memoryId, repoId, null, 'skipped_corrupt');
      result.skipped++;
      continue;
    }
    if (data.authority === 'repository') {
      record(memoryId, repoId, null, 'skipped_repository');
      result.skipped++;
      continue;
    }
    if (['archived', 'revoked'].includes(String(data.status ?? ''))) {
      record(memoryId, repoId, null, 'skipped_inactive');
      result.skipped++;
      continue;
    }
    if (typeof data.body !== 'string' || !data.body.trim()) {
      record(memoryId, repoId, null, 'skipped_empty');
      result.skipped++;
      continue;
    }

    const marker = `<!-- legacy-project-memory: ${memoryId} -->`;
    const content = formatMigratedMarkdown(row, data, value => redactor.text(value));
    const stem = sanitizeStem(data.catalog?.title || row.fact_key || memoryId);
    const idPrefix = memoryId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 8) || 'legacy';

    try {
      if (!ensuredDirs.has(repoId)) {
        try {
          await manager.call('POST', `/v1/projects/${repoId}/file-tree/directories`, { path: MIGRATION_DIR });
        } catch (error) {
          if (!isConflictError(error)) throw error;
        }
        ensuredDirs.add(repoId);
      }

      let migratedPath: string | null = null;
      for (let attempt = 1; attempt <= 20; attempt++) {
        const suffix = attempt === 1 ? '' : `-${attempt}`;
        const candidate = `${MIGRATION_DIR}/${stem}--${idPrefix}${suffix}.md`;
        try {
          await manager.call('POST', `/v1/projects/${repoId}/file-tree`, {
            path: candidate,
            content,
            actor: MIGRATION_ACTOR,
            create_parents: true,
          });
          migratedPath = candidate;
          break;
        } catch (error) {
          if (!isConflictError(error)) throw error;
          // Check whether this exact path already contains this migrated entry (idempotent replay after crash).
          const listed = await manager.call('GET', `/v1/projects/${repoId}/file-tree?` + new URLSearchParams({
            directory: MIGRATION_DIR,
            query: '',
            include_deleted: '0',
            deleted_only: '0',
          }));
          const existing = Array.isArray(listed?.files) ? listed.files.find((f: any) => f.path === candidate) : null;
          if (existing?.id) {
            const read = await manager.call('GET', `/v1/projects/${repoId}/file-tree/${encodeURIComponent(existing.id)}`);
            if (typeof read?.content === 'string' && read.content.startsWith(marker)) {
              migratedPath = candidate;
              break;
            }
          }
          // Otherwise another file owns this path; try next non-colliding suffix without overwriting it.
        }
      }

      if (!migratedPath) {
        result.failed++;
        continue;
      }
      record(memoryId, repoId, migratedPath, 'migrated');
      store.audit('system', 'memory.migrated', migratedPath, repoId);
      result.migrated++;
    } catch {
      // Transient manager error: do not mark migrated so a later run retries cleanly.
      result.failed++;
    }
  }

  return result;
}
