import {readFile,stat,unlink} from 'node:fs/promises';

// Five seconds cover polling and transport delay; this is an idle window, never a total deadline.
export const modelReplyIdleMs=95000;
export async function waitModelReply(dir,id){
  let lastActivity=Date.now(),sequence=0,replyBytes=0;
  try{
    for(;;){
      const response=await readFile(dir+'/reply-'+id+'.json','utf8').then(JSON.parse).catch(()=>null);
      if(response)return response;
      const progress=await readFile(dir+'/progress-'+id+'.json','utf8').then(JSON.parse).catch(()=>null);
      if(Number.isSafeInteger(progress?.sequence)&&progress.sequence>sequence){sequence=progress.sequence;lastActivity=Date.now();}
      // A large sanitized reply arrives in several writes; keep waiting while those bytes advance.
      const partial=await stat(dir+'/reply-'+id+'.tmp').catch(()=>null);
      if(partial&&partial.size>replyBytes){replyBytes=partial.size;lastActivity=Date.now();}
      if(Date.now()-lastActivity>=modelReplyIdleMs)throw new Error('model_proxy_timeout');
      await new Promise(resolve=>setTimeout(resolve,100));
    }
  }finally{await unlink(dir+'/progress-'+id+'.json').catch(()=>{});}
}
