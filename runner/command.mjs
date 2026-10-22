import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
// User-level installs (pip --user, uv tool, cargo, npm prefix) land under HOME, which lives in the work volume.
const home = '/workspace/home', userBins = ['.local/bin', '.cargo/bin', '.npm-global/bin'].map(dir => `${home}/${dir}`).join(':');
// Repository variables configured by an administrator; the manager lists their names in BOT_PROJECT_ENV_KEYS.
const projectEnvironment = Object.fromEntries(String(process.env.BOT_PROJECT_ENV_KEYS || '').split(',').filter(Boolean)
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
export const environment = { LANG:'C.UTF-8', ...projectEnvironment, PATH:`${userBins}:/usr/local/bin:/usr/bin:/bin`, HOME:home, TMPDIR:'/tmp',
  NPM_CONFIG_PREFIX:`${home}/.npm-global`, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_TERMINAL_PROMPT:'0' };
// Absolute ceiling; each project's own limit (set by an administrator) is enforced by the manager.
export const maxCommandMs = 4 * 60 * 60 * 1000;
// Output is mirrored to outputFile while the command runs so the control plane can show it live.
export function command(value,cwd,timeoutMs=10000,{outputFile,keepBackground=false}={}) {
  if(typeof value!=='string'||!value||value.length>32768)throw new Error('invalid_command');
  return new Promise((resolve,reject)=>{
    const child=spawn('/bin/sh',['-c',value],{cwd,detached:true,env:environment,stdio:['ignore','pipe','pipe']});
    let output='',timedOut=false,truncated=false,done=false;
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=setTimeout(()=>{timedOut=true;kill();},Math.min(maxCommandMs,Math.max(100,Number(timeoutMs)||10000)));
    const collect=data=>{
      if(Buffer.byteLength(output)+data.length>1024*1024){truncated=true;kill();return;}
      output+=data.toString();if(outputFile)try{appendFileSync(outputFile,data,{mode:0o600});}catch{/* Live output is best effort. */}
    };
    const finish=(code,signal)=>{
      if(done)return;done=true;clearTimeout(timer);
      // Kept background processes may still hold the pipes; release them instead of waiting.
      if(keepBackground&&!timedOut&&!truncated){child.stdout.destroy();child.stderr.destroy();child.unref();}else kill();
      resolve({exit_code:code,signal,output,timed_out:timedOut,truncated});
    };
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',error=>{clearTimeout(timer);kill();reject(error);});
    // By default the process group ends with the shell; keep_background leaves it running for later commands of the same task.
    child.on('exit',(code,signal)=>{if(keepBackground)setTimeout(()=>finish(code,signal),500);else kill();});
    child.on('close',finish);
  });
}
