import { publicText } from '../core/redaction.js';
import type { Redactor } from '../agent/common.js';

/**
 * A Pi service turn's own work, as its conversation shows it (#1296): the native tools it runs on the computer, each model
 * step and Pi's compaction. Every field is bounded and already redacted; no full argument or output is ever carried.
 */
export type ServiceProgress =
 | {kind:'model_step';step:number}
 | {kind:'tool_started';call_id:string;name:string;preview?:string}
 | {kind:'tool_finished';call_id:string;name:string;state:'succeeded'|'failed';duration_ms?:number;exit_code?:number;tail?:string}
 | {kind:'notice';notice:'compacting'|'compacted'|'compaction_failed'|'image_recovery'|'restarted'};

/** Pi's native tools (src/roles/harness.ts forwards their events); every other tool is the platform's own and reports itself. */
export const piNativeTools:readonly string[]=['read','edit','write','bash','grep','find','ls'];
const previewChars=160,tailChars=300,tailLines=5,scanChars=8192;
const marker='[REDACTED]';

// Values named as credentials on a command line or in an output: NAME=value, --token value, Authorization: Bearer value,
// https://user:password@host and curl -u user:password. They are not in any known format, so publicText cannot see them.
const value=String.raw`("[^"\n]*"|'[^'\n]*'|[^\s"'\`;&|)]+)`;
const secretName=String.raw`(?:[\w.-]*[_.-])?(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)(?:[_.-][\w.-]*)?`;
const credentialRules:[RegExp,(match:string,...groups:string[])=>string][]=[
 [/\b([a-z][\w+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,(_match,scheme)=>scheme+marker+'@'],
 [new RegExp(String.raw`\b(authorization\s*[:=]\s*(?:(?:bearer|token|basic|bot)\s+)?)`+value,'gi'),(_match,name)=>name+marker],
 [new RegExp(String.raw`\b(bearer\s+)[\w.~+/=-]{8,}`,'gi'),(_match,name)=>name+marker],
 [new RegExp(String.raw`\b((?:x-)?(?:api[-_]?key|private[-_]?token|auth[-_]?token|access[-_]?token|cookie)\s*:\s*)`+value,'gi'),(_match,name)=>name+marker],
 [new RegExp(String.raw`(^|[^\w-])(--?${secretName}(?:=|\s+))`+value,'gi'),(match,lead,name,secret)=>secret.startsWith('$')?match:lead+name+marker],
 [new RegExp(String.raw`\b(${secretName}\s*[=:]\s*)`+value,'gi'),(match,name,secret)=>secret.startsWith('$')?match:name+marker],
 [new RegExp(String.raw`(\s(?:-[A-Za-z]*u|--user)(?:=|\s+))("[^"\n]*:[^"\n]*"|'[^'\n]*:[^'\n]*'|[^\s"':;&|]+:[^\s"';&|]+)`,'g'),(_match,name)=>name+marker],
];
/** Masks credentials written out by name on a command line (`GH_TOKEN=…`, `--password …`, `Authorization: Bearer …`). */
export function maskCommandCredentials(text:string):string{
 let masked=text;for(const [pattern,replace] of credentialRules)masked=masked.replace(pattern,replace);return masked;
}
/** The text a person may see: known values of the turn and the deployment in any encoding, token formats, named credentials. */
export function progressText(text:string,redactors:Pick<Redactor,'publicationPattern'>[]):string{
 let clean=text.slice(0,scanChars);for(const redactor of redactors)clean=publicText(clean,redactor);return maskCommandCredentials(clean);
}
const cut=(text:string,limit:number)=>{const chars=Array.from(text);return chars.length>limit?chars.slice(0,limit-1).join('')+'…':text;};
const str=(value:unknown)=>typeof value==='string'&&value.trim()?value.trim():undefined;

/** What a native call works on: a command's first line, a path, a search pattern. */
function preview(name:string,args:any,clean:(text:string)=>string):string|undefined{
 const path=str(args?.path);let text:string|undefined;
 if(name==='bash'){
  const lines=String(args?.command??'').split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  text=lines.length?lines[0]+(lines.length>1?' …':''):undefined;
 }else if(name==='grep'||name==='find')text=str(args?.pattern)&&[args.pattern,path].filter(Boolean).join(' · ');
 else text=path??(name==='ls'?'.':undefined);
 return text===undefined?undefined:cut(clean(text).replace(/\s+/g,' '),previewChars);
}
const resultText=(result:any):string=>Array.isArray(result?.content)?result.content.filter((item:any)=>item?.type==='text').map((item:any)=>String(item.text??'')).join('\n'):'';
/** A command's last lines, for a glance at how it ended. Output never goes in full. */
function tail(result:any,clean:(text:string)=>string):string|undefined{
 const text=resultText(result).slice(-scanChars);if(!text.trim())return undefined;
 // Blank runs count as one line: Pi puts two before a failed command's status, and they would crowd out the output.
 const kept=clean(text).trimEnd().split(/\r?\n/).filter((line,i,all)=>line.trim()!==''||i>0&&all[i-1]!.trim()!=='').slice(-tailLines);
 while(kept.length&&!kept[0]!.trim())kept.shift();
 const lines=kept.join('\n'),chars=Array.from(lines);
 return chars.length>tailChars?'…'+chars.slice(-(tailChars-1)).join(''):lines;
}
function exitCode(result:any):number|undefined{
 const code=result?.structuredContent?.exit_code;if(Number.isInteger(code))return code;
 const stated=/Command exited with code (\d+)\s*$/.exec(resultText(result).slice(-200))?.[1];return stated===undefined?undefined:Number(stated);
}

/**
 * Reads a Pi session's harness events (src/roles/harness.ts) as progress. A runner without timings still gets a duration,
 * measured from when the control plane saw the call start.
 */
export function serviceProgressReader(clean:(text:string)=>string,now:()=>number=Date.now){
 const started=new Map<string,number>();
 return (event:any):ServiceProgress|undefined=>{
  if(event?.type==='model_start')return {kind:'model_step',step:Math.max(1,Math.floor(Number(event.step))||1)};
  if(event?.type==='compaction')return {kind:'notice',notice:event.phase==='started'?'compacting':event.failed||event.aborted?'compaction_failed':'compacted'};
  if(event?.type==='image_recovery')return {kind:'notice',notice:'image_recovery'};
  if(event?.type!=='tool'||!piNativeTools.includes(event.name))return undefined;
  const call=String(event.call_id??'').slice(0,200),name=String(event.name);
  if(event.phase==='started'){
   started.set(call,now());
   const shown=preview(name,event.arguments,clean);
   return {kind:'tool_started',call_id:call,name,...(shown?{preview:shown}:{})};
  }
  if(event.phase!=='completed')return undefined;
  const begun=started.get(call);started.delete(call);
  const duration=Number.isFinite(event.duration_ms)?Math.max(0,Math.round(event.duration_ms)):begun===undefined?undefined:Math.max(0,now()-begun);
  const code=name==='bash'?exitCode(event.result):undefined,last=name==='bash'?tail(event.result,clean):undefined;
  return {kind:'tool_finished',call_id:call,name,state:event.isError?'failed':'succeeded',...(duration===undefined?{}:{duration_ms:duration}),
   ...(code===undefined?{}:{exit_code:code}),...(last?{tail:last}:{})};
 };
}

/**
 * Keeps a chatty turn from flooding its conversation (#1266): a burst, then one step per interval, at most `cap` steps a
 * turn. A tool's end is let through whenever its start was, so no shown step stays running; skipped tool calls are counted.
 * Notices are rare (a compaction, a restart) and always pass.
 */
export class ProgressBudget {
 private tokens:number;private at:number;private admitted=0;private readonly open=new Set<string>();
 private skippedCalls=0;
 constructor(private readonly burst=30,private readonly interval=2000,private readonly cap=300,private readonly now:()=>number=Date.now){this.tokens=burst;this.at=now();}
 admit(progress:ServiceProgress):boolean{
  if(progress.kind==='notice')return true;
  if(progress.kind==='tool_finished')return this.open.delete(progress.call_id);
  const time=this.now();this.tokens=Math.min(this.burst,this.tokens+Math.max(0,time-this.at)/this.interval);this.at=time;
  if(this.tokens<1||this.admitted>=this.cap){if(progress.kind==='tool_started')this.skippedCalls++;return false;}
  this.tokens--;this.admitted++;if(progress.kind==='tool_started')this.open.add(progress.call_id);return true;
 }
 /** Tool calls skipped since the last call of this. */
 skipped():number{const count=this.skippedCalls;this.skippedCalls=0;return count;}
}

/**
 * One console identity per tool invocation of a turn (#1313): Pi may reuse its own call id in a later step of the same
 * turn, so the id the conversation pairs a call with its result on is generated here; Pi's id is only the lookup key
 * while the call is open. A finish without a start still gets an identity, so nothing is ever merged by name.
 */
export class CallIdentities {
 private readonly open=new Map<string,string>();
 constructor(private readonly next:()=>string){}
 start(call:string):string{const id=this.next();this.open.set(call,id);return id;}
 finish(call:string):string{const id=this.open.get(call);this.open.delete(call);return id??this.next();}
}
