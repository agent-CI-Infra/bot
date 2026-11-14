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

// The read token a Pi session gives its commands as GH_TOKEN and GITHUB_TOKEN. The control plane owns it: it revokes the
// tokens of a review round when the round ends, and replaces one that has less than fifteen minutes left. A session can
// outlive both (it waits for the next round, or keeps running across a control-plane restart), so it never trusts a value it
// holds: it asks again whenever the model calls github_read_token, before a command once the token has under ten minutes
// left, and before the first command of a resumed round (#711). The control plane answers with the token it holds now.
export function createReadGrant(exchange,mask){
  let grant=null,stale=false;
  const ask=async signal=>{
    const reply=await exchange(signal);
    // A refused or cancelled exchange leaves a token that is still good in place, but never one from an ended round.
    if(reply.error){if(stale||grant&&Date.parse(grant.expires_at)<=Date.now()){grant=null;stale=false;}}
    else {stale=false;grant=reply.structured_only?null:reply;if(grant)mask(grant.token);}
    return reply;
  };
  return {
    // The model asked for the token: the control plane's answer, or the reason there is none.
    request:ask,
    // The variables for a command, renewed first when the held token is from an ended round or about to expire.
    async env(signal){
      if(grant&&(stale||Date.parse(grant.expires_at)-Date.now()<10*60000))await ask(signal);
      return grant?{GH_TOKEN:grant.token,GITHUB_TOKEN:grant.token}:undefined;
    },
    // A new review round: the control plane revoked the tokens of the one that ended.
    resume(){if(grant)stale=true;},
    get current(){return grant;}
  };
}
