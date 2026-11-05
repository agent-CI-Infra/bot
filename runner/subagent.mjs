import {narrowCapabilities,toolCapabilityError,platformWrites} from './capabilities.mjs';

// Tools a sub-agent never gets: publishing, any other write, finishing the task and starting more agents stay with the
// main agent. Finishing tools are named by the task configuration.
const reserved=config=>new Set(['finish_review','create_pull_request','start_agent',...Object.keys(platformWrites),...(config.finish_tools||[])]);
const offered=(config,name)=>name==='write_file'?config.capabilities.workspace.notes===true||config.capabilities.workspace.write===true:!toolCapabilityError(config,name,{});
// The configuration of one sub-agent: its own system prompt (the control plane's frame plus the instructions the main
// agent wrote) and the main agent's tools that its narrowed capabilities still allow.
export function subagentConfig(config,args){
  const capabilities=narrowCapabilities(config.capabilities,args?.permissions),child={...config,capabilities,review_session:false};
  const withheld=reserved(config);
  return {...child,system:config.subagent_system+'\n\n'+String(args.instructions),prompt:String(args.task),tools:config.tools.filter(tool=>!withheld.has(tool.function.name)&&offered(child,tool.function.name))};
}
// Runs one sub-agent to its final answer. createSession builds a new Pi session from the child configuration alone, with
// an empty history: the sub-agent never sees the main agent's messages, only its instructions and task.
export async function runSubagent({config,args,id,createSession,writeEvent}){
  if(config.capabilities?.agents!==true||typeof config.subagent_system!=='string')return {error:'start_agent_not_allowed'};
  if(!args||typeof args.instructions!=='string'||typeof args.task!=='string'||!args.task.trim())return {error:'start_agent_invalid'};
  const child=subagentConfig(config,args);
  await writeEvent({type:'agent_start',agent:id,name:String(args.name||''),tools:child.tools.map(tool=>tool.function.name),capabilities:child.capabilities});
  const session=await createSession(child,id);
  try{
    await session.prompt(child.prompt);
    const result=session.getLastAssistantText()||'';
    await writeEvent({type:'agent_end',agent:id,result});
    return {agent_id:id,tools:child.tools.map(tool=>tool.function.name),result};
  }finally{session.dispose();}
}
