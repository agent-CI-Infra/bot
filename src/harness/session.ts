import { randomId } from '../core/security.js';
import { TaskError } from '../agent/common.js';

export type HarnessEvent = {type:'session_bound'|'message'|'tool'|'artifact'|'permission'|'configuration'|'turn'|'usage'|'ended';[key:string]:unknown};
/** A connection to a native conversation. Ending a turn is distinct from closing its connection or completing a task. */
export interface HarnessSession<T> {
 readonly id:string;
 run():Promise<T>;
 send(message:string):Promise<T>;
 cancel(reason?:unknown):Promise<void>;
 close():Promise<void>;
}
export function managedSession<T>(execute:(signal:AbortSignal,message?:string)=>Promise<T>,emit:(event:HarnessEvent)=>void,dispose:()=>Promise<void>=async()=>{}):HarnessSession<T>{
 let controller:AbortController|undefined,running=false,closed=false;
 const send=async(message?:string)=>{
  if(running||closed)throw new Error('harness_session_unavailable');
  running=true;controller=new AbortController();const signal=controller.signal;
  try{const result=await execute(signal,message);if(signal.aborted)throw signal.reason??new TaskError('harness_cancelled','cancelled');emit({type:'ended',status:'completed'});return result;}
  catch(error){emit({type:'ended',status:signal.aborted||(error as any).state==='cancelled'?'cancelled':'failed',code:(error as any).code??'harness_error'});throw error;}
  finally{running=false;controller=undefined;}
 };
 return {id:randomId(),run:()=>send(),send,
  async cancel(reason?:unknown){controller?.abort(reason??new TaskError('harness_cancelled','cancelled'));},
  async close(){if(closed)return;closed=true;controller?.abort(new TaskError('harness_cancelled','cancelled'));await dispose();}};
}
