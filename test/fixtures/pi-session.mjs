// Drive the real Pi entry point without a provider or SDK installation. File and command tools still run normally.
import {workspace as run} from '../../runner/workspace.mjs';
import {environment} from '../../runner/command.mjs';

Object.assign(environment,{HOME:process.env.BOT_RUNNER_TEST_ROOT,TMPDIR:process.env.BOT_RUNNER_TEST_ROOT});
export const workspace=request=>run(request,process.env.BOT_RUNNER_TEST_ROOT);
export const createExtensionRuntime=()=>({});
export const ModelRuntime={create:async()=>({getModel:()=>({})})};
export const SessionManager={inMemory:()=>({})};
export const SettingsManager={inMemory:()=>({})};
export async function createAgentSession({customTools}){
  let subscriber;
  return {session:{
    subscribe(callback){subscriber=callback;},abort(){},dispose(){},getLastAssistantText:()=>'{"summary":"Done"}',
    async prompt(input){
      for(const [index,call] of JSON.parse(input).entries()){
        subscriber({type:'message_end',message:{role:'assistant',content:[{type:'toolCall',id:String(index),name:call.name,arguments:call.args}]}});
        await customTools.find(tool=>tool.name===call.name).execute(String(index),call.args);
      }
    }
  }};
}
