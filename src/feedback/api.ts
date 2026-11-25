import type { Store } from '../storage/database.js';
import { superAdmin, type Actor } from '../app/auth.js';
import { fail, fields, type Json } from '../core/security.js';
import {
  deleteFeedbackEntry,
  FEEDBACK_CATEGORIES,
  FEEDBACK_SEVERITIES,
  FEEDBACK_SOURCE_KINDS,
  FEEDBACK_STATUSES,
  feedbackBounds,
  feedbackDefaults,
  feedbackSettings,
  feedbackStatusCounts,
  getFeedbackEntry,
  listFeedbackEntries,
  listFeedbackRepositories,
  readFeedbackPayload,
  saveFeedbackSettings,
  updateFeedbackTriage,
  type FeedbackCategory,
  type FeedbackSeverity,
  type FeedbackSourceKind,
  type FeedbackStatus,
} from './storage.js';

const idRoute = /^\/api\/feedback\/([a-zA-Z0-9_-]{8,120})$/;

function parseNonNegativeInt(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) fail(400, 'invalid_pagination');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) fail(400, 'invalid_pagination');
  return value;
}

/**
 * Super-admin-only HTTP API for the platform Feedback Box.
 * Every endpoint enforces `superAdmin(user)` before touching SQLite or payload files.
 */
export function feedbackApi(
  store: Store,
  user: Actor,
  method: string,
  url: URL,
  input: Json,
): Json | undefined {
  const path = url.pathname;
  if (path !== '/api/feedback' && !path.startsWith('/api/feedback/')) return undefined;
  superAdmin(user);

  if (path === '/api/feedback/settings') {
    if (method === 'GET') {
      return {
        settings: feedbackSettings(store),
        defaults: feedbackDefaults,
        bounds: feedbackBounds,
      } as unknown as Json;
    }
    if (method === 'PUT') {
      const saved = saveFeedbackSettings(store, user.id, input);
      return {
        settings: saved,
        defaults: feedbackDefaults,
        bounds: feedbackBounds,
      } as unknown as Json;
    }
    return fail(405, 'method_not_allowed');
  }

  if (path === '/api/feedback') {
    if (method !== 'GET') return fail(405, 'method_not_allowed');
    const q = url.searchParams;
    const rawStatus = q.get('status');
    let status: FeedbackStatus | 'all' | undefined;
    if (rawStatus && rawStatus !== 'all') {
      if (!(FEEDBACK_STATUSES as readonly string[]).includes(rawStatus)) fail(400, 'feedback_invalid_filter', 'status');
      status = rawStatus as FeedbackStatus;
    }
    const rawCategory = q.get('category');
    let category: FeedbackCategory | undefined;
    if (rawCategory) {
      if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(rawCategory)) fail(400, 'feedback_invalid_filter', 'category');
      category = rawCategory as FeedbackCategory;
    }
    const rawSeverity = q.get('severity');
    let severity: FeedbackSeverity | undefined;
    if (rawSeverity) {
      if (!(FEEDBACK_SEVERITIES as readonly string[]).includes(rawSeverity)) fail(400, 'feedback_invalid_filter', 'severity');
      severity = rawSeverity as FeedbackSeverity;
    }
    const rawSource = q.get('source_kind');
    let sourceKind: FeedbackSourceKind | undefined;
    if (rawSource) {
      if (!(FEEDBACK_SOURCE_KINDS as readonly string[]).includes(rawSource)) fail(400, 'feedback_invalid_filter', 'source_kind');
      sourceKind = rawSource as FeedbackSourceKind;
    }
    const rawRepo = q.get('repository_id');
    const repositoryId = rawRepo ? rawRepo.slice(0, 128) : undefined;

    const rawUntrusted = q.get('untrusted');
    let untrusted: boolean | undefined;
    if (rawUntrusted !== null && rawUntrusted !== '') {
      if (rawUntrusted === '1' || rawUntrusted === 'true') untrusted = true;
      else if (rawUntrusted === '0' || rawUntrusted === 'false') untrusted = false;
      else fail(400, 'feedback_invalid_filter', 'untrusted');
    }

    const rawQuery = q.get('q');
    const search = rawQuery ? rawQuery.slice(0, 120) : undefined;
    const offset = parseNonNegativeInt(q.get('offset'), 0, 1_000_000);
    const limit = Math.max(1, parseNonNegativeInt(q.get('limit'), 20, 100));

    const page = listFeedbackEntries(store, {
      status,
      category,
      severity,
      source_kind: sourceKind,
      repository_id: repositoryId,
      untrusted,
      q: search,
      offset,
      limit,
    });
    return {
      ...page,
      counts: feedbackStatusCounts(store),
      repositories: listFeedbackRepositories(store),
      settings: feedbackSettings(store),
    } as unknown as Json;
  }

  const match = idRoute.exec(path);
  if (!match) return fail(404, 'feedback_not_found');
  const id = match[1]!;

  if (method === 'GET') {
    const entry = getFeedbackEntry(store, id);
    if (!entry) return fail(404, 'feedback_not_found');
    const payload = readFeedbackPayload(store, entry.id, entry.payload_sha256);
    const repositoryDeleted = Boolean(entry.repository_id && !store.get('SELECT 1 FROM repositories WHERE id=?', entry.repository_id));
    const taskExists = Boolean(entry.task_id && store.get('SELECT 1 FROM tasks WHERE id=?', entry.task_id));
    return {
      entry: {
        ...entry,
        repository_deleted: repositoryDeleted,
        task_exists: taskExists,
      },
      payload,
    } as unknown as Json;
  }

  if (method === 'PATCH') {
    fields(input, ['status', 'triage_note']);
    if (!Object.keys(input).length) fail(400, 'feedback_invalid_field');
    const patch: { status?: FeedbackStatus; triage_note?: string | null } = {};
    if (Object.hasOwn(input, 'status')) {
      if (typeof input.status !== 'string' || !(FEEDBACK_STATUSES as readonly string[]).includes(input.status)) {
        fail(400, 'feedback_invalid_field', 'status');
      }
      patch.status = input.status as FeedbackStatus;
    }
    if (Object.hasOwn(input, 'triage_note')) {
      if (input.triage_note === null || input.triage_note === '') {
        patch.triage_note = null;
      } else if (typeof input.triage_note === 'string' && !input.triage_note.includes('\0') && Array.from(input.triage_note).length <= 2000) {
        patch.triage_note = input.triage_note.trim() || null;
      } else {
        fail(400, 'feedback_invalid_field', 'triage_note');
      }
    }
    const updated = updateFeedbackTriage(store, id, user.id, user.username || user.id, patch);
    return { entry: updated } as unknown as Json;
  }

  if (method === 'DELETE') {
    return deleteFeedbackEntry(store, id, user.id) as unknown as Json;
  }

  return fail(405, 'method_not_allowed');
}
