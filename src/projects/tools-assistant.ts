import type { Store } from '../storage/database.js';
import type { ActorContext } from '../identity/authorization.js';
import type { ManagementService } from '../management/service.js';
import type { AssistantComputer } from '../service-roles/assistant-computers.js';
import type { MediaTurn } from '../channels/media.js';
import { sameRepositoryName } from '../management/repository-name.js';
import { fail, fields, text, type Json } from '../core/security.js';
import { projectToolsQuotaBytes, type ProjectToolsService } from './tools.js';

export const projectToolsListName = 'project_tools_list';
export const projectToolsPublishName = 'project_tools_publish';
export const projectToolsRollbackName = 'project_tools_rollback';
export const projectToolsAssistantNames = [projectToolsListName, projectToolsPublishName, projectToolsRollbackName];

/** Shared 3-tier tool provisioning guidance injected into project task prompts and management assistant instructions. */
export const projectToolsPriorityGuidance =
  'Tool provisioning priority (strictly prefer lower-maintenance tiers first): '
  + '(1) Use the base image preinstalled toolchain (Node.js, Python/uv, git, gh, gcc/make, ripgrep, jq, Chromium, etc.) whenever sufficient. '
  + '(2) For tools or SDKs that can be declaratively installed from Debian apt or online/intranet package registries, configure precompiled image packages and setup_script (global or project computer settings) instead of uploading binaries. '
  + '(3) Use the per-project read-only tools volume (/opt/project-tools, with /opt/project-tools/bin appended at the end of PATH so it never shadows system or preinstalled binaries) ONLY for private, offline, or proprietary prebuilt binaries that cannot be installed via packages/setup_script. Updates publish an immutable revision and switch via full-volume idle rotation without interrupting running tasks.';

const fn = (name: string, description: string, properties: Json, required: string[] = []) => ({
  type: 'function' as const,
  function: {
    name,
    description,
    parameters: { type: 'object', properties, required, additionalProperties: false },
  },
});

const repoProp = { type: 'string', description: 'Target repository full name (owner/name) or numeric repository ID.' };

export const projectToolsAssistantTools = [
  fn(
    projectToolsListName,
    'Inspect a project\'s isolated read-only binary tools volume (/opt/project-tools): active revision, pending idle rotation status (tools_pending), quota and usage, file manifest, and recent retained rollback revisions.',
    { repository: repoProp },
    ['repository'],
  ),
  fn(
    projectToolsPublishName,
    'Publish private/offline prebuilt binary tools into a project\'s isolated read-only tools volume (/opt/project-tools) as a new immutable revision (switched when the project computer is idle, never interrupting running tasks). Requires project administrator write permission on the target project. '
    + projectToolsPriorityGuidance
    + ' Choose source="message_resource" to publish directly from a Feishu message attachment (resource_id), source="computer" to publish a verified file or directory from /workspace/... or /tmp/... on your assistant computer, or source="delete" (with mode="merge" and delete_paths) to remove files.',
    {
      repository: repoProp,
      source: { type: 'string', enum: ['computer', 'message_resource', 'delete'], description: 'Where the tool payload comes from: "computer" (file or directory in /workspace or /tmp), "message_resource" (Feishu attachment resource_id), or "delete" (remove paths in merge mode).' },
      mode: { type: 'string', enum: ['merge', 'replace'], description: 'Publish mode: "merge" overlays/deletes on top of the active revision; "replace" replaces the entire tools volume.' },
      source_path: { type: 'string', description: 'Required when source="computer": path to a prepared file or directory in /workspace/... or /tmp/....' },
      resource_id: { type: 'string', description: 'Required when source="message_resource": opaque resource_id from list_message_resources.' },
      target_path: { type: 'string', description: 'Optional relative destination path inside /opt/project-tools for a single file (e.g. "bin/my-cli"). Ignored for archives or directories.' },
      executable: { type: 'boolean', description: 'For a single file, whether to set the +x executable bit (mode 0755).' },
      extract_archive: { type: 'boolean', description: 'When publishing a single .tar.gz/.tgz/.zip file, extract it into the tools volume (default true). Set false to store the archive file as-is.' },
      delete_paths: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 500, description: 'Optional relative paths to remove when mode="merge".' },
      note: { type: 'string', maxLength: 500, description: 'Optional short release note recorded with this revision.' },
    },
    ['repository', 'source', 'mode'],
  ),
  fn(
    projectToolsRollbackName,
    'Roll back a project\'s read-only tools volume (/opt/project-tools) to a retained previous revision, or clear it (clear=true). Requires project administrator write permission; containers rotate when idle without interrupting running tasks.',
    {
      repository: repoProp,
      revision: { type: 'integer', minimum: 1, description: 'Retained revision number to restore (omit when clear=true).' },
      clear: { type: 'boolean', description: 'Set true to clear the active tools volume (unmounts /opt/project-tools on next idle rotation).' },
    },
    ['repository'],
  ),
];

export interface ProjectToolsAssistantContext {
  store: Store;
  actor: ActorContext;
  service: ManagementService;
  projectTools: ProjectToolsService;
  computer?: AssistantComputer;
  media?: MediaTurn;
  guard: () => Promise<void>;
}

function isArchiveFilename(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.zip');
}

