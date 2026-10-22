import { timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { type Store, type Row } from '../storage/database.js';
import { digest, fail, text, fields, type Json } from '../core/security.js';

export const actionsIssuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(actionsIssuer+'/.well-known/jwks'), {
  timeoutDuration:5000, [customFetch]:(url,options)=>fetch(url,{...options,redirect:'error'})
});
export function trustConfig(value: unknown): Json {
  if(!value||typeof value!=='object'||Array.isArray(value))return fail(400,'oidc_trust_required');
  const v=value as Json;fields(v,['audience','subject','repository','repository_id','owner_id','workflow_ref','ref']);
  for(const key of ['audience','subject','repository','repository_id','owner_id','workflow_ref','ref'])text(v[key],512);
  if(!/^[1-9]\d*$/.test(String(v.repository_id))||!/^[1-9]\d*$/.test(String(v.owner_id))||!/^[-\w.]+\/[-\w.]+$/.test(String(v.repository))||
    !String(v.ref).startsWith('refs/heads/')||!String(v.workflow_ref).startsWith(v.repository+'/.github/workflows/')||!String(v.workflow_ref).endsWith('@'+String(v.ref)))fail(400,'invalid_oidc_trust');
  return v;
}
export async function authenticate(store:Store,client:Row|undefined,authorization:string,oidcKeys:JWTVerifyGetKey=keys):Promise<string|null>{
  const token=/^Bearer ([^\s]+)$/.exec(authorization)?.[1];
  if(!client?.enabled||!token||token.length>16384)fail(401,'external_unauthorized');
  if(client!.auth_type==='client_secret'){
    const a=Buffer.from(digest(token!)),b=Buffer.from(client!.secret_hash||'');
    if(a.length!==b.length||!timingSafeEqual(a,b))fail(401,'external_unauthorized');return null;
  }
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
