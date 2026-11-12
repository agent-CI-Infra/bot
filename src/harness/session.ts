import { randomId } from '../core/security.js';
import { TaskError } from '../agent/common.js';

// turn: one prompt's lifecycle and terminal status; usage: tokens the agent reported for its own model calls.
export type HarnessEvent = {type:'session_bound'|'message'|'tool'|'artifact'|'permission'|'configuration'|'turn'|'usage'|'ended';[key:string]:unknown};
export interface HarnessSession<T> {
 readonly id:string;
 run():Promise<T>;
 cancel(reason?:unknown):Promise<void>;
 close():Promise<void>;
}
/** Same lifecycle for in-process loops, workers and protocol clients. A session handle
 * owns resources for one connection; its durable binding may outlive the handle. */
export function managedSession<T>(execute:(signal:AbortSignal)=>Promise<T>,emit:(event:HarnessEvent)=>void,dispose:()=>Promise<void>=async()=>{}):HarnessSession<T>{
 const controller=new AbortController();let running=false,closed=false;
 return {id:randomId(),async run(){
  if(running||closed)throw new Error('harness_session_unavailable');running=true;
  try{const result=await execute(controller.signal);if(controller.signal.aborted)throw controller.signal.reason??new TaskError('harness_cancelled','cancelled');emit({type:'ended',status:'completed'});return result;}
  catch(error){emit({type:'ended',status:controller.signal.aborted||(error as any).state==='cancelled'?'cancelled':'failed',code:(error as any).code??'harness_error'});throw error;}
  finally{running=false;}
 },async cancel(reason?:unknown){controller.abort(reason??new TaskError('harness_cancelled','cancelled'));},async close(){if(closed)return;closed=true;controller.abort();await dispose();}};
}
