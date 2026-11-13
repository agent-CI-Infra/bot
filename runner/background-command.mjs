import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

// The runner disconnects after startup; keep draining and masking both streams for the lifetime of the service.
process.once('message',({command,secrets})=>{
  const child=spawn('/bin/sh',['-c',command],{env:process.env,stdio:['ignore','pipe','pipe']});
  const send=message=>{if(process.connected)process.send(message,()=>{});};
  for(const stream of [child.stdout,child.stderr]){
    const decoder=new StringDecoder('utf8');let pending='';
    const flush=final=>{
      let held=0;
      if(!final)for(const secret of secrets)for(let n=1;n<secret.length;n++)if(pending.endsWith(secret.slice(0,n)))held=Math.max(held,n);
      let end=pending.length-held;
      // A retained prefix must not split a complete credential already present in this chunk.
      for(const secret of secrets){const start=pending.lastIndexOf(secret,end-1);if(start>=0&&start+secret.length>end)end=start;}
      const text=pending.slice(0,end);pending=pending.slice(end);
      writeSync(1,secrets.reduce((value,secret)=>value.replaceAll(secret,'[REDACTED]'),text));
    };
    stream.on('data',data=>{pending+=decoder.write(data);flush(false);});
    stream.on('end',()=>{pending+=decoder.end();flush(true);});
  }
  child.on('exit',(code,signal)=>send({type:'exit',code,signal}));
  child.on('error',error=>{writeSync(2,String(error.message));send({type:'exit',code:127,signal:null});});
  child.on('close',()=>{if(process.connected)process.disconnect();});
});
