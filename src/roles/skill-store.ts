import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Store } from '../storage/database.js';
import { parseSkillDescription } from '../rules/service.js';

export const DEFAULT_SKILL_STORE_ROOT = '/skill-store';
export const CONTAINER_SKILLS_ROOT = '/opt/bot-skills';

export interface SkillStoreFile {
  path: string;
  content: string;
  sha256?: string;
  bytes?: number;
}

export interface MaterializedSkillEntry {
  name: string;
  slug: string;
  description: string;
  skillMdPath: string;
  containerPath: string;
  hostPath: string;
  supportFiles: string[];
}

export interface MaterializedSkillSet {
  setHash: string;
  scope: string;
  storeRoot: string;
  hostRoot: string;
  hostPluginDir: string;
  hostSkillsDir: string;
  containerRoot: string;
  containerPluginDir: string;
  containerSkillsDir: string;
  skills: MaterializedSkillEntry[];
}

export interface HarnessSkillSetConfig {
  set_hash: string;
  scope: string;
  plugin_dir: string;
  skills_dir: string;
  local_root?: string;
}

export const NATIVE_SKILL_HARNESSES = new Set(['pi', 'claude_code', 'codex', 'icode']);

const SCOPE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SET_HASH_PATTERN = /^[a-f0-9]{64}$/;
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const hashText = (value: string) => createHash('sha256').update(value).digest('hex');

function assertSafeRelativePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('skill_store_path_invalid');
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.includes('\\') || CONTROL_CHAR_PATTERN.test(trimmed)) {
    throw new Error('skill_store_path_invalid');
  }
  const parts = trimmed.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('skill_store_path_invalid');
  return parts.join('/');
}

function assertRealDirectoryOrMissing(dir: string): boolean {
  try {
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('skill_store_path_invalid');
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function ensureReadableDir(dir: string): void {
  if (!assertRealDirectoryOrMissing(dir)) {
    mkdirSync(dir, { mode: 0o755 });
  }
  chmodSync(dir, 0o755);
}

function ensureReadableTree(root: string, relativeParts: string[]): string {
  const base = resolve(root);
  ensureReadableDir(base);
  let current = base;
  for (const part of relativeParts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\')) {
      throw new Error('skill_store_path_invalid');
    }
    current = join(current, part);
    ensureReadableDir(current);
  }
  return current;
}

export function resolveSkillStoreRoot(store?: Pick<Store, 'skillStoreDir' | 'path'>, explicitRoot?: string): string | null {
  if (explicitRoot && explicitRoot.trim()) return resolve(explicitRoot.trim());
  const fromEnv = process.env.BOT_SKILL_STORE_DIR?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (store?.skillStoreDir) return resolve(store.skillStoreDir);
  if (existsSync(DEFAULT_SKILL_STORE_ROOT)) return DEFAULT_SKILL_STORE_ROOT;
  return null;
}

export function projectSkillScope(repositoryId: string): string {
  if (typeof repositoryId !== 'string' || !SCOPE_ID_PATTERN.test(repositoryId)) {
    throw new Error('skill_store_scope_invalid');
  }
  return `projects/${repositoryId}`;
}

export function serviceSkillScope(): string {
  return 'service';
}

export function ensureProjectSkillScope(root: string, repositoryId: string): string {
  const scope = projectSkillScope(repositoryId);
  const parts = scope.split('/');
  const scopeDir = ensureReadableTree(root, parts);
  ensureReadableDir(join(scopeDir, 'sets'));
  return scopeDir;
}

export function ensureServiceSkillScope(root: string): string {
  const scopeDir = ensureReadableTree(root, ['service']);
  ensureReadableDir(join(scopeDir, 'sets'));
  return scopeDir;
}

function sanitizeSlug(raw: string, fallback = 'skill'): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .slice(0, 64);
  if (cleaned && /^[a-z0-9]/.test(cleaned)) return cleaned;
  return fallback;
}

function parseFrontmatter(content: string): { hasFrontmatter: boolean; front: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match) return { hasFrontmatter: false, front: '', body: content };
  return { hasFrontmatter: true, front: match[1] ?? '', body: match[2] ?? '' };
}

