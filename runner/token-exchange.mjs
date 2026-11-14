import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

// Each token exchange owns token-requests/<id>.json and waits for token-replies/<id>.json,
// allowing concurrent callers without head-of-line blocking or request collisions.
export function createTokenExchange(dir, options = {}) {
  const requestsDir = dir + '/token-requests', repliesDir = dir + '/token-replies';
  const defaultToken = options.token ?? null;
  let dirsReady;
  const ensureDirs = () => (dirsReady ??= Promise.all([
    mkdir(requestsDir, { recursive: true, mode: 0o700 }),
    mkdir(repliesDir, { recursive: true, mode: 0o700 })
  ]));

  return async function exchange(signal, callOptions = {}) {
    const cancelled = { error: 'github_read_token_cancelled' };
    if (signal?.aborted) return cancelled;
    await ensureDirs();
    if (signal?.aborted) return cancelled;
    const id = randomBytes(24).toString('hex');
    const reqBase = `${requestsDir}/${id}`, replyBase = `${repliesDir}/${id}`;
    const token = callOptions.token !== undefined ? callOptions.token : defaultToken;
    try {
      await writeFile(reqBase + '.tmp', JSON.stringify({ id, ...(token ? { token } : {}) }), { mode: 0o600 });
      await rename(reqBase + '.tmp', reqBase + '.json');
      for (const end = Date.now() + 120000; Date.now() < end;) {
        if (signal?.aborted) return cancelled;
        const value = await readFile(replyBase + '.json', 'utf8').then(JSON.parse).catch(() => null);
        if (value) return value;
        await delay(50, undefined, signal ? { signal } : undefined);
      }
      return { error: 'github_read_token_timeout' };
    } catch (error) {
      if (signal?.aborted) return cancelled;
      throw error;
    } finally {
      await unlink(reqBase + '.json').catch(() => {});
      await unlink(reqBase + '.tmp').catch(() => {});
      await unlink(replyBase + '.json').catch(() => {});
      await unlink(replyBase + '.tmp').catch(() => {});
    }
  };
}

// The read token a Pi session gives its commands as GH_TOKEN and GITHUB_TOKEN. The control plane owns it: it revokes the
// tokens of a review round when the round ends, and replaces one that has less than fifteen minutes left. A session can
// outlive both (it waits for the next round, or keeps running across a control-plane restart), so it never trusts a value it
// holds: it asks again whenever the model calls github_read_token, before a command once the token has under ten minutes
// left, and before the first command of a resumed round (#711). The control plane answers with the token it holds now.
export function createReadGrant(exchange,mask){
  let grant=null,stale=false;
  const ask=async signal=>{
    const reply=await exchange(signal);
    // A refused or cancelled exchange leaves a token that is still good in place, but never one from an ended round.
    if(reply.error){if(stale||grant&&Date.parse(grant.expires_at)<=Date.now()){grant=null;stale=false;}}
    else {stale=false;grant=reply.structured_only?null:reply;if(grant)mask(grant.token);}
    return reply;
  };
  return {
    // The model asked for the token: the control plane's answer, or the reason there is none.
    request:ask,
    // The variables for a command, renewed first when the held token is from an ended round or about to expire.
    async env(signal){
      if(grant&&(stale||Date.parse(grant.expires_at)-Date.now()<10*60000))await ask(signal);
      return grant?{GH_TOKEN:grant.token,GITHUB_TOKEN:grant.token}:undefined;
    },
    // A new review round: the control plane revoked the tokens of the one that ended.
    resume(){if(grant)stale=true;},
    get current(){return grant;}
  };
}
