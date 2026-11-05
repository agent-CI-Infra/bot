import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

// Only repository tools share this queue; Pi can keep running other tools in parallel.
export function createRepositoryTool(dir){
  let pending=Promise.resolve();
  return function repositoryTool(name,args,signal){
    const run=pending.then(async()=>{
      if(signal?.aborted)return {error:'repository_tool_cancelled'};
      const id=randomBytes(24).toString('hex'),reply=dir+'/repository-reply-'+id;
      try{
        await writeFile(dir+'/repository-request.tmp',JSON.stringify({id,name,arguments:args}),{mode:0o600});
        await rename(dir+'/repository-request.tmp',dir+'/repository-request.json');
        for(const end=Date.now()+120000;Date.now()<end;await new Promise(resolve=>setTimeout(resolve,100))){
          if(signal?.aborted)return {error:'repository_tool_cancelled'};
          const value=await readFile(reply+'.json','utf8').then(JSON.parse).catch(()=>null);if(value)return value;
        }
        return {error:'repository_tool_timeout'};
      }finally{
        await unlink(dir+'/repository-request.json').catch(()=>{});
        await unlink(reply+'.json').catch(()=>{});await unlink(reply+'.tmp').catch(()=>{});
      }
    });
    // A failed exchange must also release the next caller's mailbox slot.
    pending=run.catch(()=>{});
    return run;
  };
}
