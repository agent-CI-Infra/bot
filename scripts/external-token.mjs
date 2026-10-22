import { createPrivateKey, createSign, randomBytes } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only the short assertion leaves the client; the private key is never sent to the broker.
export function createAssertion(clientId,audience,privateKey,requestId=randomBytes(24).toString('hex'),now=Math.floor(Date.now()/1000)){
  const key=typeof privateKey==='string'?createPrivateKey(privateKey):privateKey;
  if(key.type!=='private'||key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048||key.asymmetricKeyDetails.modulusLength>4096)throw new Error('RSA private key (2048–4096 bits) required');
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const data=encode({alg:'RS256',typ:'JWT'})+'.'+encode({iss:clientId,sub:clientId,aud:audience,iat:now,exp:now+120,jti:requestId});
  return {request_id:requestId,assertion:data+'.'+createSign('RSA-SHA256').update(data).sign(key).toString('base64url')};
}
export async function exchangeToken(url,clientId,privateKey,fetcher=fetch){
  const target=new URL(url);
  if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash||target.pathname!=='/external/token')throw new Error('Use the configured HTTPS token audience URL');
  const proof=createAssertion(clientId,target.href,privateKey);
  const response=await fetcher(target.href,{method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),headers:{'Content-Type':'application/json',Authorization:'Bearer '+proof.assertion},body:JSON.stringify({client_id:clientId,request_id:proof.request_id})});
  if(!response.ok)throw new Error('Token exchange failed (HTTP '+response.status+')');
  const value=await response.json();if(typeof value.token!=='string'||typeof value.grant_id!=='string'||typeof value.expires_at!=='string')throw new Error('Invalid token response');return value;
}
async function main(){
  if(process.argv.includes('--help')){console.log('node scripts/external-token.mjs --url <configured HTTPS token URL> --client-id <id> --key <local private PEM file>');return;}
  const options={};for(let i=2;i<process.argv.length;i+=2){const key=process.argv[i],value=process.argv[i+1];if(!['--url','--client-id','--key'].includes(key)||!value||options[key])throw new Error('Use --help for required options');options[key]=value;}
  if(!options['--key']||!options['--url']||!options['--client-id'])throw new Error('Use --help for required options');
  if(process.platform!=='win32'&&(statSync(options['--key']).mode&0o077))throw new Error('Private key permissions must be 0600 or stricter');
  const result=await exchangeToken(options['--url'],options['--client-id'],readFileSync(options['--key'],'utf8'));process.stdout.write(JSON.stringify(result)+'\n');
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.code?'Cannot read the private key file':error.message);process.exitCode=1;});
