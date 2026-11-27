import { extname } from 'node:path/posix';
import { marked } from 'marked';
import { blobSha, sha, stop, TaskError, type Redactor } from '../agent/common.js';
import type { Workspace } from '../agent/workspace.js';
import type { MediaComputer, MediaTurn } from '../channels/media.js';
import { publicText, registeredRedactor } from '../core/redaction.js';
import { HttpError } from '../core/security.js';
import type { Store } from '../storage/database.js';
import type { GitHub } from './client.js';
import { hostedMediaOrigin, hostedMediaType, registerHostedMedia, type HostedPullRequestMedia } from './hosted-pr-media.js';
import { RUNNER_TRANSFER_CHUNK_BYTES } from '../../runner/command-policy.mjs';
import { bytesMatch, detectHostedMediaFormat, isVideoFormat, type HostedMediaFormat } from './media-format.js';

export { bytesMatch, detectHostedMediaFormat, isVideoFormat, type HostedMediaFormat };

const maxFiles = 8;
const MiB = 1024 * 1024;
const maxTotalBytes = 30 * MiB;
const mediaPrefix = 'workspace:';
const resourcePrefix = 'resource:';
const hashPattern = /^[a-f0-9]{40}$/;
const assetPath = /^([a-f0-9]{64})\.([a-z0-9]+)$/;
const resourceIdPattern = /^[a-zA-Z0-9_-]{2,120}$/;

export type MediaPlanMode = 'task_workspace' | 'assistant';

export const pullRequestMediaSchema = {
  type: 'array', maxItems: maxFiles, uniqueItems: true, items: { type: 'string' },
  description: 'Optional repository-relative workspace paths outside the code diff (for example gitignored output such as .tmp/result.png or .tmp/demo.webm) explicitly selected for this PR. In summary, use ![Screenshot](workspace:path) for PNG, JPEG, GIF or WebP and [Recording](workspace:path) for MP4 or WebM. Percent-encode spaces and parentheses in the link. Select only media safe to share with anyone who receives the link. Inspect each file for credentials and private content first. When revising an existing description, keep its previously published media lines if they still apply.',
};

export const commentMediaSchema = {
  type: 'array', maxItems: maxFiles, uniqueItems: true, items: { type: 'string' },
  description: 'Optional repository-relative workspace paths (for example .tmp/result.png or .tmp/demo.webm) explicitly selected to attach in Markdown body text (Issue/PR comments, reviews, Issues or PR descriptions). Use ![Screenshot](workspace:path) for PNG, JPEG, GIF or WebP and [Recording](workspace:path) for MP4 or WebM. Percent-encode spaces and parentheses in the link. Select only media safe to share with anyone who receives the link and inspect each file for credentials first.',
};

export const assistantCommentMediaSchema = {
  type: 'array', maxItems: maxFiles, uniqueItems: true, items: { type: 'string' },
  description: 'Optional media sources explicitly selected to attach in Markdown body text (Issues, pull requests, comments, and reviews): authorized Feishu attachments as "resource:<resource_id>" (from list_message_resources) and/or assistant computer files as "workspace:<path>" (/workspace-relative, /workspace/..., /tmp/..., or ~/..., for example ffmpeg keyframes or resized screenshots). Reference images (PNG, JPEG, GIF, WebP; up to 5 MiB each) with ![Description](resource:<id>) or ![Description](workspace:<path>), and videos (MP4, WebM; up to 20 MiB each; 30 MiB total across up to 8 files) with [Description](resource:<id>) or [Description](workspace:<path>). Percent-encode spaces and parentheses in the link. Inspect files for secrets before publishing.',
};

const format = (path: string) => extname(path).slice(1).toLowerCase().replace(/^jpeg$/, 'jpg');
const video = (path: string) => isVideoFormat(format(path));

function isReservedAssistantSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    !segment ||
    segment === '.' ||
    segment === '..' ||
    lower === '.git' ||
    segment === '.runner-journal' ||
    segment === '.bot-bg' ||
    segment.startsWith('.sync-') ||
    segment.startsWith('.write-') ||
    segment.startsWith('.expired-') ||
    segment.startsWith('.bot-archive-') ||
    segment.startsWith('.bot-unpack-') ||
    segment.startsWith('.bot-pack-') ||
    segment.startsWith('.bot-usage-')
  );
}

