import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, lstatSync, mkdirSync,
  openSync, readdirSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gunzipSync } from 'node:zlib';
import { TaskError } from '../agent/common.js';

const gunzipAsync = promisify(gunzip);
const MAX_UNCOMPRESSED_BYTES = 768 * 1024 * 1024;

export function isSubpath(rootReal: string, targetReal: string): boolean {
  return targetReal === rootReal || targetReal.startsWith(rootReal.endsWith(sep) ? rootReal : rootReal + sep);
}

// ---------------------------------------------------------------- Pure-Node safe .tar.gz extractor

function parseOctal(buf: Buffer, offset: number, length: number): number {
  const raw = buf.subarray(offset, offset + length).toString('ascii').replace(/\0.*$/, '').trim();
  if (!raw) return 0;
  const value = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new TaskError('agent_tool_archive_invalid', 'failed', 'invalid_tar_octal');
  return value;
}

function readCString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const zero = slice.indexOf(0);
  return (zero >= 0 ? slice.subarray(0, zero) : slice).toString('utf8');
}

function parsePaxHeaders(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  const text = data.toString('utf8');
  while (pos < text.length) {
    const space = text.indexOf(' ', pos);
    if (space < 0) break;
    const len = Number.parseInt(text.slice(pos, space), 10);
    if (!Number.isSafeInteger(len) || len <= space - pos + 1) break;
    // PAX record length is in bytes; slice byte-accurately from Buffer when non-ASCII is possible.
    const recordBytes = data.subarray(Buffer.byteLength(text.slice(0, pos)), Buffer.byteLength(text.slice(0, pos)) + len);
    const record = recordBytes.toString('utf8');
    const sp = record.indexOf(' ');
    const eq = record.indexOf('=', sp + 1);
    if (sp > 0 && eq > sp) {
      const key = record.slice(sp + 1, eq);
      const val = record.endsWith('\n') ? record.slice(eq + 1, -1) : record.slice(eq + 1);
      out[key] = val;
    }
    pos += record.length;
  }
  return out;
}

function normalizeArchiveRelativePath(rawPath: string, stripComponents: number): string | null {
  const cleaned = rawPath.replace(/\\/g, '/').replace(/^\/+/, '');
  // `./` is the prefix many tar writers emit and means the same as no prefix; only `..` may still escape. The dot
  // segments go before stripComponents counts, so `./package/x` strips exactly like `package/x`.
  const parts = cleaned.split('/').filter(p => p && p !== '.');
  if (parts.includes('..')) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `unsafe_archive_path:${rawPath}`);
  }
  if (parts.length <= stripComponents) return null;
  return parts.slice(stripComponents).join('/');
}

interface ExtractTarOptions {
  stripComponents?: number;
  include?: (relPath: string) => boolean;
  writeImpl?: (fd: number, buffer: Buffer, offset: number, length: number) => number;
}

export function extractTarGz(
  compressed: Buffer,
  destDir: string,
  options: ExtractTarOptions = {},
): void {
  let tar: Buffer;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    throw new TaskError('agent_tool_archive_invalid', 'failed', 'gunzip_failed_or_too_large');
  }
  extractTarBuffer(tar, destDir, options);
}