function frontmatterField(front: string, key: string): string {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(front);
  if (!match) return '';
  return (match[1] ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
}

function yamlScalar(value: string): string {
  const cleaned = value.replace(/[\r\n]+/g, ' ').trim();
  if (!cleaned) return '""';
  if (/^[A-Za-z0-9._/-]+$/.test(cleaned) && !/^(?:true|false|null|yes|no|on|off|~)$/i.test(cleaned)) {
    return cleaned;
  }
  return JSON.stringify(cleaned);
}

function deriveDescription(body: string, fallbackName: string): string {
  const parsed = parseSkillDescription(body);
  if (parsed) return parsed.slice(0, 240);
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^#+\s*/, '').trim();
    if (line && !line.startsWith('```') && !line.startsWith('---')) return line.slice(0, 240);
  }
  return `Pinned working guidance for ${fallbackName}.`;
}

export function normalizeSkillMarkdown(content: string, slug: string): { content: string; name: string; description: string } {
  const { hasFrontmatter, front, body } = parseFrontmatter(content);
  const existingName = hasFrontmatter ? frontmatterField(front, 'name') : '';
  const existingDesc = hasFrontmatter ? frontmatterField(front, 'description') : '';
  const name = existingName || slug;
  const description = existingDesc || deriveDescription(body, name);
  if (hasFrontmatter && existingName && existingDesc) {
    return { content, name, description };
  }
  if (hasFrontmatter) {
    const extra: string[] = [];
    if (!existingName) extra.push(`name: ${yamlScalar(name)}`);
    if (!existingDesc) extra.push(`description: ${yamlScalar(description)}`);
    const mergedFront = front.trimEnd() ? `${front.trimEnd()}\n${extra.join('\n')}` : extra.join('\n');
    return { content: `---\n${mergedFront}\n---\n${body}`, name, description };
  }
  const normalizedBody = body.replace(/^\r?\n+/, '');
  return {
    content: `---\nname: ${yamlScalar(name)}\ndescription: ${yamlScalar(description)}\n---\n\n${normalizedBody}`,
    name,
    description,
  };
}

type OriginLayer = 'defaults' | 'repository' | 'project' | 'direct';
const LAYER_PRIORITY: Record<OriginLayer, number> = { defaults: 1, repository: 2, project: 3, direct: 3 };

interface ClassifiedFile {
  layer: OriginLayer;
  rel: string;
  content: string;
}

interface FlattenedSkill {
  slug: string;
  name: string;
  description: string;
  priority: number;
  files: Map<string, string>; // relative path inside bot/skills/<slug>/ -> content
}

function classifyFile(file: SkillStoreFile): ClassifiedFile {
  if (typeof file.content !== 'string' || file.content.includes('\0')) {
    throw new Error('skill_store_content_invalid');
  }
  const normalized = assertSafeRelativePath(file.path);
  if (normalized.startsWith('defaults/')) return { layer: 'defaults', rel: normalized.slice('defaults/'.length), content: file.content };
  if (normalized.startsWith('repository/')) return { layer: 'repository', rel: normalized.slice('repository/'.length), content: file.content };
  if (normalized.startsWith('.agents/skills/')) return { layer: 'repository', rel: normalized.slice('.agents/skills/'.length), content: file.content };
  if (normalized.startsWith('project/')) return { layer: 'project', rel: normalized.slice('project/'.length), content: file.content };
  return { layer: 'direct', rel: normalized, content: file.content };
}