class MediaInputError extends TaskError {
  constructor(detail: string) { super('pull_request_media_invalid', 'retry_wait', detail); }
}

/**
 * Validates and canonicalizes an assistant computer media path (/workspace-relative, /workspace/..., /tmp/..., ~/...,
 * or /home/assistant/...). Strictly confined to assistant mode; task workspaces never call this.
 */
export function normalizeAssistantMediaPath(raw: string): string {
  if (typeof raw !== 'string' || !raw || raw.length > 1024 || /[\\\x00-\x1f\x7f]/.test(raw)) {
    throw new MediaInputError('Use a valid assistant computer media path under /workspace, /tmp or ~/.');
  }
  if (raw.startsWith(resourcePrefix) || raw.startsWith(mediaPrefix)) {
    throw new MediaInputError(`Invalid assistant workspace media path ${JSON.stringify(raw)}.`);
  }
  let root: string;
  let rest: string;
  if (raw.startsWith('/tmp/')) {
    root = '/tmp/';
    rest = raw.slice('/tmp/'.length);
  } else if (raw.startsWith('/workspace/')) {
    root = '/workspace/';
    rest = raw.slice('/workspace/'.length);
  } else if (raw.startsWith('~/')) {
    root = '~/';
    rest = raw.slice('~/'.length);
  } else if (raw.startsWith('/home/assistant/')) {
    root = '~/';
    rest = raw.slice('/home/assistant/'.length);
  } else if (!raw.startsWith('/') && raw !== '~' && !/^[a-z][a-z\d+.-]*:/i.test(raw)) {
    root = '/workspace/';
    rest = raw;
  } else {
    throw new MediaInputError(`Assistant media path ${JSON.stringify(raw)} must be inside /workspace, /tmp or ~/.`);
  }
  const parts = rest.split('/');
  if (!parts.length || parts.some(isReservedAssistantSegment)) {
    throw new MediaInputError(`Assistant media path ${JSON.stringify(raw)} contains an invalid or reserved path segment.`);
  }
  return root + parts.join('/');
}

function selectedTaskPaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxFiles || new Set(value).size !== value.length)
    throw new MediaInputError(`Select up to ${maxFiles} distinct workspace files in media.`);
  for (const path of value) {
    if (typeof path !== 'string' || !path || path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) ||
        path.startsWith(resourcePrefix) || path.startsWith(mediaPrefix) || path === '~' || path.startsWith('~/') ||
        path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
      throw new MediaInputError('Use repository-relative workspace media paths outside .git.');
    if (!hostedMediaType(format(path)))
      throw new MediaInputError(`Unsupported media format for ${JSON.stringify(path)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
  }
  return value;
}

function selectedAssistantSources(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxFiles)
    throw new MediaInputError(`Select up to ${maxFiles} distinct media sources in media.`);
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 1024 || /[\\\x00-\x1f\x7f]/.test(item)) {
      throw new MediaInputError('Use resource:<resource_id> or workspace:<path> entries in media.');
    }
    let normalized: string;
    if (item.startsWith(resourcePrefix)) {
      const id = item.slice(resourcePrefix.length);
      if (!resourceIdPattern.test(id)) {
        throw new MediaInputError(`Invalid Feishu attachment reference ${JSON.stringify(item)}.`);
      }
      normalized = resourcePrefix + id;
    } else {
      const rawPath = item.startsWith(mediaPrefix) ? item.slice(mediaPrefix.length) : item;
      const assistantPath = normalizeAssistantMediaPath(rawPath);
      const ext = format(assistantPath);
      if (ext && !hostedMediaType(ext)) {
        throw new MediaInputError(`Unsupported media format for ${JSON.stringify(item)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
      }
      normalized = mediaPrefix + assistantPath;
    }
    if (seen.has(normalized)) {
      throw new MediaInputError(`Select up to ${maxFiles} distinct media sources in media.`);
    }
    seen.add(normalized);
    canonical.push(normalized);
  }
  return canonical;
}

function knownSourceFormat(source: string, mode: MediaPlanMode): string | null {
  if (mode === 'task_workspace') return format(source) || null;
  if (source.startsWith(resourcePrefix)) return null;
  const rawPath = source.startsWith(mediaPrefix) ? source.slice(mediaPrefix.length) : source;
  const ext = format(rawPath);
  return ext && hostedMediaType(ext) ? ext : null;
}

