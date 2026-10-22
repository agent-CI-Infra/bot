import {createServer} from 'node:http';
import {once} from 'node:events';
import {generateKeyPairSync,createVerify,randomBytes} from 'node:crypto';
import {harness,setup,account,repository} from './helpers.mjs';
import {ExternalService} from '../dist/external/service.js';
import {createAssertion} from '../scripts/external-token.mjs';
export const random=()=>randomBytes(24).toString('hex');
export async function githubFixture(t){
 const keys=generateKeyPairSync('rsa',{modulusLength:2048}),privateKey=keys.privateKey.export({format:'pem',type:'pkcs8'}),tokens=new Map(),grants=[],comments=[];let failMint=false,mintHook=null;
 const server=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{},path=decodeURIComponent(new URL(req.url,'http://fake').pathname),auth=req.headers.authorization?.slice(7);
  const send=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/app'||path.endsWith('/installation')||path.endsWith('/access_tokens')){
   try{const[h,p,s]=auth.split('.');if(!createVerify('RSA-SHA256').update(h+'.'+p).verify(keys.publicKey,Buffer.from(s,'base64url')))return send({},401);if(JSON.parse(Buffer.from(p,'base64url')).iss!=='123')return send({},401);}catch{return send({},401);}
   if(path==='/app')return send({id:123,slug:'fixture-app'});
   if(path.endsWith('/installation'))return send({id:7,account:{id:10},permissions:{contents:'write',issues:'write',pull_requests:'write'}});
   grants.push(body);if(failMint)return send({message:'fixture mint fault'},500);const token=random();tokens.set(token,{...body,revoked:false});const hook=mintHook;mintHook=null;await hook?.();return send({token,expires_at:new Date(Date.now()+3600000).toISOString()});
  }
  const token=tokens.get(auth);if(!token||token.revoked)return send({},401);
  if(path==='/installation/token'&&req.method==='DELETE'){token.revoked=true;res.writeHead(204);return res.end();}
  if(path.startsWith('/users/'))return send({id:999});
  const m=/^\/repositories\/(\d+)$/.exec(path);if(m){if(!token.repository_ids.includes(Number(m[1])))return send({},403);return send({id:Number(m[1]),full_name:'fixture/project-'+m[1],owner:{id:10},default_branch:'main'});}
  const comment=/^\/repos\/fixture\/project-(\d+)\/issues\/(\d+)\/comments$/.exec(path);
  if(comment&&req.method==='POST'){if(!token.repository_ids.includes(Number(comment[1]))||token.permissions.issues!=='write')return send({},403);const value={id:comments.length+1,body:body.body,user:{id:999,login:'fixture-app[bot]'}};comments.push(value);return send(value,201);}
  return send({},404);
 });server.listen(0,'127.0.0.1');await once(server,'listening');
 if(t)t.after(()=>new Promise(resolve=>server.close(resolve)));
 return {server,url:'http://127.0.0.1:'+server.address().port,keys,privateKey,tokens,grants,comments,setFail(value){failMint=value;},onMint(hook){mintHook=hook;}};
}
export async function externalFixture(t,options={}){
 const github=await githubFixture(t),h=await harness(t,undefined,store=>({external:new ExternalService(store,{githubUrl:github.url,privateHosts:['127.0.0.1'],...options})}));
 const{admin,password}=await setup(h),a=await account(admin,{type:'github_app',app_id:'123',private_key:github.privateKey,token:undefined});await repository(admin,a.id,'101');await repository(admin,a.id,'202');
 const audience='https://bot.invalid/external/token';await admin('/api/external/settings','PUT',{token_audience:audience});
 async function client(repo='101',extra={}){const keys=extra.auth_type==='github_actions_oidc'?null:generateKeyPairSync('rsa',{modulusLength:2048}),publicKey=keys?.publicKey.export({format:'pem',type:'spki'});
  const r=await admin('/api/external/clients','POST',{repository_id:repo,name:'Review workstation '+repo,auth_type:'private_key_jwt',...(publicKey?{public_key:publicKey}:{}),...extra});if(r.status!==201)throw Error(JSON.stringify(r));return {...r.value,privateKey:keys?.privateKey,publicKey};}
 async function exchange(clientId,identity,extra={}){const request=extra.request_id||random(),proof=identity?.type==='private'?createAssertion(clientId,audience,identity,request).assertion:identity;
  const r=await fetch(h.webhook+'/external/token',{method:'POST',headers:{Authorization:'Bearer '+proof,'Content-Type':'application/json'},body:JSON.stringify({client_id:clientId,request_id:request,...extra})});return {status:r.status,value:await r.json(),headers:r.headers};}
 const result={...h,managementClient:h.client,adminBase:h.admin,github,admin,password,a,client,exchange,audience,async restart(){await h.stop();await h.start();Object.assign(result,{store:h.store,external:h.external,webhook:h.webhook,adminBase:h.admin});}};return result;
}
