import type { Store } from '../storage/database.js';
import { repository, type Actor } from '../app/auth.js';
import { authorize } from '../identity/authorization.js';
import { fail, fields, type Json } from '../core/security.js';
import {
  createConsoleSkill,
  deleteProjectSkill,
  getSkill,
  importRepositorySkills,
  listSkills,
  listSkillVersions,
  listTrustedCacheRepositorySkills,
  stripSkillVersionContent,
  updateConsoleSkill,
  type SkillOrigin,
} from './skill-library.js';

const ORIGINS = new Set<SkillOrigin>(['builtin', 'repository', 'console']);

function parseNonNegativeInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) fail(400, 'invalid_pagination');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(400, 'invalid_pagination');
  return value;
}

function parsePositiveInt(raw: string | null, field: string, max = Number.MAX_SAFE_INTEGER, code = 'invalid_skill_version'): number | undefined {
  if (raw === null || raw === '') return undefined;
  if (!/^\d+$/.test(raw)) fail(400, code, field);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(400, code, field);
  return value;
}

function parseBoolParam(raw: string | null, fallback: boolean, field: string): boolean {
  if (raw === null || raw === '') return fallback;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return fail(400, 'invalid_skill_query', field);
}

function canEditRoles(user: Actor, repositoryId: string): boolean {
  try {
    if (user.context) authorize(user.context, 'roles.edit', { project_id: repositoryId });
    return true;
  } catch {
    return false;
  }
}

/**
 * Project-scoped REST API for the independent versioned Skill Library (`/api/repositories/:id/skills*`).
 * Reads require project scope (`repository`); mutations require `roles.edit`.
 */
export async function skillLibraryApi(
  store: Store,
  user: Actor,
  method: string,
  url: URL,
  input: Json,
  options: { githubUrl?: string } = {},
): Promise<Json | undefined> {
  const match = /^\/api\/repositories\/([^/]+)\/skills(?:\/([^/]+)(?:\/(versions))?)?$/.exec(url.pathname);
  if (!match) return undefined;

  const repo = match[1]!;
  repository(store, user, repo);
  const segment = match[2];
  const sub = match[3];
  const requireEdit = () => {
    if (user.context) authorize(user.context, 'roles.edit', { project_id: repo });
  };

  // Collection endpoints: GET/POST /api/repositories/:id/skills
  if (!segment) {
    if (method === 'GET') {
      const rawOrigin = url.searchParams.get('origin');
      let origin: SkillOrigin | undefined;
      if (rawOrigin) {
        if (!ORIGINS.has(rawOrigin as SkillOrigin)) fail(400, 'invalid_skill_origin', 'origin');
        origin = rawOrigin as SkillOrigin;
      }
      const query = url.searchParams.get('q') ?? undefined;
      if (query && query.length > 200) fail(400, 'invalid_skill_query', 'q');
      const includeBuiltin = parseBoolParam(url.searchParams.get('include_builtin'), true, 'include_builtin');
      const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0, 100_000);
      const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 100, 'invalid_pagination') ?? 50;
      const page = listSkills(store, repo, { origin, query, include_builtin: includeBuiltin, offset, limit });
      const repositorySources = listTrustedCacheRepositorySkills(store, repo);
      return {
        ...page,
        can_edit: canEditRoles(user, repo),
        repository_sources: repositorySources,
      } as unknown as Json;
    }
    if (method === 'POST') {
      requireEdit();
      fields(input, ['slug', 'files']);
      const result = createConsoleSkill(store, repo, { slug: input.slug, files: input.files }, user.id);
      return result as unknown as Json;
    }
    return fail(405, 'method_not_allowed');
  }

  // Repository whole-directory import: POST /api/repositories/:id/skills/import
  if (segment === 'import' && !sub) {
    if (method !== 'POST') return fail(405, 'method_not_allowed');
    requireEdit();
    fields(input, ['path', 'slug', 'all', 'commit', 'source']);
    const result = await importRepositorySkills(
      store,
      repo,
      { path: input.path, slug: input.slug, all: input.all, commit: input.commit, source: input.source },
      user.id,
      { githubUrl: options.githubUrl, beforeCommit: () => { repository(store, user, repo); requireEdit(); } },
    );
    return {
      ...result,
      imported: result.imported.map(entry => ({ ...entry, version: stripSkillVersionContent(entry.version) })),
    } as unknown as Json;
  }

  let skillId: string;
  try {
    skillId = decodeURIComponent(segment);
  } catch {
    return fail(400, 'invalid_skill_id');
  }

  // Version history: GET /api/repositories/:id/skills/:skillId/versions
  if (sub === 'versions') {
    if (method !== 'GET') return fail(405, 'method_not_allowed');
    const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0, 100_000);
    const limit = parsePositiveInt(url.searchParams.get('limit'), 'limit', 100, 'invalid_pagination') ?? 50;
    return listSkillVersions(store, repo, skillId, { offset, limit }) as unknown as Json;
  }

  // Single skill item: GET/PUT/DELETE /api/repositories/:id/skills/:skillId
  if (method === 'GET') {
    const version = parsePositiveInt(url.searchParams.get('version'), 'version');
    const includeContent = parseBoolParam(url.searchParams.get('include_content'), true, 'include_content');
    const detail = getSkill(store, repo, skillId, { version, include_content: includeContent });
    return { ...detail, can_edit: canEditRoles(user, repo) && detail.skill.can_edit } as unknown as Json;
  }
  if (method === 'PUT') {
    requireEdit();
    fields(input, ['expected_version', 'files']);
    const result = updateConsoleSkill(store, repo, skillId, { expected_version: input.expected_version, files: input.files }, user.id);
    return result as unknown as Json;
  }
  if (method === 'DELETE') {
    requireEdit();
    fields(input, ['expected_version']);
    return deleteProjectSkill(store, repo, skillId, input.expected_version, user.id) as unknown as Json;
  }
  return fail(405, 'method_not_allowed');
}
