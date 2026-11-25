import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import {
  buildDefaultProjectBundles,
  defaultProjectRoleBundleIds,
} from './builtin-bundles.js';
import {
  deriveSkillSlug,
  parseStrictSkillFrontmatter,
  projectSkillId,
  validateSkillFiles,
  type SkillFileInput,
} from './skill-library.js';

const MIGRATION_MARKER = 'migration:1359:skill-bundles-v3';
const MIGRATION_ACTOR = 'migration:1359';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const short = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 16);
const nowIso = () => new Date().toISOString();

function yamlScalar(value: string): string {
  return JSON.stringify(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim());
}

function allocateProjectSkillSlug(store: Store, origin: 'console' | 'repository', repositoryId: string, baseSlug: string): string {
  let candidate = deriveSkillSlug(baseSlug);
  let suffix = 1;
  while (store.get('SELECT 1 FROM skills WHERE id=?', projectSkillId(origin, repositoryId, candidate))) {
    const tag = `-m${suffix++}`;
    candidate = `${deriveSkillSlug(baseSlug).slice(0, Math.max(1, 64 - tag.length))}${tag}`;
  }
  return candidate;
}

function insertMigratedSkill(
  store: Store,
  params: {
    origin: 'console' | 'repository';
    repositoryId: string;
    baseSlug: string;
    sourcePath: string | null;
    sourceMeta: Record<string, unknown>;
    rawFiles: SkillFileInput[];
    bundleId: string;
  },
): { skill_id: string; version: number; slug: string; origin: 'console' | 'repository'; content_hash: string; files: ReturnType<typeof validateSkillFiles>['files']; needsReview: boolean } | null {
  const { origin, repositoryId, baseSlug, sourcePath, sourceMeta, rawFiles, bundleId } = params;
  if (!rawFiles.length) return null;
  const slug = allocateProjectSkillSlug(store, origin, repositoryId, baseSlug);
  let filesToValidate: SkillFileInput[] = rawFiles.map(f => ({ ...f }));
  let needsReview = false;

  const entryIndex = filesToValidate.findIndex(f => f.path === 'SKILL.md');
  if (entryIndex >= 0) {
    try {
      parseStrictSkillFrontmatter(filesToValidate[entryIndex]!.content, 'SKILL.md');
    } catch {
      const original = filesToValidate[entryIndex]!.content;
      const body = original.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
      filesToValidate[entryIndex] = {
        ...filesToValidate[entryIndex]!,
        content: `---\nname: ${yamlScalar(slug)}\ndescription: ${yamlScalar(`Migrated from legacy bundle ${bundleId}; review recommended.`)}\n---\n\n${body || `# ${slug}`}\n`,
      };
      needsReview = true;
    }
  } else {
    const fileList = filesToValidate.map(f => `- \`${f.path}\``).join('\n');
    filesToValidate = [
      {
        path: 'SKILL.md',
        content: `---\nname: ${yamlScalar(slug)}\ndescription: ${yamlScalar(`Migrated from legacy bundle ${bundleId}; review recommended.`)}\n---\n\n# ${slug}\n\nMigrated working material files:\n${fileList}\n`,
      },
      ...filesToValidate,
    ];
    needsReview = true;
  }

  let validated: ReturnType<typeof validateSkillFiles>;
  try {
    validated = validateSkillFiles(filesToValidate, { field: `migration:${bundleId}` });
  } catch {
    // Isolate any malformed legacy bundle rather than aborting startup for other projects.
    return null;
  }

  const id = projectSkillId(origin, repositoryId, slug);
  const now = nowIso();
  const meta = { ...sourceMeta, ...(needsReview ? { needs_review: true } : {}) };
  store.run(
    `INSERT INTO skills(id,scope_kind,repository_id,slug,origin,name,description,latest_version,source_path,created_at,updated_at,created_by,updated_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, 'project', repositoryId, slug, origin, validated.name, validated.description, 1, sourcePath, now, now, MIGRATION_ACTOR, MIGRATION_ACTOR,
  );
  store.run(
    `INSERT INTO skill_versions(skill_id,version,name,description,content_hash,files,file_count,total_bytes,source_meta,created_at,created_by)
     VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
    id, 1, validated.name, validated.description, validated.content_hash, JSON.stringify(validated.files),
    validated.file_count, validated.total_bytes, JSON.stringify(meta), now, MIGRATION_ACTOR,
  );
  return { skill_id: id, version: 1, slug, origin, content_hash: validated.content_hash, files: validated.files, needsReview };
}

