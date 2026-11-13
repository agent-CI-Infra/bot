import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { local, workspaceRoot, localEnvironment, assistant, homeDirectory as home } from './paths.mjs';
// User-level installs (pip --user, uv tool, cargo, npm prefix) land under HOME: the work volume of a project computer, the
// persistent HOME of an assistant computer.
const userBins = ['.local/bin', '.cargo/bin', '.npm-global/bin'].map(dir => `${home}/${dir}`).join(':');
// Repository variables configured by an administrator; the manager lists their names in BOT_PROJECT_ENV_KEYS.
const projectEnvironment = Object.fromEntries(String(process.env.BOT_PROJECT_ENV_KEYS || '').split(',').filter(Boolean)
  .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
// An assistant's HOME is persistent and has a size limit: package caches go to /tmp, which ends with the computer.
const caches = assistant ? { XDG_CACHE_HOME:'/tmp/.cache', PIP_CACHE_DIR:'/tmp/.cache/pip', UV_CACHE_DIR:'/tmp/.cache/uv', npm_config_cache:'/tmp/.npm' } : {};
export const environment = { LANG:'C.UTF-8', ...projectEnvironment, ...localEnvironment, ...caches,
  ...(/^[a-f0-9]{48}$/.test(process.env.BOT_OPERATION_ID || '') ? { BOT_OPERATION_ID: process.env.BOT_OPERATION_ID } : {}),
  PATH:`${local ? dirname(process.execPath) + ':' : ''}${userBins}:/usr/local/bin:/usr/bin:/bin`, HOME:home, TMPDIR:local ? workspaceRoot + '/tmp' : '/tmp',
  NPM_CONFIG_PREFIX:`${home}/.npm-global`, GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_NOSYSTEM:'1', GIT_TERMINAL_PROMPT:'0' };
// Output is mirrored to outputFile while the command runs so the control plane can show it live.
// timeoutMs null runs the command until it ends (stopping the project computer still ends it); omitted means 10 seconds.
// secretEnv (the task's read-only GitHub token) is added to the command's environment and masked in everything it prints.
// workspaceId marks the command and everything it starts as that task's (BOT_WORKSPACE_ID), so cleanup can end one task's
// processes while other tasks keep running on the same computer.
export const workspaceTag = id => /^[a-f0-9]{48}$/.test(id || '') ? { BOT_WORKSPACE_ID: id } : {};
export function command(value,cwd,timeoutMs=10000,{outputFile,keepBackground=false,secretEnv,workspaceId,backgroundDirectory}={}) {
  if(typeof value!=='string'||!value||value.length>32768)throw new Error('invalid_command');
  // Local mode shares the host process namespace: use task cleanup, never name-wide kills.
  if(local&&/(?:^|[\s;&|])(?:pkill|killall)(?:\s|$)/.test(value))return Promise.resolve({exit_code:126,output:'Name-wide process termination is disabled in local mode. Let the task manager clean up task processes, or stop a specific process you started.',timed_out:false,truncated:false});
  const extra=Object.fromEntries(Object.entries(secretEnv||{}).filter(([key,secret])=>['GH_TOKEN','GITHUB_TOKEN'].includes(key)&&typeof secret==='string'&&secret.length>=8));
  const mask=text=>Object.values(extra).reduce((masked,secret)=>masked.replaceAll(secret,'[REDACTED]'),text);
  if(keepBackground)return backgroundCommand(value,cwd,timeoutMs,{outputFile,extra,workspaceId,backgroundDirectory});
  return new Promise((resolve,reject)=>{
    const child=spawn('/bin/sh',['-c',value],{cwd,detached:true,env:{...environment,...workspaceTag(workspaceId),...extra},stdio:['ignore','pipe','pipe']});
    let output='',timedOut=false,truncated=false,done=false;
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=timeoutMs===null?null:setTimeout(()=>{timedOut=true;kill();},Math.max(100,Number(timeoutMs)||10000));
    const collect=data=>{
      if(Buffer.byteLength(output)+data.length>1024*1024){truncated=true;kill();return;}
      output+=data.toString();if(outputFile)try{appendFileSync(outputFile,mask(data.toString()),{mode:0o600});}catch{/* Live output is best effort. */}
    };
    const finish=(code,signal)=>{
      if(done)return;done=true;clearTimeout(timer);
      kill();
      resolve({exit_code:code,signal,output:mask(output),timed_out:timedOut,truncated});
    };
    child.stdout.on('data',collect);child.stderr.on('data',collect);
    child.on('error',error=>{clearTimeout(timer);kill();reject(error);});
    // By default the process group ends with the shell; keep_background leaves it running for later commands of the same task.
    child.on('exit',()=>kill());
    child.on('close',finish);
  });
}

// A small detached logger owns the service's pipes after this request exits. Its stdout is a regular file, so neither
// the runner's exit nor a full pipe buffer can terminate a service. Logs sit outside the candidate checkout.
function backgroundCommand(value,cwd,timeoutMs,{outputFile,extra,workspaceId,backgroundDirectory}) {
  const directory=backgroundDirectory||cwd;mkdirSync(directory,{recursive:true,mode:0o700});
  const logPath=join(mkdtempSync(join(directory,'.command-')),'output.log'),fd=openSync(logPath,'wx',0o600);
  return new Promise((resolve,reject)=>{
    let child;try{child=spawn(process.execPath,[fileURLToPath(new URL('./background-command.mjs',import.meta.url))],
      {cwd,detached:true,env:{...environment,...workspaceTag(workspaceId),...extra},stdio:['ignore',fd,fd,'ipc']});}finally{closeSync(fd);}
    let done=false,code=null,signal=null,timedOut=false;
    const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
    const timer=timeoutMs===null?null:setTimeout(()=>{timedOut=true;kill();finish();},Math.max(100,Number(timeoutMs)||10000));
    const startup=setTimeout(()=>finish(),500);
    const finish=()=>{
      if(done)return;done=true;clearTimeout(timer);clearTimeout(startup);
      let handle,size,bytes;const buffer=Buffer.alloc(65536);
      try{handle=openSync(logPath,'r');size=fstatSync(handle).size;bytes=readSync(handle,buffer,0,buffer.length,0);}
      catch(error){kill();reject(error);return;}finally{if(handle!==undefined)closeSync(handle);}
      const output=buffer.subarray(0,bytes).toString('utf8');
      if(outputFile)try{appendFileSync(outputFile,output,{mode:0o600});}catch{/* Live output is best effort. */}
      if(child.connected)child.disconnect();child.unref();
      resolve({exit_code:code,signal,output,timed_out:timedOut,truncated:size>65536,log_path:logPath,
        ...(!timedOut&&code===null&&signal===null?{running:true,pid:child.pid}:{})});
    };
    child.on('message',message=>{if(message.type==='exit'){code=message.code;signal=message.signal;}});
    child.on('exit',(exitCode,exitSignal)=>{code??=exitCode;signal??=exitSignal;finish();});
    child.on('error',error=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(startup);kill();reject(error);});
    child.send({command:value,secrets:Object.values(extra)});
  });
}
