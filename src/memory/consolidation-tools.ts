import type { Row, Store } from '../storage/database.js';
import type { Manager } from '../projects/service.js';
import type { ManagementService } from '../management/service.js';
import type { ChannelService } from '../channels/service.js';
import type { ActorContext } from '../identity/authorization.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, fields, HttpError, text, type Json } from '../core/security.js';
import { TaskError } from '../agent/common.js';
import { readToolResult } from '../agent/tool-results.js';
import { loadDevelopmentCandidateMeta, logContent } from '../storage/payloads.js';
import { traceClean, traceSource } from '../tasks/trace.js';
import { readDispatchThread } from '../dispatch/store.js';
import {
  knowledgePath,
  projectNoteVersions,
  readProjectNote,
  resolveNoteId,
  saveProjectNote,
  searchProjectNotes,
  stripNotesPrefix,
} from './project.js';
import { memoryAuthorize } from './access.js';
import { migrateLegacyProjectMemories } from './migration.js';
import {
  assistantHome,
  isMemorySubpath,
  normalizeAssistantMemoryPath,
  type AssistantHomes,
} from '../service-roles/assistant-computers.js';
import { bindingScope } from '../channels/service-bindings.js';
import { managementAssistant } from '../service-roles/roles.js';
import { permitsTool, type RolePermissions } from '../roles/permissions.js';
import {
  listConsolidationRuns,
  type ConsolidationFileChange,
  type ConsolidationScopeKind,
} from './consolidation-storage.js';

const fn = (name: string, description: string, properties: Json, required: string[] = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

const ASSISTANT_READ_LIMIT = 1024 * 1024;
const DEFAULT_RECORD_CHARS = 16_000;
const MAX_RECORD_CHARS = 64_000;
const SENSITIVE_HOME_READ = /(^|\/)(?:\.env(?:\.[^/]*)?|\.git|\.ssh|\.aws|credentials(?:\.(?!ts$|tsx$|js$|mjs$|cjs$|jsx$|py$|md$|mdx$|html$|css$|scss$|vue$|svelte$|rs$|go$|java$|kt$|rb$|php$|sh$)[^/]*)?|id_(?:rsa|ed25519)|[^/]+\.(?:pem|key))(?:\/|$)/i;

export const finishConsolidationTool = fn(
  'finish_consolidation',
  'Finish this memory consolidation pass and submit a concise factual summary of what you reviewed, changed, merged, or deleted.',
  {
    summary: { type: 'string', maxLength: 4000, description: 'Concise factual summary of consolidation findings and actions taken.' },
    changed_files: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 500, description: 'Optional list of memory file paths created, updated, or moved.' },
    deleted_files: { type: 'array', items: { type: 'string', maxLength: 500 }, maxItems: 500, description: 'Optional list of memory file paths deleted.' },
    notes: { type: 'string', maxLength: 2000, description: 'Optional open caveats or observations for future passes.' },
  },
  ['summary'],
);

const listConsolidationRunsTool = fn(
  'list_consolidation_runs',
  'List prior memory consolidation runs for this scope (newest first) with status, timestamps, changed/deleted files, and summaries.',
  {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  },
);

