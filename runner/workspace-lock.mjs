import {spawn} from 'node:child_process';

// Kernel lock, shared by independent runner processes and released on pipe close
// or crash. This is our own lock file; never remove Git's live index.lock.
export async function withWorkspaceLock(path, work) {
  const child=spawn('python3',['-c',
    'import fcntl,sys\nf=open(sys.argv[1],"a")\nfcntl.flock(f,fcntl.LOCK_EX)\nprint("locked",flush=True)\nsys.stdin.read()\n',path],{stdio:['pipe','pipe','pipe']});
  child.stdin.on('error',()=>{});
  const ended=new Promise(resolve=>child.once('close',resolve));
  try {
    await new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',code=>reject(new Error('workspace_lock_failed:'+code)));
      child.stdout.once('data',()=>resolve());
    });
    return await work();
  } finally {child.stdin.end();await ended;}
}
