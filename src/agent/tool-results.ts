import { resultSourcesCurrent, type ResultSource } from '../storage/tool-results.js';
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
/** A trusted caller supplies the task/role or conversation owner and its live authorization/source revision. */
export class ResultSession {
  constructor(readonly store: Store, readonly scope: TrajectoryScope, readonly owner: () => string, readonly guard: () => unknown | Promise<unknown>,readonly secrets:Iterable<string>=active.getStore()?.secrets??[],readonly sources:()=>ResultSource[]=active.getStore()?.sources??(()=>[]),readonly sourceContext:ResultSource[]=[]) {}
  run<T>(execute:()=>Promise<T>,replace=false):Promise<T> {
    const current=active.getStore();
    return active.run(current&&!replace?current:new ResultSession(this.store,this.scope,this.owner,this.guard,this.secrets,this.sources,this.sources()),execute);
  }
  async read(args:any) {
    const session=active.getStore()??this;await session.guard();
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !['file','position','length'].includes(k))) return { error: 'tool_result_range_invalid' };
    const result=session.store.trajectories.results.read(session.owner(),args.file,args.position,args.length);
    await session.guard();return result;
  }
  execute(name:string,args:any,execute:()=>Promise<any>):Promise<any> {
    return this.run(async()=>{await (active.getStore()??this).guard();const value=await (name==='read_tool_result'?this.read(args):execute());return value?.file?boundedResult(value,batchBytes):value;},true);
  }
}
export function resultSpec<T>(spec: AgentSpec<T>, owner: () => string): AgentSpec<T> {
  const scope = resultScope(spec.store,spec.task);
  const session = new ResultSession(spec.store, scope, owner, spec.guard,spec.redactor.values), execute = spec.execute;
  return { ...spec, tools: [...(spec.tools ?? []).filter(t => t.function.name !== 'read_tool_result'), readToolResult],
    execute: (name,args) => session.execute(name,args,async()=>execute?.(name,args) ?? {error:'tool_not_allowed'}) };
}
/** Streaming copy: runner journals are read only by a trusted operation id, never a model-supplied path. */
export async function commandResult(result: any, source: string, page: (offset: number) => Promise<any>, fallback?: ResultSession) {
  if (!result || !result.truncated || !result.output_file) return result;
  const { output_file: _path, ...preview } = result, session = active.getStore() ?? fallback;
  if (!session) return { ...preview, error: 'tool_result_storage_unavailable' };
  const owner = session.owner();
  const guard = async () => { await session.guard(); if (session.owner() !== owner||!resultSourcesCurrent(session.store.db,session.sourceContext)) throw new Error('tool_result_source_changed'); };
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
    const reference = await session.store.trajectories.results.save(owner, session.scope, source, chunks(), guard,session.sourceContext);
    return { ...preview, ...reference, ...(result.running ? {notice:reference.notice+' '+backgroundOutputNotice} : {}) };
  } catch { await session.guard(); return { ...preview,output:String(preview.head??'').slice(0,4096)+'\n[… output file unavailable …]\n'+String(preview.tail??'').slice(-4096),head:String(preview.head??'').slice(0,4096),tail:String(preview.tail??'').slice(-4096), error: 'tool_result_storage_failed', notice: 'The complete command output could not be saved. This is not a usable result file; inspect the storage/runner failure before repeating the command.' }; }
}
export const resultOwner = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export function resultScope(store:Store,task:Record<string,any>):TrajectoryScope {
  return store.trajectories.scopeOf(task)??{key:'results:'+task.id,path:'',repository_id:task.repository_id??null,task_id:task.conversation_id?null:task.id??null,run_id:null,conversation_id:task.conversation_id??null,turn_id:task.conversation_id?task.id:null};
}