function persistBundleRevision(
  store: Store,
  repositoryId: string,
  bundleId: string,
  source: Record<string, unknown>,
  files: { path: string; sha256: string; bytes: number; content: string; encoding?: 'utf8' | 'base64'; executable?: boolean }[],
): { id: string; revision: number; content_hash: string; source: Record<string, unknown>; files: { path: string; sha256: string; bytes: number }[] } {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const listing = sorted.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes }));
  const content_hash = sha256(JSON.stringify({ source, files: listing }));
  const existing = store.get(
    'SELECT revision FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND content_hash=? ORDER BY revision DESC LIMIT 1',
    repositoryId, bundleId, content_hash,
  );
  if (existing) {
    return { id: bundleId, revision: Number(existing.revision), content_hash, source, files: listing };
  }
  const revision = Number(store.get('SELECT max(revision) revision FROM skill_bundle_revisions WHERE repository_id=? AND id=?', repositoryId, bundleId)?.revision ?? 0) + 1;
  store.run(
    'INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)',
    repositoryId, bundleId, revision, JSON.stringify(source), JSON.stringify(sorted), content_hash, nowIso(),
  );
  return { id: bundleId, revision, content_hash, source, files: listing };
}

/**
 * One-shot startup migration (#1359):
 * - Leaves `follows_default` projects untouched so they automatically adopt the new built-in default bundles.
 * - Preserves historical `role_snapshots` and `task_execution_configs` read-only.
 * - For customized saved V2 projects, records the pre-migration config in `role_config_revisions` if needed,
 *   migrates legacy `inline` / `repository` bundles into versioned project `skills` / `skill_versions` + `library`
 *   bundles (marking synthesized frontmatter with `migrated_needs_review`), pins the built-in bundles (`planning`,
 *   `ci-gates`, `dev-practices`) and backfills multi-bundle `skill_bundle_refs[]` for built-in roles without
 *   creating slug conflicts against existing custom bundles.
 */
