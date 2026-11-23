import type { ManagementService } from '../management/service.js';
import { configuredRedactor } from '../core/redaction.js';
import { fail, HttpError, type Json } from '../core/security.js';
import { memoryAuthorize } from './access.js';
import { migrateLegacyProjectMemories } from './migration.js';
import {
  isPhysicalNoteId,
  knowledgePath,
  projectNoteVersions,
  readProjectNote,
  resolveNoteId,
  saveProjectNote,
  searchProjectNotes,
  stripNotesPrefix,
} from './project.js';

/** Management, Web, Feishu and task roles all share the physical project notes volume via manager/file-tree. */
export function registerKnowledge(service: ManagementService): void {
  const requireManager = () => {
    if (!service.computer) fail(503, 'manager_unavailable');
    return service.computer!;
  };

  service.knowledgeSearch = async (actor, project, query, offset, limit) => {
    memoryAuthorize({ actor }, project);
    const manager = requireManager();
    await migrateLegacyProjectMemories(service.store, manager, project);
    return searchProjectNotes(manager, project, query, { offset, limit }) as unknown as Json;
  };

  service.knowledgeRead = async (actor, project, id, revision, versions) => {
    memoryAuthorize({ actor }, project);
    const manager = requireManager();
    await migrateLegacyProjectMemories(service.store, manager, project);
    if (versions) {
      return (await projectNoteVersions(manager, project, id)) as Json;
    }
    const file = await readProjectNote(manager, project, id, revision);
    service.store.audit(actor.principal_id, 'memory.read', `notes:${file.id}:${file.revision}`, project);
    return { file } as Json;
  };

  service.register('knowledge.revise', {
    async reconcile(actor, command, key) {
      memoryAuthorize({ actor }, command.target.project_id, true);
      const manager = requireManager();
      const args = command.arguments as Record<string, any>;
      const targetIdOrPath = typeof args.id === 'string' && args.id ? args.id : typeof args.path === 'string' ? args.path : '';
      if (!targetIdOrPath) return null;
      const expectedActor = `user:${actor.principal_id}:mgmt:${key}`;
      try {
        const history = await projectNoteVersions(manager, command.target.project_id, targetIdOrPath);
        const match = Array.isArray(history?.versions)
          ? history.versions.find((v: any) => v.actor === expectedActor)
          : null;
        if (!match) return null;
        const file = await readProjectNote(manager, command.target.project_id, history.id, Number(match.revision));
        return { file } as Json;
      } catch (error) {
        if ((error as any)?.code === 'note_not_found') return null;
        throw error;
      }
    },

    async execute(actor, command, key) {
      memoryAuthorize({ actor }, command.target.project_id, true);
      const manager = requireManager();
      const repo = command.target.project_id;
      const args = command.arguments as Record<string, any>;
      const action = typeof args.action === 'string' ? args.action : 'save';
      const mgmtActor = `user:${actor.principal_id}:mgmt:${key}`;
      const expectedRevision = Number(args.revision);
      const targetIdOrPath = typeof args.id === 'string' && args.id ? args.id : typeof args.path === 'string' ? args.path : '';
      if (!targetIdOrPath) fail(400, 'invalid_management_arguments');

      try {
        if (action === 'delete') {
          const resolvedId = await resolveNoteId(manager, repo, targetIdOrPath);
          const file = await manager.call('DELETE', `/v1/projects/${repo}/file-tree/${encodeURIComponent(resolvedId)}`, {
            expected_revision: expectedRevision,
            actor: mgmtActor,
          });
          service.store.audit(actor.principal_id, 'knowledge.file.deleted', file.path ?? resolvedId, repo);
          return { file } as Json;
        }

        if (action === 'restore') {
          const targetRev = Number(args.target_revision);
          if (!Number.isSafeInteger(targetRev) || targetRev < 1) fail(400, 'invalid_note_revision');
          const resolvedId = await resolveNoteId(manager, repo, targetIdOrPath);
          const file = await manager.call('POST', `/v1/projects/${repo}/file-tree/${encodeURIComponent(resolvedId)}/restore`, {
            revision: targetRev,
            expected_revision: expectedRevision,
            actor: mgmtActor,
          });
          service.store.audit(actor.principal_id, 'knowledge.file.restored', file.path ?? resolvedId, repo);
          return { file } as Json;
        }

        const text = typeof args.content === 'string' ? args.content : typeof args.body === 'string' ? args.body : null;
        if (text === null) return fail(400, 'invalid_note_content');
        const redacted = configuredRedactor(service.store).text(text);

        let file: any;
        if (isPhysicalNoteId(targetIdOrPath)) {
          file = await manager.call('PUT', `/v1/projects/${repo}/file-tree/${encodeURIComponent(targetIdOrPath)}`, {
            content: redacted,
            expected_revision: expectedRevision,
            actor: mgmtActor,
          });
        } else {
          const rel = knowledgePath(stripNotesPrefix(targetIdOrPath));
          file = await saveProjectNote(service.store, manager, repo, {
            path: rel,
            content: redacted,
            expected_revision: expectedRevision,
          }, mgmtActor);
        }
        service.store.audit(actor.principal_id, 'knowledge.file.saved', file.path ?? targetIdOrPath, repo);
        return { file } as Json;
      } catch (error) {
        if (error instanceof HttpError) throw error;
        const status = Number((error as any)?.status);
        const code = String((error as any)?.code || (error as any)?.message || '');
        if (Number.isInteger(status) && status >= 400 && status < 600 && code) fail(status, code);
        throw error;
      }
    },
  });
}
