import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { posix } from 'node:path';
import type { Redactor } from '../agent/common.js';
import { sha, validWorkspaceToolPath } from '../agent/common.js';
import type { Row, Store } from '../storage/database.js';
import { RUNNER_TRANSFER_CHUNK_BYTES } from '../../runner/command-policy.mjs';
import type { GitHub } from './client.js';
import { hostedMediaType, parseHostedMediaUrl, readHostedMediaForRepository } from './hosted-pr-media.js';
import { bytesMatch, detectHostedMediaFormat, isVideoFormat, type HostedMediaFormat } from './pull-request-media.js';

export const GITHUB_MEDIA_MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const GITHUB_MEDIA_MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const GITHUB_MEDIA_MAX_REDIRECTS = 5;

const MEDIA_HEADER_TIMEOUT_MS = 30_000;
const MEDIA_STREAM_CHUNK_TIMEOUT_MS = 30_000;
const MAGIC_PROBE_BYTES = 256;

const s3AssetHostPattern = /^github-production-(?:user|release)-asset-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const localHostPattern = /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/i;

export type DnsLookupFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface WorkspaceMediaWriter {
  writeChunk(targetPath: string, data: Buffer, offset: number, final: boolean): Promise<any>;
  truncate?(targetPath: string): Promise<void>;
  canWriteCheckout?: () => boolean;
  /** Dependency injection for unit/integration tests; never populated from user/model input. */
  fetchImpl?: typeof fetch;
  lookup?: DnsLookupFn;
  testOrigins?: string[];
}

export interface FetchGitHubMediaContext {
  store: Store;
  repository: Row;
  redactor: Redactor;
  guard: () => Promise<void>;
  scopes: string[];
  writer: WorkspaceMediaWriter;
  getApiClient: () => Promise<GitHub>;
}

export interface FetchGitHubMediaArgs {
  url: string;
  path?: string;
  source_path?: string;
}

const defaultLookup: DnsLookupFn = async hostname => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map(r => ({ address: r.address, family: r.family }));
};

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 169 && b === 254) return true; // link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast & reserved
  return false;
}

/** Rejects loopback, link-local, RFC1918, ULA, CGNAT, multicast, reserved, and IPv4-mapped private IPv6 addresses. */
export function isPrivateIp(rawIp: string): boolean {
  const ip = rawIp.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family !== 6) return true;
  if (ip === '::' || ip === '::1') return true;
  const v4MappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
  if (v4MappedDotted) return isPrivateIpv4(v4MappedDotted[1]!);
  const v4MappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1]!, 16);
    const lo = parseInt(v4MappedHex[2]!, 16);
    return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }
  const firstHextet = parseInt(ip.split(':')[0] || '0', 16);
  if (!Number.isFinite(firstHextet)) return true;
  if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (ip.startsWith('100::') || ip.startsWith('2001:db8:')) return true;
  if (ip.startsWith('::') && !ip.startsWith('::ffff:')) return true; // deprecated IPv4-compatible
  return false;
}

function hasUnsafeUrlSegments(pathname: string): boolean {
  for (const part of pathname.split('/')) {
    if (!part) continue;
    let decoded = part;
    for (let i = 0; i < 3; i++) {
      if (decoded === '.' || decoded === '..' || /[\\\x00-\x1f\x7f]/.test(decoded)) return true;
      let next: string;
      try { next = decodeURIComponent(decoded); } catch { return true; }
      if (next === decoded) break;
      decoded = next;
      if (decoded.includes('/')) return true;
    }
  }
  return false;
}

function isAllowedTestOrigin(url: URL, testOrigins?: string[]): boolean {
  return !!testOrigins?.length && testOrigins.includes(url.origin);
}

function assertSafeUrlShape(url: URL, testOrigins?: string[]): { error: string; detail: string } | null {
  if (url.username || url.password) {
    return { error: 'github_media_url_forbidden', detail: 'Media URL must not include credentials.' };
  }
  const testAllowed = isAllowedTestOrigin(url, testOrigins);
  if (!testAllowed) {
    if (url.protocol !== 'https:') {
      return { error: 'github_media_url_forbidden', detail: 'Only HTTPS GitHub media URLs are allowed.' };
    }
    if (url.port !== '') {
      return { error: 'github_media_url_forbidden', detail: 'Non-standard ports are not allowed for media URLs.' };
    }
    const host = url.hostname.toLowerCase();
    if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || localHostPattern.test(host)) {
      return { error: 'github_media_url_forbidden', detail: 'IP literals and local hostnames are forbidden.' };
    }
  } else if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { error: 'github_media_url_forbidden', detail: 'Unsupported media URL scheme.' };
  }
  if (hasUnsafeUrlSegments(url.pathname)) {
    return { error: 'github_media_url_forbidden', detail: 'Media URL contains unsafe path segments.' };
  }
  return null;
}

