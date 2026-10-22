import { createPublicKey, createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { type Store, type Row } from '../storage/database.js';
import { digest, fail, text, fields, type Json } from '../core/security.js';

export const actionsIssuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(actionsIssuer+'/.well-known/jwks'), {
  timeoutDuration:5000, [customFetch]:(url,options)=>fetch(url,{...options,redirect:'error'})
});
export function publicKey(value:unknown):string{
  const pem=text(value,8192);
  if(!pem.startsWith('-----BEGIN PUBLIC KEY-----')||pem.includes('PRIVATE KEY'))return fail(400,'invalid_client_public_key');
  try{
    const key=createPublicKey(pem),bits=key.asymmetricKeyDetails?.modulusLength||0;
    if(key.asymmetricKeyType!=='rsa'||bits<2048||bits>4096)return fail(400,'invalid_client_public_key');
    return key.export({type:'spki',format:'pem'}).toString();
  }catch{return fail(400,'invalid_client_public_key');}
}
export function fingerprint(pem:string|null):string|null{
  return pem?createHash('sha256').update(createPublicKey(pem).export({type:'spki',format:'der'})).digest('hex'):null;
}
export function audienceUrl(value:unknown):string{
  try{const url=new URL(text(value,2048));if(url.protocol!=='https:'||url.username||url.password||url.hash||url.search||url.pathname!=='/external/token')return fail(400,'invalid_token_audience');return url.href;}
  catch{return fail(400,'invalid_token_audience');}
}
export function tokenAudience(store:Store):string|undefined{return store.get("SELECT value FROM settings WHERE key='external_token_audience'")?.value;}
export function trustConfig(value: unknown): Json {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail(400,'oidc_trust_required');
  const v=value as Json;fields(v,['audience','subject','repository','repository_id','owner_id','workflow_ref','ref']);
  for(const key of ['audience','subject','repository','repository_id','owner_id','workflow_ref','ref'])text(v[key],512);
  if(!/^[1-9]\d*$/.test(String(v.repository_id))||!/^[1-9]\d*$/.test(String(v.owner_id))||!/^[-\w.]+\/[-\w.]+$/.test(String(v.repository))||
    !String(v.ref).startsWith('refs/heads/')||!String(v.workflow_ref).startsWith(v.repository+'/.github/workflows/')||!String(v.workflow_ref).endsWith('@'+String(v.ref)))fail(400,'invalid_oidc_trust');
  return v;
}
export async function authenticate(store:Store,client:Row|undefined,authorization:string,oidcKeys:JWTVerifyGetKey=keys,requestId?:string,audience?:string):Promise<string>{
  const token=/^Bearer ([^\s]+)$/.exec(authorization)?.[1];
  if(!client?.enabled||!token||token.length>16384)fail(401,'external_unauthorized');
  if(client!.auth_type==='private_key_jwt'){
    if(!client!.public_key)return fail(401,'external_unauthorized');
    if(!audience)return fail(503,'external_audience_not_configured');
    try{
      const {payload:p,protectedHeader:h}=await jwtVerify(token!,createPublicKey(client!.public_key),{issuer:client!.id,subject:client!.id,audience,algorithms:['RS256'],
        requiredClaims:['iss','sub','aud','exp','iat','jti'],maxTokenAge:'2m',clockTolerance:5});
      const now=Math.floor(Date.now()/1000);
      if(h.typ!=='JWT'||h.jku||h.jwk||h.x5u||p.aud!==audience||typeof p.iat!=='number'||typeof p.exp!=='number'||p.iat>now+5||p.exp<=p.iat||p.exp-p.iat>120||
        typeof p.jti!=='string'||!/^[a-zA-Z0-9_-]{16,128}$/.test(p.jti)||p.jti!==requestId)return fail(401,'external_unauthorized');
      return digest('private-key:'+client!.id+':'+p.jti);
    }catch{return fail(401,'external_unauthorized');}
  }
  if(client!.auth_type!=='github_actions_oidc')return fail(401,'external_unauthorized');
  const trust=JSON.parse(client!.trust);
  let p:any;
  try{({payload:p}=await jwtVerify(token!,oidcKeys,{issuer:actionsIssuer,audience:trust.audience,algorithms:['RS256'],
    requiredClaims:['sub','exp','iat','nbf','jti'],maxTokenAge:'10m',clockTolerance:5}));}catch{return fail(401,'external_unauthorized');}
  if(p.sub!==trust.subject||p.repository!==trust.repository||p.repository_id!==trust.repository_id||p.repository_owner_id!==trust.owner_id||p.workflow_ref!==trust.workflow_ref||
    p.ref!==trust.ref||p.ref_type!=='branch'||!['schedule','workflow_dispatch','repository_dispatch'].includes(String(p.event_name))||(p.job_workflow_ref!==undefined&&p.job_workflow_ref!==trust.workflow_ref)||typeof p.jti!=='string'||p.jti.length>512||
    !/^[1-9]\d*$/.test(String(p.run_id))||!/^[1-9]\d*$/.test(String(p.run_attempt))||p.exp-p.iat>600)fail(403,'external_identity_forbidden');
  // The same federated identity cannot mint twice, including through another client registration.
  return digest(actionsIssuer+':'+p.jti);
}