/** Keep the source Markdown, including code and ordinary destinations. Ambiguous repeated source spans are refused. */
export function planMarkdownMedia(texts: string[], value: unknown, options: { mode?: MediaPlanMode } = {}) {
  const mode: MediaPlanMode = options.mode ?? 'task_workspace';
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string'))
    throw new MediaInputError('Use Markdown strings for media references.');
  const paths = mode === 'assistant' ? selectedAssistantSources(value) : selectedTaskPaths(value);
  type Reference = { path: string; destination: string; href: string; count: number; text: string; tokenType: 'image' | 'link' };
  type Edit = Reference & { start: number; raw: string };
  const linked = new Set<string>();
  const perTextEdits: Edit[][] = texts.map(text => {
    const references = new Map<string, Reference>();
    const shouldScan = paths.length > 0 || text.includes(mediaPrefix) || (mode === 'assistant' && text.includes(resourcePrefix));
    if (shouldScan) {
      marked.walkTokens(marked.lexer(text), token => {
        if (token.type !== 'image' && token.type !== 'link') return;
        const explicitWorkspace = token.href.startsWith(mediaPrefix);
        const explicitResource = mode === 'assistant' && token.href.startsWith(resourcePrefix);
        const explicit = explicitWorkspace || explicitResource;
        if (!explicit && (!paths.length || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(token.href))) return;
        let path: string;
        if (explicitResource) {
          let id: string;
          try { id = decodeURIComponent(token.href.slice(resourcePrefix.length)); }
          catch { throw new MediaInputError('A resource: link contains invalid percent encoding.'); }
          if (!resourceIdPattern.test(id)) {
            throw new MediaInputError(`Invalid Feishu attachment link ${JSON.stringify(token.href)}.`);
          }
          path = resourcePrefix + id;
        } else {
          let decoded: string;
          try { decoded = decodeURIComponent(explicitWorkspace ? token.href.slice(mediaPrefix.length) : token.href.replace(/^\.\//, '')); }
          catch {
            if (!explicit) return;
            throw new MediaInputError('A workspace: link contains invalid percent encoding.');
          }
          if (mode === 'assistant') {
            try { path = mediaPrefix + normalizeAssistantMediaPath(decoded); }
            catch (error) {
              if (!explicit) return;
              throw error;
            }
          } else {
            path = decoded;
          }
        }
        if (!paths.includes(path)) {
          if (!explicit) return;
          throw new MediaInputError(`The ${explicitResource ? 'resource' : 'workspace'} link for ${JSON.stringify(path)} must name a selected media file.`);
        }
        const known = knownSourceFormat(path, mode);
        if (known && (token.type === 'image') === isVideoFormat(known))
          throw new MediaInputError(`Use ${isVideoFormat(known) ? 'a Markdown link' : 'Markdown image syntax'} for ${JSON.stringify(path)}.`);
        const destination = [...token.raw.matchAll(/\]\(\s*<?([^\s<>)]+)/g)].filter(match => match[1] === token.href);
        if (destination.length !== 1) throw new MediaInputError('Use an inline Markdown link or image for each media file.');
        const previous = references.get(token.raw);
        if (previous) previous.count++;
        else references.set(token.raw, { path, destination: destination[0]![0], href: token.href, count: 1, text: token.text, tokenType: token.type });
      });
    }
    for (const reference of references.values()) linked.add(reference.path);
    const edits: Edit[] = [];
    for (const [raw, reference] of references) {
      let offset = 0, count = 0;
      while ((offset = text.indexOf(raw, offset)) !== -1) {
        edits.push({ ...reference, start: offset, raw });
        count++;
        offset += raw.length;
      }
      if (count !== reference.count) throw new MediaInputError('A workspace: reference is ambiguous. Give each media reference distinct link text.');
    }
    edits.sort((a, b) => b.start - a.start);
    for (let index = 1; index < edits.length; index++) {
      const edit = edits[index]!;
      if (edit.start + edit.raw.length > edits[index - 1]!.start)
        throw new MediaInputError('Use separate Markdown links or images for workspace media.');
    }
    return edits;
  });
  for (const path of paths) if (!linked.has(path))
    throw new MediaInputError(`Add a Markdown reference in summary for ${JSON.stringify(path)}.`);
  return {
    paths,
    assertFormats(formats: Map<string, string>) {
      for (const edits of perTextEdits) {
        for (const edit of edits) {
          const type = formats.get(edit.path);
          if (!type || !hostedMediaType(type)) {
            throw new MediaInputError(`Unsupported media format for ${JSON.stringify(edit.path)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
          }
          if ((edit.tokenType === 'image') === isVideoFormat(type)) {
            throw new MediaInputError(`Use ${isVideoFormat(type) ? 'a Markdown link' : 'Markdown image syntax'} for ${JSON.stringify(edit.path)}.`);
          }
        }
      }
    },
    renderAll(url?: (path: string) => string) {
      return texts.map((text, index) => {
        let result = text;
        for (const edit of perTextEdits[index]!) {
          const replacement = url ? edit.raw.replace(edit.destination, () => edit.destination.slice(0, -edit.href.length) + url(edit.path)) : edit.text;
          result = result.slice(0, edit.start) + replacement + result.slice(edit.start + edit.raw.length);
        }
        return result;
      });
    },
  };
}

/** Keep the source Markdown, including code and ordinary destinations. Ambiguous repeated source spans are refused. */
export function planPullRequestMedia(summary: string, value: unknown) {
  if (typeof summary !== 'string') throw new MediaInputError('Use a Markdown string for the pull request summary.');
  const plan = planMarkdownMedia([summary], value);
  return {
    paths: plan.paths,
    render(url?: (path: string) => string) {
      return plan.renderAll(url)[0]!;
    },
  };
}

export type StoredMedia = { source: string; path: string; blob: string; content: { $blob: string } };
export type CandidateMedia = { media?: StoredMedia[]; hosted_media?: HostedPullRequestMedia; summary: string };

export function pullRequestSummaryForProgress(candidate: CandidateMedia): string {
  return candidate.media?.length
    ? planPullRequestMedia(candidate.summary, candidate.media.map(file => file.source)).render()
    : candidate.summary;
}

export function assertMediaOutsideCode(paths: string[], files: { path: string; sha: string; mode: string }[], upstream: typeof files) {
  for (const path of paths) {
    const file = files.find(entry => entry.path === path), original = upstream.find(entry => entry.path === path);
    if (file?.sha !== original?.sha || file?.mode !== original?.mode)
      throw new MediaInputError(`Selected media ${JSON.stringify(path)} is in the code diff. Move it to a gitignored output path before submitting.`);
  }
}

async function readWorkspaceMedia(workspace: Workspace, source: string, maxBytes: number, redactor: ReturnType<typeof registeredRedactor>) {
  const file = await workspace.deliver({ type: 'workspace_export', path: source, mode: 'pull_request_media' });
  if (!hashPattern.test(file?.sha) || !Number.isSafeInteger(file?.size))
    throw new MediaInputError(`Cannot read ${JSON.stringify(source)} as a regular workspace media file (${redactor.text(String(file?.detail || file?.error || 'invalid export'))}).`);
  if (file.size < 1 || file.size > maxBytes)
    throw new MediaInputError(`Media size limit exceeded for ${JSON.stringify(source)}. Limits are 5 MiB per image, 20 MiB per video and 30 MiB total.`);
  const bytes = Buffer.alloc(file.size);
  let offset = 0;
  while (offset < bytes.length) {
    const part = await workspace.deliver({ type: 'workspace_blob', sha: file.sha, offset, limit: RUNNER_TRANSFER_CHUNK_BYTES });
    const data = Buffer.from(typeof part?.base64 === 'string' ? part.base64 : '', 'base64');
    if (part?.size !== file.size || data.length < 1 || offset + data.length > bytes.length)
      throw new MediaInputError(`Workspace media ${JSON.stringify(source)} changed or could not be read completely.`);
    data.copy(bytes, offset);
    offset += data.length;
  }
  if (blobSha(bytes) !== file.sha)
    throw new MediaInputError(`Workspace media ${JSON.stringify(source)} does not match its snapshot.`);
  return { bytes, blob: file.sha };
}

export async function collectPullRequestMedia(workspace: Workspace, paths: string[]) {
  if (!paths.length) return undefined;
  const redactor = registeredRedactor(workspace.store, workspace.redactor);
  const result: (Omit<StoredMedia, 'content'> & { base64: string })[] = [];
  let total = 0;
  for (const source of paths) {
    if (publicText(source, redactor) !== source) throw new MediaInputError('A selected media path contains a credential.');
    const limit = Math.min((video(source) ? 20 : 5) * MiB, maxTotalBytes - total);
    const { bytes, blob } = await readWorkspaceMedia(workspace, source, limit, redactor);
    total += bytes.length;
    const type = format(source);
    if (!bytesMatch(bytes, type))
      throw new MediaInputError(`The contents of ${JSON.stringify(source)} do not match the selected media format.`);
    assertMediaRedacted(bytes, source, redactor);
    result.push({ source, path: `${sha(bytes)}.${type}`, blob, base64: bytes.toString('base64') });
  }
  return result.map(({ base64, ...file }) => ({ ...file,
    content: workspace.store.trajectories.putBlob(base64, String(workspace.task.repository_id)) }));
}

export interface AssistantMediaContext {
  store: Store;
  repositoryId: string;
  redactor: Redactor;
  guard: () => Promise<void> | void;
  media?: MediaTurn;
  computer?: MediaComputer;
  canReadComputer?: () => boolean;
}

/** Collects Feishu session attachments (resource:<id>) and/or assistant computer files (workspace:<path>) for github_write. */
export async function collectAssistantMedia(context: AssistantMediaContext, sources: string[]): Promise<StoredMedia[] | undefined> {
  if (!sources.length) return undefined;
  const redactor = registeredRedactor(context.store, context.redactor);
  const result: (Omit<StoredMedia, 'content'> & { base64: string })[] = [];
  let total = 0;
  for (const source of sources) {
    await context.guard();
    if (publicText(source, redactor) !== source) throw new MediaInputError('A selected media source contains a credential.');
    let bytes: Buffer;
    let type: HostedMediaFormat | null;
    if (source.startsWith(resourcePrefix)) {
      if (!context.media) {
        throw new MediaInputError('No Feishu message attachments are available in this conversation.');
      }
      const id = source.slice(resourcePrefix.length);
      try {
        const file = await context.media.bytes(id);
        bytes = file.data;
      } catch (error) {
        await context.guard();
        if (error instanceof HttpError) {
          throw new MediaInputError(`Cannot read Feishu attachment ${JSON.stringify(source)} (${error.code}).`);
        }
        throw error;
      }
      type = detectHostedMediaFormat(bytes);
      if (!type) {
        throw new MediaInputError(`Unsupported media format for ${JSON.stringify(source)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
      }
      const limit = Math.min((isVideoFormat(type) ? 20 : 5) * MiB, maxTotalBytes - total);
      if (bytes.length < 1 || bytes.length > limit) {
        throw new MediaInputError(`Media size limit exceeded for ${JSON.stringify(source)}. Limits are 5 MiB per image, 20 MiB per video and 30 MiB total.`);
      }
    } else if (source.startsWith(mediaPrefix)) {
      if (!context.computer || (context.canReadComputer && !context.canReadComputer())) {
        throw new MediaInputError('Assistant computer file reading is not available for workspace media in this conversation.');
      }
      const assistantPath = normalizeAssistantMediaPath(source.slice(mediaPrefix.length));
      const declared = format(assistantPath);
      if (declared && !hostedMediaType(declared)) {
        throw new MediaInputError(`Unsupported media format for ${JSON.stringify(source)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
      }
      const exportLimit = Math.min((declared ? (isVideoFormat(declared) ? 20 : 5) : 20) * MiB, maxTotalBytes - total);
      if (exportLimit < 1) {
        throw new MediaInputError(`Media size limit exceeded for ${JSON.stringify(source)}. Limits are 5 MiB per image, 20 MiB per video and 30 MiB total.`);
      }
      try {
        const exported = await context.computer.exportFile(assistantPath, exportLimit);
        bytes = exported.data;
      } catch (error) {
        await context.guard();
        if (error instanceof HttpError) {
          if (error.code === 'channel_resource_too_large') {
            throw new MediaInputError(`Media size limit exceeded for ${JSON.stringify(source)}. Limits are 5 MiB per image, 20 MiB per video and 30 MiB total.`);
          }
          throw new MediaInputError(`Cannot read assistant computer file ${JSON.stringify(source)} (${error.code}).`);
        }
        throw error;
      }
      if (declared) {
        if (!bytesMatch(bytes, declared)) {
          throw new MediaInputError(`The contents of ${JSON.stringify(source)} do not match the selected media format.`);
        }
        type = declared as HostedMediaFormat;
      } else {
        type = detectHostedMediaFormat(bytes);
        if (!type) {
          throw new MediaInputError(`Unsupported media format for ${JSON.stringify(source)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
        }
      }
      const limit = Math.min((isVideoFormat(type) ? 20 : 5) * MiB, maxTotalBytes - total);
      if (bytes.length < 1 || bytes.length > limit) {
        throw new MediaInputError(`Media size limit exceeded for ${JSON.stringify(source)}. Limits are 5 MiB per image, 20 MiB per video and 30 MiB total.`);
      }
    } else {
      throw new MediaInputError(`Invalid assistant media source ${JSON.stringify(source)}.`);
    }
    total += bytes.length;
    assertMediaRedacted(bytes, source, redactor);
    result.push({ source, path: `${sha(bytes)}.${type}`, blob: blobSha(bytes), base64: bytes.toString('base64') });
  }
  return result.map(({ base64, ...file }) => ({
    ...file,
    content: context.store.trajectories.putBlob(base64, context.repositoryId),
  }));
}

function assertMediaRedacted(bytes: Buffer, source: string, redactor: ReturnType<typeof registeredRedactor>) {
  const text = bytes.toString('utf8');
  if (redactor.contains(bytes) || publicText(text, redactor) !== text)
    throw new MediaInputError(`A credential was found in ${JSON.stringify(source)}. Remove it before publishing.`);
}

export function mediaPublicationError(error: unknown) {
  if (error instanceof MediaInputError) return { error: error.code, message: error.detail };
  throw error;
}

export function publishHostedMedia(
  github: GitHub,
  media: StoredMedia[],
  requiredPermissions?: readonly ('contents' | 'pull_requests' | 'issues')[],
): HostedPullRequestMedia {
  if (requiredPermissions?.length) {
    if (!github.installationPermissions || !requiredPermissions.every(permission => github.permissions[permission] === 'write')) {
      return stop(
        'pull_request_media_permission',
        'waiting_permission',
        'PR media needs the target repository’s GitHub App installation with Contents and Pull requests write permissions.',
      );
    }
  } else if (github.installationPermissions && !['issues', 'pull_requests', 'contents'].some(permission => github.permissions[permission] === 'write')) {
    return stop(
      'pull_request_media_permission',
      'waiting_permission',
      'Hosted media needs the target repository’s GitHub App installation with Issues, Pull requests or Contents write permission.',
    );
  }
  const origin = hostedMediaOrigin(github.store);
  if (!origin) return stop('pull_request_media_origin_missing', 'waiting_configuration', 'Configure the Bot’s public HTTPS address to publish PR media.');
  const repositoryId = String(github.repository.id);
  const assets = [...new Map(media.map(item => [item.path, item])).values()];
  const redactor = registeredRedactor(github.store, github.redactor);
  const entries = assets.map(item => {
    const match = assetPath.exec(item.path), type = match?.[2];
    if (!type || !hostedMediaType(type)) return stop('pull_request_media_corrupt', 'failed', 'Stored PR media has an invalid format.');
    if (!github.store.get('SELECT 1 FROM trajectory_blobs WHERE repository_id=? AND sha256=?', repositoryId, item.content.$blob))
      return stop('pull_request_media_corrupt', 'failed', 'Stored PR media does not belong to this repository or is no longer available.');
    const content = github.store.trajectories.getBlob(item.content.$blob);
    const bytes = Buffer.from(String(content), 'base64');
    if (blobSha(bytes) !== item.blob || sha(bytes) !== match?.[1] || !bytesMatch(bytes, type))
      return stop('pull_request_media_corrupt', 'failed', 'Stored PR media failed its integrity check.');
    assertMediaRedacted(bytes, item.source, redactor);
    return { item, type, bytes: bytes.length };
  });
  const tokens = Object.fromEntries(entries.map(({ item, type, bytes }) => [item.path,
    registerHostedMedia(github.store, repositoryId, item.content.$blob, type, bytes)]));
  return { origin, tokens };
}

export function publishPullRequestMedia(github: GitHub, media: StoredMedia[]): HostedPullRequestMedia {
  return publishHostedMedia(github, media, ['contents', 'pull_requests']);
}