async function assertPublicHost(url: URL, lookup: DnsLookupFn, testOrigins?: string[]): Promise<{ error: string; detail: string } | null> {
  if (isAllowedTestOrigin(url, testOrigins)) return null;
  const host = url.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) !== 0 || localHostPattern.test(host)) {
    return { error: 'github_media_ssrf_blocked', detail: `Refused to connect to restricted host ${host}.` };
  }
  let records: { address: string; family: number }[];
  try {
    records = await lookup(host);
  } catch {
    return { error: 'github_media_download_failed', detail: `Could not resolve media host ${host}.` };
  }
  if (!records.length || records.some(r => isPrivateIp(r.address))) {
    return { error: 'github_media_ssrf_blocked', detail: `Media host ${host} resolved to a private or non-public address.` };
  }
  return null;
}

type ClassifiedMediaUrl =
  | { kind: 'user_attachment'; url: URL }
  | { kind: 'repo_file'; url: URL; rawPath: string; preferDirect: boolean }
  | { kind: 'error'; error: string; detail: string };

function decodePathPart(part: string): string {
  try { return decodeURIComponent(part); } catch { return part; }
}

/** Splits `<ref>/<filePath>` (handling `refs/heads/<branch>/<file>` and `refs/tags/<tag>/<file>`) into candidate pairs. */
function repoRefCandidates(rest: string): { ref: string; filePath: string }[] {
  const parts = rest.split('/').filter(Boolean).map(decodePathPart);
  if (parts.length < 2) return [];
  const out: { ref: string; filePath: string }[] = [];
  if (parts[0] === 'refs' && (parts[1] === 'heads' || parts[1] === 'tags') && parts.length >= 4) {
    for (let split = 3; split < Math.min(parts.length, 7); split++) {
      out.push({ ref: parts.slice(0, split).join('/'), filePath: parts.slice(split).join('/') });
    }
  }
  for (let split = 1; split < Math.min(parts.length, 5); split++) {
    out.push({ ref: parts.slice(0, split).join('/'), filePath: parts.slice(split).join('/') });
  }
  return out;
}

export function classifyGitHubMediaUrl(rawUrl: string, repoFullName: string, testOrigins?: string[]): ClassifiedMediaUrl {
  let url: URL;
  try { url = new URL(rawUrl); } catch {
    return { kind: 'error', error: 'github_media_url_forbidden', detail: 'Invalid media URL.' };
  }
  const shapeErr = assertSafeUrlShape(url, testOrigins);
  if (shapeErr) return { kind: 'error', ...shapeErr };
  const [owner, repo] = repoFullName.toLowerCase().split('/');
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  const isSameRepo = (o: string, r: string) => o.toLowerCase() === owner && r.toLowerCase() === repo;

  if (host === 'github.com' || isAllowedTestOrigin(url, testOrigins)) {
    if (/^\/user-attachments\/(?:assets|files)\/[^/]+(?:\/.*)?$/.test(pathname)) {
      return { kind: 'user_attachment', url };
    }
    const repoAsset = /^\/([^/]+)\/([^/]+)\/assets\/.+/.exec(pathname);
    if (repoAsset) {
      if (!isSameRepo(repoAsset[1]!, repoAsset[2]!)) {
        return { kind: 'error', error: 'github_media_repository_mismatch', detail: `Media URL belongs to ${repoAsset[1]}/${repoAsset[2]}, outside current repository ${repoFullName}.` };
      }
      return { kind: 'user_attachment', url };
    }
    const repoRaw = /^\/([^/]+)\/([^/]+)\/(?:raw|blob)\/(.+)$/.exec(pathname);
    if (repoRaw) {
      if (!isSameRepo(repoRaw[1]!, repoRaw[2]!)) {
        return { kind: 'error', error: 'github_media_repository_mismatch', detail: `Media URL belongs to ${repoRaw[1]}/${repoRaw[2]}, outside current repository ${repoFullName}.` };
      }
      return { kind: 'repo_file', url, rawPath: repoRaw[3]!, preferDirect: false };
    }
    if (host === 'github.com') {
      return { kind: 'error', error: 'github_media_url_forbidden', detail: 'Only official GitHub attachment and current-repository raw/blob/asset URLs are allowed.' };
    }
  }

  if (host === 'user-images.githubusercontent.com' || host === 'private-user-images.githubusercontent.com') {
    if (pathname.length <= 1) return { kind: 'error', error: 'github_media_url_forbidden', detail: 'Missing media asset path.' };
    return { kind: 'user_attachment', url };
  }

  if (host === 'raw.githubusercontent.com') {
    const match = /^\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match) return { kind: 'error', error: 'github_media_url_forbidden', detail: 'Invalid raw.githubusercontent.com media path.' };
    if (!isSameRepo(match[1]!, match[2]!)) {
      return { kind: 'error', error: 'github_media_repository_mismatch', detail: `Media URL belongs to ${match[1]}/${match[2]}, outside current repository ${repoFullName}.` };
    }
    return { kind: 'repo_file', url, rawPath: match[3]!, preferDirect: false };
  }

  if (host === 'media.githubusercontent.com') {
    const match = /^\/media\/([^/]+)\/([^/]+)\/(.+)$/.exec(pathname);
    if (!match) return { kind: 'error', error: 'github_media_url_forbidden', detail: 'Invalid media.githubusercontent.com path.' };
    if (!isSameRepo(match[1]!, match[2]!)) {
      return { kind: 'error', error: 'github_media_repository_mismatch', detail: `Media URL belongs to ${match[1]}/${match[2]}, outside current repository ${repoFullName}.` };
    }
    return { kind: 'repo_file', url, rawPath: match[3]!, preferDirect: true };
  }

  return { kind: 'error', error: 'github_media_url_forbidden', detail: `Host ${host} is not in the GitHub media allowlist.` };
}