export const projectConsolidationTools = [
  readToolResult,
  fn('list_project_notes', 'List files and directories in shared project notes (../notes/). Defaults to listing the full recursive tree.', {
    directory: { type: 'string', description: 'Optional relative directory inside ../notes/ (empty string for root).' },
    include_deleted: { type: 'boolean', description: 'Include soft-deleted notes still present in .write-history (default false).' },
    recursive: { type: 'boolean', description: 'List all subdirectories recursively (default true).' },
  }),
  fn('search_project_memory', 'Search shared project notes in ../notes/ by filename, path, or UTF-8 text content with excerpt previews.', {
    query: { type: 'string', maxLength: 200 },
    path: { type: 'string', description: 'Optional relative path prefix inside ../notes/.' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  fn('read_project_memory', 'Read one project note file revision from ../notes/ by file id or relative path, with character pagination.', {
    id: { type: 'string', description: 'File id (e.g. f:...) or relative path inside ../notes/.' },
    revision: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECORD_CHARS },
  }, ['id']),
  fn('read_project_note_versions', 'List revision history of one project note file by id or relative path.', {
    id: { type: 'string' },
  }, ['id']),
  fn('save_project_note', 'Create or update a UTF-8 project note file in ../notes/. Automatically redacts credentials. Pass expected_revision when updating an existing note.', {
    path: { type: 'string', description: 'Relative path inside ../notes/ (e.g. INDEX.md or guides/testing.md).' },
    id: { type: 'string', description: 'Optional stable file id when updating an existing note.' },
    content: { type: 'string', description: 'Complete UTF-8 content to write (at most 256 KiB).' },
    expected_revision: { type: 'integer', minimum: 0, description: 'Optimistic concurrency revision (0 for new file, current revision for updates).' },
  }, ['content']),
  fn('move_project_note', 'Move or rename an existing project note file in ../notes/.', {
    id: { type: 'string', description: 'File id or current relative path.' },
    path: { type: 'string', description: 'New relative path inside ../notes/.' },
    expected_revision: { type: 'integer', minimum: 1 },
  }, ['id', 'path', 'expected_revision']),
  fn('delete_project_note', 'Soft-delete an obsolete or redundant project note in ../notes/. Its revision history remains recoverable in .write-history.', {
    id: { type: 'string', description: 'File id or relative path inside ../notes/.' },
    path: { type: 'string', description: 'Relative path inside ../notes/ (alternative to id).' },
    expected_revision: { type: 'integer', minimum: 1, description: 'Optional optimistic concurrency revision.' },
  }),
  fn('list_project_tasks', 'List all historical tasks of this project with optional status, kind, date range, and keyword filters (paginated, newest first).', {
    status: { type: 'string', maxLength: 64 },
    kind: { type: 'string', maxLength: 64 },
    since: { type: 'string', maxLength: 64, description: 'ISO timestamp lower bound on updated_at.' },
    until: { type: 'string', maxLength: 64, description: 'ISO timestamp upper bound on updated_at.' },
    query: { type: 'string', maxLength: 200, description: 'Substring filter against task id, object number, summary, or error_code.' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  fn('read_project_task', 'Read full details of one task in this project: detail (default), contract, result, runs, or logs (reconstructed from trajectory files).', {
    task_id: { type: 'string' },
    section: { type: 'string', enum: ['detail', 'contract', 'result', 'runs', 'logs'] },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['task_id']),
  fn('list_task_records', 'List task_history event records of one project task (supports run_id, types filter, and id pagination) along with source_ref handles.', {
    task_id: { type: 'string' },
    run_id: { type: 'string' },
    types: { type: 'array', items: { type: 'string', maxLength: 64 }, maxItems: 32 },
    after: { type: 'integer', minimum: 0, description: 'Return records with id > after (ascending).' },
    before: { type: 'integer', minimum: 1, description: 'Return records with id < before (descending).' },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }, ['task_id']),
  fn('read_task_record', 'Read full reconstructed content of any task trace reference (task:<id>, contract:revision:<n>, task_history:<id>, task_runs:<id>:context|config, task_tools:<id>, task_logs:<id>, github_effects:<id>, model_requests:<id>:request|response, role_snapshots:<sha>) with character pagination.', {
    task_id: { type: 'string' },
    ref: { type: 'string', maxLength: 200 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECORD_CHARS },
  }, ['task_id', 'ref']),
  fn('list_dispatch_threads', 'List all persistent Object Manager dispatch threads of this project (Issue/PR/release/actions/schedule threads).', {
    object_type: { type: 'string', maxLength: 64 },
    updated_after: { type: 'string', maxLength: 64 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  fn('read_dispatch_thread', 'Read one Object Manager dispatch thread (rolling summary, decision turns) and optionally its paginated dispatch_events.', {
    thread_key: { type: 'string', maxLength: 240 },
    include_events: { type: 'boolean', description: 'Include dispatch_events for this thread (default true).' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['thread_key']),
  listConsolidationRunsTool,
  finishConsolidationTool,
];

const assistantMemoryFileTools = [
  fn('list_files', 'List files and subdirectories in ~/memory/ (or another read-only subdirectory under ~). Does not follow symlinks.', {
    path: { type: 'string', description: 'Directory path under ~ (default "~/memory").' },
    recursive: { type: 'boolean', description: 'List files recursively (default true).' },
  }),
  fn('read_file', 'Read a UTF-8 file under ~/memory/ (or non-sensitive files under ~) with optional character pagination.', {
    path: { type: 'string', description: 'Path under ~/memory/ (e.g. "~/memory/INDEX.md").' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECORD_CHARS },
  }, ['path']),
  fn('write_file', 'Create or replace a UTF-8 Markdown memory file strictly inside ~/memory/. Writes outside ~/memory/ are refused. Automatically redacts credentials.', {
    path: { type: 'string', description: 'Path strictly inside ~/memory/ (e.g. "~/memory/INDEX.md" or "~/memory/preferences.md").' },
    content: { type: 'string', description: 'Complete UTF-8 text content to save (at most 256 KiB).' },
  }, ['path', 'content']),
  fn('delete_file', 'Delete a redundant or obsolete file or subdirectory strictly inside ~/memory/. Deleting ~/memory itself or anything outside ~/memory/ is refused.', {
    path: { type: 'string', description: 'Path strictly inside ~/memory/ to delete.' },
  }, ['path']),
];

const ledgerHistoryTools = [
  fn('search_conversation_history', 'Search or paginate the full local Feishu conversation message ledger (excludes recalled and sensitive messages, strictly within current retention and fence).', {
    chat_id: { type: 'string', description: 'Optional chat id (required for personal assistant only when multiple bound private chats exist).' },
    message_id: { type: 'string' },
    sender_id: { type: 'string' },
    reply_to: { type: 'string' },
    thread_id: { type: 'string' },
    from: { type: 'integer', minimum: 0, description: 'Epoch ms lower bound on created_at.' },
    to: { type: 'integer', minimum: 0, description: 'Epoch ms upper bound on created_at.' },
    keyword: { type: 'string', maxLength: 200 },
    cursor: { type: 'string' },
    direction: { type: 'string', enum: ['older'] },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  }),
  fn('read_conversation_message', 'Read the full text of one local Feishu message (non-recalled, non-sensitive) with character pagination.', {
    chat_id: { type: 'string', description: 'Optional chat id (for personal assistant with multiple bound private chats).' },
    message_id: { type: 'string' },
    part: { type: 'string', enum: ['content', 'resources'] },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECORD_CHARS },
  }, ['message_id']),
  fn('read_conversation_summary', 'Read the current rolling summary of the Feishu chat when valid under the current authorization fence.', {
    chat_id: { type: 'string', description: 'Optional chat id (for personal assistant with multiple bound private chats).' },
  }),
];

const ownTaskReadTools = [
  fn('list_own_tasks', 'List all historical independent own tasks visible under the current fence (newest first, paginated).', {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  fn('read_own_task', 'Read full instructions and conclusions of one visible independent own task.', {
    task_id: { type: 'string' },
  }, ['task_id']),
];

const scopedProjectReadTools = [
  fn('list_projects', 'List projects currently accessible in this assistant scope (read-only).', {}),
  fn('list_project_tasks', 'List historical tasks of one accessible project (read-only).', {
    repository: { type: 'string', description: 'Repository full name (owner/name) or project id.' },
    status: { type: 'string', maxLength: 64 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['repository']),
  fn('read_project_task', 'Read one task of an accessible project (read-only).', {
    repository: { type: 'string' },
    task_id: { type: 'string' },
    section: { type: 'string', enum: ['detail', 'contract', 'result', 'runs', 'logs'] },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['repository', 'task_id']),
  fn('search_project_memory', 'Search shared project notes (../notes/) of one accessible project (read-only).', {
    repository: { type: 'string' },
    query: { type: 'string', maxLength: 200 },
    path: { type: 'string' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['repository']),
  fn('read_project_memory', 'Read one shared project note of an accessible project (read-only).', {
    repository: { type: 'string' },
    id: { type: 'string' },
    revision: { type: 'integer', minimum: 1 },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: MAX_RECORD_CHARS },
  }, ['repository', 'id']),
];

export function groupConsolidationTools(permissions: RolePermissions) {
  const canReadTasks = permitsTool(permissions, 'list_project_tasks');
  const canReadMemory = permissions.project_memory !== 'none';
  return [
    readToolResult,
    ...assistantMemoryFileTools,
    ...ledgerHistoryTools,
    fn('list_chat_members', 'List cached members of this Feishu group (open_id and display name when cached).', {
      query: { type: 'string', maxLength: 100 },
      offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    }),
    ...ownTaskReadTools,
    scopedProjectReadTools[0]!,
    ...(canReadTasks ? [scopedProjectReadTools[1]!, scopedProjectReadTools[2]!] : []),
    ...(canReadMemory ? [scopedProjectReadTools[3]!, scopedProjectReadTools[4]!] : []),
    listConsolidationRunsTool,
    finishConsolidationTool,
  ];
}

export const personalConsolidationTools = [
  readToolResult,
  ...assistantMemoryFileTools,
  fn('list_management_conversations', 'List all your Web console and Feishu management conversations accessible under your current scope and authorization revision (newest first).', {
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }),
  fn('read_management_conversation', 'Read messages and optional step events of one management conversation under your current authorization revision (paginated).', {
    conversation_id: { type: 'string' },
    include_events: { type: 'boolean', description: 'Include management_events for returned messages (default true).' },
    offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['conversation_id']),
  fn('list_feishu_private_chats', 'List your currently active bound Feishu private chats accessible in this scope.', {}),
  ...ledgerHistoryTools,
  ...ownTaskReadTools,
  ...scopedProjectReadTools,
  listConsolidationRunsTool,
  finishConsolidationTool,
];

export interface ConsolidationMutationTracker {
  recordChanged(entry: ConsolidationFileChange): void;
  recordDeleted(entry: ConsolidationFileChange): void;
  changed(): ConsolidationFileChange[];
  deleted(): ConsolidationFileChange[];
}

export function createMutationTracker(): ConsolidationMutationTracker {
  const changedMap = new Map<string, ConsolidationFileChange>();
  const deletedMap = new Map<string, ConsolidationFileChange>();
  return {
    recordChanged(entry) {
      deletedMap.delete(entry.path);
      changedMap.set(entry.path, entry);
    },
    recordDeleted(entry) {
      changedMap.delete(entry.path);
      deletedMap.set(entry.path, entry);
    },
    changed: () => [...changedMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
    deleted: () => [...deletedMap.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function parseJsonSafe(raw: unknown, fallback: any = null): any {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function readPagedTasks(
  store: Store,
  repositoryId: string,
  input: Json,
): Json {
  fields(input, ['repository', 'status', 'kind', 'since', 'until', 'query', 'offset', 'limit']);
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 20 : Number(input.limit);
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    fail(400, 'invalid_pagination');
  }
  const where = ['repository_id=?'];
  const args: (string | number | null)[] = [repositoryId];
  if (typeof input.status === 'string' && input.status.trim()) { where.push('status=?'); args.push(input.status.trim()); }
  if (typeof input.kind === 'string' && input.kind.trim()) { where.push('kind=?'); args.push(input.kind.trim()); }
  if (typeof input.since === 'string' && input.since.trim()) { where.push('updated_at>=?'); args.push(input.since.trim()); }
  if (typeof input.until === 'string' && input.until.trim()) { where.push('updated_at<=?'); args.push(input.until.trim()); }
  if (typeof input.query === 'string' && input.query.trim()) {
    const q = `%${input.query.trim().toLowerCase()}%`;
    where.push("(lower(coalesce(summary,'')) LIKE ? OR lower(id) LIKE ? OR cast(coalesce(object_number,'') AS TEXT) LIKE ? OR lower(coalesce(error_code,'')) LIKE ?)");
    args.push(q, q, q, q);
  }
  const clause = where.join(' AND ');
  const total = Number(store.get(`SELECT count(*) AS n FROM tasks WHERE ${clause}`, ...args)?.n ?? 0);
  const rows = store.all(
    `SELECT id,kind,status,phase,object_number,attempt,priority,summary,error_code,source_task_id,created_at,updated_at
     FROM tasks WHERE ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
    ...args, limit, offset,
  );
  const redactor = configuredRedactor(store);
  return {
    tasks: rows.map(r => redactor.clean(traceClean({
      task_id: r.id,
      kind: r.kind,
      status: r.status,
      phase: r.phase,
      object_number: r.object_number ?? null,
      attempt: r.attempt,
      priority: r.priority ?? null,
      summary: r.summary ?? null,
      error_code: r.error_code ?? null,
      source_task_id: r.source_task_id ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }))),
    total,
    next_offset: offset + rows.length < total ? offset + rows.length : null,
  };
}

function readOneTask(
  store: Store,
  repositoryId: string,
  input: Json,
): Json {
  fields(input, ['repository', 'task_id', 'section', 'offset', 'limit']);
  const taskId = text(input.task_id, 128);
  const task = store.get('SELECT * FROM tasks WHERE id=? AND repository_id=?', taskId, repositoryId);
  if (!task) return { error: 'task_not_found' };
  const section = typeof input.section === 'string' ? input.section : 'detail';
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? 30 : Number(input.limit);
  if (!['detail', 'contract', 'result', 'runs', 'logs'].includes(section)) fail(400, 'invalid_arguments');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_pagination');

  const redactor = configuredRedactor(store);
  const clean = (value: unknown) => redactor.clean(traceClean(value));
  const record = store.get('SELECT * FROM task_records WHERE task_id=?', taskId);

  if (section === 'contract') {
    const candidate = loadDevelopmentCandidateMeta(store, taskId);
    return clean({
      task_id: taskId,
      revision: record?.revision ?? null,
      contract: parseJsonSafe(record?.contract),
      candidate,
      input: parseJsonSafe(task.input),
    });
  }
  if (section === 'result') {
    const effects = store.all('SELECT id,kind,state,request,response,created_at FROM github_effects WHERE task_id=? ORDER BY rowid DESC LIMIT 20', taskId)
      .map(e => ({ id: e.id, ref: 'github_effects:' + e.id, kind: e.kind, state: e.state, request: parseJsonSafe(e.request, e.request), response: parseJsonSafe(e.response, e.response), created_at: e.created_at }));
    return clean({
      task_id: taskId,
      status: task.status,
      phase: task.phase,
      error_code: task.error_code ?? null,
      error_detail: task.error_detail ?? null,
      result: parseJsonSafe(task.result, task.result),
      acceptance: parseJsonSafe(record?.acceptance),
      github_effects: effects,
    });
  }
  if (section === 'runs') {
    const total = Number(store.get('SELECT count(*) AS n FROM task_runs WHERE task_id=?', taskId)?.n ?? 0);
    const rows = store.all(
      'SELECT id,kind,attempt,revision,candidate_id,parent_run_id,previous_run_id,role,harness,status,stop_reason,started_at,ended_at FROM task_runs WHERE task_id=? ORDER BY rowid ASC LIMIT ? OFFSET ?',
      taskId, limit, offset,
    );
    return clean({
      task_id: taskId,
      runs: rows.map(r => ({
        ...r,
        context_ref: `task_runs:${r.id}:context`,
        config_ref: `task_runs:${r.id}:config`,
      })),
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    });
  }
  if (section === 'logs') {
    const total = Number(store.get('SELECT count(*) AS n FROM task_logs WHERE task_id=?', taskId)?.n ?? 0);
    const rows = store.all(
      'SELECT id,content,content_ref,run_id,role,created_at FROM task_logs WHERE task_id=? ORDER BY rowid ASC LIMIT ? OFFSET ?',
      taskId, limit, offset,
    );
    return clean({
      task_id: taskId,
      logs: rows.map(r => {
        let body: string;
        try { body = logContent(store, r); } catch { body = String(r.content ?? ''); }
        return { id: r.id, ref: `task_logs:${r.id}`, run_id: r.run_id ?? null, role: r.role ?? null, created_at: r.created_at, content: body.slice(0, 4000), truncated: body.length > 4000 };
      }),
      total,
      next_offset: offset + rows.length < total ? offset + rows.length : null,
    });
  }

  const updates = store.hasTable('review_updates')
    ? store.all('SELECT id,event_key,data FROM review_updates WHERE task_id=? ORDER BY id ASC LIMIT 30', taskId)
        .map(u => ({ id: u.id, event_key: u.event_key, data: parseJsonSafe(u.data, u.data) }))
    : [];
  const runsCount = Number(store.get('SELECT count(*) AS n FROM task_runs WHERE task_id=?', taskId)?.n ?? 0);
  const historyCount = Number(store.get('SELECT count(*) AS n FROM task_history WHERE task_id=?', taskId)?.n ?? 0);
  const logsCount = Number(store.get('SELECT count(*) AS n FROM task_logs WHERE task_id=?', taskId)?.n ?? 0);
  return clean({
    task: {
      id: task.id,
      repository_id: task.repository_id,
      kind: task.kind,
      status: task.status,
      phase: task.phase,
      object_number: task.object_number ?? null,
      attempt: task.attempt,
      head_sha: task.head_sha ?? null,
      summary: task.summary ?? null,
      error_code: task.error_code ?? null,
      error_detail: task.error_detail ?? null,
      source_task_id: task.source_task_id ?? null,
      created_at: task.created_at,
      updated_at: task.updated_at,
    },
    revision: record?.revision ?? null,
    contract: parseJsonSafe(record?.contract),
    result: parseJsonSafe(task.result, task.result),
    acceptance: parseJsonSafe(record?.acceptance),
    review_updates: updates,
    counts: { runs: runsCount, history: historyCount, logs: logsCount },
  });
}

function readHomeRelative(value: unknown, defaultPath = '~/memory'): string | null {
  const raw = value === undefined ? defaultPath : typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 1024 || raw.includes('\0') || raw.includes('\\')) fail(400, 'invalid_path');
  let rel: string;
  if (raw === '~' || raw === assistantHome) return null;
  if (raw.startsWith('~/')) rel = raw.slice(2);
  else if (raw.startsWith(assistantHome + '/')) rel = raw.slice(assistantHome.length + 1);
  else if (raw.startsWith('/')) return fail(400, 'invalid_path');
  else rel = raw;
  const parts = rel.split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..') || parts.length > 64) fail(400, 'invalid_path');
  return parts.length ? parts.join('/') : null;
}

function queryCleanLedger(
  store: Store,
  channels: ChannelService,
  chatId: string,
  input: Json,
  projects?: string[],
  fence?: string,
): Json {
  const chat = store.get('SELECT id,retained_after FROM channel_chats WHERE id=?', chatId);
  if (!chat) return { error: 'channel_chat_not_found' };
  const retainedAfter = Number(chat.retained_after ?? 0);
  const queryInput: Record<string, any> = {};
  for (const key of ['message_id', 'sender_id', 'reply_to', 'thread_id', 'from', 'to', 'keyword', 'cursor', 'limit', 'direction']) {
    if (input[key] !== undefined) queryInput[key] = input[key];
  }
  if (retainedAfter > 0) {
    queryInput.from = Math.max(retainedAfter, Number(queryInput.from ?? 0));
  }
  const result = channels.ledger.query(chatId, queryInput, projects, fence);
  const redactor = configuredRedactor(store);
  const rawMessages = Array.isArray(result.messages) ? (result.messages as Json[]) : [];
  const filtered = rawMessages
    .filter(m => !m.deleted && !m.sensitive && Number(m.created_at ?? 0) >= retainedAfter)
    .map(m => {
      const { resources, ...rest } = m;
      const content = redactor.text(String(m.content ?? ''));
      return {
        ...rest,
        content: content.slice(0, 2000),
        truncated: content.length > 2000,
        resource_references_available: !!resources,
      };
    });
  return { ...result, messages: filtered };
}

function readCleanLedgerMessage(
  store: Store,
  channels: ChannelService,
  chatId: string,
  input: Json,
  projects?: string[],
  fence?: string,
): Json {
  const chat = store.get('SELECT id,retained_after FROM channel_chats WHERE id=?', chatId);
  if (!chat) return { error: 'channel_chat_not_found' };
  const part = text(input.part ?? 'content');
  const offset = input.offset === undefined ? 0 : Number(input.offset);
  const limit = input.limit === undefined ? DEFAULT_RECORD_CHARS : Number(input.limit);
  if (!['content', 'resources'].includes(part) || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_CHARS) {
    return { error: 'invalid_message_chunk' };
  }
  const found = (channels.ledger.query(chatId, { message_id: text(input.message_id, 200), limit: 1 }, projects, fence).messages as Json[])[0];
  if (!found || found.deleted || found.sensitive || Number(found.created_at ?? 0) < Number(chat.retained_after ?? 0)) {
    return { state: 'not_found_locally' };
  }
  const redactor = configuredRedactor(store);
  const rawText = part === 'content'
    ? redactor.text(String(found.content ?? ''))
    : redactor.text(JSON.stringify(found.resources ?? []));
  return {
    message_id: found.message_id,
    sender_id: found.sender_id,
    sender_tenant: found.sender_tenant,
    sender_type: found.sender_type,
    message_type: found.message_type,
    created_at: found.created_at,
    parent_id: found.parent_id,
    root_id: found.root_id,
    thread_id: found.thread_id,
    part,
    offset,
    text: rawText.slice(offset, offset + limit),
    next_offset: offset + limit < rawText.length ? offset + limit : null,
    total_characters: rawText.length,
  };
}

function readChatSummary(store: Store, chatId: string, expectedFence?: string): Json {
  const saved = store.get('SELECT * FROM channel_chat_summaries WHERE chat_id=?', chatId);
  if (!saved) return { state: 'not_compacted' };
  const sources = parseJsonSafe(saved.sources, {});
  if (expectedFence !== undefined && sources?.authorization_fence !== expectedFence) {
    return { state: 'not_compacted' };
  }
  const payload = store.secrets.open(saved.payload, 'channel-summary:' + chatId);
  return configuredRedactor(store).clean(traceClean({
    ...payload,
    sources,
    through_time: saved.through_time,
    through_id: saved.through_id,
    authority: 'derived; inspect original messages',
  }));
}

export interface ProjectConsolidationToolDeps {
  store: Store;
  manager: Manager;
  repositoryId: string;
  runId: string;
  guard: () => Promise<void>;
  mutations: ConsolidationMutationTracker;
}

export function createProjectConsolidationExecutor(deps: ProjectConsolidationToolDeps) {
  const { store, manager, repositoryId, runId, guard, mutations } = deps;
  const actorTag = `system:memory-consolidation:${runId}`;
  const redactor = () => configuredRedactor(store);

  return async (name: string, rawArgs: unknown): Promise<Json> => {
    await guard();
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Json;
    try {
      if (name === 'list_project_notes') {
        fields(args, ['directory', 'include_deleted', 'recursive']);
        await migrateLegacyProjectMemories(store, manager, repositoryId);
        const dir = typeof args.directory === 'string' && args.directory.trim() ? knowledgePath(stripNotesPrefix(args.directory.trim())) : '';
        const params = new URLSearchParams({
          directory: dir,
          query: '',
          include_deleted: args.include_deleted === true ? '1' : '0',
          deleted_only: '0',
          recursive: args.recursive === false ? '0' : '1',
          preview: '0',
        });
        const tree = await manager.call('GET', `/v1/projects/${repositoryId}/file-tree?` + params);
        await guard();
        return tree;
      }
      if (name === 'search_project_memory') {
        fields(args, ['query', 'path', 'offset', 'limit']);
        await migrateLegacyProjectMemories(store, manager, repositoryId);
        const result = await searchProjectNotes(manager, repositoryId, String(args.query ?? ''), {
          path: typeof args.path === 'string' ? args.path : undefined,
          offset: args.offset === undefined ? undefined : Number(args.offset),
          limit: args.limit === undefined ? undefined : Number(args.limit),
        });
        await guard();
        return result as unknown as Json;
      }
      if (name === 'read_project_memory') {
        fields(args, ['id', 'revision', 'offset', 'limit']);
        await migrateLegacyProjectMemories(store, manager, repositoryId);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? DEFAULT_RECORD_CHARS : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_CHARS) {
          return { error: 'invalid_memory_offset' };
        }
        const fileData = await readProjectNote(manager, repositoryId, text(args.id, 500), args.revision === undefined ? undefined : Number(args.revision));
        await guard();
        if (fileData?.binary || fileData?.availability === 'unsupported_format') {
          return { id: fileData.id, path: fileData.path, revision: Number(fileData.revision ?? 1), availability: 'unsupported_format' };
        }
        const body = redactor().text(String(fileData?.content ?? ''));
        return {
          id: fileData.id,
          path: fileData.path,
          name: fileData.name,
          revision: Number(fileData.revision ?? 1),
          current_revision: Number(fileData.current_revision ?? fileData.revision ?? 1),
          deleted: Boolean(fileData.deleted),
          historical: Boolean(fileData.historical),
          body: body.slice(offset, offset + limit),
          offset,
          next_offset: offset + limit < body.length ? offset + limit : null,
          total_characters: body.length,
        };
      }
      if (name === 'read_project_note_versions') {
        fields(args, ['id']);
        await migrateLegacyProjectMemories(store, manager, repositoryId);
        const versions = await projectNoteVersions(manager, repositoryId, text(args.id, 500));
        await guard();
        return versions;
      }
      if (name === 'save_project_note') {
        fields(args, ['path', 'id', 'content', 'expected_revision']);
        if (typeof args.content !== 'string') return { error: 'invalid_note_content' };
        await migrateLegacyProjectMemories(store, manager, repositoryId);
        const isNew = args.expected_revision === 0 && !args.id;
        const saved = await saveProjectNote(store, manager, repositoryId, {
          id: typeof args.id === 'string' && args.id.trim() ? args.id.trim() : undefined,
          path: typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined,
          content: args.content,
          expected_revision: args.expected_revision === undefined ? undefined : Number(args.expected_revision),
        }, actorTag);
        await guard();
        mutations.recordChanged({
          path: String(saved.path ?? args.path ?? ''),
          id: typeof saved.id === 'string' ? saved.id : undefined,
          revision: Number.isSafeInteger(saved.revision) ? Number(saved.revision) : undefined,
          action: isNew || Number(saved.revision) === 1 ? 'created' : 'updated',
        });
        return { id: saved.id, path: saved.path, revision: saved.revision };
      }
      if (name === 'move_project_note') {
        fields(args, ['id', 'path', 'expected_revision']);
        const expected = Number(args.expected_revision);
        if (!Number.isSafeInteger(expected) || expected < 1) return { error: 'invalid_note_revision' };
        const id = await resolveNoteId(manager, repositoryId, text(args.id, 500));
        const dest = knowledgePath(stripNotesPrefix(text(args.path, 500)));
        const moved = await manager.call('POST', `/v1/projects/${repositoryId}/file-tree/${encodeURIComponent(id)}/move`, {
          path: dest,
          expected_revision: expected,
          actor: actorTag,
        });
        await guard();
        const file = moved?.file ?? moved;
        mutations.recordChanged({
          path: String(file?.path ?? dest),
          id: String(file?.id ?? id),
          revision: Number.isSafeInteger(file?.revision) ? Number(file.revision) : undefined,
          action: 'moved',
        });
        return { id: file?.id ?? id, path: file?.path ?? dest, revision: file?.revision };
      }
      if (name === 'delete_project_note') {
        fields(args, ['id', 'path', 'expected_revision']);
        const target = typeof args.id === 'string' && args.id.trim()
          ? args.id.trim()
          : typeof args.path === 'string' && args.path.trim()
            ? args.path.trim()
            : '';
        if (!target) return { error: 'invalid_note_path' };
        const id = await resolveNoteId(manager, repositoryId, text(target, 500));
        let expected: number;
        if (args.expected_revision !== undefined) {
          expected = Number(args.expected_revision);
          if (!Number.isSafeInteger(expected) || expected < 1) return { error: 'invalid_note_revision' };
        } else {
          const current = await manager.call('GET', `/v1/projects/${repositoryId}/file-tree/${encodeURIComponent(id)}`);
          const curFile = current?.file ?? current;
          expected = Number(curFile?.current_revision ?? curFile?.revision ?? 0);
          if (!Number.isSafeInteger(expected) || expected < 1) return { error: 'note_not_found' };
        }
        const deleted = await manager.call('DELETE', `/v1/projects/${repositoryId}/file-tree/${encodeURIComponent(id)}`, {
          expected_revision: expected,
          actor: actorTag,
        });
        await guard();
        const file = deleted?.file ?? deleted;
        mutations.recordDeleted({
          path: String(file?.path ?? target),
          id: String(file?.id ?? id),
          revision: Number.isSafeInteger(file?.revision) ? Number(file.revision) : undefined,
          action: 'deleted',
        });
        return { id: file?.id ?? id, path: file?.path ?? target, revision: file?.revision, deleted: true };
      }
      if (name === 'list_project_tasks') {
        return readPagedTasks(store, repositoryId, args);
      }
      if (name === 'read_project_task') {
        return readOneTask(store, repositoryId, args);
      }
      if (name === 'list_task_records') {
        fields(args, ['task_id', 'run_id', 'types', 'after', 'before', 'limit']);
        const taskId = text(args.task_id, 128);
        if (!store.get('SELECT 1 FROM tasks WHERE id=? AND repository_id=?', taskId, repositoryId)) {
          return { error: 'task_not_found' };
        }
        const limit = args.limit === undefined ? 50 : Number(args.limit);
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail(400, 'invalid_pagination');
        const where = ['task_id=?'];
        const params: (string | number | null)[] = [taskId];
        if (typeof args.run_id === 'string' && args.run_id.trim()) { where.push('run_id=?'); params.push(args.run_id.trim()); }
        if (Array.isArray(args.types) && args.types.length) {
          const types = args.types.filter((t): t is string => typeof t === 'string' && t.length > 0 && t.length <= 64).slice(0, 32);
          if (types.length) { where.push(`type IN (${types.map(() => '?').join(',')})`); params.push(...types); }
        }
        const descending = args.before !== undefined;
        if (args.after !== undefined) {
          const after = Number(args.after);
          if (!Number.isSafeInteger(after) || after < 0) fail(400, 'invalid_pagination');
          where.push('id>?'); params.push(after);
        }
        if (args.before !== undefined) {
          const before = Number(args.before);
          if (!Number.isSafeInteger(before) || before < 1) fail(400, 'invalid_pagination');
          where.push('id<?'); params.push(before);
        }
        const total = Number(store.get(`SELECT count(*) AS n FROM task_history WHERE ${where.join(' AND ')}`, ...params)?.n ?? 0);
        const rows = store.all(
          `SELECT id,type,run_id,actor,source_ref,created_at,length(data) AS body_chars,substr(data,1,400) AS preview
           FROM task_history WHERE ${where.join(' AND ')} ORDER BY id ${descending ? 'DESC' : 'ASC'} LIMIT ?`,
          ...params, limit + 1,
        );
        const more = rows.length > limit;
        rows.splice(limit);
        const cleanRedactor = redactor();
        return {
          task_id: taskId,
          events: rows.map(r => ({
            id: Number(r.id),
            ref: 'task_history:' + r.id,
            type: r.type,
            run_id: r.run_id ?? null,
            actor: r.actor ?? null,
            source_ref: r.source_ref ?? null,
            created_at: r.created_at,
            body_chars: Number(r.body_chars ?? 0),
            preview: cleanRedactor.text(String(r.preview ?? '')),
          })),
          total,
          next_after: !descending && more && rows.length ? Number(rows.at(-1)!.id) : null,
          next_before: descending && more && rows.length ? Number(rows.at(-1)!.id) : null,
        };
      }
      if (name === 'read_task_record') {
        fields(args, ['task_id', 'ref', 'offset', 'limit']);
        const taskId = text(args.task_id, 128);
        const ref = text(args.ref, 200);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? DEFAULT_RECORD_CHARS : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_CHARS) {
          fail(400, 'invalid_pagination');
        }
        if (!store.get('SELECT 1 FROM tasks WHERE id=? AND repository_id=?', taskId, repositoryId)) {
          return { error: 'task_not_found' };
        }
        const raw = traceSource(store, taskId, ref);
        const cleaned = redactor().clean(traceClean(raw));
        const serialized = JSON.stringify(cleaned) ?? 'null';
        return {
          task_id: taskId,
          ref,
          offset,
          total_characters: serialized.length,
          next_offset: offset + limit < serialized.length ? offset + limit : null,
          text: serialized.slice(offset, offset + limit),
        };
      }
      if (name === 'list_dispatch_threads') {
        fields(args, ['object_type', 'updated_after', 'offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          fail(400, 'invalid_pagination');
        }
        if (!store.hasTable('dispatch_threads')) return { threads: [], total: 0, next_offset: null };
        const where = ['repository_id=?'];
        const params: (string | number | null)[] = [repositoryId];
        if (typeof args.object_type === 'string' && args.object_type.trim()) { where.push('object_type=?'); params.push(args.object_type.trim()); }
        if (typeof args.updated_after === 'string' && args.updated_after.trim()) { where.push('updated_at>=?'); params.push(args.updated_after.trim()); }
        const clause = where.join(' AND ');
        const total = Number(store.get(`SELECT count(*) AS n FROM dispatch_threads WHERE ${clause}`, ...params)?.n ?? 0);
        const rows = store.all(
          `SELECT thread_key,object_type,object_number,messages,summary,active_task_id,updated_at
           FROM dispatch_threads WHERE ${clause} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
          ...params, limit, offset,
        );
        const cleanRedactor = redactor();
        return {
          threads: rows.map(r => {
            const messages = parseJsonSafe(r.messages, []);
            return {
              thread_key: r.thread_key,
              object_type: r.object_type,
              object_number: r.object_number ?? null,
              active_task_id: r.active_task_id ?? null,
              updated_at: r.updated_at,
              message_count: Array.isArray(messages) ? messages.length : 0,
              summary_preview: r.summary ? cleanRedactor.text(String(r.summary)).slice(0, 400) : null,
            };
          }),
          total,
          next_offset: offset + rows.length < total ? offset + rows.length : null,
        };
      }
      if (name === 'read_dispatch_thread') {
        fields(args, ['thread_key', 'include_events', 'offset', 'limit']);
        const key = text(args.thread_key, 240);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
          fail(400, 'invalid_pagination');
        }
        const row = store.hasTable('dispatch_threads')
          ? store.get('SELECT * FROM dispatch_threads WHERE thread_key=? AND repository_id=?', key, repositoryId)
          : undefined;
        if (!row) return { error: 'dispatch_thread_not_found' };
        const thread = readDispatchThread(store, key, repositoryId);
        let events: Json[] = [];
        let eventsTotal = 0;
        if (args.include_events !== false && store.hasTable('dispatch_events')) {
          // A dispatch thread key is scoped to its repository (verified above on dispatch_threads), so filtering
          // dispatch_events by thread_key alone uses the dispatch_events_thread index instead of scanning every event
          // of the repository.
          eventsTotal = Number(store.get('SELECT count(*) AS n FROM dispatch_events WHERE thread_key=?', key)?.n ?? 0);
          events = store.all(
            `SELECT id,type,source,object_type,object_number,summary,facts,state,decision,reason,brief,result,rule,error,created_at,decided_at
             FROM dispatch_events WHERE thread_key=? ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`,
            key, limit, offset,
          ).map(ev => ({
            ...ev,
            facts: parseJsonSafe(ev.facts, ev.facts),
            result: parseJsonSafe(ev.result, ev.result),
            error: parseJsonSafe(ev.error, ev.error),
          }));
        }
        return redactor().clean(traceClean({
          thread,
          events,
          events_total: eventsTotal,
          next_offset: offset + events.length < eventsTotal ? offset + events.length : null,
        }));
      }
      if (name === 'list_consolidation_runs') {
        fields(args, ['offset', 'limit']);
        return listConsolidationRuns(store, {
          scope_kind: 'project',
          scope_id: repositoryId,
          offset: args.offset === undefined ? 0 : Number(args.offset),
          limit: args.limit === undefined ? 10 : Math.min(50, Number(args.limit)),
        }) as unknown as Json;
      }
      return { error: 'tool_not_allowed' };
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof TaskError)) throw error;
      await guard();
      return { error: error.code, ...(error instanceof TaskError && error.detail ? { detail: redactor().text(error.detail) } : {}) };
    }
  };
}

export interface AssistantHomeAccessor {
  homes: AssistantHomes;
  ownerId: string;
  generation: number;
  directory: string;
  mode: 'rw' | 'ro';
}

async function executeAssistantMemoryTool(
  store: Store,
  home: AssistantHomeAccessor,
  guard: () => Promise<void>,
  mutations: ConsolidationMutationTracker,
  name: string,
  args: Json,
): Promise<Json | undefined> {
  if (name === 'list_files') {
    fields(args, ['path', 'recursive']);
    const rel = readHomeRelative(args.path, '~/memory');
    if (rel && SENSITIVE_HOME_READ.test(rel)) return { error: 'memory_sensitive_path' };
    const listed = await home.homes.list(home.directory, rel, args.recursive !== false);
    await guard();
    const safeEntries = (listed.entries || []).filter(entry => !SENSITIVE_HOME_READ.test(String(entry.path || '')));
    return { path: '~/' + (rel ?? ''), exists: listed.exists, entries: safeEntries, truncated: listed.truncated };
  }
  if (name === 'read_file') {
    fields(args, ['path', 'offset', 'limit']);
    const rel = readHomeRelative(args.path, '');
    if (!rel) return { error: 'regular_file_required' };
    if (SENSITIVE_HOME_READ.test(rel)) return { error: 'memory_sensitive_path' };
    const offset = args.offset === undefined ? 0 : Number(args.offset);
    const limit = args.limit === undefined ? DEFAULT_RECORD_CHARS : Number(args.limit);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_CHARS) {
      return { error: 'invalid_pagination' };
    }
    const file = await home.homes.read(home.directory, rel, ASSISTANT_READ_LIMIT);
    await guard();
    const full = configuredRedactor(store).text(file.data.toString('utf8'));
    return {
      path: '~/' + rel,
      content: full.slice(offset, offset + limit),
      offset,
      next_offset: offset + limit < full.length ? offset + limit : null,
      total_characters: full.length,
      size: file.size,
      ...(file.size > ASSISTANT_READ_LIMIT ? { truncated: true } : {}),
    };
  }
  if (name === 'write_file') {
    fields(args, ['path', 'content']);
    if (home.mode === 'ro') return { error: 'assistant_home_read_only' };
    if (typeof args.content !== 'string') return { error: 'invalid_memory_content' };
    const normalized = normalizeAssistantMemoryPath(args.path);
    const existed = await home.homes.read(home.directory, normalized, 1).then(() => true).catch(() => false);
    await guard();
    const wrote = await home.homes.writeMemoryText(home.directory, normalized, args.content);
    home.homes.touch(home.ownerId);
    await guard();
    mutations.recordChanged({ path: normalized.slice('memory/'.length), action: existed ? 'updated' : 'created' });
    return { path: wrote.path, written: true, bytes: wrote.bytes };
  }
  if (name === 'delete_file') {
    fields(args, ['path']);
    const normalized = normalizeAssistantMemoryPath(args.path);
    await guard();
    const removed = await home.homes.remove(home.directory, normalized);
    home.homes.touch(home.ownerId);
    await guard();
    if (removed.deleted) {
      mutations.recordDeleted({ path: normalized.slice('memory/'.length), action: 'deleted' });
    }
    return { path: '~/' + normalized, ...removed };
  }
  return undefined;
}

export interface GroupConsolidationToolDeps {
  store: Store;
  manager?: Manager;
  channels: ChannelService;
  chat: Row;
  binding: Row;
  fence: string;
  home: AssistantHomeAccessor;
  guard: () => Promise<void>;
  mutations: ConsolidationMutationTracker;
}

export function createGroupConsolidationExecutor(deps: GroupConsolidationToolDeps) {
  const { store, manager, channels, chat, binding, fence, home, guard, mutations } = deps;
  const scope = [bindingScope(binding.id)];
  const permissions = (): RolePermissions => channels.serviceBindings.permissions(binding);
  const redactor = () => configuredRedactor(store);

  return async (name: string, rawArgs: unknown): Promise<Json> => {
    await guard();
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Json;
    try {
      const memResult = await executeAssistantMemoryTool(store, home, guard, mutations, name, args);
      if (memResult !== undefined) return memResult;

      if (name === 'search_conversation_history') {
        fields(args, ['chat_id', 'message_id', 'sender_id', 'reply_to', 'thread_id', 'from', 'to', 'keyword', 'cursor', 'limit', 'direction']);
        const res = queryCleanLedger(store, channels, chat.id, args, scope, fence);
        const namer = channels.members?.namer(chat);
        if (namer && Array.isArray(res.messages)) {
          res.messages = (res.messages as Json[]).map(m => {
            const known = m.sender_type === 'user' ? namer({ id: String(m.sender_id), tenant: String(m.sender_tenant) }) : undefined;
            return known ? { ...m, sender_name: known } : m;
          });
        }
        return res;
      }
      if (name === 'read_conversation_message') {
        fields(args, ['chat_id', 'message_id', 'part', 'offset', 'limit']);
        const res = readCleanLedgerMessage(store, channels, chat.id, args, scope, fence);
        const namer = channels.members?.namer(chat);
        if (namer && res.sender_type === 'user') {
          const known = namer({ id: String(res.sender_id), tenant: String(res.sender_tenant) });
          if (known) res.sender_name = known;
        }
        return res;
      }
      if (name === 'read_conversation_summary') {
        fields(args, ['chat_id']);
        return readChatSummary(store, chat.id, fence);
      }
      if (name === 'list_chat_members') {
        fields(args, ['query', 'offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 100 : Number(args.limit);
        const query = args.query === undefined ? '' : text(args.query, 100).toLowerCase();
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          return { error: 'invalid_arguments' };
        }
        // Cached local roster only: zero external Feishu network calls during nightly consolidation.
        const roster = channels.members?.roster(chat);
        if (!roster) return { members: [], total: 0, next_offset: null, cached: false };
        const found = roster.members.filter(m => !query || m.id.toLowerCase().includes(query) || !!m.name?.toLowerCase().includes(query));
        const end = offset + limit;
        return {
          members: found.slice(offset, end).map(m => ({ id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.tenant !== chat.installation_tenant ? { external: true } : {}) })),
          total: found.length,
          next_offset: end < found.length ? end : null,
          refreshed_at: roster.refreshed_at ? new Date(roster.refreshed_at).toISOString() : null,
          cached: true,
        };
      }
      if (name === 'list_own_tasks') {
        fields(args, ['offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) return { error: 'invalid_pagination' };
        const total = Number(store.get(
          "SELECT count(*) AS n FROM service_role_own_tasks WHERE owner_kind='channel' AND owner_id=? AND service_role_id=? AND principal_id=? AND fence=?",
          chat.id, binding.service_role_id, binding.principal_id, fence,
        )?.n ?? 0);
        const rows = store.all(
          "SELECT * FROM service_role_own_tasks WHERE owner_kind='channel' AND owner_id=? AND service_role_id=? AND principal_id=? AND fence=? ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?",
          chat.id, binding.service_role_id, binding.principal_id, fence, limit, offset,
        );
        return {
          own_tasks: rows.map(row => {
            const rounds = (store.secrets.open(row.history, 'own-task:' + row.id) as Json).rounds as any[];
            return {
              task_id: row.id,
              title: row.title,
              state: row.control ?? row.state,
              rounds: row.rounds,
              error: row.error ?? null,
              updated_at: row.updated_at,
              last_conclusion: redactor().text(String(rounds?.at(-1)?.conclusion ?? '')).slice(0, 2000),
            };
          }),
          total,
          next_offset: offset + rows.length < total ? offset + rows.length : null,
        };
      }
      if (name === 'read_own_task') {
        fields(args, ['task_id']);
        const row = store.get(
          "SELECT * FROM service_role_own_tasks WHERE owner_kind='channel' AND owner_id=? AND service_role_id=? AND principal_id=? AND fence=? AND id=?",
          chat.id, binding.service_role_id, binding.principal_id, fence, text(args.task_id, 100),
        );
        if (!row) return { error: 'own_task_not_found' };
        const rounds = (store.secrets.open(row.history, 'own-task:' + row.id) as Json).rounds;
        return redactor().clean(traceClean({ task_id: row.id, title: row.title, state: row.control ?? row.state, history: rounds }));
      }
      if (name === 'list_projects') {
        fields(args, []);
        const reach = channels.serviceBindings.reach(binding);
        return {
          scope: binding.scope,
          projects: reach.projects.map(p => ({ id: p.id, repository: p.full_name, private: p.private, enabled: p.enabled })),
        };
      }
      if (name === 'list_project_tasks' || name === 'read_project_task') {
        if (!permitsTool(permissions(), 'list_project_tasks')) return { error: 'tool_not_allowed' };
        const project = channels.serviceBindings.project(binding, args.repository, ['tasks.read']);
        if (!project) return { error: 'repository_out_of_scope' };
        channels.serviceBindings.actor(binding, project.id, ['tasks.read']);
        return name === 'list_project_tasks'
          ? { repository: project.full_name, ...readPagedTasks(store, project.id, args) }
          : { repository: project.full_name, ...readOneTask(store, project.id, args) };
      }
      if (name === 'search_project_memory' || name === 'read_project_memory') {
        if (permissions().project_memory === 'none') return { error: 'tool_not_allowed' };
        if (!manager) return { error: 'notes_unavailable' };
        const project = channels.serviceBindings.project(binding, args.repository, ['knowledge.read']);
        if (!project) return { error: 'repository_out_of_scope' };
        channels.serviceBindings.actor(binding, project.id, ['knowledge.read']);
        await migrateLegacyProjectMemories(store, manager, project.id);
        if (name === 'search_project_memory') {
          fields(args, ['repository', 'query', 'path', 'offset', 'limit']);
          const result = await searchProjectNotes(manager, project.id, String(args.query ?? ''), {
            path: typeof args.path === 'string' ? args.path : undefined,
            offset: args.offset === undefined ? undefined : Number(args.offset),
            limit: args.limit === undefined ? undefined : Number(args.limit),
          });
          await guard();
          return { repository: project.full_name, ...(result as unknown as Json) };
        }
        fields(args, ['repository', 'id', 'revision', 'offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? DEFAULT_RECORD_CHARS : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_CHARS) {
          return { error: 'invalid_memory_offset' };
        }
        const file = await readProjectNote(manager, project.id, text(args.id, 500), args.revision === undefined ? undefined : Number(args.revision));
        await guard();
        if (file?.deleted) return { error: 'note_not_found' };
        if (file?.binary || file?.availability === 'unsupported_format') return { repository: project.full_name, id: file.id, path: file.path, availability: 'unsupported_format' };
        const body = redactor().text(String(file?.content ?? ''));
        return {
          repository: project.full_name,
          id: file.id,
          path: file.path,
          revision: Number(file.revision ?? 1),
          body: body.slice(offset, offset + limit),
          offset,
          next_offset: offset + limit < body.length ? offset + limit : null,
          total_characters: body.length,
        };
      }
      if (name === 'list_consolidation_runs') {
        fields(args, ['offset', 'limit']);
        return listConsolidationRuns(store, {
          scope_kind: 'group_assistant',
          scope_id: chat.id,
          offset: args.offset === undefined ? 0 : Number(args.offset),
          limit: args.limit === undefined ? 10 : Math.min(50, Number(args.limit)),
        }) as unknown as Json;
      }
      return { error: 'tool_not_allowed' };
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof TaskError)) throw error;
      await guard();
      return { error: error.code, ...(error instanceof TaskError && error.detail ? { detail: redactor().text(error.detail) } : {}) };
    }
  };
}

export interface PersonalConsolidationToolDeps {
  store: Store;
  manager?: Manager;
  management: ManagementService;
  channels?: ChannelService;
  actor: ActorContext;
  scopeId: string;
  tenant: string;
  home: AssistantHomeAccessor;
  guard: () => Promise<void>;
  mutations: ConsolidationMutationTracker;
}

export function listBoundPersonalPrivateChats(store: Store, principalId: string, tenant: string): Row[] {
  if (!store.hasTable('channel_personal_owners') || !store.hasTable('channel_chats')) return [];
  return store.all(
    `SELECT h.*, c.app_name, c.tenant_name
     FROM channel_personal_owners po
     JOIN channel_chats h ON h.id = po.chat_id
     JOIN channel_connectors c ON c.id = h.connector_id
     JOIN external_identities e ON e.principal_id = po.principal_id
       AND e.provider = 'feishu' AND e.status = 'active'
       AND (e.expires_at IS NULL OR e.expires_at > ?)
       AND e.connector = c.id || ':' || c.app_id
       AND e.external_actor = po.actor_id
       AND e.external_tenant = po.actor_tenant
     WHERE po.principal_id = ? AND h.chat_type = 'p2p' AND h.state = 'active' AND c.enabled = 1
       AND (? = '' OR c.owner_tenant = '' OR c.owner_tenant = ?)
     ORDER BY h.last_received_at DESC, h.id`,
    Date.now(), principalId, tenant, tenant,
  );
}

export function createPersonalConsolidationExecutor(deps: PersonalConsolidationToolDeps) {
  const { store, manager, management, channels, actor, scopeId, tenant, home, guard, mutations } = deps;
  const authRev = actor.authorization_revision;
  const redactor = () => configuredRedactor(store);

  const visibleConversation = (conversationId: string): Row | null => {
    const row = store.get("SELECT * FROM management_conversations WHERE id=? AND principal_id=? AND scope NOT LIKE 'onboarding:%'", conversationId, actor.principal_id);
    if (!row) return null;
    if (tenant && row.tenant_id && String(row.tenant_id) !== tenant) return null;
    return row;
  };

  const resolvePersonalChat = (requestedChatId?: unknown): Row | { error: string; chats?: Json[] } => {
    if (!channels) return { error: 'channels_unavailable' };
    const chats = listBoundPersonalPrivateChats(store, actor.principal_id, tenant);
    if (!chats.length) return { error: 'no_bound_private_chat' };
    if (typeof requestedChatId === 'string' && requestedChatId.trim()) {
      const found = chats.find(c => c.id === requestedChatId.trim());
      return found ?? { error: 'channel_chat_not_found' };
    }
    if (chats.length === 1) return chats[0]!;
    return {
      error: 'multiple_private_chats',
      chats: chats.map(c => ({ chat_id: c.id, app_name: c.app_name || '', tenant_name: c.tenant_name || '', last_received_at: c.last_received_at })),
    };
  };

  const resolveProject = (selected: unknown): Row | null => {
    if (typeof selected !== 'string' || !selected.trim()) return null;
    const wanted = selected.trim().toLowerCase();
    const accessibleIds = new Set(management.projects(actor));
    const found = store.all('SELECT * FROM repositories').find(r => accessibleIds.has(String(r.id)) && (String(r.id) === selected.trim() || String(r.full_name).toLowerCase() === wanted));
    return found ?? null;
  };

  return async (name: string, rawArgs: unknown): Promise<Json> => {
    await guard();
    const args = (rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}) as Json;
    try {
      const memResult = await executeAssistantMemoryTool(store, home, guard, mutations, name, args);
      if (memResult !== undefined) return memResult;

      if (name === 'list_management_conversations') {
        fields(args, ['offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid_pagination');
        const tenantClause = tenant ? " AND (c.tenant_id='' OR c.tenant_id=?)" : '';
        const tenantArgs = tenant ? [tenant] : [];
        const total = Number(store.get(
          `SELECT count(*) AS n FROM management_conversations c WHERE c.principal_id=? AND c.scope NOT LIKE 'onboarding:%'${tenantClause}`,
          actor.principal_id, ...tenantArgs,
        )?.n ?? 0);
        const rows = store.all(
          `SELECT c.id,c.scope,c.tenant_id,c.created_at,
                  CASE WHEN c.title_revision=? THEN c.title END AS title,
                  (SELECT count(*) FROM management_messages m WHERE m.conversation_id=c.id AND m.authorization_revision=?) AS message_count,
                  coalesce((SELECT max(m.updated_at) FROM management_messages m WHERE m.conversation_id=c.id AND m.authorization_revision=?),c.created_at) AS last_activity_at
           FROM management_conversations c
           WHERE c.principal_id=? AND c.scope NOT LIKE 'onboarding:%'${tenantClause}
           ORDER BY last_activity_at DESC, c.created_at DESC, c.rowid DESC LIMIT ? OFFSET ?`,
          authRev, authRev, authRev, actor.principal_id, ...tenantArgs, limit, offset,
        );
        return {
          conversations: rows.map(r => ({
            conversation_id: r.id,
            scope: r.scope,
            title: r.title ? redactor().text(String(r.title)) : null,
            message_count: Number(r.message_count ?? 0),
            created_at: r.created_at,
            last_activity_at: r.last_activity_at,
          })),
          total,
          next_offset: offset + rows.length < total ? offset + rows.length : null,
        };
      }
      if (name === 'read_management_conversation') {
        fields(args, ['conversation_id', 'include_events', 'offset', 'limit']);
        const conversationId = text(args.conversation_id, 128);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid_pagination');
        const conv = visibleConversation(conversationId);
        if (!conv) return { error: 'conversation_not_found' };
        const total = Number(store.get(
          'SELECT count(*) AS n FROM management_messages WHERE conversation_id=? AND authorization_revision=?',
          conversationId, authRev,
        )?.n ?? 0);
        const msgs = store.all(
          'SELECT id,source_message,input,state,created_at,updated_at FROM management_messages WHERE conversation_id=? AND authorization_revision=? ORDER BY rowid ASC LIMIT ? OFFSET ?',
          conversationId, authRev, limit, offset,
        );
        const includeEvents = args.include_events !== false;
        const cleanRedactor = redactor();
        return cleanRedactor.clean(traceClean({
          conversation_id: conversationId,
          scope: conv.scope,
          title: conv.title_revision === authRev ? conv.title : null,
          messages: msgs.map(m => ({
            id: m.id,
            source_message: m.source_message,
            input: parseJsonSafe(m.input, m.input),
            state: m.state,
            created_at: m.created_at,
            updated_at: m.updated_at,
            ...(includeEvents ? {
              events: store.all('SELECT sequence,type,data,created_at FROM management_events WHERE message_id=? ORDER BY sequence ASC LIMIT 200', m.id)
                .map(e => ({ sequence: e.sequence, type: e.type, data: parseJsonSafe(e.data, e.data), created_at: e.created_at })),
            } : {}),
          })),
          total,
          next_offset: offset + msgs.length < total ? offset + msgs.length : null,
        }));
      }
      if (name === 'list_feishu_private_chats') {
        fields(args, []);
        const chats = listBoundPersonalPrivateChats(store, actor.principal_id, tenant);
        return {
          chats: chats.map(c => ({ chat_id: c.id, app_name: c.app_name || '', tenant_name: c.tenant_name || '', last_received_at: c.last_received_at })),
        };
      }
      if (name === 'search_conversation_history') {
        fields(args, ['chat_id', 'message_id', 'sender_id', 'reply_to', 'thread_id', 'from', 'to', 'keyword', 'cursor', 'limit', 'direction']);
        const target = resolvePersonalChat(args.chat_id);
        if ('error' in target) return target as Json;
        return queryCleanLedger(store, channels!, String(target.id), args);
      }
      if (name === 'read_conversation_message') {
        fields(args, ['chat_id', 'message_id', 'part', 'offset', 'limit']);
        const target = resolvePersonalChat(args.chat_id);
        if ('error' in target) return target as Json;
        return readCleanLedgerMessage(store, channels!, String(target.id), args);
      }
      if (name === 'read_conversation_summary') {
        fields(args, ['chat_id']);
        const target = resolvePersonalChat(args.chat_id);
        if ('error' in target) return target as Json;
        return readChatSummary(store, String(target.id));
      }
      if (name === 'list_own_tasks') {
        fields(args, ['offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? 20 : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail(400, 'invalid_pagination');
        const tenantClause = tenant ? " AND (c.tenant_id='' OR c.tenant_id=?)" : '';
        const tenantArgs = tenant ? [tenant] : [];
        const total = Number(store.get(
          `SELECT count(*) AS n FROM service_role_own_tasks t
           JOIN management_conversations c ON c.id=t.owner_id
           WHERE t.owner_kind='management' AND t.service_role_id=? AND t.principal_id=? AND t.fence=? AND c.principal_id=?${tenantClause}`,
          managementAssistant, actor.principal_id, String(authRev), actor.principal_id, ...tenantArgs,
        )?.n ?? 0);
        const rows = store.all(
          `SELECT t.* FROM service_role_own_tasks t
           JOIN management_conversations c ON c.id=t.owner_id
           WHERE t.owner_kind='management' AND t.service_role_id=? AND t.principal_id=? AND t.fence=? AND c.principal_id=?${tenantClause}
           ORDER BY t.updated_at DESC, t.rowid DESC LIMIT ? OFFSET ?`,
          managementAssistant, actor.principal_id, String(authRev), actor.principal_id, ...tenantArgs, limit, offset,
        );
        return {
          own_tasks: rows.map(row => {
            const rounds = (store.secrets.open(row.history, 'own-task:' + row.id) as Json).rounds as any[];
            return {
              task_id: row.id,
              conversation_id: row.owner_id,
              title: row.title,
              state: row.control ?? row.state,
              rounds: row.rounds,
              error: row.error ?? null,
              updated_at: row.updated_at,
              last_conclusion: redactor().text(String(rounds?.at(-1)?.conclusion ?? '')).slice(0, 2000),
            };
          }),
          total,
          next_offset: offset + rows.length < total ? offset + rows.length : null,
        };
      }
      if (name === 'read_own_task') {
        fields(args, ['task_id']);
        const tenantClause = tenant ? " AND (c.tenant_id='' OR c.tenant_id=?)" : '';
        const tenantArgs = tenant ? [tenant] : [];
        const row = store.get(
          `SELECT t.* FROM service_role_own_tasks t
           JOIN management_conversations c ON c.id=t.owner_id
           WHERE t.owner_kind='management' AND t.service_role_id=? AND t.principal_id=? AND t.fence=? AND c.principal_id=?${tenantClause} AND t.id=?`,
          managementAssistant, actor.principal_id, String(authRev), actor.principal_id, ...tenantArgs, text(args.task_id, 100),
        );
        if (!row) return { error: 'own_task_not_found' };
        const rounds = (store.secrets.open(row.history, 'own-task:' + row.id) as Json).rounds;
        return redactor().clean(traceClean({ task_id: row.id, conversation_id: row.owner_id, title: row.title, state: row.control ?? row.state, history: rounds }));
      }
      if (name === 'list_projects') {
        fields(args, []);
        const ids = management.projects(actor);
        const projects = ids.map(id => store.get('SELECT id,full_name FROM repositories WHERE id=?', id)).filter(Boolean)
          .map(r => ({ id: r!.id, repository: r!.full_name }));
        return { projects };
      }
      if (name === 'list_project_tasks' || name === 'read_project_task') {
        const project = resolveProject(args.repository);
        if (!project) return { error: 'repository_not_found' };
        management.scope(actor, String(project.id), 'tasks.read');
        return name === 'list_project_tasks'
          ? { repository: project.full_name, ...readPagedTasks(store, String(project.id), args) }
          : { repository: project.full_name, ...readOneTask(store, String(project.id), args) };
      }
      if (name === 'search_project_memory' || name === 'read_project_memory') {
        if (!manager) return { error: 'notes_unavailable' };
        const project = resolveProject(args.repository);
        if (!project) return { error: 'repository_not_found' };
        memoryAuthorize({ actor }, String(project.id), false);
        await migrateLegacyProjectMemories(store, manager, String(project.id));
        if (name === 'search_project_memory') {
          fields(args, ['repository', 'query', 'path', 'offset', 'limit']);
          const result = await searchProjectNotes(manager, String(project.id), String(args.query ?? ''), {
            path: typeof args.path === 'string' ? args.path : undefined,
            offset: args.offset === undefined ? undefined : Number(args.offset),
            limit: args.limit === undefined ? undefined : Number(args.limit),
          });
          await guard();
          return { repository: project.full_name, ...(result as unknown as Json) };
        }
        fields(args, ['repository', 'id', 'revision', 'offset', 'limit']);
        const offset = args.offset === undefined ? 0 : Number(args.offset);
        const limit = args.limit === undefined ? DEFAULT_RECORD_CHARS : Number(args.limit);
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RECORD_CHARS) {
          return { error: 'invalid_memory_offset' };
        }
        const file = await readProjectNote(manager, String(project.id), text(args.id, 500), args.revision === undefined ? undefined : Number(args.revision));
        await guard();
        if (file?.deleted) return { error: 'note_not_found' };
        if (file?.binary || file?.availability === 'unsupported_format') return { repository: project.full_name, id: file.id, path: file.path, availability: 'unsupported_format' };
        const body = redactor().text(String(file?.content ?? ''));
        return {
          repository: project.full_name,
          id: file.id,
          path: file.path,
          revision: Number(file.revision ?? 1),
          body: body.slice(offset, offset + limit),
          offset,
          next_offset: offset + limit < body.length ? offset + limit : null,
          total_characters: body.length,
        };
      }
      if (name === 'list_consolidation_runs') {
        fields(args, ['offset', 'limit']);
        return listConsolidationRuns(store, {
          scope_kind: 'personal_assistant',
          scope_id: scopeId,
          offset: args.offset === undefined ? 0 : Number(args.offset),
          limit: args.limit === undefined ? 10 : Math.min(50, Number(args.limit)),
        }) as unknown as Json;
      }
      return { error: 'tool_not_allowed' };
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof TaskError)) throw error;
      await guard();
      return { error: error.code, ...(error instanceof TaskError && error.detail ? { detail: redactor().text(error.detail) } : {}) };
    }
  };
}
