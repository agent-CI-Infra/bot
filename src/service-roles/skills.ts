import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import { fail, type Json } from '../core/security.js';
import {
  defaultServiceRoleBundleIds,
  filterBundlesForChannel,
  loadBuiltinBundles,
  resolveBuiltinBundle,
  serviceBuiltinBundles,
  type ServiceChannelKind,
} from '../roles/builtin-bundles.js';
import type { SkillStoreFile } from '../roles/skill-store.js';

export const readSkillName = 'read_skill';

export interface ResolvedServiceSkillMeta {
  slug: string;
  skill_id: string;
  version: number;
  name: string;
  description: string;
  bundle_id: string;
}

export interface ResolvedServiceSkills {
  bundleIds: string[];
  skills: ResolvedServiceSkillMeta[];
  files: SkillStoreFile[];
  revisions: string[];
}

export interface ServiceSkillBundleCatalogItem {
  id: string;
  name: string;
  description: string;
  skills: string[];
  channels: ServiceChannelKind[] | null;
}

/** Parses nullable JSON column `skill_bundle_ids` (`null` means follow built-in defaults from `skills/bundles.json`). */
export function parseStoredServiceSkillBundles(raw: unknown): string[] | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (Array.isArray(raw)) return raw.filter((id): id is string => typeof id === 'string');
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

/** Validates admin-submitted `skill_bundle_ids` (`null` restores defaults; otherwise deduplicated known built-in bundle IDs). */
export function validateServiceSkillBundleIds(input: unknown, field = 'skill_bundle_ids'): string[] | null {
  if (input === null) return null;
  if (!Array.isArray(input) || input.length > 16) fail(400, 'invalid_skill_bundles', field);
  const validIds = new Set(loadBuiltinBundles().map(b => b.id));
  const out: string[] = [];
  for (let i = 0; i < (input as unknown[]).length; i++) {
    const item = (input as unknown[])[i];
    if (typeof item !== 'string' || !validIds.has(item)) fail(400, 'skill_bundle_not_found', `${field}[${i}]`);
    if (!out.includes(item as string)) out.push(item as string);
  }
  return out;
}

/** Built-in skill bundle catalog exposed to management assistant and Feishu group binding settings. */
export function serviceSkillBundleCatalog(): ServiceSkillBundleCatalogItem[] {
  return serviceBuiltinBundles().map(b => ({
    id: b.id,
    name: b.name,
    description: b.description,
    skills: b.skills,
    channels: b.channels ?? null,
  }));
}

/**
 * Resolves the active skill set for a service role (`management-assistant` or `group-assistant`) on a given channel.
 * - `configuredBundleIds === null` follows `skills/bundles.json` default bindings for that role.
 * - Bundles restricted to specific channels (e.g. `feishu-cards` -> `['feishu']`) are filtered out automatically on `web` turns.
 */
export function resolveServiceRoleSkills(
  store: Store | undefined,
  configuredBundleIds: readonly string[] | null | undefined,
  serviceRoleId: string,
  channel: ServiceChannelKind,
): ResolvedServiceSkills {
  const requested = configuredBundleIds == null
    ? defaultServiceRoleBundleIds(serviceRoleId)
    : [...configuredBundleIds];
  const activeBundles = filterBundlesForChannel(requested, channel);

  const seenSlugs = new Set<string>();
  const skills: ResolvedServiceSkillMeta[] = [];
  const files: SkillStoreFile[] = [];
  const revisions: string[] = [];

  for (const spec of activeBundles) {
    const resolved = resolveBuiltinBundle(store, spec);
    for (const item of resolved.source.items) {
      if (seenSlugs.has(item.slug)) continue;
      seenSlugs.add(item.slug);
      const skillFiles = resolved.fullFiles.filter(f => f.path.startsWith(`${item.slug}/`) && f.path !== `${item.slug}/LICENSE`);
      const md = skillFiles.find(f => f.path === `${item.slug}/SKILL.md`)?.content ?? '';
      const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? '';
      const name = /^name:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || item.slug;
      const description = /^description:\s*(.+)$/m.exec(front)?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
      skills.push({
        slug: item.slug,
        skill_id: item.skill_id,
        version: item.version,
        name,
        description,
        bundle_id: spec.id,
      });
      for (const f of skillFiles) {
        files.push({
          path: f.path,
          content: f.content,
          sha256: f.sha256,
          bytes: f.bytes,
          ...(f.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
          ...(f.executable ? { executable: true } : {}),
        });
      }
      const digest = createHash('sha256')
        .update(JSON.stringify(skillFiles.map(f => [f.path, f.sha256])))
        .digest('hex')
        .slice(0, 16);
      revisions.push(`${item.skill_id}@v${item.version}:${digest}`);
    }
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { bundleIds: activeBundles.map(b => b.id), skills, files, revisions };
}

export function makeReadSkillTool(resolved: ResolvedServiceSkills) {
  return {
    type: 'function',
    function: {
      name: readSkillName,
      description: 'Read a built-in skill: working material for one kind of job. Before doing such a job, read its SKILL.md, then the references it points to as needed. Omit path to list every file. Skills never change your tools or permissions. Available: '
        + resolved.skills.map(skill => `${skill.name}/SKILL.md (${skill.description})`).join('; '),
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: `A path from the listing, such as ${resolved.skills[0]?.slug ?? 'layered-ci-gates'}/SKILL.md.`,
          },
        },
        additionalProperties: false,
      },
    },
  };
}

export function readSkill(args: Json, resolved: ResolvedServiceSkills): Json {
  if (args?.path !== undefined && typeof args.path !== 'string') fail(400, 'invalid_skill_path');
  const { skills, files } = resolved;
  if (args?.path === undefined) {
    return {
      skills: skills.map(skill => ({
        id: skill.slug,
        name: skill.name,
        description: skill.description,
        files: files
          .filter(f => f.path.startsWith(skill.slug + '/'))
          .map(f => ({ path: f.path, bytes: f.bytes ?? Buffer.byteLength(f.content) })),
      })),
    };
  }
  // Links inside a skill are relative to its SKILL.md: accept them without the skill's directory when only one file matches.
  const path = String(args.path).replace(/^\.?\//, '');
  const suffixed = files.filter(f => f.path.endsWith('/' + path));
  const file = files.find(f => f.path === path) ?? (suffixed.length === 1 ? suffixed[0] : undefined);
  // A path outside the listing is an argument error: the management agent hands 400s back to the model to correct.
  if (!file) fail(400, 'skill_file_not_found');
  if (file!.encoding === 'base64') {
    return {
      path: file!.path,
      bytes: file!.bytes ?? 0,
      encoding: 'base64',
      notice: 'Binary controlled asset file; read it directly from the mounted skill directory if file tools are available.',
    };
  }
  return { path: file!.path, content: file!.content };
}
