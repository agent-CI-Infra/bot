import { extname } from 'node:path/posix';
import { marked } from 'marked';
import { blobSha, sha, stop, TaskError } from '../agent/common.js';
import type { Workspace } from '../agent/workspace.js';
import { publicText, registeredRedactor } from '../core/redaction.js';
import type { GitHub } from './client.js';
import { hostedMediaOrigin, hostedMediaType, registerHostedMedia, type HostedPullRequestMedia } from './hosted-pr-media.js';
import { RUNNER_TRANSFER_CHUNK_BYTES } from '../../runner/command-policy.mjs';

const maxFiles = 8;
const MiB = 1024 * 1024;
const maxTotalBytes = 30 * MiB;
const mediaPrefix = 'workspace:';
const hashPattern = /^[a-f0-9]{40}$/;
const assetPath = /^([a-f0-9]{64})\.([a-z0-9]+)$/;

export const pullRequestMediaSchema = {
  type: 'array', maxItems: maxFiles, uniqueItems: true, items: { type: 'string' },
  description: 'Optional repository-relative workspace paths outside the code diff (for example gitignored output such as .tmp/result.png or .tmp/demo.webm) explicitly selected for this PR. In summary, use ![Screenshot](workspace:path) for PNG, JPEG, GIF or WebP and [Recording](workspace:path) for MP4 or WebM. Percent-encode spaces and parentheses in the link. Select only media safe to share with anyone who receives the link. Inspect each file for credentials and private content first. When revising an existing description, keep its previously published media lines if they still apply.',
};

export const commentMediaSchema = {
  type: 'array', maxItems: maxFiles, uniqueItems: true, items: { type: 'string' },
  description: 'Optional repository-relative workspace paths (for example .tmp/result.png or .tmp/demo.webm) explicitly selected to attach in Markdown body text (Issue/PR comments, reviews, Issues or PR descriptions). Use ![Screenshot](workspace:path) for PNG, JPEG, GIF or WebP and [Recording](workspace:path) for MP4 or WebM. Percent-encode spaces and parentheses in the link. Select only media safe to share with anyone who receives the link and inspect each file for credentials first.',
};

const format = (path: string) => extname(path).slice(1).toLowerCase().replace(/^jpeg$/, 'jpg');
const video = (path: string) => ['mp4', 'webm'].includes(format(path));

class MediaInputError extends TaskError {
  constructor(detail: string) { super('pull_request_media_invalid', 'retry_wait', detail); }
}

function selectedPaths(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxFiles || new Set(value).size !== value.length)
    throw new MediaInputError(`Select up to ${maxFiles} distinct workspace files in media.`);
  for (const path of value) {
    if (typeof path !== 'string' || !path || path.length > 1024 || /[\\\x00-\x1f\x7f]/.test(path) ||
        path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
      throw new MediaInputError('Use repository-relative workspace media paths outside .git.');
    if (!hostedMediaType(format(path)))
      throw new MediaInputError(`Unsupported media format for ${JSON.stringify(path)}. Use PNG, JPEG, GIF, WebP, MP4 or WebM.`);
  }
  return value;
}

/** Keep the source Markdown, including code and ordinary destinations. Ambiguous repeated source spans are refused. */
export function planMarkdownMedia(texts: string[], value: unknown) {
  if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string'))
    throw new MediaInputError('Use Markdown strings for media references.');
  const paths = selectedPaths(value);
  type Reference = { path: string; destination: string; href: string; count: number; text: string };
  type Edit = Reference & { start: number; raw: string };
  const linked = new Set<string>();
  const perTextEdits: Edit[][] = texts.map(text => {
    const references = new Map<string, Reference>();
    if (paths.length || text.includes(mediaPrefix)) {
      marked.walkTokens(marked.lexer(text), token => {
        if (token.type !== 'image' && token.type !== 'link') return;
        const explicit = token.href.startsWith(mediaPrefix);
        if (!explicit && (!paths.length || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(token.href))) return;
        let path: string;
        try { path = decodeURIComponent(explicit ? token.href.slice(mediaPrefix.length) : token.href.replace(/^\.\//, '')); }
        catch {
          if (!explicit) return;
          throw new MediaInputError('A workspace: link contains invalid percent encoding.');
        }
        if (!paths.includes(path)) {
          if (!explicit) return;
          throw new MediaInputError(`The workspace link for ${JSON.stringify(path)} must name a selected media file.`);
        }
        if ((token.type === 'image') === video(path))
          throw new MediaInputError(`Use ${video(path) ? 'a Markdown link' : 'Markdown image syntax'} for ${JSON.stringify(path)}.`);
        const destination = [...token.raw.matchAll(/\]\(\s*<?([^\s<>)]+)/g)].filter(match => match[1] === token.href);
        if (destination.length !== 1) throw new MediaInputError('Use an inline Markdown link or image for each media file.');
        const previous = references.get(token.raw);
        if (previous) previous.count++;
        else references.set(token.raw, { path, destination: destination[0]![0], href: token.href, count: 1, text: token.text });
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

const bytesMatch = (bytes: Buffer, type: string) => {
  const at = (offset: number, text: string) => bytes.subarray(offset, offset + text.length).toString('latin1') === text;
  switch (type) {
    case 'png': return at(0, '\x89PNG\r\n\x1a\n') && at(12, 'IHDR');
    case 'jpg': return at(0, '\xff\xd8\xff');
    case 'gif': return at(0, 'GIF87a') || at(0, 'GIF89a');
    case 'webp': return at(0, 'RIFF') && at(8, 'WEBP');
    case 'mp4': return at(4, 'ftyp') && bytes.length >= 16;
    case 'webm': return at(0, '\x1a\x45\xdf\xa3') && bytes.subarray(4, 256).includes(Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]));
    default: return false;
  }
};

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