function extractLayerSkills(layer: OriginLayer, items: ClassifiedFile[]): FlattenedSkill[] {
  if (!items.length) return [];
  const priority = LAYER_PRIORITY[layer];
  const byRel = new Map<string, string>();
  for (const item of items) byRel.set(item.rel, item.content);

  const skillEntries = [...byRel.keys()]
    .filter(rel => rel === 'SKILL.md' || rel.endsWith('/SKILL.md'))
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));

  const claimed = new Set<string>();
  const usedSlugs = new Set<string>();
  const allocateSlug = (preferred: string, disambiguator: string): string => {
    const base = sanitizeSlug(preferred, layer === 'defaults' ? 'default-skill' : 'project');
    if (!usedSlugs.has(base)) {
      usedSlugs.add(base);
      return base;
    }
    const suffixed = sanitizeSlug(`${base}-${hashText(disambiguator).slice(0, 6)}`, base);
    usedSlugs.add(suffixed);
    return suffixed;
  };

  const out: FlattenedSkill[] = [];
  // Claim nested <dir>/SKILL.md directories first (deepest first), then root SKILL.md if present.
  const nestedEntries = skillEntries.filter(rel => rel !== 'SKILL.md');
  for (const entryPath of nestedEntries) {
    const dir = entryPath.slice(0, -'/SKILL.md'.length);
    const leaf = dir.split('/').at(-1) || dir;
    const rawSkillMd = byRel.get(entryPath)!;
    const slug = allocateSlug(leaf, dir);
    const normalizedMd = normalizeSkillMarkdown(rawSkillMd, slug);
    const skillFiles = new Map<string, string>();
    skillFiles.set('SKILL.md', normalizedMd.content);
    claimed.add(entryPath);
    const prefix = dir + '/';
    for (const [rel, content] of byRel) {
      if (claimed.has(rel) || !rel.startsWith(prefix)) continue;
      skillFiles.set(rel.slice(prefix.length), content);
      claimed.add(rel);
    }
    out.push({ slug, name: normalizedMd.name, description: normalizedMd.description, priority, files: skillFiles });
  }

  if (byRel.has('SKILL.md')) {
    const rawSkillMd = byRel.get('SKILL.md')!;
    const { hasFrontmatter, front } = parseFrontmatter(rawSkillMd);
    const declared = hasFrontmatter ? frontmatterField(front, 'name') : '';
    const slug = allocateSlug(declared || 'project', `${layer}:root`);
    const normalizedMd = normalizeSkillMarkdown(rawSkillMd, slug);
    const skillFiles = new Map<string, string>();
    skillFiles.set('SKILL.md', normalizedMd.content);
    claimed.add('SKILL.md');
    for (const [rel, content] of byRel) {
      if (claimed.has(rel)) continue;
      skillFiles.set(rel, content);
      claimed.add(rel);
    }
    out.push({ slug, name: normalizedMd.name, description: normalizedMd.description, priority, files: skillFiles });
  }

  const unclaimed = [...byRel.entries()].filter(([rel]) => !claimed.has(rel)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (unclaimed.length) {
    const slug = allocateSlug(layer === 'defaults' ? 'defaults' : 'project', `${layer}:legacy`);
    const fileList = unclaimed.map(([rel]) => `- \`${rel}\``).join('\n');
    const synthesized = normalizeSkillMarkdown(
      `---\nname: ${yamlScalar(slug)}\ndescription: Supplemental project working material pinned for this role.\n---\n\n# ${slug}\n\nPinned working material files in this skill directory:\n${fileList}\n`,
      slug,
    );
    const skillFiles = new Map<string, string>([['SKILL.md', synthesized.content]]);
    for (const [rel, content] of unclaimed) skillFiles.set(rel, content);
    out.push({ slug, name: synthesized.name, description: synthesized.description, priority, files: skillFiles });
  }

  return out;
}

function isExecutableSkillFile(relInsideSkill: string, content: string): boolean {
  return relInsideSkill.startsWith('scripts/') || content.startsWith('#!');
}

const CLAUDE_PLUGIN_MANIFEST = JSON.stringify({
  name: 'bot',
  version: '1.0.0',
  description: 'Launchpad pinned role skills',
}, null, 2) + '\n';