function classifyRedirectTarget(url: URL, repoFullName: string, testOrigins?: string[]): { ok: true } | { authRequired: true } | { error: string; detail: string } {
  const shapeErr = assertSafeUrlShape(url, testOrigins);
  if (shapeErr) return shapeErr;
  const host = url.hostname.toLowerCase();
  const pathname = url.pathname;
  const [owner, repo] = repoFullName.toLowerCase().split('/');

  if (host === 'github.com') {
    if (/^\/(?:login|session|sessions|signup|join)(?:\/|$)/.test(pathname)) return { authRequired: true };
    const classified = classifyGitHubMediaUrl(url.toString(), repoFullName, testOrigins);
    if (classified.kind === 'error') return { error: classified.error, detail: classified.detail };
    return { ok: true };
  }
  if (isAllowedTestOrigin(url, testOrigins)) {
    if (/^\/(?:login|session)(?:\/|$)/.test(pathname)) return { authRequired: true };
    return { ok: true };
  }
  if (
    host === 'objects.githubusercontent.com' ||
    host === 'private-user-images.githubusercontent.com' ||
    host === 'user-images.githubusercontent.com' ||
    host === 'release-assets.githubusercontent.com' ||
    s3AssetHostPattern.test(host)
  ) {
    return { ok: true };
  }
  if (host === 'raw.githubusercontent.com') {
    const match = /^\/([^/]+)\/([^/]+)\/.+$/.exec(pathname);
    if (match && match[1]!.toLowerCase() === owner && match[2]!.toLowerCase() === repo) return { ok: true };
    return { error: 'github_media_repository_mismatch', detail: 'Redirected raw.githubusercontent.com URL is outside the current repository.' };
  }
  if (host === 'media.githubusercontent.com') {
    const match = /^\/media\/([^/]+)\/([^/]+)\/.+$/.exec(pathname);
    if (match && match[1]!.toLowerCase() === owner && match[2]!.toLowerCase() === repo) return { ok: true };
    return { error: 'github_media_repository_mismatch', detail: 'Redirected media.githubusercontent.com URL is outside the current repository.' };
  }
  return { error: 'github_media_redirect_forbidden', detail: `Refused redirect to non-allowlisted host ${host}.` };
}

async function openUnauthenticatedMedia(
  startUrl: URL,
  repoFullName: string,
  guard: () => Promise<void>,
  fetchImpl: typeof fetch,
  lookup: DnsLookupFn,
  testOrigins?: string[],
): Promise<{ response: Response } | { authRequired: true; status?: number } | { error: string; detail: string }> {
  let current = startUrl;
  for (let hop = 0; hop <= GITHUB_MEDIA_MAX_REDIRECTS; hop++) {
    await guard();
    const dnsErr = await assertPublicHost(current, lookup, testOrigins);
    if (dnsErr) return dnsErr;
    let response: Response;
    try {
      response = await fetchImpl(current, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(MEDIA_HEADER_TIMEOUT_MS),
        headers: { Accept: 'image/*, video/*, application/octet-stream' },
      });
    } catch {
      return { error: 'github_media_download_failed', detail: 'Failed to connect to GitHub media host.' };
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => {});
      if (!location) return { error: 'github_media_redirect_forbidden', detail: 'Redirect response missing Location header.' };
      if (hop === GITHUB_MEDIA_MAX_REDIRECTS) {
        return { error: 'github_media_redirect_limit', detail: `Exceeded maximum redirect hops (${GITHUB_MEDIA_MAX_REDIRECTS}).` };
      }
      let next: URL;
      try { next = new URL(location, current); } catch {
        return { error: 'github_media_redirect_forbidden', detail: 'Redirect target is not a valid URL.' };
      }
      const checked = classifyRedirectTarget(next, repoFullName, testOrigins);
      if ('authRequired' in checked) return { authRequired: true, status: response.status };
      if ('error' in checked) return checked;
      current = next;
      continue;
    }
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      return { authRequired: true, status: response.status };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return { error: 'github_media_download_failed', detail: `Media host returned HTTP ${response.status}.` };
    }
    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType.startsWith('text/html') || contentType.startsWith('application/xhtml+xml')) {
      await response.body?.cancel().catch(() => {});
      return { authRequired: true, status: response.status };
    }
    return { response };
  }
  return { error: 'github_media_redirect_limit', detail: `Exceeded maximum redirect hops (${GITHUB_MEDIA_MAX_REDIRECTS}).` };
}

