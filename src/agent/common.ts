import { createHash } from 'node:crypto';
export class TaskError extends Error {
  constructor(readonly code: string, readonly state = 'failed', readonly detail?: string, readonly retryAfterMs?: number) { super(code); }
}
export const stop = (code: string, state?: string, detail?: string, retryAfterMs?: number): never => { throw new TaskError(code, state, detail, retryAfterMs); };
export const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
// Error responses are untrusted: keep only a short message, never headers or the whole payload.
export async function errorBody(response:Response):Promise<any>{
  const reader=response.body?.getReader();if(!reader)return null;
  const chunks:Uint8Array[]=[];let length=0;
  try{
    while(length<16384){const {done,value}=await reader.read();if(done)break;chunks.push(value.subarray(0,16384-length));length+=value.length;}
  }catch{/* Preserve the HTTP failure when the error body cannot be read. */}
  finally{await reader.cancel().catch(()=>{});}
  const text=Buffer.concat(chunks).toString('utf8');
  try{return JSON.parse(text);}catch{return response.headers.get('content-type')?.startsWith('text/plain')?{message:text.split(/[\r\n]/)[0]}:null;}
}
// Why fetch() threw: a timeout, DNS, a refused or reset connection, TLS, or a redirect we refuse to follow.
const networkCodes: Record<string,string> = { ENOTFOUND:'域名解析失败', EAI_AGAIN:'域名解析暂时失败', ECONNREFUSED:'连接被拒绝', ECONNRESET:'连接被重置',
  ETIMEDOUT:'连接超时', EHOSTUNREACH:'主机不可达', ENETUNREACH:'网络不可达', EPIPE:'连接中断', UND_ERR_SOCKET:'连接中断',
  UND_ERR_CONNECT_TIMEOUT:'建立连接超时', UND_ERR_HEADERS_TIMEOUT:'等待响应超时', UND_ERR_BODY_TIMEOUT:'读取响应超时' };
export function networkReason(error: unknown, timeoutMs: number): string {
  const value = error as any, cause = value?.cause, code = String(cause?.code || value?.code || ''), message = String(cause?.message || value?.message || '');
  if (['TimeoutError','AbortError'].includes(value?.name) || ['TimeoutError','AbortError'].includes(cause?.name)) return `${Math.round(timeoutMs/1000)} 秒内没有响应`;
  if (networkCodes[code]) return `${networkCodes[code]}（${code}）`;
  if (/CERT|SSL|TLS/i.test(code)) return `TLS 证书校验失败（${code}）`;
  if (/redirect/i.test(message)) return '服务返回了重定向，已拒绝跟随';
  return code ? `网络错误（${code}）` : `网络错误（${message.replace(/\s+/g,' ').slice(0,120) || '未知'}）`;
}
export const operationId = (value: string) => sha(value).slice(0, 48);
export const blobSha = (data: Buffer) => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
// Hash only entry metadata; file contents stay in one-file buffers during transfer.
export function treeSha(files: {path:string,mode:string,sha:string}[]): string {
  type Tree = Map<string, Tree | {mode:string,sha:string}>;
  const root:Tree=new Map();
  for(const file of files){
    const parts=safePath(file.path).split('/');let node=root;
    for(const part of parts.slice(0,-1)){
      if(!node.has(part))node.set(part,new Map());
      const child=node.get(part);if(!(child instanceof Map))return stop('repository_path_conflict',undefined,`Conflicting path: ${file.path}`);node=child;
    }
    const name=parts.at(-1)!;if(node.has(name))stop('repository_path_conflict',undefined,`Conflicting path: ${file.path}`);
    if(!/^[a-f0-9]{40}$/.test(file.sha)||!/^\d{5,6}$/.test(file.mode))stop('repository_tree_invalid',undefined,`Invalid tree entry: ${file.path}, mode ${file.mode}, SHA ${file.sha}`);
    node.set(name,{mode:file.mode.replace(/^0+/,''),sha:file.sha});
  }
  const hash=(node:Tree):string=>{
    const entries=[...node].sort(([a,x],[b,y])=>Buffer.compare(Buffer.from(a+(x instanceof Map?'/':'')),Buffer.from(b+(y instanceof Map?'/':''))));
    const body=Buffer.concat(entries.map(([name,entry])=>Buffer.concat([Buffer.from(`${entry instanceof Map?'40000':entry.mode} ${name}\0`),Buffer.from(entry instanceof Map?hash(entry):entry.sha,'hex')])));
    return createHash('sha1').update(`tree ${body.length}\0`).update(body).digest('hex');
  };
  return hash(root);
}
export function describeEntries(lines:string[],limit=24000):string {
  const kept:string[]=[];let length=0;
  for(const line of lines){const size=JSON.stringify(line).length+1;if(length+size>limit)break;kept.push(line);length+=size;}
  if(kept.length<lines.length)kept.push(`[… ${lines.length-kept.length} entries omitted …]`);
  return kept.join('\n');
}
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
  if (typeof path !== 'string' || !path || path.length > 1024 || path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some(p => !p || p === '..' || p === '.' || p.toLowerCase() === '.git')) return stop('unsafe_repository_path',undefined,`Unsafe repository path: ${JSON.stringify(path)}`);
  return path;
}
