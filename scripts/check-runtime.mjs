import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for(const directory of ['manager','runner','tunnel','webhook','static','test/fixtures','scripts','public-board','public-board/scripts','public-board/scripts/lib','public-board/single-repo/static']){
  for(const name of readdirSync(directory))if(/\.(?:mjs|js)$/.test(name))execFileSync(process.execPath,['--check',`${directory}/${name}`],{stdio:'inherit'});
}
// The Pi harness pins the SDK version the project computer image installs; the two must not drift apart.
const pinned=/version: '([^']+)'/.exec(/export const piRuntime = \{[^}]*\}/.exec(readFileSync('src/agent/pi.ts','utf8'))?.[0]||'')?.[1];
const installed=JSON.parse(readFileSync('runner/package.json','utf8')).dependencies['@earendil-works/pi-coding-agent'];
if(!pinned||pinned!==installed){console.error(`src/agent/pi.ts pins Pi ${pinned}, runner/package.json installs ${installed}`);process.exit(1);}
console.log('Runtime JavaScript syntax checks passed');