function validateSourcePath(raw: string): { path: string; kind: 'issue_or_pr' | 'issue_comment' | 'pr'; number?: number } | null {
  if (!raw || raw.length > 512 || !raw.startsWith('/') || raw.startsWith('//') || /[?#\\\s\x00-\x1f]/.test(raw) || hasUnsafeUrlSegments(raw)) {
    return null;
  }
  let m: RegExpExecArray | null;
  if ((m = /^\/issues\/([1-9]\d{0,9})(?:\/comments)?$/.exec(raw))) {
    return { path: raw, kind: 'issue_or_pr', number: Number(m[1]) };
  }
  if (/^\/issues\/comments\/([1-9]\d{0,9})$/.test(raw)) {
    return { path: raw, kind: 'issue_comment' };
  }
  if (/^\/pulls\/([1-9]\d{0,9})(?:\/(?:comments|reviews(?:\/[1-9]\d{0,9})?))?$|^\/pulls\/comments\/([1-9]\d{0,9})$/.test(raw)) {
    return { path: raw, kind: 'pr' };
  }
  return null;
}

function decodeHtmlAttr(raw: string): string {
  return raw
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>');
}

function attachmentTokenFromUrl(url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (!parts.length) return null;
  const userAttachment = /^\/user-attachments\/assets\/([^/]+)$/.exec(url.pathname);
  if (userAttachment) return userAttachment[1]!;
  const userFile = /^\/user-attachments\/files\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (userFile) return `${userFile[1]}/${userFile[2]}`;
  const repoAsset = /^\/[^/]+\/[^/]+\/assets\/[^/]+\/([^/]+)$/.exec(url.pathname);
  if (repoAsset) return repoAsset[1]!;
  return parts.at(-1)!;
}

function extractSignedUrlFromHtml(htmlBodies: string[], originalUrl: URL, repoFullName: string, testOrigins?: string[]): URL | null {
  const token = attachmentTokenFromUrl(originalUrl)?.toLowerCase();
  const originalNormalized = originalUrl.toString();
  const candidates: URL[] = [];
  const seen = new Set<string>();
  const addCandidate = (raw: string) => {
    const decoded = decodeHtmlAttr(raw).trim();
    if (!decoded || decoded === originalNormalized || seen.has(decoded)) return;
    seen.add(decoded);
    let parsed: URL;
    try { parsed = new URL(decoded); } catch { return; }
    const checked = classifyRedirectTarget(parsed, repoFullName, testOrigins);
    if ('ok' in checked) candidates.push(parsed);
  };

  for (const html of htmlBodies) {
    // Prefer exact tag matches carrying data-canonical-src matching the requested URL.
    for (const tag of html.matchAll(/<(?:img|video|source|a)\b[^>]*>/gi)) {
      const text = tag[0]!;
      const canonical = /(?:^|\s)data-canonical-src="([^"]+)"/i.exec(text)?.[1];
      if (canonical && decodeHtmlAttr(canonical) === originalNormalized) {
        const src = /(?:^|\s)(?:src|href)="([^"]+)"/i.exec(text)?.[1];
        if (src) addCandidate(src);
      }
    }
    for (const attr of html.matchAll(/(?:^|\s)(?:src|href)="([^"]+)"/gi)) {
      const value = decodeHtmlAttr(attr[1]!);
      if (token && value.toLowerCase().includes(token)) {
        addCandidate(value);
      }
    }
  }
  // Prefer signed URLs (with query params or on private-user-images / objects / s3) over bare URLs.
  candidates.sort((a, b) => {
    const score = (u: URL) => (u.search ? 2 : 0) + (u.hostname.toLowerCase().includes('private-user-images') || u.hostname.toLowerCase().includes('objects.githubusercontent.com') ? 1 : 0);
    return score(b) - score(a);
  });
  return candidates[0] ?? null;
}

