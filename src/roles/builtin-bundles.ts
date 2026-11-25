import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Store } from '../storage/database.js';
import { builtinSkillsRootPath, readBuiltinSkillDirectory } from './builtin-skills.js';
import {
  builtinSkillId,
  classifySkillBlob,
  getSkillVersion,
  SKILL_SLUG_PATTERN,
  validateSkillFiles,
  type SkillFileEncoding,
  type SkillOrigin,
} from './skill-library.js';

export type ServiceChannelKind = 'web' | 'feishu';

export interface BuiltinBundleSpec {
  id: string;
  name: string;
  description: string;
  skills: string[];
  default_roles: string[];
  service_roles: string[];
  channels?: ServiceChannelKind[];
}

export interface BuiltinBundleUpgradeItem {
  skill_id: string;
  slug: string;
  name: string;
  pinned_version: number;
  latest_version: number;
}

export interface BuiltinBundleUpgradeNotice {
  bundle_id: string;
  upgrades: BuiltinBundleUpgradeItem[];
}

export interface ResolvedBuiltinBundle {
  id: string;
  name: string;
  origin: 'builtin';
  revision: number;
  content_hash: string;
  source: {
    type: 'library';
    origin: 'builtin';
    builtin_id: string;
    items: { skill_id: string; version: number; slug: string; origin: SkillOrigin; content_hash: string }[];
  };
  files: { path: string; sha256: string; bytes: number }[];
  fullFiles: { path: string; sha256: string; bytes: number; content: string; encoding?: SkillFileEncoding; executable?: boolean }[];
}

const BUNDLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
const ALLOWED_CHANNELS = new Set<ServiceChannelKind>(['web', 'feishu']);
const DEFAULT_MANIFEST_PATH = fileURLToPath(new URL('../../skills/bundles.json', import.meta.url));
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

let cachedDefaultBundles: BuiltinBundleSpec[] | null = null;
let cachedDefaultFileSnapshot: Map<string, ResolvedBuiltinBundle> | null = null;

