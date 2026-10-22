import { spawn } from 'node:child_process';
export const environment = { PATH:'/usr/local/bin:/usr/bin:/bin', HOME:'/workspace/home',LANG:'C.UTF-8',TMPDIR:'/tmp',
  GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_TERMINAL_PROMPT:'0' };
export function command(value,cwd,timeoutMs=10000) {
  if(typeof value!=='string'||!value||value.length>32768)throw new Error('invalid_command');
  return new Promise((resolve,reject)=>{
    const child=spawn('/bin/sh',['-c',value],{cwd,detached:true,env:environment,stdio:['ignore','pipe','pipe']});
    let output='',timedOut=false,truncated=false;
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},Math.min(60000,Math.max(100,Number(timeoutMs)||10000)));
    const collect=data=>{if(Buffer.byteLength(output)+data.length<=1024*1024)output+=data.toString();else{truncated=true;kill();}};
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',error=>{clearTimeout(timer);kill();reject(error);});child.on('exit',kill);
    child.on('close',(code,signal)=>{clearTimeout(timer);kill();resolve({exit_code:code,signal,output,timed_out:timedOut,truncated});});
  });
}