export function materializeSkillSet(options: {
  root: string;
  scope: string;
  files: SkillStoreFile[];
}): MaterializedSkillSet | null {
  const { root, scope, files } = options;
  if (!files.length) return null;
  const scopeParts = assertSafeRelativePath(scope).split('/');
  if (scopeParts[0] === 'projects') {
    if (scopeParts.length !== 2 || !SCOPE_ID_PATTERN.test(scopeParts[1] ?? '')) throw new Error('skill_store_scope_invalid');
  } else if (scope !== 'service') {
    throw new Error('skill_store_scope_invalid');
  }

  const byLayer = new Map<OriginLayer, ClassifiedFile[]>();
  for (const file of files) {
    const classified = classifyFile(file);
    const bucket = byLayer.get(classified.layer) ?? [];
    bucket.push(classified);
    byLayer.set(classified.layer, bucket);
  }

  // Merge in ascending precedence order so project/direct overrides repository overrides defaults on slug collision.
  const merged = new Map<string, FlattenedSkill>();
  for (const layer of ['defaults', 'repository', 'project', 'direct'] as OriginLayer[]) {
    for (const skill of extractLayerSkills(layer, byLayer.get(layer) ?? [])) {
      const existing = merged.get(skill.slug);
      if (!existing || skill.priority >= existing.priority) {
        merged.set(skill.slug, skill);
      }
    }
  }
  if (!merged.size) return null;

  const sortedSkills = [...merged.values()].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const payload: { relPath: string; content: string; mode: number }[] = [
    { relPath: 'bot/.claude-plugin/plugin.json', content: CLAUDE_PLUGIN_MANIFEST, mode: 0o644 },
  ];
  for (const skill of sortedSkills) {
    const sortedEntries = [...skill.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [relInsideSkill, content] of sortedEntries) {
      const safeInside = assertSafeRelativePath(relInsideSkill);
      payload.push({
        relPath: `bot/skills/${skill.slug}/${safeInside}`,
        content,
        mode: isExecutableSkillFile(safeInside, content) ? 0o755 : 0o644,
      });
    }
  }
  payload.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const setHash = hashText(JSON.stringify(payload.map(entry => [entry.relPath, entry.mode, hashText(entry.content)])));
  const storeRoot = resolve(root);
  const scopeDir = ensureReadableTree(storeRoot, scopeParts);
  const setsDir = join(scopeDir, 'sets');
  ensureReadableDir(setsDir);
  const finalDir = join(setsDir, setHash);

  if (assertRealDirectoryOrMissing(finalDir)) {
    const now = new Date();
    try { utimesSync(finalDir, now, now); } catch {}
  } else {
    const tmpDir = join(setsDir, `.tmp-${randomBytes(8).toString('hex')}`);
    mkdirSync(tmpDir, { mode: 0o755 });
    chmodSync(tmpDir, 0o755);
    try {
      for (const entry of payload) {
        const dest = join(tmpDir, entry.relPath);
        const relDirs = dirname(entry.relPath).split('/').filter(Boolean);
        let dirCursor = tmpDir;
        for (const segment of relDirs) {
          dirCursor = join(dirCursor, segment);
          ensureReadableDir(dirCursor);
        }
        writeFileSync(dest, entry.content, { encoding: 'utf8', mode: entry.mode });
        chmodSync(dest, entry.mode);
      }
      chmodSync(tmpDir, 0o755);
      try {
        renameSync(tmpDir, finalDir);
      } catch (error: any) {
        if (['EEXIST', 'ENOTEMPTY', 'EACCES', 'EPERM'].includes(error?.code) && assertRealDirectoryOrMissing(finalDir)) {
          rmSync(tmpDir, { recursive: true, force: true });
        } else {
          throw error;
        }
      }
    } catch (error) {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
      throw error;
    }
  }

  const containerRoot = `${CONTAINER_SKILLS_ROOT}/sets/${setHash}`;
  const containerPluginDir = `${containerRoot}/bot`;
  const containerSkillsDir = `${containerPluginDir}/skills`;
  const hostPluginDir = join(finalDir, 'bot');
  const hostSkillsDir = join(hostPluginDir, 'skills');

  const skills: MaterializedSkillEntry[] = sortedSkills.map(skill => ({
    name: skill.name,
    slug: skill.slug,
    description: skill.description,
    skillMdPath: `bot/skills/${skill.slug}/SKILL.md`,
    containerPath: `${containerSkillsDir}/${skill.slug}/SKILL.md`,
    hostPath: join(hostSkillsDir, skill.slug, 'SKILL.md'),
    supportFiles: [...skill.files.keys()].filter(rel => rel !== 'SKILL.md').sort(),
  }));

  return {
    setHash,
    scope,
    storeRoot,
    hostRoot: finalDir,
    hostPluginDir,
    hostSkillsDir,
    containerRoot,
    containerPluginDir,
    containerSkillsDir,
    skills,
  };
}

export function toHarnessSkillSetConfig(
  set: MaterializedSkillSet | null | undefined,
  includeLocalRoot = false,
): HarnessSkillSetConfig | undefined {
  if (!set) return undefined;
  return {
    set_hash: set.setHash,
    scope: set.scope,
    plugin_dir: set.containerPluginDir,
    skills_dir: set.containerSkillsDir,
    ...(includeLocalRoot ? { local_root: set.storeRoot } : {}),
  };
}

export function removeProjectSkillStore(root: string, repositoryId: string): void {
  const scope = projectSkillScope(repositoryId);
  const base = resolve(root);
  if (!assertRealDirectoryOrMissing(base)) return;
  const projectsDir = join(base, 'projects');
  if (!assertRealDirectoryOrMissing(projectsDir)) return;
  const target = join(base, scope);
  try {
    const info = lstatSync(target);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('skill_store_path_invalid');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  rmSync(target, { recursive: true, force: true });
}

function measureDirectoryBytes(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) total += measureDirectoryBytes(full);
    else if (entry.isFile()) {
      try { total += statSync(full).size; } catch {}
    }
  }
  return total;
}

