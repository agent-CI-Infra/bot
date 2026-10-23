import {fail} from '../core/security.js';

// Parse only GitHub identifiers; pasted URLs are never requested by the server.
export function installationOrganization(input:unknown):string{
  if(typeof input!=='string'||!input.trim()||input.length>2048||/[\s\u0000-\u001f\u007f]/.test(input.trim()))return fail(400,'invalid_installation_target');
  let value=input.trim(),name:string|undefined;
  if(value.startsWith('@'))value=value.slice(1);
  if(value.startsWith('git@github.com:'))value='https://github.com/'+value.slice('git@github.com:'.length);
  if(/^(?:www\.)?github\.com\//i.test(value))value='https://'+value;
  if(value.includes('://')){
    let url:URL;try{url=new URL(value);}catch{return fail(400,'invalid_installation_target');}
    if(!['https:','http:','ssh:'].includes(url.protocol)||!['github.com','www.github.com'].includes(url.hostname)||url.port||url.password||
      (url.protocol==='ssh:'?url.username!=='git':!!url.username))return fail(400,'invalid_installation_target');
    const parts=url.pathname.split('/').filter(Boolean);
    try{name=decodeURIComponent(parts[['orgs','organizations'].includes(parts[0]||'')?1:0]||'');}catch{return fail(400,'invalid_installation_target');}
  }else{
    const parts=value.split('/');if(parts.length>2||parts.some(part=>!part))return fail(400,'invalid_installation_target');name=parts[0];
  }
  if(!name||!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(name))return fail(400,'invalid_installation_target');
  return name;
}

export function organizationInstallUrl(slug:string,id:number):string{
  // GitHub documents suggested_target_id for preselecting an account on the permissions page.
  const url=new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new/permissions`);
  url.searchParams.set('suggested_target_id',String(id));return url.href;
}
