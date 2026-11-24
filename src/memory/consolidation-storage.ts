import type { Row, Store } from '../storage/database.js';
import { digest, fail, fields, randomId, text, type Json } from '../core/security.js';
import { localParts } from '../schedules/time.js';

export type ConsolidationScopeKind = 'project' | 'group_assistant' | 'personal_assistant';
export type ConsolidationTrigger = 'nightly' | 'manual';
export type ConsolidationRunStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface ConsolidationSettings {
  enabled: boolean;
  window_start: string;
  window_end: string;
  timezone: string;
  max_concurrency: number;
  model_id: string | null;
}

export interface ConsolidationFileChange {
  path: string;
  id?: string;
  revision?: number;
  action: 'created' | 'updated' | 'moved' | 'deleted';
}

export interface ConsolidationStateRow {
  scope_kind: ConsolidationScopeKind;
  scope_id: string;
  enabled_override: boolean | null;
  model_id: string | null;
  last_run_id: string | null;
  last_logical_day: string | null;
  last_completed_at: string | null;
  last_status: ConsolidationRunStatus | null;
  updated_at: string;
}

export interface ConsolidationRunRow {
  id: string;
  scope_kind: ConsolidationScopeKind;
  scope_id: string;
  logical_day: string;
  trigger: ConsolidationTrigger;
  status: ConsolidationRunStatus;
  model_id: string | null;
  started_at: string;
  finished_at: string | null;
  summary: string | null;
  changed_files: ConsolidationFileChange[];
  deleted_files: ConsolidationFileChange[];
  error_code: string | null;
  error_detail: string | null;
}

export const CONSOLIDATION_SETTINGS_KEY = 'memory_consolidation';
export const CONSOLIDATION_CONCURRENCY_BOUNDS = [1, 8] as const;

