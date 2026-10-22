import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';

let child=null,last=null,closing=false;
async function tick(){
  const token=await readFile('/tunnel/token').catch(()=>null),hash=token?createHash('sha256').update(token).digest('hex'):null;
  if(hash!==last||hash&&!child){
    if(child){const previous=child;child=null;previous.kill('SIGTERM');await new Promise(resolve=>{previous.once('exit',resolve);setTimeout(()=>{previous.kill('SIGKILL');resolve();},3000).unref();});}
    last=hash;if(hash&&!closing){child=spawn('cloudflared',['tunnel','--no-autoupdate','--metrics','0.0.0.0:2000','run','--token-file','/tunnel/token'],{stdio:'ignore'});const current=child;current.on('error',()=>{if(child===current)child=null;});current.on('exit',()=>{if(child===current)child=null;});}
  }
  if(!closing)setTimeout(tick,3000);
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{closing=true;child?.kill('SIGTERM');setTimeout(()=>process.exit(0),500).unref();});
await tick();