export function migrateSkillsToLibraryV3(store: Store): void {
  if (store.get('SELECT 1 FROM settings WHERE key=?', MIGRATION_MARKER)) return;
  if (!store.hasTable('skills') || !store.hasTable('role_config_revisions')) return;

  store.transaction(() => {
    if (store.get('SELECT 1 FROM settings WHERE key=?', MIGRATION_MARKER)) return;
    const defaultBundles = buildDefaultProjectBundles(store);
    const defaultBundleById = new Map(defaultBundles.map(b => [b.id, b]));

    for (const row of store.all("SELECT key,value FROM settings WHERE key LIKE 'roles:%'")) {
      let stored: any;
      try { stored = JSON.parse(String(row.value)); } catch { continue; }
      if (stored?.schema !== 2 || !Array.isArray(stored.roles)) continue;

      const repositoryId = String(row.key).slice('roles:'.length);
      const currentRevision = Number(stored.revision ?? 0);
      const now = nowIso();

      // Preserve the pre-migration configuration in history before minting a new revision.
      if (currentRevision > 0 && !store.get('SELECT 1 FROM role_config_revisions WHERE repository_id=? AND revision=?', repositoryId, currentRevision)) {
        const { updated_at: _u, updated_by: _b, ...body } = stored;
        store.run(
          'INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          repositoryId, currentRevision, JSON.stringify(stored), short(body), String(stored.updated_by ?? MIGRATION_ACTOR), String(stored.updated_at ?? now),
        );
      }

      const nextBundles: any[] = [];
      const bundleById = new Map<string, any>();

      for (const bundle of Array.isArray(stored.skills) ? stored.skills : []) {
        if (!bundle || typeof bundle.id !== 'string') continue;
        if (bundle.source?.type === 'library') {
          nextBundles.push(bundle);
          bundleById.set(bundle.id, bundle);
          continue;
        }
        const revRow = store.get(
          'SELECT source,files FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND revision=?',
          repositoryId, bundle.id, Number(bundle.revision ?? 0),
        );
        if (!revRow) {
          nextBundles.push(bundle);
          bundleById.set(bundle.id, bundle);
          continue;
        }
        let revFiles: any[] = [];
        try { revFiles = JSON.parse(String(revRow.files ?? '[]')); } catch { revFiles = []; }
        const revSource = (() => { try { return JSON.parse(String(revRow.source ?? '{}')); } catch { return {}; } })();

        if (bundle.source?.type === 'inline' || bundle.source?.type === 'builtin') {
          const rawFiles: SkillFileInput[] = revFiles
            .filter(f => typeof f?.path === 'string' && typeof f?.content === 'string')
            .map(f => ({ path: String(f.path), content: String(f.content) }));
          const migrated = insertMigratedSkill(store, {
            origin: 'console',
            repositoryId,
            baseSlug: bundle.id,
            sourcePath: null,
            sourceMeta: { origin: 'console', migrated_from: bundle.source.type, original_bundle_id: bundle.id },
            rawFiles,
            bundleId: bundle.id,
          });
          if (migrated) {
            const libSource = {
              type: 'library',
              origin: 'project',
              ...(migrated.needsReview ? { migrated_needs_review: true } : {}),
              items: [{
                skill_id: migrated.skill_id,
                version: migrated.version,
                slug: migrated.slug,
                origin: migrated.origin,
                content_hash: migrated.content_hash,
              }],
            };
            const prefixedFiles = migrated.files.map(f => ({ ...f, path: `${migrated.slug}/${f.path}` }));
            const savedBundle = {
              ...persistBundleRevision(store, repositoryId, bundle.id, libSource, prefixedFiles),
              origin: 'project' as const,
            };
            nextBundles.push(savedBundle);
            bundleById.set(bundle.id, savedBundle);
            continue;
          }
        } else if (bundle.source?.type === 'repository') {
          // Group pinned `.agents/skills/<dir>/...` files by skill directory; fall back to bundle id if loose.
          const byDir = new Map<string, SkillFileInput[]>();
          const skillDirs = revFiles
            .filter(f => typeof f?.path === 'string' && (f.path.endsWith('/SKILL.md') || f.path === 'SKILL.md'))
            .map(f => String(f.path).replace(/\/?SKILL\.md$/, ''))
            .sort((a, b) => b.length - a.length);
          for (const file of revFiles) {
            if (typeof file?.path !== 'string' || typeof file?.content !== 'string') continue;
            const dir = skillDirs.find(d => d ? file.path.startsWith(d + '/') : true) ?? '';
            const rel = dir ? file.path.slice(dir.length + 1) : file.path.replace(/^\.agents\/skills\//, '');
            const list = byDir.get(dir) ?? [];
            list.push({ path: rel, content: String(file.content) });
            byDir.set(dir, list);
          }
          const items: any[] = [];
          const prefixedFiles: any[] = [];
          let anyNeedsReview = false;
          for (const [dir, dirFiles] of byDir) {
            const migrated = insertMigratedSkill(store, {
              origin: 'repository',
              repositoryId,
              baseSlug: dir || bundle.id,
              sourcePath: dir || null,
              sourceMeta: {
                commit: revSource.commit ?? bundle.source?.commit ?? null,
                ...(dir ? { path: dir } : {}),
                migrated_from: 'repository_bundle',
                original_bundle_id: bundle.id,
              },
              rawFiles: dirFiles,
              bundleId: bundle.id,
            });
            if (!migrated) continue;
            if (migrated.needsReview) anyNeedsReview = true;
            items.push({
              skill_id: migrated.skill_id,
              version: migrated.version,
              slug: migrated.slug,
              origin: migrated.origin,
              content_hash: migrated.content_hash,
            });
            for (const f of migrated.files) prefixedFiles.push({ ...f, path: `${migrated.slug}/${f.path}` });
          }
          if (items.length) {
            const libSource = {
              type: 'library',
              origin: 'project',
              ...(anyNeedsReview ? { migrated_needs_review: true } : {}),
              items,
            };
            const savedBundle = {
              ...persistBundleRevision(store, repositoryId, bundle.id, libSource, prefixedFiles),
              origin: 'project' as const,
            };
            nextBundles.push(savedBundle);
            bundleById.set(bundle.id, savedBundle);
            continue;
          }
        }
        nextBundles.push(bundle);
        bundleById.set(bundle.id, bundle);
      }

      // Add built-in default bundles pinned to current built-in versions unless a custom bundle already took that ID.
      for (const built of defaultBundles) {
        if (bundleById.has(built.id)) continue;
        const persisted = persistBundleRevision(store, repositoryId, built.id, built.source, built.fullFiles);
        const entry = { ...persisted, name: built.name, origin: 'builtin' as const };
        nextBundles.push(entry);
        bundleById.set(built.id, entry);
      }

      // Convert each role's single `skill_bundle_ref` into `skill_bundle_refs[]` and backfill explicit built-in defaults.
      const nextRoles = stored.roles.map((role: any) => {
        if (!role || typeof role.role_id !== 'string') return role;
        const existingRaw: any[] = Array.isArray(role.skill_bundle_refs)
          ? role.skill_bundle_refs
          : role.skill_bundle_ref ? [role.skill_bundle_ref] : [];
        const refs: { id: string; revision: number; content_hash: string }[] = [];
        const seenIds = new Set<string>();
        const usedSlugs = new Map<string, string>(); // slug -> skill_id@version

        const tryAdd = (bundleId: string) => {
          if (seenIds.has(bundleId)) return;
          const b = bundleById.get(bundleId);
          if (!b) return;
          if (b.source?.type === 'library' && Array.isArray(b.source.items)) {
            for (const item of b.source.items) {
              const key = `${item.skill_id}@${item.version}`;
              const prior = usedSlugs.get(item.slug);
              if (prior && prior !== key) return; // Skip conflicting built-in backfill; keep custom bundle intact.
            }
            for (const item of b.source.items) {
              usedSlugs.set(item.slug, `${item.skill_id}@${item.version}`);
            }
          }
          seenIds.add(bundleId);
          refs.push({ id: b.id, revision: b.revision, content_hash: b.content_hash });
        };

        for (const r of existingRaw) {
          if (typeof r?.id === 'string') tryAdd(r.id);
        }
        for (const defaultId of defaultProjectRoleBundleIds(role.role_id)) {
          const candidate = bundleById.get(defaultId);
          if (candidate && defaultBundleById.has(defaultId) && candidate.source?.origin === 'builtin') {
            tryAdd(defaultId);
          }
        }
        return {
          ...role,
          skill_bundle_ref: refs[0] ?? null,
          skill_bundle_refs: refs,
        };
      });

      const { updated_at: _oldAt, updated_by: _oldBy, ...rest } = stored;
      const nextConfig = {
        ...rest,
        revision: currentRevision + 1,
        roles: nextRoles,
        skills: nextBundles,
      };
      const saved = { ...nextConfig, updated_at: now, updated_by: MIGRATION_ACTOR };
      store.run(
        'INSERT INTO role_config_revisions VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
        repositoryId, saved.revision, JSON.stringify(saved), short(nextConfig), MIGRATION_ACTOR, now,
      );
      store.run('UPDATE settings SET value=? WHERE key=?', JSON.stringify(saved), row.key);
      store.audit(MIGRATION_ACTOR, 'roles.skills_migrated', String(saved.revision), repositoryId);
    }

    store.run('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO NOTHING', MIGRATION_MARKER, nowIso());
  });
}
