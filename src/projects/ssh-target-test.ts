import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { fail } from '../core/security.js';
import type { Store } from '../storage/database.js';

type TestError = 'ssh_target_changed' | 'ssh_target_denied' | 'ssh_host_key_mismatch' | 'ssh_auth_failed' |
  'ssh_credential_invalid' | 'ssh_connect_failed' | 'ssh_connect_timeout';

/** A single authentication attempt from the control plane. Never opens an SSH channel. */
export async function testSshTarget(store: Store, actorId: string, id: string, project: string | null) {
  const lookup = () => store.get(`SELECT host,port,host_key_sha256,username,auth,sealed FROM ssh_targets
    WHERE id=? AND (owner_project IS ? OR (owner_project IS NULL AND EXISTS
        (SELECT 1 FROM ssh_target_projects WHERE target_id=? AND repository_id=?)))`,id,project,id,project);
  const target = lookup();
  if (!target) return fail(404,'ssh_target_not_found');
  const current = (): TestError | null => {
    try { store.checkAuthorization(); } catch { return 'ssh_target_denied'; }
    const row = lookup();
    return row && Object.keys(target).every(key => row[key] === target[key]) ? null : 'ssh_target_changed';
  };
  const error = await new Promise<TestError | null>(resolve => {
    const client = new ssh2.Client();
    let verified = false, attempted = false, stopped: TestError | null = null;
    const finish = (result: TestError | null) => {
      resolve(result);
      client.destroy();
    };
    client.on('error', (reason: Error & {level?:string}) => {
      const code = reason.level === 'client-authentication' ? 'ssh_auth_failed' :
        reason.level === 'client-timeout' ? 'ssh_connect_timeout' : 'ssh_connect_failed';
      finish(stopped ?? code);
    });
    client.once('close', () => resolve(stopped ?? 'ssh_connect_failed'));
    client.once('ready', () => finish(verified && attempted ? current() : 'ssh_auth_failed'));
    try {
      client.connect({
        host: target.host, port: target.port, username: target.username, readyTimeout: 10_000,
        hostVerifier: (key: Buffer) => {
          verified = 'SHA256:'+createHash('sha256').update(key).digest('base64').replace(/=+$/,'') === target.host_key_sha256;
          if (!verified) stopped = 'ssh_host_key_mismatch';
          return verified;
        },
        authHandler: () => {
          if (!verified || attempted) return false;
          stopped = current();
          if (stopped) return false;
          attempted = true;
          try {
            const credential = store.secrets.open(target.sealed,'ssh-target:'+id);
            if (target.auth === 'password' && typeof credential.password === 'string')
              return {type:'password',username:target.username,password:credential.password};
            if (target.auth === 'key' && typeof credential.private_key === 'string') {
              const key = ssh2.utils.parseKey(credential.private_key);
              if (!(key instanceof Error) && key.isPrivateKey()) return {type:'publickey',username:target.username,key};
            }
          } catch { /* Report a stable code without including key parser or decryption diagnostics. */ }
          stopped = 'ssh_credential_invalid';
          return false;
        },
      });
    } catch { finish('ssh_connect_failed'); }
  });
  store.audit(actorId,'ssh_target.test.'+(error ?? 'ok'),id,project);
  return error ? {ok:false,error} : {ok:true};
}
