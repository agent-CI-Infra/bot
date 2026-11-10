// Drive the real Pi entry point without a provider or SDK installation. File and command tools still run normally.
import {workspace as run} from '../../runner/workspace.mjs';
import {environment} from '../../runner/command.mjs';

Object.assign(environment,{HOME:process.env.BOT_RUNNER_TEST_ROOT,TMPDIR:process.env.BOT_RUNNER_TEST_ROOT});
export const workspace=request=>run(request,process.env.BOT_RUNNER_TEST_ROOT,undefined,process.env.BOT_RUNNER_TEST_ROOT+'/project-notes');
export const createExtensionRuntime=()=>({});
// streamSimple only serializes: the runner's tool result guard reads the payload and stops before any request.
export const ModelRuntime={create:async()=>({getModel:()=>({}),streamSimple(_model,context,options){try{options?.onPayload?.(context);}catch{}return {result:async()=>({})};}})};
export const estimateTokens=message=>Math.ceil(JSON.stringify(message).length/4);
export const SessionManager={inMemory:()=>({})};
export const SettingsManager={inMemory:()=>({})};
// A prompt is a JSON list of tool calls. Any other prompt (the runner asking the session to continue) runs the next list in
// BOT_FIXTURE_CONTINUE, or nothing. BOT_FIXTURE_LAST_TEXT replaces the last answer text.
const continuations=JSON.parse(process.env.BOT_FIXTURE_CONTINUE||'[]');
export async function createAgentSession({customTools}){
  let subscriber;const messages=[];
  return {session:{
    messages,agent:{state:{model:{},tools:[]},convertToLlm:async value=>value},
    subscribe(callback){subscriber=callback;},abort(){},dispose(){},getLastAssistantText:()=>process.env.BOT_FIXTURE_LAST_TEXT??'{"summary":"Done"}',
    async prompt(input){
      let calls;try{calls=JSON.parse(input);}catch{messages.push({role:'user',content:input});calls=continuations.shift()||[];}
      for(const [index,call] of calls.entries()){
        subscriber({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:String(index),name:call.name,arguments:call.args}]}});
        await customTools.find(tool=>tool.name===call.name).execute(String(index),call.args);
      }
    }
  }};
}