export function pruneUnusedSkillSets(
  store: Store,
  options: { root?: string | null; now?: number; graceMs?: number; tmpMaxAgeMs?: number } = {},
): { count: number; bytes: number; failed: number } {
  const root = options.root === undefined ? resolveSkillStoreRoot(store) : options.root;
  const result = { count: 0, bytes: 0, failed: 0 };
  if (!root) return result;
  const base = resolve(root);
  if (!existsSync(base)) return result;
  // Fail closed if root exists but is unreadable or not a real directory.
  const rootInfo = lstatSync(base);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('skill_store_path_invalid');
  readdirSync(base);

  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? 24 * 3600_000;
  const tmpMaxAgeMs = options.tmpMaxAgeMs ?? 3600_000;

  const activeHashes = new Set<string>();
  if (store.hasTable('task_runs')) {
    for (const row of store.all("SELECT run_context FROM task_runs WHERE status='running' AND run_context IS NOT NULL")) {
      try {
        const ctx = JSON.parse(String(row.run_context));
        if (typeof ctx?.skill_set_hash === 'string' && SET_HASH_PATTERN.test(ctx.skill_set_hash)) {
          activeHashes.add(ctx.skill_set_hash);
        }
      } catch {}
    }
  }
  const liveRepos = new Set(
    store.hasTable('repositories')
      ? store.all('SELECT id FROM repositories').map(row => String(row.id))
      : [],
  );

  const pruneSetsDir = (setsDir: string): { remainingLive: number } => {
    let remainingLive = 0;
    if (!existsSync(setsDir)) return { remainingLive };
    const info = lstatSync(setsDir);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      result.failed++;
      return { remainingLive: 1 };
    }
    for (const entry of readdirSync(setsDir, { withFileTypes: true })) {
      const full = join(setsDir, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        remainingLive++;
        continue;
      }
      const stat = lstatSync(full);
      const ageMs = now - stat.mtimeMs;
      if (entry.name.startsWith('.tmp-')) {
        if (ageMs >= tmpMaxAgeMs) {
          try {
            const bytes = measureDirectoryBytes(full);
            rmSync(full, { recursive: true, force: true });
            result.count++;
            result.bytes += bytes;
          } catch {
            result.failed++;
            remainingLive++;
          }
        } else {
          remainingLive++;
        }
        continue;
      }
      if (!SET_HASH_PATTERN.test(entry.name)) {
        remainingLive++;
        continue;
      }
      if (activeHashes.has(entry.name) || ageMs < graceMs) {
        remainingLive++;
        continue;
      }
      try {
        const bytes = measureDirectoryBytes(full);
        rmSync(full, { recursive: true, force: true });
        result.count++;
        result.bytes += bytes;
      } catch {
        result.failed++;
        remainingLive++;
      }
    }
    return { remainingLive };
  };

  const serviceSets = join(base, 'service', 'sets');
  if (existsSync(serviceSets)) {
    try { pruneSetsDir(serviceSets); } catch { result.failed++; }
  }

  const projectsDir = join(base, 'projects');
  if (existsSync(projectsDir)) {
    const pInfo = lstatSync(projectsDir);
    if (pInfo.isSymbolicLink() || !pInfo.isDirectory()) throw new Error('skill_store_path_invalid');
    for (const entry of readdirSync(projectsDir, { withFileTypes: true })) {
      const repoDir = join(projectsDir, entry.name);
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      try {
        const { remainingLive } = pruneSetsDir(join(repoDir, 'sets'));
        if (!liveRepos.has(entry.name) && remainingLive === 0) {
          const stat = lstatSync(repoDir);
          if (now - stat.mtimeMs >= graceMs) {
            const bytes = measureDirectoryBytes(repoDir);
            rmSync(repoDir, { recursive: true, force: true });
            result.count++;
            result.bytes += bytes;
          }
        }
      } catch {
        result.failed++;
      }
    }
  }

  return result;
}

/**
 * Returns false when a live project computer has explicitly reported `skills_mounted: false`
 * (for example during a rolling upgrade before idle container rotation mounts `/opt/bot-skills`),
 * so callers keep `read_skill` offered instead of silently dropping skills.
 */
export function projectSkillMountReady(store: Store, repositoryId: string): boolean {
  if (!store.hasTable('computer_console_specs')) return true;
  const row = store.get('SELECT spec FROM computer_console_specs WHERE repository_id=?', repositoryId);
  if (!row?.spec) return true;
  try {
    const parsed = JSON.parse(String(row.spec));
    return parsed?.skills_mounted !== false;
  } catch {
    return true;
  }
}
