const repositoryTools=new Set(['github_read','github_search','read_job_log']);

// Reserve sibling results too: parallel tool results enter Pi history together after the batch.
export function createRepositoryResultGuard({getMessages,renderRequest,tooLarge}){
  const results=new Map();let pending=Promise.resolve();
  const check=(id,name,value)=>{
    const run=pending.then(async()=>{
      const message={role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text:JSON.stringify(value)}],isError:false,timestamp:Date.now()};
      results.set(id,message);
      if(repositoryTools.has(name)){
        const messages=getMessages(),recorded=new Set(messages.filter(message=>message.role==='toolResult').map(message=>message.toolCallId));
        const projected=[...messages,...[...results.values()].filter(message=>!recorded.has(message.toolCallId))];
        if(tooLarge(await renderRequest(projected))){
          value={error:'repository_result_too_large',detail:'The result would exceed the existing model request context limit. Narrow the path, remove recursive=1, or continue pagination with smaller page/per_page requests.'};
          message.content=[{type:'text',text:JSON.stringify(value)}];
        }
      }
      return value;
    });
    pending=run.catch(()=>{});return run;
  };
  check.reset=()=>results.clear();return check;
}
