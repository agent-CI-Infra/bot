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
// A result too large for the next request is saved by the control plane before it is replaced with a preview.
export function createToolResultGuard({getMessages,renderRequest,tooLarge,preserve}){
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
          value=value?.file?resultPreview(value,4096):preserve?resultPreview(await preserve(name,value),4096):{error:'tool_result_storage_failed'};
          message.content=[{type:'text',text:JSON.stringify(value)}];
        }
      }else{
        const call=messages.findLast(message=>message.role==='assistant');
        const kept=[...messages.filter(message=>message.role==='system'),...(call?[call]:[]),...batch];
        if(tooLarge(await renderRequest(kept),compactionSummaryTokens)){
          value=value?.file?resultPreview(value,4096):preserve?resultPreview(await preserve(name,value),4096):{error:'tool_result_storage_failed'};
          message.content=[{type:'text',text:JSON.stringify(value)}];
        }
      }
      return value;
    });
    pending=run.catch(()=>{});return run;
  };
  check.reset=()=>results.clear();return check;
}
