import http from 'node:http';

// The edge network has this fixed webhook gateway, never the bot or manager themselves.
// Neither the request URL nor Host header can select the upstream port.
const proxy=http.createServer((req,res)=>{
  const upstream=http.request({host:'bot',port:8791,method:req.method,path:req.url,headers:req.headers,timeout:30000},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
  upstream.on('timeout',()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.on('aborted',()=>upstream.destroy());req.pipe(upstream);
});
proxy.requestTimeout=30000;proxy.headersTimeout=10000;proxy.listen(8791,'0.0.0.0');

// The control plane reads non-sensitive tunnel readiness/routes through this bridge.
// No token, headers or other cloudflared configuration is returned.
http.createServer(async(req,res)=>{
  try{
    if(!['/ready','/config'].includes(req.url)||req.method!=='GET'){res.writeHead(404);res.end();return;}
    const response=await fetch('http://tunnel:2000'+req.url,{signal:AbortSignal.timeout(2500),redirect:'error'});
    if(req.url==='/ready'){res.writeHead(response.ok?200:503);res.end();return;}
    const config=await response.json(),ingress=(config.config?.ingress||[]).filter(r=>typeof r.hostname==='string').map(r=>{
      let service='invalid route';try{const url=new URL(r.service);if(['http:','https:'].includes(url.protocol))service=url.origin;}catch{}
      return {hostname:r.hostname,service};
    });res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({config:{ingress}}));
  }catch{res.writeHead(503);res.end();}
}).listen(8794,'0.0.0.0');
