import { createHash } from 'node:crypto';
export class TaskError extends Error {
  constructor(readonly code: string, readonly state = 'failed') { super(code); }
}
export const stop = (code: string, state?: string): never => { throw new TaskError(code, state); };
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const operationId = (value: string) => sha(value).slice(0, 48);
export const blobSha = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
export class Redactor {
  readonly values = new Set<string>();
  add(value: unknown): void { if (typeof value === 'string' && value.length >= 8) this.values.add(value); }
  text(value: string): string { for (const secret of this.values) value = value.replaceAll(secret, '[REDACTED]'); return value; }
  clean<T>(value: T): T {
    if(typeof value==='string')return this.text(value) as T;
    if(Array.isArray(value))return value.map(item=>this.clean(item)) as T;
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.clean(item)])) as T;
    return value;
  }
  contains(value: Buffer): boolean { return [...this.values].some(secret => value.includes(Buffer.from(secret))); }
}
// Keeps the head and tail of long text so a stored log entry stays valid, bounded JSON.
export const clip = (value: unknown, limit = 8000): string => {
  const text = typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value);
  return text.length <= limit ? text : text.slice(0, limit * 0.6) + `\n[… ${text.length - limit} characters omitted …]\n` + text.slice(-limit * 0.4);
};
export function safePath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.length > 1024 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')) return stop('unsafe_repository_path');
  return path;
}