function parseManifest(raw: string, pathLabel: string): BuiltinBundleSpec[] {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${pathLabel}: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || parsed.schema !== 1 || !Array.isArray(parsed.bundles)) {
    throw new Error(`Invalid bundles manifest schema in ${pathLabel}`);
  }
  const seen = new Set<string>();
  const out: BuiltinBundleSpec[] = [];
  for (const entry of parsed.bundles) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Invalid bundle entry in ${pathLabel}`);
    }
    const id = typeof entry.id === 'string' ? entry.id.trim() : '';
    if (!BUNDLE_ID_PATTERN.test(id) || seen.has(id)) {
      throw new Error(`Invalid or duplicate bundle id "${id}" in ${pathLabel}`);
    }
    seen.add(id);
    const name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : id;
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    if (!Array.isArray(entry.skills) || !entry.skills.length) {
      throw new Error(`Bundle "${id}" must list at least one skill in ${pathLabel}`);
    }
    const skills: string[] = [];
    for (const slug of entry.skills) {
      if (typeof slug !== 'string' || !SKILL_SLUG_PATTERN.test(slug)) {
        throw new Error(`Invalid skill slug "${String(slug)}" in bundle "${id}"`);
      }
      if (!skills.includes(slug)) skills.push(slug);
    }
    const defaultRoles: string[] = Array.isArray(entry.default_roles)
      ? (entry.default_roles as unknown[]).filter((r): r is string => typeof r === 'string' && BUNDLE_ID_PATTERN.test(r))
      : [];
    const serviceRoles: string[] = Array.isArray(entry.service_roles)
      ? (entry.service_roles as unknown[]).filter((r): r is string => typeof r === 'string' && BUNDLE_ID_PATTERN.test(r))
      : [];
    let channels: ServiceChannelKind[] | undefined;
    if (entry.channels !== undefined) {
      if (!Array.isArray(entry.channels) || entry.channels.some((c: unknown) => !ALLOWED_CHANNELS.has(c as ServiceChannelKind))) {
        throw new Error(`Invalid channels in bundle "${id}"`);
      }
      channels = [...new Set(entry.channels as ServiceChannelKind[])];
    }
    out.push({
      id,
      name,
      description,
      skills,
      default_roles: [...new Set(defaultRoles)],
      service_roles: [...new Set(serviceRoles)],
      ...(channels ? { channels } : {}),
    });
  }
  return out;
}

/**
 * Loads the built-in skill bundles declaration from `skills/bundles.json` (honoring `BOT_SKILLS_DIR` or explicit root,
 * falling back to the packaged `skills/bundles.json` when an override directory only overrides skill files).
 */
export function loadBuiltinBundles(root?: string | URL): BuiltinBundleSpec[] {
  const useDefaultCache = root === undefined && !process.env.BOT_SKILLS_DIR?.trim();
  if (useDefaultCache && cachedDefaultBundles) return cachedDefaultBundles;
  const rootDir = builtinSkillsRootPath(root);
  const candidate = join(rootDir, 'bundles.json');
  const manifestPath = existsSync(candidate) ? candidate : DEFAULT_MANIFEST_PATH;
  const bundles = parseManifest(readFileSync(manifestPath, 'utf8'), manifestPath);
  if (useDefaultCache) cachedDefaultBundles = bundles;
  return bundles;
}

/** Built-in bundles offered to project roles (`planning`, `ci-gates`, `dev-practices`). */
export function projectBuiltinBundles(root?: string | URL): BuiltinBundleSpec[] {
  return loadBuiltinBundles(root).filter(b => !b.channels?.length);
}

/** Built-in bundles offered to service roles (management assistant & Feishu group assistants). */
export function serviceBuiltinBundles(root?: string | URL): BuiltinBundleSpec[] {
  return loadBuiltinBundles(root);
}

/** Default built-in bundle IDs bound to one project role (`follows_default` and new default configs). */
export function defaultProjectRoleBundleIds(roleId: string, root?: string | URL): string[] {
  return projectBuiltinBundles(root)
    .filter(bundle => bundle.default_roles.includes(roleId))
    .map(bundle => bundle.id);
}

/** Default built-in bundle IDs bound to one service role (`management-assistant` or `group-assistant`). */
export function defaultServiceRoleBundleIds(serviceRoleId: string, root?: string | URL): string[] {
  return loadBuiltinBundles(root)
    .filter(bundle => bundle.service_roles.includes(serviceRoleId))
    .map(bundle => bundle.id);
}

/** Filters a list of built-in bundle IDs by runtime channel capability (e.g. drops `feishu-cards` on `web` turns). */
export function filterBundlesForChannel(bundleIds: readonly string[], channel: ServiceChannelKind, root?: string | URL): BuiltinBundleSpec[] {
  const byId = new Map(loadBuiltinBundles(root).map(b => [b.id, b]));
  const result: BuiltinBundleSpec[] = [];
  const seen = new Set<string>();
  for (const id of bundleIds) {
    if (seen.has(id)) continue;
    const spec = byId.get(id);
    if (!spec) continue;
    if (spec.channels?.length && !spec.channels.includes(channel)) continue;
    seen.add(id);
    result.push(spec);
  }
  return result;
}

function buildBundleFromDisk(bundle: BuiltinBundleSpec, root?: string | URL): ResolvedBuiltinBundle {
  const items: ResolvedBuiltinBundle['source']['items'] = [];
  const fullFiles: ResolvedBuiltinBundle['fullFiles'] = [];
  for (const slug of bundle.skills) {
    const rawEntries = readBuiltinSkillDirectory(slug, root);
    const inputs = rawEntries.map(entry => classifySkillBlob(entry.path, entry.data, entry.executable));
    const validated = validateSkillFiles(inputs, { field: `builtin:${slug}` });
    items.push({
      skill_id: builtinSkillId(slug),
      version: 1,
      slug,
      origin: 'builtin',
      content_hash: validated.content_hash,
    });
    for (const file of validated.files) {
      fullFiles.push({
        path: `${slug}/${file.path}`,
        sha256: file.sha256,
        bytes: file.bytes,
        content: file.content,
        ...(file.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
        ...(file.executable ? { executable: true } : {}),
      });
    }
  }
  fullFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = fullFiles.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes }));
  const source: ResolvedBuiltinBundle['source'] = { type: 'library', origin: 'builtin', builtin_id: bundle.id, items };
  const content_hash = sha256(JSON.stringify({ source, files }));
  return { id: bundle.id, name: bundle.name, origin: 'builtin', revision: 1, content_hash, source, files, fullFiles };
}

/**
 * Resolves one built-in bundle against the latest registered `builtin:<slug>` versions in `store`
 * (or against packaged disk `skills/` when `store` is omitted, producing the identical hash for fresh v1 installs).
 */
export function resolveBuiltinBundle(store: Store | undefined, bundle: BuiltinBundleSpec, root?: string | URL): ResolvedBuiltinBundle {
  if (!store) {
    const useCache = root === undefined && !process.env.BOT_SKILLS_DIR?.trim();
    if (useCache) {
      cachedDefaultFileSnapshot ??= new Map();
      const hit = cachedDefaultFileSnapshot.get(bundle.id);
      if (hit) return hit;
      const built = buildBundleFromDisk(bundle);
      cachedDefaultFileSnapshot.set(bundle.id, built);
      return built;
    }
    return buildBundleFromDisk(bundle, root);
  }

  const items: ResolvedBuiltinBundle['source']['items'] = [];
  const fullFiles: ResolvedBuiltinBundle['fullFiles'] = [];
  for (const slug of bundle.skills) {
    const id = builtinSkillId(slug);
    const row = store.get("SELECT latest_version FROM skills WHERE id=? AND scope_kind='builtin'", id);
    if (!row) {
      // Fallback to disk if called on an uninitialized test fixture or partial override directory.
      const disk = buildBundleFromDisk({ ...bundle, skills: [slug] }, root);
      items.push(...disk.source.items);
      fullFiles.push(...disk.fullFiles);
      continue;
    }
    const latest = Number(row.latest_version);
    const resolved = getSkillVersion(store, '__builtin__', id, latest);
    items.push({
      skill_id: id,
      version: latest,
      slug,
      origin: 'builtin',
      content_hash: resolved.version.content_hash,
    });
    for (const file of resolved.version.files) {
      fullFiles.push({
        path: `${slug}/${file.path}`,
        sha256: file.sha256,
        bytes: file.bytes,
        content: file.content,
        ...(file.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
        ...(file.executable ? { executable: true } : {}),
      });
    }
  }
  fullFiles.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files = fullFiles.map(({ path, sha256: digest, bytes }) => ({ path, sha256: digest, bytes }));
  const source: ResolvedBuiltinBundle['source'] = { type: 'library', origin: 'builtin', builtin_id: bundle.id, items };
  const content_hash = sha256(JSON.stringify({ source, files }));
  return { id: bundle.id, name: bundle.name, origin: 'builtin', revision: 1, content_hash, source, files, fullFiles };
}

/** Builds all built-in project bundles pinned to the latest built-in skill versions. */
export function buildDefaultProjectBundles(store?: Store, root?: string | URL): ResolvedBuiltinBundle[] {
  return projectBuiltinBundles(root).map(bundle => resolveBuiltinBundle(store, bundle, root));
}

/**
 * Inspects saved project skill bundles and reports any pinned `builtin:<slug>@vN` item whose library skill
 * now has a newer `latest_version > N` so the console can prompt a one-click upgrade (Decision 3).
 */
export function detectBuiltinBundleUpgrades(
  store: Store,
  bundles: readonly { id: string; source: any }[],
): BuiltinBundleUpgradeNotice[] {
  if (!bundles.length || !store.hasTable('skills')) return [];
  const latestMap = new Map<string, { version: number; slug: string; name: string }>();
  for (const row of store.all("SELECT id,slug,name,latest_version FROM skills WHERE scope_kind='builtin'")) {
    latestMap.set(String(row.id), { version: Number(row.latest_version), slug: String(row.slug), name: String(row.name) });
  }
  const notices: BuiltinBundleUpgradeNotice[] = [];
  for (const bundle of bundles) {
    if (bundle.source?.type !== 'library' || !Array.isArray(bundle.source.items)) continue;
    const upgrades: BuiltinBundleUpgradeItem[] = [];
    for (const item of bundle.source.items) {
      if (typeof item?.skill_id !== 'string' || !item.skill_id.startsWith('builtin:')) continue;
      const latest = latestMap.get(item.skill_id);
      const pinnedVersion = Number(item.version ?? 0);
      if (latest && latest.version > pinnedVersion) {
        upgrades.push({
          skill_id: item.skill_id,
          slug: latest.slug,
          name: latest.name,
          pinned_version: pinnedVersion,
          latest_version: latest.version,
        });
      }
    }
    if (upgrades.length) notices.push({ bundle_id: bundle.id, upgrades });
  }
  return notices;
}

/** Classifies a project skill bundle as unmodified built-in, modified built-in, or custom project bundle. */
export function classifyProjectBundle(bundle: { id: string; source: any }, root?: string | URL): 'builtin' | 'builtin_modified' | 'project' {
  const declared = projectBuiltinBundles(root).find(b => b.id === bundle.id);
  if (!declared) return 'project';
  if (bundle.source?.type !== 'library' || !Array.isArray(bundle.source.items)) return 'builtin_modified';
  const expectedIds = declared.skills.map(s => builtinSkillId(s)).sort();
  const actualIds = bundle.source.items
    .map((item: any) => String(item?.skill_id ?? ''))
    .filter(Boolean)
    .sort();
  return JSON.stringify(expectedIds) === JSON.stringify(actualIds) ? 'builtin' : 'builtin_modified';
}
