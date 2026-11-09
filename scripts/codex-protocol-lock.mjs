// Checks the installed Codex CLI against the app-server protocol lock in src/harness/app-server.ts.
// Usage: npm run build && node scripts/codex-protocol-lock.mjs [work-dir] [--codex /path/to/codex]
// It regenerates the JSON Schema with the CLI under a throwaway CODEX_HOME (no login or shared config is read), hashes the
// definitions the client depends on and compares the CLI version and the digest. Exit code 1 means the lock is stale.
import {execFileSync} from 'node:child_process';import {createHash} from 'node:crypto';import {mkdirSync,readFileSync,rmSync} from 'node:fs';import {join,resolve} from 'node:path';
import {codexAppServer} from '../dist/harness/app-server.js';
const args=process.argv.slice(2),flag=args.indexOf('--codex'),codex=flag>=0?args.splice(flag,2)[1]:'codex';
const work=resolve(args[0]??'.tmp/codex-protocol-lock'),home=join(work,'codex-home'),out=join(work,'schema');
rmSync(work,{recursive:true,force:true});mkdirSync(home,{recursive:true});
const env={PATH:process.env.PATH,HOME:home,CODEX_HOME:home,LANG:'C.UTF-8'};
const version=/(\d+\.\d+\.\d+\S*)/.exec(execFileSync(codex,['--version'],{env,encoding:'utf8'}))?.[1]??null;
execFileSync(codex,['app-server','generate-json-schema','--out',out],{env,stdio:'ignore'});
const bundle=name=>JSON.parse(readFileSync(join(out,name),'utf8')).definitions??{};
const definitions={...bundle('codex_app_server_protocol.schemas.json'),...bundle('codex_app_server_protocol.v2.schemas.json')};
const missing=codexAppServer.definitions.filter(name=>!definitions[name]);
const serverRequests=JSON.parse(readFileSync(join(out,'ServerRequest.json'),'utf8')).oneOf.map(v=>v.properties?.method?.enum?.[0]).filter(Boolean).sort();
// Canonical JSON: sorted keys, so the digest depends on the schema content only.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=createHash('sha256').update(JSON.stringify(canonical({definitions:Object.fromEntries(codexAppServer.definitions.map(name=>[name,definitions[name]??null])),serverRequests}))).digest('hex');
const unanswered=serverRequests.filter(m=>!codexAppServer.serverRequests.includes(m));
const report={cli:version,locked_cli:codexAppServer.cli,digest,locked_digest:codexAppServer.schemaDigest,missing_definitions:missing,unanswered_server_requests:unanswered};
console.log(JSON.stringify(report,null,2));
rmSync(work,{recursive:true,force:true});
process.exit(version===codexAppServer.cli&&digest===codexAppServer.schemaDigest&&!missing.length&&!unanswered.length?0:1);
