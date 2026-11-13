import { spawn } from 'node:child_process';
import { writeSync } from 'node:fs';
import { maskedStream } from './command-output.mjs';

// The runner disconnects after startup; keep draining and masking both streams for the lifetime of the service.
process.once('message',({command,secrets})=>{
  const child=spawn('/bin/sh',['-c',command],{env:process.env,stdio:['ignore','pipe','pipe']});
  const send=message=>{if(process.connected)process.send(message,()=>{});};
  for(const stream of [child.stdout,child.stderr]){
    const masked=maskedStream(secrets,text=>writeSync(1,text));
    stream.on('data',masked.data);stream.on('end',masked.end);
  }
  child.on('exit',(code,signal)=>send({type:'exit',code,signal}));
  child.on('error',error=>{writeSync(2,String(error.message));send({type:'exit',code:127,signal:null});});
  child.on('close',()=>{if(process.connected)process.disconnect();});
});