async function resolveSignedAttachmentUrl(
  context: FetchGitHubMediaContext,
  sourcePathRaw: string,
  originalUrl: URL,
): Promise<{ url: URL } | { error: string; detail: string }> {
  const parsed = validateSourcePath(sourcePathRaw);
  if (!parsed) {
    return { error: 'invalid_arguments', detail: 'source_path must be a repository-relative Issue, PR, comment, or review REST path (for example /issues/12 or /issues/comments/345).' };
  }
  const { scopes } = context;
  if (parsed.kind === 'pr' && !scopes.includes('pull_requests')) {
    return { error: 'github_resource_forbidden', detail: 'Reading pull request HTML requires Pull requests read permission.' };
  }
  if ((parsed.kind === 'issue_or_pr' || parsed.kind === 'issue_comment') && !scopes.includes('issues') && !scopes.includes('pull_requests')) {
    return { error: 'github_resource_forbidden', detail: 'Reading Issue or PR HTML requires Issues or Pull requests read permission.' };
  }
  const client = await context.getApiClient();
  if (parsed.kind === 'issue_or_pr') {
    if (!scopes.includes('issues') && scopes.includes('pull_requests')) {
      const pr = await client.request('GET', client.path('/pulls/' + parsed.number), undefined, true);
      if (!pr) return { error: 'github_resource_forbidden', detail: 'Target object is not a pull request and this role lacks Issues read permission.' };
    } else if (scopes.includes('issues') && !scopes.includes('pull_requests')) {
      const obj = await client.request('GET', client.path('/issues/' + parsed.number), undefined, true);
      if (!obj) return { error: 'github_media_source_not_found', detail: `Source ${parsed.path} was not found.` };
      if (obj.pull_request) return { error: 'github_resource_forbidden', detail: 'Target object is a pull request and this role lacks Pull requests read permission.' };
    }
  }
  const data = await client.requestHtml(client.path(parsed.path), true);
  if (!data) return { error: 'github_media_source_not_found', detail: `Source ${parsed.path} was not found.` };
  if (parsed.kind === 'issue_comment' && (!scopes.includes('issues') || !scopes.includes('pull_requests'))) {
    const issueNum = Number(/\/issues\/(\d+)$/.exec(String(data.issue_url ?? ''))?.[1]);
    if (!Number.isSafeInteger(issueNum)) return { error: 'github_resource_forbidden', detail: 'Could not verify parent object kind for comment.' };
    const parent = await client.request('GET', client.path('/issues/' + issueNum), undefined, true);
    if (!parent) return { error: 'github_resource_forbidden', detail: 'Parent object was not found.' };
    const needed = parent.pull_request ? 'pull_requests' : 'issues';
    if (!scopes.includes(needed)) return { error: 'github_resource_forbidden', detail: `Parent object requires ${needed} read permission.` };
  }
  const items = Array.isArray(data) ? data : [data];
  const htmlBodies = items
    .map(item => (item && typeof item === 'object' && typeof (item as any).body_html === 'string' ? String((item as any).body_html) : ''))
    .filter(Boolean);
  const signed = extractSignedUrlFromHtml(htmlBodies, originalUrl, String(context.repository.full_name), context.writer.testOrigins);
  if (!signed) {
    return { error: 'github_media_auth_required', detail: `Could not find a signed download URL matching ${originalUrl.pathname} in ${parsed.path}.` };
  }
  return { url: signed };
}

async function readChunkWithTimeout(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('media_stream_timeout')), MEDIA_STREAM_CHUNK_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeBufferInChunks(writer: WorkspaceMediaWriter, targetPath: string, data: Buffer, guard: () => Promise<void>): Promise<{ error: string; detail?: string } | null> {
  if (data.length === 0) {
    const res = await writer.writeChunk(targetPath, Buffer.alloc(0), 0, true);
    return res?.error ? res : null;
  }
  for (let offset = 0; offset < data.length; offset += RUNNER_TRANSFER_CHUNK_BYTES) {
    await guard();
    const end = Math.min(offset + RUNNER_TRANSFER_CHUNK_BYTES, data.length);
    const slice = data.subarray(offset, end);
    const res = await writer.writeChunk(targetPath, slice, offset, end >= data.length);
    if (res?.error) return res;
  }
  return null;
}

