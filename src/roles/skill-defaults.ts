import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import type { RoleSnapshot } from './definition.js';
import { parseSkillDescription, skillEntryPath, skillFilePath } from '../rules/service.js';
import type { SkillFileEncoding } from './skill-library.js';

type Bundle = NonNullable<RoleSnapshot['skills']>;
export type ComposedSkillFile = {
  path: string;
  sha256: string;
  bytes: number;
  content: string;
  encoding?: SkillFileEncoding;
  executable?: boolean;
};
export interface BoundRoleBundle {
  bundle: Bundle;
  files: ComposedSkillFile[];
  persisted: boolean;
}

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Extracts validated `.agents/skills/<name>/**` text files belonging to directories that declare a `SKILL.md`. */
export function extractRepositorySkillFiles(files: Record<string, string>): ComposedSkillFile[] {
  const roots = Object.keys(files).filter(skillEntryPath);
  if (!roots.length) return [];
  const dirs = roots.map(path => path.slice(0, -'/SKILL.md'.length));
  return Object.entries(files)
    .filter(([path, content]) => skillFilePath(path) && typeof content === 'string' && !content.includes('\0') && dirs.some(dir => path.startsWith(dir + '/')))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, content]) => ({ path, content, sha256: hash(content), bytes: Buffer.byteLength(content) }));
}

export interface PinnedRepositorySkills {
  id: string;
  revision: number;
  content_hash: string;
  sha: string | null;
}

/** Pins a task's trusted base-branch `.agents/skills/` files in `skill_bundle_revisions` without bloating `tasks.input`. */
export function pinRepositorySkillEntries(s: Store, repositoryId: string, sha: string | null, files: Record<string, string>, persist = true): PinnedRepositorySkills | null {
  const extracted = extractRepositorySkillFiles(files);
  if (!extracted.length) return null;
  const listing = extracted.map(({ content: _c, encoding: _e, executable: _x, ...file }) => file);
  const source = { type: 'repository_auto', path_root: '.agents/skills', commit: sha };
  const content_hash = hash(JSON.stringify({ path_root: '.agents/skills', files: listing })), id = '@repository-skills';
  const pin = () => {
    const existing = s.get('SELECT revision FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND content_hash=? ORDER BY revision DESC LIMIT 1', repositoryId, id, content_hash);
    if (existing) return Number(existing.revision);
    const revision = Number(s.get('SELECT max(revision) revision FROM skill_bundle_revisions WHERE repository_id=? AND id=?', repositoryId, id)?.revision ?? 0) + 1;
    if (persist) s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', repositoryId, id, revision, JSON.stringify(source), JSON.stringify(extracted), content_hash, new Date().toISOString());
    return revision;
  };
  const revision = persist ? s.transaction(pin) : pin();
  return { id, revision, content_hash, sha };
}

/** Resolves a skill file by exact bundle path, `.agents/skills/...` path, or unambiguous relative path. */
export function resolveSkillBundleFile<T extends { path: string }>(files: T[], rawPath: unknown): T | undefined {
  if (typeof rawPath !== 'string') return undefined;
  const trimmed = rawPath.trim().replace(/^(?:\.\/)+/, '');
  if (!trimmed || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('\\') || trimmed.includes('\0')) return undefined;
  if (trimmed.split('/').some(part => !part || part === '.' || part === '..')) return undefined;
  const exact = files.find(f => f.path === trimmed);
  if (exact) return exact;
  const stripped = trimmed.startsWith('.agents/skills/') ? trimmed.slice('.agents/skills/'.length) : trimmed;
  for (const prefix of ['project/', 'repository/', 'defaults/', '.agents/skills/']) {
    const prefixed = files.find(f => f.path === prefix + stripped);
    if (prefixed) return prefixed;
  }
  const suffixed = files.filter(f => f.path.endsWith('/' + stripped));
  return suffixed.length === 1 ? suffixed[0] : undefined;
}