export const consolidationDefaults: ConsolidationSettings = {
  enabled: true,
  window_start: '02:00',
  window_end: '05:00',
  timezone: 'Asia/Shanghai',
  max_concurrency: 2,
  model_id: null,
};

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseClockMinutes(value: string): number {
  const match = TIME_PATTERN.exec(value);
  if (!match) return fail(400, 'invalid_consolidation_window');
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function previousCalendarDay(year: number, month: number, day: number): string {
  const date = new Date(Date.UTC(year, month - 1, day) - 86_400_000);
  return formatDate(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/**
 * Evaluates whether `nowMs` falls inside the configured nightly window and computes the logical consolidation day.
 * Overnight wrap windows (e.g. `23:00`–`04:00`) assign pre-midnight and post-midnight hours of the same night to the
 * same logical day so each scope runs at most once per night.
 */
export function evaluateConsolidationWindow(
  nowMs: number,
  settings: Pick<ConsolidationSettings, 'window_start' | 'window_end' | 'timezone'>,
): { inWindow: boolean; logicalDay: string } {
  const [year, month, day, hour, minute] = localParts(nowMs, settings.timezone);
  const current = hour! * 60 + minute!;
  const start = parseClockMinutes(settings.window_start);
  const end = parseClockMinutes(settings.window_end);
  const today = formatDate(year!, month!, day!);
  if (start < end) {
    return { inWindow: current >= start && current < end, logicalDay: today };
  }
  if (start > end) {
    if (current >= start) return { inWindow: true, logicalDay: today };
    if (current < end) return { inWindow: true, logicalDay: previousCalendarDay(year!, month!, day!) };
    return { inWindow: false, logicalDay: today };
  }
  return { inWindow: false, logicalDay: today };
}

/** Deterministic per-night ordering hash so subjects spread across the window instead of colliding every night. */
export function consolidationStaggerKey(logicalDay: string, scopeKind: ConsolidationScopeKind, scopeId: string): string {
  return digest(`memory-consolidation:${logicalDay}:${scopeKind}:${scopeId}`);
}

export function personalScopeId(principalId: string, tenant: string): string {
  return tenant ? `${principalId}:${tenant}` : principalId;
}

export function parsePersonalScopeId(scopeId: string): { principalId: string; tenant: string } {
  const idx = scopeId.indexOf(':');
  if (idx < 0) return { principalId: scopeId, tenant: '' };
  return { principalId: scopeId.slice(0, idx), tenant: scopeId.slice(idx + 1) };
}

export function consolidationStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS memory_consolidation_state(
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','group_assistant','personal_assistant')),
      scope_id TEXT NOT NULL,
      enabled_override INTEGER,
      model_id TEXT,
      last_run_id TEXT,
      last_logical_day TEXT,
      last_completed_at TEXT,
      last_status TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(scope_kind, scope_id)
    );
    CREATE TABLE IF NOT EXISTS memory_consolidation_runs(
      id TEXT PRIMARY KEY,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('project','group_assistant','personal_assistant')),
      scope_id TEXT NOT NULL,
      logical_day TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('nightly','manual')),
      status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','skipped')),
      model_id TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      summary TEXT,
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      deleted_files_json TEXT NOT NULL DEFAULT '[]',
      error_code TEXT,
      error_detail TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_consolidation_nightly_day
      ON memory_consolidation_runs(scope_kind, scope_id, logical_day)
      WHERE trigger='nightly';
    CREATE INDEX IF NOT EXISTS memory_consolidation_runs_scope
      ON memory_consolidation_runs(scope_kind, scope_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS memory_consolidation_runs_started
      ON memory_consolidation_runs(started_at);
  `);
}

/** Marks any in-progress runs left over from a prior control-plane process as interrupted. */
export function interruptConsolidationRuns(store: Store, nowIso = new Date().toISOString()): number {
  if (!store.hasTable('memory_consolidation_runs')) return 0;
  const stale = store.all("SELECT id,scope_kind,scope_id FROM memory_consolidation_runs WHERE status='running'");
  if (!stale.length) return 0;
  store.transaction(() => {
    store.run(
      "UPDATE memory_consolidation_runs SET status='failed',error_code='consolidation_interrupted',finished_at=? WHERE status='running'",
      nowIso,
    );
    for (const row of stale) {
      store.run(
        "UPDATE memory_consolidation_state SET last_status='failed',updated_at=? WHERE scope_kind=? AND scope_id=? AND last_run_id=?",
        nowIso, row.scope_kind, row.scope_id, row.id,
      );
    }
  });
  return stale.length;
}

export function consolidationSettings(store: Store): ConsolidationSettings {
  let saved: Partial<ConsolidationSettings> = {};
  try {
    const raw = store.get('SELECT value FROM settings WHERE key=?', CONSOLIDATION_SETTINGS_KEY)?.value;
    if (raw) saved = JSON.parse(String(raw));
  } catch { /* corrupt settings fall back to safe defaults */ }
  const maxConcurrency = Number(saved.max_concurrency);
  const windowStart = typeof saved.window_start === 'string' && TIME_PATTERN.test(saved.window_start)
    ? saved.window_start : consolidationDefaults.window_start;
  const windowEnd = typeof saved.window_end === 'string' && TIME_PATTERN.test(saved.window_end)
    ? saved.window_end : consolidationDefaults.window_end;
  const timezone = typeof saved.timezone === 'string' && saved.timezone.trim()
    ? saved.timezone.trim() : consolidationDefaults.timezone;
  let validTimezone = consolidationDefaults.timezone;
  try { localParts(Date.now(), timezone); validTimezone = timezone; } catch { /* fallback */ }
  return {
    enabled: typeof saved.enabled === 'boolean' ? saved.enabled : consolidationDefaults.enabled,
    window_start: windowStart === windowEnd ? consolidationDefaults.window_start : windowStart,
    window_end: windowStart === windowEnd ? consolidationDefaults.window_end : windowEnd,
    timezone: validTimezone,
    max_concurrency: Number.isSafeInteger(maxConcurrency) && maxConcurrency >= CONSOLIDATION_CONCURRENCY_BOUNDS[0] && maxConcurrency <= CONSOLIDATION_CONCURRENCY_BOUNDS[1]
      ? maxConcurrency : consolidationDefaults.max_concurrency,
    model_id: typeof saved.model_id === 'string' && saved.model_id.trim() ? saved.model_id.trim() : null,
  };
}

export function saveConsolidationSettings(store: Store, userId: string, input: Json): ConsolidationSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.keys(input).length) {
    fail(400, 'invalid_consolidation_settings');
  }
  fields(input, ['enabled', 'window_start', 'window_end', 'timezone', 'max_concurrency', 'model_id']);
  const next = consolidationSettings(store);
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return fail(400, 'invalid_consolidation_settings', 'enabled');
    next.enabled = input.enabled;
  }
  if (input.window_start !== undefined) {
    if (typeof input.window_start !== 'string' || !TIME_PATTERN.test(input.window_start)) return fail(400, 'invalid_consolidation_window', 'window_start');
    next.window_start = input.window_start;
  }
  if (input.window_end !== undefined) {
    if (typeof input.window_end !== 'string' || !TIME_PATTERN.test(input.window_end)) return fail(400, 'invalid_consolidation_window', 'window_end');
    next.window_end = input.window_end;
  }
  if (next.window_start === next.window_end) return fail(400, 'invalid_consolidation_window', 'window_end');
  if (input.timezone !== undefined) {
    const tz = text(input.timezone, 100);
    try { localParts(Date.now(), tz); } catch { return fail(400, 'invalid_consolidation_timezone', 'timezone'); }
    next.timezone = tz;
  }
  if (input.max_concurrency !== undefined) {
    const value = Number(input.max_concurrency);
    if (!Number.isSafeInteger(value) || value < CONSOLIDATION_CONCURRENCY_BOUNDS[0] || value > CONSOLIDATION_CONCURRENCY_BOUNDS[1]) {
      return fail(400, 'invalid_consolidation_concurrency', 'max_concurrency');
    }
    next.max_concurrency = value;
  }
  if (input.model_id !== undefined) {
    if (input.model_id === null || input.model_id === '') {
      next.model_id = null;
    } else {
      const modelId = text(input.model_id, 128);
      const model = store.get('SELECT id,repository_id FROM models WHERE id=?', modelId);
      if (!model) return fail(404, 'model_not_found', 'model_id');
      if (model.repository_id !== null) return fail(400, 'shared_model_required', 'model_id');
      next.model_id = modelId;
    }
  }
  store.transaction(() => {
    store.run(
      'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      CONSOLIDATION_SETTINGS_KEY,
      JSON.stringify(next),
    );
    store.audit(userId, 'memory.consolidation.settings.updated', CONSOLIDATION_SETTINGS_KEY);
  });
  return next;
}

function mapStateRow(row: Row | undefined, scopeKind: ConsolidationScopeKind, scopeId: string): ConsolidationStateRow {
  if (!row) {
    return {
      scope_kind: scopeKind,
      scope_id: scopeId,
      enabled_override: null,
      model_id: null,
      last_run_id: null,
      last_logical_day: null,
      last_completed_at: null,
      last_status: null,
      updated_at: '',
    };
  }
  return {
    scope_kind: row.scope_kind as ConsolidationScopeKind,
    scope_id: String(row.scope_id),
    enabled_override: row.enabled_override === null || row.enabled_override === undefined ? null : Number(row.enabled_override) === 1,
    model_id: row.model_id ? String(row.model_id) : null,
    last_run_id: row.last_run_id ? String(row.last_run_id) : null,
    last_logical_day: row.last_logical_day ? String(row.last_logical_day) : null,
    last_completed_at: row.last_completed_at ? String(row.last_completed_at) : null,
    last_status: row.last_status ? (String(row.last_status) as ConsolidationRunStatus) : null,
    updated_at: String(row.updated_at || ''),
  };
}

function parseFileChanges(raw: unknown): ConsolidationFileChange[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item): ConsolidationFileChange[] => {
      if (typeof item === 'string' && item) return [{ path: item, action: 'updated' }];
      if (item && typeof item === 'object' && typeof (item as any).path === 'string') {
        const entry: ConsolidationFileChange = {
          path: String((item as any).path),
          action: ['created', 'updated', 'moved', 'deleted'].includes(String((item as any).action))
            ? (String((item as any).action) as ConsolidationFileChange['action'])
            : 'updated',
        };
        if (typeof (item as any).id === 'string' && (item as any).id) entry.id = String((item as any).id);
        if (Number.isSafeInteger((item as any).revision)) entry.revision = Number((item as any).revision);
        return [entry];
      }
      return [];
    });
  } catch {
    return [];
  }
}

function mapRunRow(row: Row): ConsolidationRunRow {
  return {
    id: String(row.id),
    scope_kind: row.scope_kind as ConsolidationScopeKind,
    scope_id: String(row.scope_id),
    logical_day: String(row.logical_day),
    trigger: row.trigger as ConsolidationTrigger,
    status: row.status as ConsolidationRunStatus,
    model_id: row.model_id ? String(row.model_id) : null,
    started_at: String(row.started_at),
    finished_at: row.finished_at ? String(row.finished_at) : null,
    summary: row.summary ? String(row.summary) : null,
    changed_files: parseFileChanges(row.changed_files_json),
    deleted_files: parseFileChanges(row.deleted_files_json),
    error_code: row.error_code ? String(row.error_code) : null,
    error_detail: row.error_detail ? String(row.error_detail) : null,
  };
}

export function getConsolidationState(store: Store, scopeKind: ConsolidationScopeKind, scopeId: string): ConsolidationStateRow {
  consolidationStorage(store);
  const row = store.get('SELECT * FROM memory_consolidation_state WHERE scope_kind=? AND scope_id=?', scopeKind, scopeId);
  return mapStateRow(row, scopeKind, scopeId);
}

export function isConsolidationEnabledForScope(store: Store, scopeKind: ConsolidationScopeKind, scopeId: string): boolean {
  const global = consolidationSettings(store);
  const state = getConsolidationState(store, scopeKind, scopeId);
  return state.enabled_override === null ? global.enabled : state.enabled_override;
}

export function saveConsolidationScopeConfig(
  store: Store,
  scopeKind: ConsolidationScopeKind,
  scopeId: string,
  input: { enabled_override?: boolean | null; model_id?: string | null },
  userId: string,
  repositoryId: string | null = null,
): ConsolidationStateRow {
  consolidationStorage(store);
  const current = getConsolidationState(store, scopeKind, scopeId);
  const enabledOverride = input.enabled_override !== undefined ? input.enabled_override : current.enabled_override;
  const modelId = input.model_id !== undefined ? (input.model_id ? input.model_id : null) : current.model_id;
  const nowIso = new Date().toISOString();
  store.transaction(() => {
    store.run(
      `INSERT INTO memory_consolidation_state(scope_kind,scope_id,enabled_override,model_id,last_run_id,last_logical_day,last_completed_at,last_status,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(scope_kind,scope_id) DO UPDATE SET enabled_override=excluded.enabled_override,model_id=excluded.model_id,updated_at=excluded.updated_at`,
      scopeKind,
      scopeId,
      enabledOverride === null ? null : enabledOverride ? 1 : 0,
      modelId,
      current.last_run_id,
      current.last_logical_day,
      current.last_completed_at,
      current.last_status,
      nowIso,
    );
    store.audit(userId, `memory.consolidation.${scopeKind}.updated`, scopeId, repositoryId);
  });
  return getConsolidationState(store, scopeKind, scopeId);
}

export function hasNightlyRunForDay(store: Store, scopeKind: ConsolidationScopeKind, scopeId: string, logicalDay: string): boolean {
  consolidationStorage(store);
  return Boolean(store.get(
    "SELECT 1 FROM memory_consolidation_runs WHERE scope_kind=? AND scope_id=? AND logical_day=? AND trigger='nightly'",
    scopeKind, scopeId, logicalDay,
  ));
}

export function runningConsolidationRun(store: Store, scopeKind: ConsolidationScopeKind, scopeId: string): ConsolidationRunRow | null {
  consolidationStorage(store);
  const row = store.get(
    "SELECT * FROM memory_consolidation_runs WHERE scope_kind=? AND scope_id=? AND status='running' ORDER BY started_at DESC LIMIT 1",
    scopeKind, scopeId,
  );
  return row ? mapRunRow(row) : null;
}

export function beginConsolidationRun(
  store: Store,
  input: {
    scope_kind: ConsolidationScopeKind;
    scope_id: string;
    logical_day: string;
    trigger: ConsolidationTrigger;
    model_id: string | null;
    started_at?: string;
    initial_status?: ConsolidationRunStatus;
    error_code?: string | null;
    error_detail?: string | null;
    summary?: string | null;
  },
): ConsolidationRunRow | null {
  consolidationStorage(store);
  const id = randomId();
  const startedAt = input.started_at ?? new Date().toISOString();
  const status = input.initial_status ?? 'running';
  const finishedAt = status === 'running' ? null : startedAt;
  try {
    store.transaction(() => {
      if (status === 'running' && store.get("SELECT 1 FROM memory_consolidation_runs WHERE scope_kind=? AND scope_id=? AND status='running'", input.scope_kind, input.scope_id)) {
        fail(409, 'consolidation_already_running');
      }
      store.run(
        `INSERT INTO memory_consolidation_runs(id,scope_kind,scope_id,logical_day,trigger,status,model_id,started_at,finished_at,summary,changed_files_json,deleted_files_json,error_code,error_detail)
         VALUES(?,?,?,?,?,?,?,?,?,?,'[]','[]',?,?)`,
        id, input.scope_kind, input.scope_id, input.logical_day, input.trigger, status, input.model_id,
        startedAt, finishedAt, input.summary ?? null, input.error_code ?? null, input.error_detail ?? null,
      );
      store.run(
        `INSERT INTO memory_consolidation_state(scope_kind,scope_id,enabled_override,model_id,last_run_id,last_logical_day,last_completed_at,last_status,updated_at)
         VALUES(?,?,NULL,NULL,?,?,?,?,?)
         ON CONFLICT(scope_kind,scope_id) DO UPDATE SET
           last_run_id=excluded.last_run_id,
           last_logical_day=CASE WHEN ?='nightly' THEN excluded.last_logical_day ELSE memory_consolidation_state.last_logical_day END,
           last_status=excluded.last_status,
           updated_at=excluded.updated_at`,
        input.scope_kind, input.scope_id, id, input.logical_day, status === 'completed' ? finishedAt : null, status, startedAt, input.trigger,
      );
    });
  } catch (error: any) {
    if (input.trigger === 'nightly' && /UNIQUE constraint failed/i.test(String(error?.message || ''))) return null;
    throw error;
  }
  const row = store.get('SELECT * FROM memory_consolidation_runs WHERE id=?', id);
  return row ? mapRunRow(row) : null;
}

export function finishConsolidationRun(
  store: Store,
  runId: string,
  input: {
    status: Exclude<ConsolidationRunStatus, 'running'>;
    model_id?: string | null;
    summary?: string | null;
    changed_files?: ConsolidationFileChange[];
    deleted_files?: ConsolidationFileChange[];
    error_code?: string | null;
    error_detail?: string | null;
    finished_at?: string;
  },
): ConsolidationRunRow | null {
  consolidationStorage(store);
  const finishedAt = input.finished_at ?? new Date().toISOString();
  store.transaction(() => {
    const existing = store.get('SELECT * FROM memory_consolidation_runs WHERE id=?', runId);
    if (!existing) return;
    const nextModelId = input.model_id !== undefined ? input.model_id : existing.model_id;
    store.run(
      `UPDATE memory_consolidation_runs
       SET status=?,model_id=?,finished_at=?,summary=?,changed_files_json=?,deleted_files_json=?,error_code=?,error_detail=?
       WHERE id=?`,
      input.status,
      nextModelId ?? null,
      finishedAt,
      input.summary ?? null,
      JSON.stringify(input.changed_files ?? []),
      JSON.stringify(input.deleted_files ?? []),
      input.error_code ?? null,
      input.error_detail ?? null,
      runId,
    );
    store.run(
      `UPDATE memory_consolidation_state
       SET last_status=?,
           last_completed_at=CASE WHEN ?='completed' THEN ? ELSE last_completed_at END,
           updated_at=?
       WHERE scope_kind=? AND scope_id=? AND last_run_id=?`,
      input.status, input.status, finishedAt, finishedAt, existing.scope_kind, existing.scope_id, runId,
    );
  });
  const row = store.get('SELECT * FROM memory_consolidation_runs WHERE id=?', runId);
  return row ? mapRunRow(row) : null;
}

export function listConsolidationRuns(
  store: Store,
  filter: { scope_kind?: ConsolidationScopeKind; scope_id?: string; offset?: number; limit?: number } = {},
): { runs: ConsolidationRunRow[]; total: number; next_offset: number | null } {
  consolidationStorage(store);
  const offset = filter.offset ?? 0;
  const limit = filter.limit ?? 20;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    fail(400, 'invalid_pagination');
  }
  const where: string[] = [];
  const args: (string | number | null)[] = [];
  if (filter.scope_kind) { where.push('scope_kind=?'); args.push(filter.scope_kind); }
  if (filter.scope_id) { where.push('scope_id=?'); args.push(filter.scope_id); }
  const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number(store.get(`SELECT count(*) AS n FROM memory_consolidation_runs ${clause}`, ...args)?.n ?? 0);
  const rows = store.all(
    `SELECT * FROM memory_consolidation_runs ${clause} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset,
  );
  return {
    runs: rows.map(mapRunRow),
    total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
  };
}

/** Deletes all consolidation state and run history for a removed project or unbound group. */
export function deleteConsolidationScope(store: Store, scopeKind: ConsolidationScopeKind, scopeId: string): void {
  if (store.hasTable('memory_consolidation_runs')) {
    store.run('DELETE FROM memory_consolidation_runs WHERE scope_kind=? AND scope_id=?', scopeKind, scopeId);
  }
  if (store.hasTable('memory_consolidation_state')) {
    store.run('DELETE FROM memory_consolidation_state WHERE scope_kind=? AND scope_id=?', scopeKind, scopeId);
  }
}

/** Clears references to deleted model(s) from both global consolidation settings and per-scope overrides. */
export function releaseConsolidationModels(store: Store, modelIds: string[], userId: string): void {
  if (!modelIds.length) return;
  const idSet = new Set(modelIds);
  const savedRow = store.get('SELECT value FROM settings WHERE key=?', CONSOLIDATION_SETTINGS_KEY);
  if (savedRow?.value) {
    try {
      const parsed = JSON.parse(String(savedRow.value));
      if (parsed && typeof parsed.model_id === 'string' && idSet.has(parsed.model_id)) {
        parsed.model_id = null;
        store.run(
          'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
          CONSOLIDATION_SETTINGS_KEY,
          JSON.stringify(parsed),
        );
        store.audit(userId, 'memory.consolidation.model_cleared', CONSOLIDATION_SETTINGS_KEY);
      }
    } catch { /* ignore malformed */ }
  }
  if (store.hasTable('memory_consolidation_state')) {
    const nowIso = new Date().toISOString();
    for (const modelId of idSet) {
      const affected = store.all('SELECT scope_kind,scope_id FROM memory_consolidation_state WHERE model_id=?', modelId);
      if (!affected.length) continue;
      store.run('UPDATE memory_consolidation_state SET model_id=NULL,updated_at=? WHERE model_id=?', nowIso, modelId);
      for (const row of affected) {
        store.audit(
          userId,
          'memory.consolidation.model_cleared',
          `${row.scope_kind}:${row.scope_id}`,
          row.scope_kind === 'project' ? String(row.scope_id) : null,
        );
      }
    }
  }
}

/** Deletes finished consolidation runs older than `beforeIso` in bounded batches (used by RetentionCleanup). */
export function pruneConsolidationRuns(
  store: Store,
  beforeIso: string,
  options: { scope_kind?: ConsolidationScopeKind; scope_id?: string; limit?: number } = {},
): number {
  if (!store.hasTable('memory_consolidation_runs')) return 0;
  const limit = options.limit ?? 500;
  const where = ["status<>'running'", 'coalesce(finished_at,started_at)<?'];
  const args: (string | number | null)[] = [beforeIso];
  if (options.scope_kind) { where.push('scope_kind=?'); args.push(options.scope_kind); }
  if (options.scope_id) { where.push('scope_id=?'); args.push(options.scope_id); }
  return Number(store.run(
    `DELETE FROM memory_consolidation_runs WHERE id IN (SELECT id FROM memory_consolidation_runs WHERE ${where.join(' AND ')} ORDER BY coalesce(finished_at,started_at),id LIMIT ?)`,
    ...args, limit,
  ).changes);
}
