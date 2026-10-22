import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for(const directory of ['manager','runner','tunnel','webhook','static','test/fixtures','scripts']){
  for(const name of readdirSync(directory))if(/\.(?:mjs|js)$/.test(name))execFileSync(process.execPath,['--check',`${directory}/${name}`],{stdio:'inherit'});
}
console.log('Runtime JavaScript syntax checks passed');
