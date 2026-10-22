import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

// Unique resources allow worktrees to verify their own image without replacing a running deployment.
const suffix=randomBytes(6).toString('hex'),image='department-bot-external-test:'+suffix,name='department-bot-external-test-'+suffix;
mkdirSync('.cache/docker',{recursive:true});mkdirSync('.cache/buildx',{recursive:true});
const env={...process.env,DOCKER_CONFIG:resolve('.cache/docker'),BUILDX_CONFIG:resolve('.cache/buildx')};
const docker=args=>execFileSync('docker',args,{env,stdio:'inherit'});
try{
  docker(['build','-t',image,'.']);
  docker(['run','--rm','--name',name,'--label','department.bot.test=external-executors','--network','none','--read-only',
    '--cap-drop','ALL','--security-opt','no-new-privileges:true','--tmpfs','/data:rw,uid=10001,gid=10001,mode=0700',
    '--tmpfs','/tmp:rw,uid=10001,gid=10001,mode=0700','--mount','type=bind,source='+resolve('test')+',target=/app/test,readonly',
    '--no-healthcheck','--entrypoint','node',image,'/app/test/external-runtime.mjs']);
}finally{
  for(const args of [['rm','-f',name],['image','rm',image]])try{execFileSync('docker',args,{env,stdio:'ignore'});}catch{}
}
