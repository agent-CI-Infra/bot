import { Redactor } from './common.js';
import { computerResultOwner } from '../../runner/result-owner.mjs';
import { boundedResult, batchBytes } from './tool-context.js';
import { maskedStream, backgroundOutputNotice } from '../../runner/command-output.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { Store } from '../storage/database.js';
import type { TrajectoryScope } from '../storage/trajectories.js';
import type { AgentSpec } from './runtime.js';

export const readToolResult = { type: 'function', function: { name: 'read_tool_result',
  description: 'Read your immutable complete tool result without repeating its operation. position/length are UTF-8 bytes; follow next_position until eof. Does not require command or workspace permissions.',
  parameters: { type: 'object', additionalProperties: false, required: ['file'], properties: {
    file: { type: 'string' }, position: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 65536 }
  } } } };
const active = new AsyncLocalStorage<ResultSession>();
/** A trusted caller supplies the execution computer owner and its live authorization guard. */
export class ResultSession {
  constructor(readonly store: Store, readonly scope: TrajectoryScope, readonly owner: () => string, readonly guard: () => unknown | Promise<unknown>, readonly secrets: Iterable<string> = active.getStore()?.secrets ?? [], readonly mounted: () => boolean = () => false) {}
  preserve = (value: unknown, name = 'tool'): any => {
    const session = active.getStore() ?? this;
    const redactor = new Redactor(); for (const secret of session.secrets) redactor.add(secret);
    const text = JSON.stringify(redactor.clean(value)) ?? 'null';
    try {
      const ref = session.store.trajectories.results.saveText(session.owner(), session.scope, name + ':' + createHash('sha256').update(text).digest('hex'), text);
      const fields: Record<string,unknown> = {};
      for (const [key,item] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? redactor.clean(value) : {})) {
        if (['output','head','tail','content'].includes(key) || item !== null && typeof item === 'object' || Buffer.byteLength(JSON.stringify(item) ?? 'null') > 256) continue;
        if (Buffer.byteLength(JSON.stringify({...fields,[key]:item})) <= 1024) fields[key]=item;
      }
      return { ...fields, fields, ...session.reference(ref), truncated: true, head: text.slice(0,8192), tail: text.slice(-8192) };
    } catch { return { error: 'tool_result_storage_failed', notice: 'The complete result could not be saved; no usable result file was produced.' }; }
  };
  reference<T extends { file: string; notice?: string }>(value: T) {
    return { ...value, ...(this.mounted() && process.env.BOT_TOOL_RESULTS_DIR ? { path: '/results/' + value.file.slice(7) + '.utf8', notice: (value.notice ?? '') + ' You may also process this read-only path on your computer; write derived data to HOME or your working directory.' } : {}) };
  }
  recent() {
    const recent: unknown[] = [];
    for (const row of this.store.trajectories.results.recent(this.owner())) {
      const entry = { ...row, ...(this.mounted() && process.env.BOT_TOOL_RESULTS_DIR ? {path:'/results/'+row.file.slice(7)+'.utf8'} : {}) }; if (Buffer.byteLength(JSON.stringify([...recent,entry])) > 2048) break; recent.push(entry);
    }
    return recent;
  }

  run<T>(execute:()=>Promise<T>,replace=false):Promise<T> {
    const current=active.getStore();
    return active.run(current&&!replace?current:this,execute);
  }
  async read(args:any) {
    const session=active.getStore()??this;await session.guard();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['file','position','length'].includes(k))) return { error: 'tool_result_range_invalid' };
    const result=session.store.trajectories.results.read(session.owner(),args.file,args.position,args.length);
    await session.guard();return result;
  }
  execute(name:string,args:any,execute:()=>Promise<any>,interceptRead=true):Promise<any> {
    return this.run(async()=>{await (active.getStore()??this).guard();const raw=await (name==='read_tool_result'&&interceptRead?this.read(args):execute()); const redactor=new Redactor(); for(const secret of this.secrets)redactor.add(secret); const value=redactor.clean(raw);await (active.getStore()??this).guard(); return boundedResult(value, batchBytes, value => this.preserve(value, name));},true);
  }
}
export function resultSpec<T>(spec: AgentSpec<T>, owner: () => string = () => taskResultOwner(spec.task), mounted?: () => boolean): AgentSpec<T> {
  const scope = resultScope(spec.store,spec.task);
  const session = new ResultSession(spec.store, scope, owner, spec.guard,spec.redactor.values, mounted ?? (() => (spec.harnessAccess?.commands ?? !!spec.tools?.some(t=>t.function.name==='run_command')) && !!(spec.roleWorkspace || spec.pi?.workspace || spec.containerOptions?.manager))), execute = spec.execute;
  return { ...spec, resultSession: session, tools: [...(spec.tools ?? []).filter(t => t.function.name !== 'read_tool_result'), readToolResult],
    execute: (name,args) => session.execute(name,args,async()=>execute?.(name,args) ?? {error:'tool_not_allowed'}) };
}
/** Streaming copy: runner journals are read only by a trusted operation id, never a model-supplied path. */
export async function commandResult(result: any, source: string, page: (offset: number) => Promise<any>, fallback?: ResultSession) {
  if (!result || !result.truncated || !result.output_file) return result;
  const { output_file: _path, ...preview } = result, session = active.getStore() ?? fallback;
  if (!session) return { ...preview, error: 'tool_result_storage_unavailable' };
  const owner = session.owner();
  const guard = async () => { await session.guard(); if (session.owner() !== owner) throw new Error('tool_result_source_changed'); };
  async function* chunks() {
    let offset = 0, size: number | undefined;
    const ready:string[]=[],mask=maskedStream([...session!.secrets],value=>ready.push(value));
    do {
      await guard(); const part = await page(offset);
      if (!part || typeof part.data !== 'string' || !Number.isSafeInteger(part.offset) || !Number.isSafeInteger(part.size) || part.offset <= offset || part.offset > part.size ||
        Buffer.byteLength(part.data) !== part.offset - offset || size !== undefined && part.size !== size) throw new Error('tool_result_output_unavailable:'+JSON.stringify({offset,next:part?.offset,size:part?.size,expected:size,bytes:typeof part?.data==='string'?Buffer.byteLength(part.data):null}));
      size = part.size; offset = part.offset;mask.data(Buffer.from(part.data));while(ready.length)yield ready.shift()!;
    } while (offset < size!);
    mask.end();while(ready.length)yield ready.shift()!;
  }
  try {
    const reference = await session.store.trajectories.results.save(owner, session.scope, 'run_command:' + source, chunks(), guard);
    return { ...preview, ...session.reference(reference), ...(result.running ? {notice:session.reference(reference).notice+' '+backgroundOutputNotice} : {}) };
  } catch { await session.guard(); return { ...preview,output:String(preview.head??'').slice(0,4096)+'\n[… output file unavailable …]\n'+String(preview.tail??'').slice(-4096),head:String(preview.head??'').slice(0,4096),tail:String(preview.tail??'').slice(-4096), error: 'tool_result_storage_failed', notice: 'The complete command output could not be saved. This is not a usable result file; inspect the storage/runner failure before repeating the command.' }; }
}
export const resultOwner = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function resultScope(store:Store,task:Record<string,any>):TrajectoryScope {
  return store.trajectories.scopeOf(task)??{key:'results:'+task.id,path:'',repository_id:task.repository_id??null,task_id:task.conversation_id?null:task.id??null,run_id:null,conversation_id:task.conversation_id??null,turn_id:task.conversation_id?task.id:null};
}

export const projectResultOwner = (repository: unknown) => computerResultOwner('project', repository);
export const assistantResultOwner = (id: string) => computerResultOwner('assistant', id);
export function taskResultOwner(task: Record<string, any>) {
  return projectResultOwner(task.repository_id);
}

export function preserveToolResult(value: unknown, name?: string) { return active.getStore()?.preserve(value,name) ?? {error:'tool_result_storage_unavailable'}; }
