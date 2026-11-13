import { open, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';

// Local Pi commands use unique immutable journals in their own session directory. The manifest binds a result to the
// workspace and sub-agent that produced it; neither a path nor a different owner's file is accepted from model output.
export async function localCommandResult(directory,owner,id,value) {
  if(!value?.truncated||!value.output_file)return value;
  const {output_file,...preview}=value;
  try {
    const bytes=(await stat(directory+'/'+id+'.utf8')).size;
    await writeFile(directory+'/'+id+'.json',JSON.stringify({owner,bytes}),{mode:0o600,flag:'wx'});
    return {...preview,file:'result:'+id,bytes,encoding:'utf-8',notice:'Read the complete immutable output with read_tool_result(file, position, length). Positions and lengths are UTF-8 bytes; follow next_position until eof. Reading never repeats the command.'};
  }catch{return {...preview,error:'tool_result_storage_failed'};}
}
export async function readLocalResult(directory,owner,args) {
  if(!args||typeof args!=='object'||Object.keys(args).some(k=>!['file','position','length'].includes(k))||!/^result:[a-f0-9]{48}$/.test(args.file||''))return {error:'tool_result_not_found'};
  const id=args.file.slice(7),position=args.position??0,length=args.length??16384;let file;
  try {
    const meta=JSON.parse(await readFile(directory+'/'+id+'.json','utf8'));
    if(meta.owner!==owner)return {error:'tool_result_not_found'};
    if(!Number.isSafeInteger(position)||position<0||position>meta.bytes||!Number.isSafeInteger(length)||length<1||length>65536)return {error:'tool_result_range_invalid'};
    file=await open(directory+'/'+id+'.utf8',constants.O_RDONLY|constants.O_NOFOLLOW);
    if((await file.stat()).size!==meta.bytes)return {error:'tool_result_unavailable'};
    const data=Buffer.alloc(Math.min(length,meta.bytes-position)),{bytesRead}=await file.read(data,0,data.length,position);
    if(bytesRead!==data.length)return {error:'tool_result_unavailable'};
    if(data.length&&(data[0]&0xc0)===0x80)return {error:'tool_result_range_invalid'};
    let end=data.length;
    if(position+end<meta.bytes)for(let back=1;back<=3&&end-back>=0;back++){
      const byte=data[end-back];if((byte&0xc0)===0x80)continue;
      const need=byte>=0xf0?4:byte>=0xe0?3:byte>=0xc0?2:1;if(need>back)end-=back;break;
    }
    if(data.length&&!end)return {error:'tool_result_range_invalid'};
    return {file:args.file,content:data.subarray(0,end).toString('utf8'),position,next_position:position+end,eof:position+end===meta.bytes,bytes:meta.bytes,encoding:'utf-8'};
  }catch{return {error:'tool_result_unavailable'};}finally{await file?.close();}
}
export async function prepareLocalResults(directory){await mkdir(directory,{recursive:true,mode:0o700});}
