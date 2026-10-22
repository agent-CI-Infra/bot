import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { fail } from '../core/security.js';

export function targetUrl(value:unknown,privateHosts:string[]):URL{
  let url:URL;try{url=new URL(String(value));}catch{return fail(400,'invalid_forward_url');}
  if(url.username||url.password||url.hash||url.href.length>2048||!['http:','https:'].includes(url.protocol)||
    url.protocol!=='https:'&&!privateHosts.includes(url.hostname))fail(400,'invalid_forward_url');
  return url;
}
export function publicAddress(address:string):boolean{
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b!>=16&&b!<=31||a===192&&(b===168||b===0)||a===100&&b!>=64&&b!<=127||a!>=224||a===198&&(b===18||b===19));}
  // Permit globally routed IPv6 only; mapped/compatible IPv4, loopback and local/link-local ranges are excluded.
  return isIP(address)===6&&/^[23]/i.test(address)&&!/^2001:(?:db8|0:|2:)/i.test(address)&&!/^2002:/i.test(address);
}
export async function sendWebhook(value:string,body:Buffer,headers:Record<string,string>,privateHosts:string[]):Promise<number>{
  const url=targetUrl(value,privateHosts),host=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=await new Promise<{address:string;family:number}[]>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('dns_timeout')),5000);lookup(host,{all:true,verbatim:true}).then(rows=>{clearTimeout(timer);resolve(rows);},error=>{clearTimeout(timer);reject(error);});});
  if(!addresses.length||!privateHosts.includes(url.hostname)&&addresses.some(a=>!publicAddress(a.address)))fail(400,'forward_address_forbidden');
  const chosen=addresses[0]!;
  return new Promise((resolve,reject)=>{
    // Pin the checked DNS result so the HTTP request cannot resolve to a different address.
    const req=(url.protocol==='https:'?httpsRequest:httpRequest)(url,{method:'POST',agent:false,headers:{...headers,'Content-Length':String(body.length)},
      lookup:((_host:any,options:any,callback:any)=>options.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)) as any},res=>{clearTimeout(deadline);const status=res.statusCode||0;res.destroy();resolve(status);});
    const deadline=setTimeout(()=>req.destroy(new Error('timeout')),5000);
    req.on('error',()=>{clearTimeout(deadline);reject(new Error('forward_unavailable'));});req.end(body);
  });
}
