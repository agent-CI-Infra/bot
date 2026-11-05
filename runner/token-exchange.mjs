import {readFile,writeFile,rename,unlink} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {randomBytes} from 'node:crypto';

// Only token exchanges use this single-slot queue; other Pi tools remain independent.
export function createTokenExchange(dir){
  let pending=Promise.resolve();
  return async function exchange(signal){
    const cancelled={error:'github_read_token_cancelled'};
    const run=pending.then(async()=>{
      if(signal?.aborted)return cancelled;
      const id=randomBytes(24).toString('hex'),reply=dir+'/token-reply-'+id;
      try{
        await writeFile(dir+'/token-request.tmp',JSON.stringify({id}),{mode:0o600});
        await rename(dir+'/token-request.tmp',dir+'/token-request.json');
        for(const end=Date.now()+120000;Date.now()<end;){
          if(signal?.aborted)return cancelled;
          const value=await readFile(reply+'.json','utf8').then(JSON.parse).catch(()=>null);if(value)return value;
          await delay(100,undefined,{signal});
        }
        return {error:'github_read_token_timeout'};
      }catch(error){if(signal?.aborted)return cancelled;throw error;}
      finally{
        const current=await readFile(dir+'/token-request.json','utf8').then(JSON.parse).catch(()=>null);
        if(current?.id===id)await unlink(dir+'/token-request.json').catch(()=>{});
        await unlink(reply+'.json').catch(()=>{});await unlink(reply+'.tmp').catch(()=>{});
      }
    });
    pending=run.catch(()=>{});
    if(!signal)return run;
    // A queued cancellation returns immediately, even while an earlier caller still owns the slot.
    let abort;
    const interrupted=new Promise(resolve=>{abort=()=>resolve(cancelled);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
    try{return await Promise.race([run,interrupted]);}finally{signal.removeEventListener('abort',abort);}
  };
}
