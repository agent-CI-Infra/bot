export function resultPreview(value,limit=32768){
  if(!value?.file)return value;
  const {output,head='',tail='',...metadata}=value;
  let first=String(head||output||''),last=String(tail);
  const result=()=>({...metadata,head:first,tail:last});
  while(Buffer.byteLength(JSON.stringify(result()))>limit&&first.length+last.length){first=first.slice(0,Math.floor(first.length*.75));last=last.length>1?last.slice(-Math.floor(last.length*.75)):'';}
  return result();
}
const repositoryTools=new Set(['github_read','github_search','read_job_log']);
// Pi compaction summarizes older history but always keeps the latest tool call with all of its results. Its summary
// (earlier history plus, for a split turn, the turn prefix) takes up to two model outputs of 8192 tokens.
const compactionSummaryTokens=2*8192;
const toolMessage=(id,name,value)=>({role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text:JSON.stringify(value)}],isError:false,timestamp:Date.now()});
// What the model gets instead of a result that cannot fit. A command has already run, so its status stays visible.
function withheld(name,value){
  if(value?.file)return resultPreview(value,4096);
  const status=name==='run_command'&&value&&typeof value==='object'
    ?Object.fromEntries(['exit_code','signal','timed_out','truncated','running','pid'].filter(key=>Object.hasOwn(value,key)).map(key=>[key,value[key]])):{};
  return {error:'tool_result_too_large',...status,result_characters:JSON.stringify(value)?.length??0,detail:name==='run_command'
    ?'The command ran, but its output alone exceeds the model request context limit and was not returned. Do not print it again in full: pipe it through head, tail, grep or wc, or redirect it to a temporary file outside the repository checkout and read only the parts you need.'
    :'This result alone exceeds the model request context limit and was not returned. Read a smaller part instead, for example one file at a time or a line range with head, sed -n or grep.'};
}

// Checks each tool result before it enters Pi history. Parallel results enter history together after the batch, so
// sibling results count too.
// - GitHub reads must fit the whole next request; the model narrows the read (repository_result_too_large).
// - Any other result is withheld only when compaction cannot make it fit: the latest tool call with this batch alone,
//   plus the system prompt and a compaction summary, would exceed the request limit (tool_result_too_large).
//   Without this, one oversized command output fails the whole task with agent_context_too_large.
export function createToolResultGuard({getMessages,renderRequest,tooLarge}){
  const results=new Map();let pending=Promise.resolve();
  const check=(id,name,value)=>{
    const run=pending.then(async()=>{
      value=resultPreview(value);
      const message=toolMessage(id,name,value);
      results.set(id,message);
      const messages=getMessages(),recorded=new Set(messages.filter(message=>message.role==='toolResult').map(message=>message.toolCallId));
      const batch=[...results.values()].filter(message=>!recorded.has(message.toolCallId));
      if(repositoryTools.has(name)){
        if(tooLarge(await renderRequest([...messages,...batch]))){
          value={error:'repository_result_too_large',detail:'The result would exceed the existing model request context limit. Narrow the path, remove recursive=1, or continue pagination with smaller page/per_page requests.'};
          message.content=[{type:'text',text:JSON.stringify(value)}];
        }
      }else{
        const call=messages.findLast(message=>message.role==='assistant');
        const kept=[...messages.filter(message=>message.role==='system'),...(call?[call]:[]),...batch];
        if(tooLarge(await renderRequest(kept),compactionSummaryTokens)){
          value=withheld(name,value);
          message.content=[{type:'text',text:JSON.stringify(value)}];
        }
      }
      return value;
    });
    pending=run.catch(()=>{});return run;
  };
  check.reset=()=>results.clear();return check;
}