async function streamMediaResponse(
  response: Response,
  urlHash: string,
  explicitPath: string | null,
  writer: WorkspaceMediaWriter,
  guard: () => Promise<void>,
): Promise<any> {
  const contentLengthHeader = response.headers.get('content-length');
  const declaredLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader.trim()) ? Number(contentLengthHeader.trim()) : null;
  if (declaredLength !== null && declaredLength > GITHUB_MEDIA_MAX_VIDEO_BYTES) {
    await response.body?.cancel().catch(() => {});
    return {
      error: 'github_media_too_large',
      size_bytes: declaredLength,
      max_bytes: GITHUB_MEDIA_MAX_VIDEO_BYTES,
      detail: `Remote media Content-Length (${declaredLength} bytes) exceeds the maximum allowed limit (${GITHUB_MEDIA_MAX_VIDEO_BYTES} bytes).`,
    };
  }
  const reader = response.body?.getReader();
  if (!reader) {
    return { error: 'github_media_invalid_format', detail: 'Remote media response has no readable body.' };
  }

  let detected: HostedMediaFormat | null = null;
  let maxBytes = GITHUB_MEDIA_MAX_VIDEO_BYTES;
  let destPath = explicitPath ?? '';
  let totalRead = 0;
  let written = 0;
  const hasher = createHash('sha256');
  let buffered: Buffer[] = [];
  let bufferedBytes = 0;

  const cleanupPartial = async () => {
    if (written > 0 && destPath && writer.truncate) {
      await writer.truncate(destPath).catch(() => {});
    }
  };

  try {
    for (;;) {
      await guard();
      const { done, value } = await readChunkWithTimeout(reader);
      if (done) break;
      if (!value || !value.length) continue;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      totalRead += chunk.length;
      if (totalRead > maxBytes) {
        await reader.cancel().catch(() => {});
        await cleanupPartial();
        return {
          error: 'github_media_too_large',
          ...(detected ? { format: detected } : {}),
          size_bytes: totalRead,
          max_bytes: maxBytes,
          detail: `Remote media exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit while streaming.`,
        };
      }
      hasher.update(chunk);
      buffered.push(chunk);
      bufferedBytes += chunk.length;

      if (!detected && bufferedBytes >= MAGIC_PROBE_BYTES) {
        const probe = Buffer.concat(buffered, bufferedBytes);
        buffered = [probe];
        detected = detectHostedMediaFormat(probe);
        if (!detected) {
          await reader.cancel().catch(() => {});
          return {
            error: 'github_media_invalid_format',
            detail: 'Downloaded content does not match a supported image (PNG, JPEG, GIF, WebP) or video (MP4, WebM) format.',
          };
        }
        maxBytes = isVideoFormat(detected) ? GITHUB_MEDIA_MAX_VIDEO_BYTES : GITHUB_MEDIA_MAX_IMAGE_BYTES;
        if (declaredLength !== null && declaredLength > maxBytes) {
          await reader.cancel().catch(() => {});
          return {
            error: 'github_media_too_large',
            format: detected,
            size_bytes: declaredLength,
            max_bytes: maxBytes,
            detail: `Remote ${detected} Content-Length (${declaredLength} bytes) exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`,
          };
        }
        if (totalRead > maxBytes) {
          await reader.cancel().catch(() => {});
          return {
            error: 'github_media_too_large',
            format: detected,
            size_bytes: totalRead,
            max_bytes: maxBytes,
            detail: `Remote ${detected} exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`,
          };
        }
        destPath = explicitPath ?? `../context/media/${urlHash}.${detected}`;
      }

      // Flush strictly when bufferedBytes > RUNNER_TRANSFER_CHUNK_BYTES so EOF always retains >= 1 final byte.
      while (detected && bufferedBytes > RUNNER_TRANSFER_CHUNK_BYTES) {
        const combined = buffered.length === 1 ? buffered[0]! : Buffer.concat(buffered, bufferedBytes);
        const slice = combined.subarray(0, RUNNER_TRANSFER_CHUNK_BYTES);
        const rest = combined.subarray(RUNNER_TRANSFER_CHUNK_BYTES);
        const res = await writer.writeChunk(destPath, slice, written, false);
        if (res?.error) {
          await reader.cancel().catch(() => {});
          await cleanupPartial();
          return res;
        }
        written += slice.length;
        buffered = [rest];
        bufferedBytes = rest.length;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    await cleanupPartial();
    if (error instanceof Error && error.message === 'media_stream_timeout') {
      return { error: 'github_media_download_failed', detail: 'Timed out while streaming remote media.' };
    }
    throw error;
  }

  if (totalRead === 0) {
    return { error: 'github_media_invalid_format', detail: 'Remote media response is empty.' };
  }
  const tail = buffered.length === 1 ? buffered[0]! : Buffer.concat(buffered, bufferedBytes);
  if (!detected) {
    detected = detectHostedMediaFormat(tail);
    if (!detected) {
      return {
        error: 'github_media_invalid_format',
        detail: 'Downloaded content does not match a supported image (PNG, JPEG, GIF, WebP) or video (MP4, WebM) format.',
      };
    }
    maxBytes = isVideoFormat(detected) ? GITHUB_MEDIA_MAX_VIDEO_BYTES : GITHUB_MEDIA_MAX_IMAGE_BYTES;
    if (declaredLength !== null && declaredLength > maxBytes) {
      return {
        error: 'github_media_too_large',
        format: detected,
        size_bytes: declaredLength,
        max_bytes: maxBytes,
        detail: `Remote ${detected} Content-Length (${declaredLength} bytes) exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`,
      };
    }
    if (totalRead > maxBytes) {
      return {
        error: 'github_media_too_large',
        format: detected,
        size_bytes: totalRead,
        max_bytes: maxBytes,
        detail: `Remote ${detected} exceeded the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`,
      };
    }
    destPath = explicitPath ?? `../context/media/${urlHash}.${detected}`;
  }

  // Write the final buffered bytes (possibly > 1 chunk if totalRead was just over 1 chunk before detection).
  let tailOffset = 0;
  while (tailOffset < tail.length) {
    await guard();
    const end = Math.min(tailOffset + RUNNER_TRANSFER_CHUNK_BYTES, tail.length);
    const slice = tail.subarray(tailOffset, end);
    const res = await writer.writeChunk(destPath, slice, written, end >= tail.length);
    if (res?.error) {
      await cleanupPartial();
      return res;
    }
    written += slice.length;
    tailOffset = end;
  }

  return {
    path: destPath,
    mime: hostedMediaType(detected)!,
    format: detected,
    size_bytes: totalRead,
    sha256: hasher.digest('hex'),
    source: 'github_download',
  };
}

const virtualTaskRoot = '/workspace/tasks/000000000000000000000000000000000000000000000000';
const virtualRepoRoot = `${virtualTaskRoot}/repo`;
const virtualContextRoot = `${virtualTaskRoot}/context`;
const virtualNotesRoot = `${virtualTaskRoot}/notes`;

function validateDestinationPath(rawPath: unknown, canWriteCheckout?: () => boolean): { path: string | null } | { error: string; detail: string } {
  if (rawPath === undefined) return { path: null };
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    return { error: 'invalid_arguments', detail: 'path must be a non-empty file path.' };
  }
  const trimmed = rawPath.trim();
  if (trimmed.endsWith('/')) {
    return { error: 'invalid_media_path', detail: 'path must be a file path, not a directory.' };
  }
  if (!validWorkspaceToolPath(trimmed)) {
    return { error: 'invalid_media_path', detail: 'Save media into ../context/media/<file> (default), /tmp/..., or a writable repository path outside ../notes/.' };
  }
  const virtual = trimmed.startsWith('/') ? posix.normalize(trimmed) : posix.normalize(`${virtualRepoRoot}/${trimmed}`);
  if (
    virtual === virtualNotesRoot ||
    virtual.startsWith(virtualNotesRoot + '/') ||
    virtual === '/workspace/project-notes' ||
    virtual.startsWith('/workspace/project-notes/')
  ) {
    return { error: 'invalid_media_path', detail: 'Media cannot be written under ../notes/ or /workspace/project-notes/.' };
  }
  if (virtual.startsWith(virtualContextRoot + '/')) {
    return { path: '../context/' + virtual.slice(virtualContextRoot.length + 1) };
  }
  if (virtual.startsWith('/tmp/')) {
    return { path: virtual };
  }
  if (virtual.startsWith(virtualRepoRoot + '/')) {
    if (canWriteCheckout && !canWriteCheckout()) {
      return { error: 'workspace_write_not_allowed', detail: 'This role cannot modify the repository checkout; omit path to save under ../context/media/ or use /tmp/...' };
    }
    return { path: virtual.slice(virtualRepoRoot.length + 1) };
  }
  return { error: 'invalid_media_path', detail: 'Save media into ../context/media/<file> (default), /tmp/..., or a writable repository-relative path.' };
}

