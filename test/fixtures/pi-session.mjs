// Drive the real Pi entry point without a provider or SDK installation. File and command tools still run normally.
import {workspace as run} from '../../runner/workspace.mjs';
export {notSelected} from '../../runner/workspace.mjs';
import {environment} from '../../runner/command.mjs';

Object.assign(environment,{HOME:process.env.BOT_RUNNER_TEST_ROOT,TMPDIR:process.env.BOT_RUNNER_TEST_ROOT});
export const workspace=request=>run(request,process.env.BOT_RUNNER_TEST_ROOT,undefined,process.env.BOT_RUNNER_TEST_ROOT+'/project-notes');
export const createExtensionRuntime=()=>({});
// streamSimple only serializes: the runner's tool result guard reads the payload and stops before any request.
export const ModelRuntime={create:async()=>({getModel:()=>({}),streamSimple(_model,context,options){try{options?.onPayload?.(context);}catch{}return {result:async()=>({})};}})};
export const estimateTokens=message=>Math.ceil(JSON.stringify(message).length/4);
// Sessions are not written: a session reports its id and file name only.
const fixtureSession=file=>({getSessionId:()=>'fixture-session',getSessionFile:()=>file});
export const SessionManager={inMemory:()=>fixtureSession(undefined),create:(_cwd,dir)=>fixtureSession(dir+'/fixture-session.jsonl'),open:file=>fixtureSession(file)};
export const SettingsManager={create:()=>({})};
// A prompt is a JSON list of tool calls. Any other prompt (the runner asking the session to continue) runs the next list in
// BOT_FIXTURE_CONTINUE, or nothing. BOT_FIXTURE_LAST_TEXT replaces the last answer text. An entry {event} is a session event
// Pi would emit (a failed model reply, the end of a compaction) and is passed to the runner as it is.
const continuations=JSON.parse(process.env.BOT_FIXTURE_CONTINUE||'[]');
export async function createAgentSession({customTools}){
  let subscriber;const messages=[];
  return {session:{
    messages,agent:{state:{model:{},tools:[]},convertToLlm:async value=>value},
    subscribe(callback){subscriber=callback;},abort(){},dispose(){},getLastAssistantText:()=>process.env.BOT_FIXTURE_LAST_TEXT??'{"summary":"Done"}',
    async prompt(input){
      let calls;try{calls=JSON.parse(input);}catch{messages.push({role:'user',content:input});calls=continuations.shift()||[];}
      for(const [index,call] of calls.entries()){
        if(call.event){subscriber(call.event);continue;}
        subscriber({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:String(index),name:call.name,arguments:call.args}]}});
        await customTools.find(tool=>tool.name===call.name).execute(String(index),call.args);
      }
    }
  }};
}

// Legacy loop fixtures do not exercise native resources; fail explicitly if they accidentally enter that mode.
export class DefaultResourceLoader { constructor(){throw new Error('native resource loader not part of legacy fixture');} }
export function createBashTool(){throw new Error('native bash not part of legacy fixture');}

export function createCodingTools(){throw new Error('native tools not part of legacy fixture');}