export async function extractTarGzAsync(
  compressed: Buffer,
  destDir: string,
  options: ExtractTarOptions = {},
): Promise<void> {
  let tar: Buffer;
  try {
    tar = await gunzipAsync(compressed, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
  } catch {
    throw new TaskError('agent_tool_archive_invalid', 'failed', 'gunzip_failed_or_too_large');
  }
  extractTarBuffer(tar, destDir, options);
}

function extractTarBuffer(
  tar: Buffer,
  destDir: string,
  options: ExtractTarOptions = {},
): void {
  const writeChunk = options.writeImpl ?? ((fd: number, buffer: Buffer, offset: number, length: number) => writeSync(fd, buffer, offset, length));
  const stripComponents = options.stripComponents ?? 0;

  mkdirSync(destDir, { recursive: true, mode: 0o755 });
  chmodSync(destDir, 0o755);
  const destReal = realpathSync(destDir);

  let offset = 0;
  let nextPax: Record<string, string> = {};
  let gnuLongPath: string | null = null;
  let gnuLongLink: string | null = null;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    offset += 512;
    if (header.every(b => b === 0)) continue;

    const size = parseOctal(header, 124, 12);
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length) throw new TaskError('agent_tool_archive_invalid', 'failed', 'truncated_tar_entry');
    const body = tar.subarray(offset, offset + size);
    offset += padded;

    const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
    if (typeflag === 'x' || typeflag === 'g') {
      const parsed = parsePaxHeaders(body);
      if (typeflag === 'x') nextPax = { ...nextPax, ...parsed };
      continue;
    }
    if (typeflag === 'L') {
      gnuLongPath = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'K') {
      gnuLongLink = body.toString('utf8').replace(/\0+$/, '');
      continue;
    }

    const prefix = readCString(header, 345, 155);
    const name = readCString(header, 0, 100);
    const rawPath = nextPax.path ?? gnuLongPath ?? (prefix ? `${prefix}/${name}` : name);
    const rawLink = nextPax.linkpath ?? gnuLongLink ?? readCString(header, 157, 100);
    const mode = parseOctal(header, 100, 8);
    nextPax = {};
    gnuLongPath = null;
    gnuLongLink = null;

    const relPath = normalizeArchiveRelativePath(rawPath, stripComponents);
    if (!relPath) continue;
    if (options.include && !options.include(relPath)) continue;

    const targetPath = resolve(destReal, relPath);
    if (!isSubpath(destReal, targetPath) || targetPath === destReal) {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_escape:${relPath}`);
    }

    if (typeflag === '5') {
      ensureSafeArchiveDirectory(destReal, targetPath, relPath);
      continue;
    }

    ensureSafeArchiveDirectory(destReal, dirname(targetPath), relPath);

    if (typeflag === '0') {
      const existing = safeLstat(targetPath);
      if (existing && (existing.isSymbolicLink() || existing.isDirectory())) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_symlink_escape:${relPath}`);
      }
      const execBit = (mode & 0o111) !== 0;
      const safeMode = execBit ? 0o755 : 0o644;
      const fd = openSync(
        targetPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
        safeMode,
      );
      let closed = false;
      try {
        let written = 0;
        while (written < body.length) {
          let n: number;
          try {
            n = writeChunk(fd, body, written, body.length - written);
          } catch (err: any) {
            if (err?.code === 'EINTR') continue;
            throw err;
          }
          if (n <= 0) throw new TaskError('agent_tool_archive_invalid', 'failed', `short_write:${relPath}`);
          written += n;
        }
        fchmodSync(fd, safeMode);
        closeSync(fd);
        closed = true;
      } catch (err: any) {
        if (!closed) {
          try { closeSync(fd); } catch {}
        }
        try { unlinkSync(targetPath); } catch {}
        if (err instanceof TaskError) throw err;
        if (err?.code === 'ENOSPC') throw new TaskError('disk_full', 'waiting_environment', `archive_extract_enospc:${relPath}`);
        throw new TaskError('agent_tool_archive_invalid', 'failed', `short_write:${relPath}:${err?.code ?? 'io_error'}`);
      }
    } else if (typeflag === '2') {
      if (!rawLink || rawLink.startsWith('/')) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', `unsafe_symlink:${relPath}`);
      }
      const resolvedLinkTarget = resolve(dirname(targetPath), rawLink);
      if (!isSubpath(destReal, resolvedLinkTarget)) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', `symlink_escape:${relPath}`);
      }
      const existing = safeLstat(targetPath);
      if (existing) {
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_symlink_escape:${relPath}`);
        }
        unlinkSync(targetPath);
      }
      symlinkSync(rawLink, targetPath);
    } else {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `unsupported_tar_type:${typeflag}`);
    }
  }

  verifyExtractedSymlinks(destReal);
}

function safeLstat(targetPath: string) {
  try {
    return lstatSync(targetPath);
  } catch (err: any) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
}

function ensureSafeArchiveDirectory(destReal: string, dirPath: string, relPath: string): void {
  if (!isSubpath(destReal, dirPath)) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_escape:${relPath}`);
  }
  if (dirPath === destReal) return;
  const rel = relative(destReal, dirPath);
  let cur = destReal;
  for (const part of rel.split(sep)) {
    if (!part || part === '.') continue;
    cur = resolve(cur, part);
    const st = safeLstat(cur);
    if (!st) {
      mkdirSync(cur, { mode: 0o755 });
      chmodSync(cur, 0o755);
    } else if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_symlink_escape:${relPath}`);
    }
  }
  if (!isSubpath(destReal, realpathSync(dirPath))) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `archive_symlink_escape:${relPath}`);
  }
}

function resolveArchiveSymlink(destReal: string, linkPath: string, depth: number): string {
  const relPath = relative(destReal, linkPath);
  if (depth > 16) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `symlink_loop:${relPath}`);
  }
  const raw = readlinkSync(linkPath);
  if (!raw || raw.startsWith('/')) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `unsafe_symlink:${relPath}`);
  }
  let cur = dirname(linkPath);
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      cur = resolve(cur, '..');
      if (!isSubpath(destReal, cur)) {
        throw new TaskError('agent_tool_archive_invalid', 'failed', `symlink_escape:${relPath}`);
      }
      continue;
    }
    const next = resolve(cur, seg);
    if (!isSubpath(destReal, next)) {
      throw new TaskError('agent_tool_archive_invalid', 'failed', `symlink_escape:${relPath}`);
    }
    const st = safeLstat(next);
    cur = st?.isSymbolicLink() ? resolveArchiveSymlink(destReal, next, depth + 1) : next;
  }
  if (existsSync(linkPath) && !isSubpath(destReal, realpathSync(linkPath))) {
    throw new TaskError('agent_tool_archive_invalid', 'failed', `symlink_escape:${relPath}`);
  }
  return cur;
}

function verifyExtractedSymlinks(destReal: string): void {
  const stack = [destReal];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        resolveArchiveSymlink(destReal, fullPath, 0);
      } else if (entry.isDirectory()) {
        stack.push(fullPath);
      }
    }
  }
}