/**
 * Fetches an image or video referenced in this repository into the task workspace:
 * - Path A: local direct mapping for this deployment's hosted /pr-media/<token> URLs (zero outbound network).
 * - Path B: controlled SSRF-hardened streaming download for official GitHub media/attachment/current-repo URLs.
 */
export async function fetchGitHubMedia(context: FetchGitHubMediaContext, args: FetchGitHubMediaArgs): Promise<any> {
  await context.guard();
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : '';
  if (!rawUrl || rawUrl.length > 2048 || /[\s\x00-\x1f\x7f]/.test(rawUrl)) {
    return { error: 'invalid_arguments', detail: 'url must be a valid media URL or /pr-media/<token> path.' };
  }
  if (args.source_path !== undefined && (typeof args.source_path !== 'string' || !args.source_path.trim())) {
    return { error: 'invalid_arguments', detail: 'source_path must be a non-empty repository-relative REST path.' };
  }
  const destChecked = validateDestinationPath(args.path, context.writer.canWriteCheckout);
  if ('error' in destChecked) return destChecked;
  const explicitPath = destChecked.path;

  // Path A: local direct mapping of this bot deployment's hosted /pr-media/<token> (zero outbound network).
  const localHosted = parseHostedMediaUrl(context.store, rawUrl);
  if (localHosted.matched) {
    if ('invalid' in localHosted) {
      return { error: 'hosted_media_not_found', detail: 'Invalid hosted /pr-media/ URL.' };
    }
    const record = readHostedMediaForRepository(context.store, String(context.repository.id), localHosted.token);
    if (!record || !bytesMatch(record.bytes, record.format)) {
      return { error: 'hosted_media_not_found', detail: 'Hosted media token was not found for this repository or is no longer available.' };
    }
    const maxBytes = isVideoFormat(record.format) ? GITHUB_MEDIA_MAX_VIDEO_BYTES : GITHUB_MEDIA_MAX_IMAGE_BYTES;
    if (record.bytes.length > maxBytes) {
      return {
        error: 'github_media_too_large',
        format: record.format,
        size_bytes: record.bytes.length,
        max_bytes: maxBytes,
        detail: `Hosted ${record.format} size (${record.bytes.length} bytes) exceeds the ${Math.floor(maxBytes / (1024 * 1024))} MiB limit.`,
      };
    }
    const targetPath = explicitPath ?? `../context/media/${localHosted.token.slice(0, 16)}.${record.format}`;
    const writeErr = await writeBufferInChunks(context.writer, targetPath, record.bytes, context.guard);
    if (writeErr) return writeErr;
    return {
      path: targetPath,
      mime: record.mime,
      format: record.format,
      size_bytes: record.size,
      sha256: sha(record.bytes),
      source: 'hosted_local',
    };
  }

  // Path B: strict GitHub domain allowlist + SSRF defense + streaming size/magic-byte enforcement.
  const repoFullName = String(context.repository.full_name);
  const fetchImpl = context.writer.fetchImpl ?? fetch;
  const lookup = context.writer.lookup ?? defaultLookup;
  const testOrigins = context.writer.testOrigins;
  const classified = classifyGitHubMediaUrl(rawUrl, repoFullName, testOrigins);
  if (classified.kind === 'error') {
    return { error: classified.error, detail: classified.detail };
  }
  const urlHash = sha(rawUrl).slice(0, 16);

  if (classified.kind === 'repo_file') {
    if (!context.scopes.includes('contents')) {
      return { error: 'github_resource_forbidden', detail: 'Fetching repository media files requires Contents read permission.' };
    }
    if (classified.preferDirect) {
      const direct = await openUnauthenticatedMedia(classified.url, repoFullName, context.guard, fetchImpl, lookup, testOrigins);
      if ('response' in direct) {
        return streamMediaResponse(direct.response, urlHash, explicitPath, context.writer, context.guard);
      }
      if ('error' in direct) return direct;
    }
    const candidates = repoRefCandidates(classified.rawPath);
    if (!candidates.length) {
      return { error: 'github_media_url_forbidden', detail: 'Repository media URL is missing ref or file path.' };
    }
    const client = await context.getApiClient();
    let lastStatus = 404;
    for (const candidate of candidates) {
      const response = await client.openRawContent(candidate.filePath, candidate.ref);
      lastStatus = response.status;
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => {});
        if (!location) return { error: 'github_media_redirect_forbidden', detail: 'Repository media redirect missing Location header.' };
        let next: URL;
        try { next = new URL(location); } catch {
          return { error: 'github_media_redirect_forbidden', detail: 'Repository media redirect target is invalid.' };
        }
        const checked = classifyRedirectTarget(next, repoFullName, testOrigins);
        if ('error' in checked) return checked;
        if ('authRequired' in checked) return { error: 'github_media_auth_required', detail: 'Repository media redirect requires authentication.' };
        const redirected = await openUnauthenticatedMedia(next, repoFullName, context.guard, fetchImpl, lookup, testOrigins);
        if ('response' in redirected) {
          return streamMediaResponse(redirected.response, urlHash, explicitPath, context.writer, context.guard);
        }
        if ('error' in redirected) return redirected;
        return { error: 'github_media_auth_required', detail: 'Repository media redirect could not be downloaded.' };
      }
      if (response.status === 404) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { error: 'github_media_download_failed', detail: `GitHub Contents API returned HTTP ${response.status}.` };
      }
      return streamMediaResponse(response, urlHash, explicitPath, context.writer, context.guard);
    }
    return { error: 'github_media_not_found', detail: `Repository media file was not found (HTTP ${lastStatus}).` };
  }

  // user_attachment: try direct unauthenticated download first (works for public repos and already-signed URLs).
  const direct = await openUnauthenticatedMedia(classified.url, repoFullName, context.guard, fetchImpl, lookup, testOrigins);
  if ('response' in direct) {
    return streamMediaResponse(direct.response, urlHash, explicitPath, context.writer, context.guard);
  }
  if ('error' in direct) return direct;

  // Direct download hit auth/404/login wall (typical for private repo attachments): use source_path HTML API if provided.
  if (args.source_path) {
    const resolved = await resolveSignedAttachmentUrl(context, args.source_path.trim(), classified.url);
    if ('error' in resolved) return resolved;
    const signed = await openUnauthenticatedMedia(resolved.url, repoFullName, context.guard, fetchImpl, lookup, testOrigins);
    if ('response' in signed) {
      return streamMediaResponse(signed.response, urlHash, explicitPath, context.writer, context.guard);
    }
    if ('error' in signed) return signed;
    return { error: 'github_media_auth_required', detail: 'Signed attachment URL could not be downloaded.' };
  }
  return {
    error: 'github_media_auth_required',
    detail: 'Direct download requires authentication (likely a private repository attachment). Pass source_path naming the repository-relative Issue, PR, comment, or review REST path (for example "/issues/12", "/issues/comments/345", or "/pulls/7") so the control plane can resolve the signed attachment URL.',
  };
}