export async function executeProjectToolsAssistantTool(
  ctx: ProjectToolsAssistantContext,
  name: string,
  args: Json,
): Promise<Json> {
  await ctx.guard();
  const selected = text(args.repository, 240);
  const project = ctx.store.all('SELECT id,full_name FROM repositories').find(r => r.id === selected || sameRepositoryName(r.full_name, selected));
  if (!project) return fail(404, 'repository_not_found');

  if (name === projectToolsListName) {
    fields(args, ['repository']);
    ctx.service.scope(ctx.actor, project.id, 'tasks.read');
    let canManage = false;
    try {
      ctx.service.scope(ctx.actor, project.id, 'config.write');
      canManage = true;
    } catch {
      canManage = false;
    }
    return {
      repository: project.full_name,
      ...(await ctx.projectTools.view(project.id, { canManage })),
    };
  }

  // Write tools require live project administrator write authority (config.write) on the target repository.
  ctx.service.scope(ctx.actor, project.id, 'config.write');

  if (name === projectToolsRollbackName) {
    fields(args, ['repository', 'revision', 'clear']);
    if (args.clear === true) {
      if (args.revision !== undefined) fail(400, 'invalid_arguments');
      return {
        repository: project.full_name,
        ...(await ctx.projectTools.clear(project.id, ctx.actor.principal_id, 'assistant')),
      };
    }
    if (!Number.isSafeInteger(args.revision) || (args.revision as number) < 1) fail(400, 'invalid_revision');
    return {
      repository: project.full_name,
      ...(await ctx.projectTools.rollback(project.id, Number(args.revision), ctx.actor.principal_id, 'assistant')),
    };
  }

  if (name !== projectToolsPublishName) fail(403, 'tool_not_allowed');
  fields(args, ['repository', 'source', 'mode', 'source_path', 'resource_id', 'target_path', 'executable', 'extract_archive', 'delete_paths', 'note']);
  const source = String(args.source || '');
  const mode = String(args.mode || '') as 'merge' | 'replace';
  if (!['merge', 'replace'].includes(mode)) fail(400, 'invalid_publish_mode');
  const note = args.note !== undefined ? text(args.note, 500) : undefined;
  const deletePaths = Array.isArray(args.delete_paths) ? args.delete_paths.map(p => text(p, 1024)) : undefined;
  const targetPath = args.target_path !== undefined ? text(args.target_path, 1024) : undefined;
  const extractArchive = args.extract_archive !== false;

  if (source === 'delete') {
    if (mode !== 'merge' || !deletePaths?.length) fail(400, 'empty_tool_publish');
    return {
      repository: project.full_name,
      ...(await ctx.projectTools.publish({
        repositoryId: project.id,
        actorId: ctx.actor.principal_id,
        source: 'assistant',
        mode: 'merge',
        kind: 'delete',
        deletePaths,
        note,
      })),
    };
  }

  if (source === 'message_resource') {
    const media = ctx.media;
    if (!media) return fail(400, 'channel_resource_source_required');
    const resourceId = text(args.resource_id, 120);
    const file = await media.bytes(resourceId);
    await ctx.guard();
    // Re-verify config.write after async download.
    ctx.service.scope(ctx.actor, project.id, 'config.write');
    const asArchive = extractArchive && !targetPath && isArchiveFilename(file.name);
    return {
      repository: project.full_name,
      ...(await ctx.projectTools.publish({
        repositoryId: project.id,
        actorId: ctx.actor.principal_id,
        source: 'assistant',
        mode,
        kind: asArchive ? 'archive' : 'file',
        filename: file.name,
        targetPath: asArchive ? undefined : (targetPath || file.name),
        executable: args.executable === true,
        deletePaths,
        note,
        buffer: file.data,
      })),
    };
  }

  if (source === 'computer') {
    const computer = ctx.computer;
    if (!computer) return fail(409, 'computer_not_configured');
    const sourcePath = text(args.source_path, 4096);
    const quotaBytes = projectToolsQuotaBytes(ctx.store);
    const packed = await computer.packArchiveStream(sourcePath, quotaBytes);
    try {
      await ctx.guard();
      ctx.service.scope(ctx.actor, project.id, 'config.write');
      if (packed.kind === 'directory') {
        return {
          repository: project.full_name,
          ...(await ctx.projectTools.publish({
            repositoryId: project.id,
            actorId: ctx.actor.principal_id,
            source: 'assistant',
            mode,
            kind: 'archive',
            archiveFormat: 'tar.gz',
            filename: `${packed.name}.tar.gz`,
            deletePaths,
            note,
            stream: packed.stream,
          })),
        };
      }
      // Single file in /workspace or /tmp: clean up the temp pack and stream the raw file so target_path,
      // executable overrides, and .zip/.tar.gz archive extraction all work directly without double-wrapping.
      await packed.cleanup();
      const asArchive = extractArchive && !targetPath && isArchiveFilename(packed.name);
      return {
        repository: project.full_name,
        ...(await ctx.projectTools.publish({
          repositoryId: project.id,
          actorId: ctx.actor.principal_id,
          source: 'assistant',
          mode,
          kind: asArchive ? 'archive' : 'file',
          filename: packed.name,
          targetPath: asArchive ? undefined : (targetPath || packed.name),
          executable: typeof args.executable === 'boolean' ? args.executable : packed.executable,
          deletePaths,
          note,
          stream: computer.readFileStream(sourcePath, quotaBytes),
        })),
      };
    } finally {
      await packed.cleanup();
    }
  }

  return fail(400, 'invalid_arguments');
}
