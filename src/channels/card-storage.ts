import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fdatasyncSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { Store } from '../storage/database.js';
import { fail, HttpError, type Json } from '../core/security.js';
import type { SanitizedCardSpec } from './cards.js';

export function interactiveCardStorage(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS channel_interactive_cards(
      id TEXT PRIMARY KEY,
      connector_id TEXT NOT NULL,
      chat_id TEXT NOT NULL REFERENCES channel_chats(id) ON DELETE CASCADE,
      chat_type TEXT NOT NULL,
      remote_message_id TEXT,
      outbox_id TEXT,
      owner_kind TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      fence TEXT NOT NULL,
      spec TEXT NOT NULL,
      state TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS channel_interactive_cards_message ON channel_interactive_cards(connector_id,remote_message_id);
    CREATE INDEX IF NOT EXISTS channel_interactive_cards_chat ON channel_interactive_cards(chat_id,expires_at);
  `);
}

export const cardSpecFileMarker = 'file';
const cardFileIdPattern = /^[a-zA-Z0-9_-]{2,120}$/;

function writeAll(fd: number, data: Buffer): void {
  for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset, data.length - offset);
}

/** Sealed interactive card spec file path under channel-cards/, sharded by the first two ID characters. */
export function channelCardPath(store: Store, id: string): string {
  if (!cardFileIdPattern.test(id)) return fail(400, 'channel_card_invalid');
  const root = resolve(store.channelCardsDir);
  const target = resolve(root, id.slice(0, 2), id + '.enc');
  if (!target.startsWith(root + sep)) return fail(400, 'channel_card_invalid');
  return target;
}

export function writeEncryptedCardSpec(store: Store, id: string, payload: Json): string {
  const target = channelCardPath(store, id);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const sealed = store.secrets.sealBytes(Buffer.from(JSON.stringify(payload), 'utf8'), 'channel-interactive-card:' + id);
  const temporary = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeAll(fd, sealed); fdatasyncSync(fd); }
  catch (error) { closeSync(fd); rmSync(temporary, { force: true }); throw error; }
  closeSync(fd);
  renameSync(temporary, target);
  return target;
}

export function readEncryptedCardSpec(store: Store, id: string): { spec: SanitizedCardSpec; footer_note?: string; console_url?: string } | null {
  const target = channelCardPath(store, id);
  let fd: number;
  try { fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    if (code === 'ELOOP') return fail(409, 'channel_card_integrity');
    throw error;
  }
  let sealed: Buffer;
  try {
    if (!fstatSync(fd).isFile()) return fail(409, 'channel_card_integrity');
    sealed = readFileSync(fd);
  } finally { closeSync(fd); }
  try {
    const parsed = JSON.parse(store.secrets.openBytes(sealed, 'channel-interactive-card:' + id).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.spec) return fail(409, 'channel_card_integrity');
    return parsed as { spec: SanitizedCardSpec; footer_note?: string; console_url?: string };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    return fail(409, 'channel_card_integrity');
  }
}

export function removeCardSpecFile(store: Store, id: string): { removed: boolean; bytes: number } {
  const target = channelCardPath(store, id);
  let bytes = 0, removed = false;
  try {
    const st = lstatSync(target);
    if (st.isFile()) bytes = st.size;
    rmSync(target, { force: true });
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
  }
  try { rmdirSync(dirname(target)); } catch { /* Shard directory is still non-empty or already removed. */ }
  return { removed, bytes };
}

export function removeCardSpecFiles(store: Store, ids: Iterable<string>): { removed: number; bytes: number; failed: number } {
  let removed = 0, bytes = 0, failed = 0;
  for (const id of new Set(ids)) {
    try {
      const one = removeCardSpecFile(store, id);
      if (one.removed) { removed++; bytes += one.bytes; }
    } catch (error) {
      failed++;
      console.error('[channel-cards] removing card spec file failed for ' + id + ':', error);
    }
  }
  return { removed, bytes, failed };
}

/** Sweeps unreferenced encrypted card spec files and stale temp files left by crashes or cascaded chat deletions. */
export function sweepOrphanChannelCards(store: Store, now = Date.now(), graceMs = 3600_000): { count: number; bytes: number; failed: number } {
  const result = { count: 0, bytes: 0, failed: 0 };
  const root = resolve(store.channelCardsDir);
  if (!existsSync(root)) return result;
  let shards;
  try { shards = readdirSync(root, { withFileTypes: true }); }
  catch (error) { result.failed++; console.error('[channel-cards] orphan sweep failed reading root:', error); return result; }
  const cutoff = now - graceMs;
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[a-zA-Z0-9_-]{2}$/.test(shard.name)) continue;
    const shardDir = join(root, shard.name);
    let entries;
    try { entries = readdirSync(shardDir, { withFileTypes: true }); }
    catch (error) { result.failed++; console.error('[channel-cards] orphan sweep failed reading shard ' + shard.name + ':', error); continue; }
    for (const entry of entries) {
      const path = join(shardDir, entry.name);
      const encMatch = /^([a-zA-Z0-9_-]{2,120})\.enc$/.exec(entry.name);
      const isTmp = /^[a-zA-Z0-9_-]{2,120}\.enc\.[a-f0-9]{12}\.tmp$/.test(entry.name);
      if (!encMatch && !isTmp) continue;
      let st;
      try { st = lstatSync(path); } catch (error) { result.failed++; console.error('[channel-cards] orphan sweep stat failed:', error); continue; }
      if (!st.isFile() || st.mtimeMs >= cutoff) continue;
      if (encMatch && store.get('SELECT 1 FROM channel_interactive_cards WHERE id=?', encMatch[1]!)) continue;
      try { rmSync(path, { force: true }); result.count++; result.bytes += st.size; }
      catch (error) { result.failed++; console.error('[channel-cards] orphan sweep remove failed:', error); }
    }
    try { rmdirSync(shardDir); } catch { /* Non-empty shard stays. */ }
  }
  return result;
}
