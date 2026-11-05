import type { Store, Row } from '../storage/database.js';
import { sha, stop, type Redactor } from '../agent/common.js';
import type { Source } from './range.js';
import { activeTrigger, workflowPermissions } from '../workflows/resolve.js';
import { enqueueEventTask, registerEventWorkflow } from '../workflows/events.js';

const headings = ['Changes', 'Commits', 'Pull requests', 'Features', 'Fixes', 'Documentation', 'Tests', 'Other', '变更', '提交', '合并的 PR', '功能', '修复', '文档', '测试', '其他'];
const escape = (value: string) => value.replace(/[\\`*_{}\[\]<>#!|]/g, '\\$&').replace(/[\r\n]/g, ' ');
export type NoteGroup = { heading: string; source_ids: string[] };

/** The built-in rule: commits, then merged pull requests, as they are. */
export const builtinGroups = (input: Source[]): NoteGroup[] => [{ heading: 'Commits', source_ids: input.filter(s => s.kind === 'commit').map(s => s.id) },
  { heading: 'Pull requests', source_ids: input.filter(s => s.kind === 'pr').map(s => s.id) }];
/**
 * Whether the release.notes workflow organizes these sources: a repository skill or the workflow's console prompt was
 * loaded at preflight, there is something to organize, and the workflow is on with its trigger and its release_notes write.
 * Otherwise the built-in rule lists the sources as they are.
 */
export function notesUseModel(store: Store, row: Row, input: Source[]): boolean {
  const data = JSON.parse(row.data);
  return ['repository', 'console'].includes(data.skill?.source) && input.length > 0 && !!activeTrigger(store, row.repository_id, 'release.notes', 'release.manual')
    && workflowPermissions(store, row.repository_id, 'release.notes').writes.includes('release_notes');
}
/** The model only groups verified sources: every source exactly once, under an allowed heading. */
export function checkGroups(value: unknown, input: Source[]): NoteGroup[] {
  const byId = new Set(input.map(s => s.id));
  if (!Array.isArray(value) || value.some((g: any) => !g || !headings.includes(g.heading) || !Array.isArray(g.source_ids))) return stop('release_notes_invalid', 'failed', '发行说明分组无法核验。');
  const ids = value.flatMap((g: any) => g.source_ids);
  if (ids.length !== input.length || new Set(ids).size !== ids.length || ids.some((id: any) => !byId.has(id))) return stop('release_notes_invalid', 'failed', '发行说明引用了未知来源或遗漏、重复了真实变更。');
  return value.map((g: any) => ({ heading: g.heading, source_ids: [...g.source_ids] }));
}
/** The notes body, written by the control plane from the sources themselves, so no claim of a model enters the draft. */
export function renderNotes(row: Row, input: Source[], groups: NoteGroup[], redactor: Redactor) {
  const data = JSON.parse(row.data), byId = new Map(input.map(s => [s.id, s]));
  const lines = [`# ${row.version}`, '', data.previous_tag ? `Range: ${data.previous_tag.name} (${data.previous_tag.sha}) → ${row.target_sha}` : `从仓库历史起算 → ${row.target_sha}`, ''];
  if (!input.length) lines.push('本次范围无新增提交');
  for (const group of groups) if (group.source_ids.length) {
    lines.push('## ' + group.heading, '');
    for (const id of group.source_ids) { const s = byId.get(id)!; lines.push(`- ${escape(s.title)} ([${s.kind === 'pr' ? '#' + s.number : s.sha}](${s.url}))`); }
    lines.push('');
  }
  const body = lines.join('\n');
  if (redactor.contains(Buffer.from(body))) return stop('release_sensitive_body', 'failed', '发行说明包含已登记的密钥，已拒绝写入；请移除敏感内容。');
  if (Buffer.byteLength(body) > 120000) return stop('release_notes_too_large', 'failed', '真实变更列表超过发行说明大小上限，请人工整理范围。');
  return { body, input_hash: sha(JSON.stringify(redactor.clean(input))), groups };
}
/** Queues the release.notes task for these sources (one per release and source range). */
export function requestNotes(store: Store, row: Row, input: Source[], attempt: number): Row {
  return enqueueEventTask(store, row.repository_id, 'release.notes', `${row.id}:${sha(JSON.stringify(input))}:${attempt}`, row.target_sha, { release_id: row.id, sources: input }, `发行说明 ${row.version}`);
}

registerEventWorkflow('release.notes', {
  async prepare(store, _github, task, input) {
    const row = store.get('SELECT * FROM project_releases WHERE id=? AND repository_id=?', input.release_id, task.repository_id);
    if (!row || row.stage !== 'preparing_notes' || JSON.parse(row.data).notes_task !== task.id) return stop('release_record_changed', 'cancelled', '发行说明已不在等待这次整理。');
    const data = JSON.parse(row.data);
    return { sha: row.target_sha, files: { 'sources.json': JSON.stringify(input.sources, null, 2), 'release-notes-skill.md': String(data.skill?.content ?? '') },
      contextFiles: [{ path: '../context/sources.json', content: `The ${input.sources.length} verified changes of this release: commits and merged pull requests with id, kind, title and url` },
        { path: '../context/release-notes-skill.md', content: `The release-notes Skill (${data.skill?.source}${data.skill?.path ? ' ' + data.skill.path : ''} at ${data.skill?.sha || 'console'}), also the workflow prompt below` }],
      context: { release: { version: row.version, target_sha: row.target_sha, previous_tag: data.previous_tag || null }, headings,
        workflow_name: '发行说明', workflow_prompt: String(data.skill?.content ?? '') } };
  },
  validate(store, task, input) {
    const row = store.get('SELECT stage,data FROM project_releases WHERE id=?', input.release_id);
    if (!row || row.stage !== 'preparing_notes' || JSON.parse(row.data).notes_task !== task.id) stop('release_record_changed', 'cancelled', '发行说明已不在等待这次整理。');
  },
  finish(_store, _task, input, result) { return { groups: checkGroups(result?.groups, input.sources) }; }
});