export function skillSummariesFromFiles(files: { path: string; content: string; encoding?: SkillFileEncoding }[]) {
  return files
    .filter(file => file.encoding !== 'base64' && (file.path === 'SKILL.md' || file.path.endsWith('/SKILL.md')))
    .map(file => {
      const dir = file.path === 'SKILL.md' ? '' : file.path.slice(0, -'/SKILL.md'.length);
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(file.content)?.[1] ?? '';
      const declaredName = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^['"]|['"]$/g, '');
      const fallbackName = dir ? dir.replace(/^(?:repository|project|defaults|\.agents\/skills)\//, '') : 'project';
      const support = files
        .filter(other => other.path !== file.path && (dir ? other.path.startsWith(dir + '/') : !other.path.endsWith('/SKILL.md')))
        .map(other => dir ? other.path.slice(dir.length + 1) : other.path)
        .sort();
      return {
        name: declaredName || fallbackName,
        description: parseSkillDescription(file.content),
        path: file.path,
        ...(support.length ? { support_files: support } : {}),
      };
    });
}

/**
 * Flattens bound role skill bundles (built-in and project) plus optional trusted base-branch `.agents/skills/`
 * into one deterministic file list using layer prefixes (`defaults/`, `repository/`, `project/`) so `skill-store`
 * applies deterministic precedence (`defaults < repository < project`) without dropping support files.
 */
export function composeRoleSkillFiles(
  boundBundles: readonly BoundRoleBundle[],
  autoRepositoryFiles: readonly ComposedSkillFile[] = [],
): ComposedSkillFile[] {
  const byPath = new Map<string, ComposedSkillFile>();
  // Emit lower-priority layers first so explicit higher-priority paths win if a duplicate path ever arises.
  const builtinEntries = boundBundles.filter(b => b.bundle.source?.origin === 'builtin');
  const projectEntries = boundBundles.filter(b => b.bundle.source?.origin !== 'builtin');

  for (const entry of builtinEntries) {
    for (const file of entry.files) {
      const rel = file.path.replace(/^defaults\//, '');
      const path = `defaults/${rel}`;
      if (!byPath.has(path)) byPath.set(path, { ...file, path });
    }
  }
  for (const file of autoRepositoryFiles) {
    const path = file.path.startsWith('repository/') ? file.path : `repository/${file.path.replace(/^\.agents\/skills\//, '')}`;
    byPath.set(path, { ...file, path });
  }
  for (const entry of projectEntries) {
    const repoRoot = entry.bundle.source?.type === 'repository' ? '.agents/skills/' : '';
    for (const file of entry.files) {
      const stripped = repoRoot && file.path.startsWith(repoRoot) ? file.path.slice(repoRoot.length) : file.path.replace(/^project\//, '');
      const path = `project/${stripped}`;
      byPath.set(path, { ...file, path });
    }
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Composes one role's effective skill bundle from its explicit `skill_bundle_refs` (built-in and project) and,
 * for non-evaluator roles, auto-overlaid trusted base-branch `.agents/skills/`. Supplemental working material only;
 * never a role permission or task contract change.
 */
export function roleSkills(
  s: Store,
  repositoryId: string,
  role: { id: string; kind: string },
  boundBundles: readonly BoundRoleBundle[],
  persist: boolean,
  repositorySource?: { sha: string | null; files: Record<string, string> } | null,
): Bundle | null {
  const autoEligible = role.kind !== 'evaluator';
  const autoFiles = autoEligible && repositorySource
    ? extractRepositorySkillFiles(repositorySource.files).map(file => ({ ...file, path: 'repository/' + file.path.slice('.agents/skills/'.length) }))
    : [];
  if (!boundBundles.length && !autoFiles.length) return null;

  // Single already-persisted custom project bundle with no repository auto-overlay: keep its direct bundle reference.
  if (boundBundles.length === 1 && !autoFiles.length && boundBundles[0]!.persisted && boundBundles[0]!.bundle.source?.origin !== 'builtin') {
    return boundBundles[0]!.bundle;
  }

  const files = composeRoleSkillFiles(boundBundles, autoFiles);
  if (!files.length) return null;
  const listing = files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  const source = {
    type: 'role_skills',
    role: role.id,
    bundles: boundBundles.map(({ bundle }) => ({
      id: bundle.id,
      revision: bundle.revision,
      content_hash: bundle.content_hash,
      origin: bundle.source?.origin === 'builtin' ? 'builtin' : 'project',
      source: bundle.source,
    })),
    ...(autoFiles.length ? { repository: { commit: repositorySource?.sha ?? null, path_prefix: 'repository/', source_path_root: '.agents/skills/' } } : {}),
  };
  const content_hash = hash(JSON.stringify({ source, files: listing })), id = '@role-skills/' + role.id;
  const pin = () => {
    const existing = s.get('SELECT revision FROM skill_bundle_revisions WHERE repository_id=? AND id=? AND content_hash=? ORDER BY revision DESC LIMIT 1', repositoryId, id, content_hash);
    if (existing) return Number(existing.revision);
    const revision = Number(s.get('SELECT max(revision) revision FROM skill_bundle_revisions WHERE repository_id=? AND id=?', repositoryId, id)?.revision ?? 0) + 1;
    if (persist) s.run('INSERT INTO skill_bundle_revisions VALUES(?,?,?,?,?,?,?)', repositoryId, id, revision, JSON.stringify(source), JSON.stringify(files), content_hash, new Date().toISOString());
    return revision;
  };
  const revision = persist ? s.transaction(pin) : pin();
  return { id, revision, content_hash, source, files: listing };
}
