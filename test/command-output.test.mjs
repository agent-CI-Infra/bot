import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { command } from '../runner/command.mjs';
import { CommandOutput, maskedStream } from '../runner/command-output.mjs';

const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
for(const exit of [0,1])test(`a 5 MiB command finishes with exit ${exit}, bounded preview and a complete log`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'command-output-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const log=join(directory,'complete.log'),body="process.stdout.write('HEAD\\n'+'x'.repeat(5*1024*1024)+'\\nFINAL_"+exit+"\\n',()=>{process.exitCode="+exit+";});";
  const result=await command(quote(process.execPath)+' -e '+quote(body),directory,30000,{outputFile:log});
  assert.equal(result.exit_code,exit);assert.equal(result.signal,null);assert.equal(result.timed_out,false);assert.equal(result.truncated,true);
  assert.match(result.head,/^HEAD/);assert.match(result.tail,new RegExp('FINAL_'+exit+'\\n$'));
  assert.match(result.output,/bytes omitted/);assert.match(result.output,new RegExp('FINAL_'+exit));
  assert.equal(result.output_file,log);assert.equal(statSync(log).size,result.output_bytes);
  const complete=readFileSync(log,'utf8');assert.ok(complete.length>5*1024*1024);assert.ok(complete.endsWith('FINAL_'+exit+'\n'));
});

test('a 128 MiB command completes with a 64 MiB JavaScript heap limit',t=>{
  const directory=mkdtempSync(join(tmpdir(),'command-memory-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const producer="const chunk='x'.repeat(65536);let i=0;const pump=()=>{while(i<2048){i++;if(!process.stdout.write(chunk)){process.stdout.once('drain',pump);return;}}};pump();";
  const shell=quote(process.execPath)+' -e '+quote(producer),module=new URL('../runner/command.mjs',import.meta.url).href;
  const script='import {command} from '+JSON.stringify(module)+';const result=await command('+JSON.stringify(shell)+','+JSON.stringify(directory)+',30000,{outputFile:'+JSON.stringify(join(directory,'output.log'))+'});console.log(JSON.stringify({exit:result.exit_code,bytes:result.output_bytes,rss:process.resourceUsage().maxRSS}));';
  const result=JSON.parse(execFileSync(process.execPath,['--max-old-space-size=64','--input-type=module','-e',script],{encoding:'utf8',timeout:45000}));
  assert.equal(result.exit,0);assert.equal(result.bytes,128*1024*1024);assert.ok(result.rss<128*1024,JSON.stringify(result));
});

test('head and tail previews preserve multibyte characters',()=>{
  const result=new CommandOutput(),chunk='中😀'.repeat(8192);for(let i=0;i<30;i++)result.append(chunk);
  const preview=result.result();assert.ok(!preview.head.includes('\ufffd'));assert.ok(!preview.tail.includes('\ufffd'));
  assert.ok(Buffer.byteLength(preview.output)<1024*1024+200);
});

test('credential and UTF-8 boundaries are preserved before writing or previewing output',()=>{
  const seen=[],stream=maskedStream(['ghp_verylongcredential'],value=>seen.push(value));
  const bytes=Buffer.from('中😀 ghp_verylongcredential end');for(const byte of bytes)stream.data(Buffer.from([byte]));stream.end();
  assert.equal(seen.join(''),'中😀 [REDACTED] end');
});

test('a complete output file that cannot be written is an explicit failure',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'command-output-error-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  await assert.rejects(command('printf done',directory,1000,{outputFile:join(directory,'missing','output')}),/ENOENT/);
});


import {localCommandResult,readLocalResult,prepareLocalResults} from '../runner/tool-results.mjs';
test('local Pi result files page an immutable command without workspace command permission',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'command-pi-pages-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));await prepareLocalResults(directory);
  const id='a'.repeat(48),path=join(directory,id+'.utf8'),body='HEAD\n'+'中😀'.repeat(800000)+'\nERROR_END\n';
  const producer="process.stdout.write('HEAD\\n'+'中😀'.repeat(800000)+'\\nERROR_END\\n',()=>{process.exitCode=1})";
  const raw=await command(quote(process.execPath)+' -e '+quote(producer),directory,30000,{outputFile:path});
  const result=await localCommandResult(directory,'workspace:agent',id,raw);assert.equal(result.exit_code,1);assert.equal(result.output_file,undefined);assert.match(result.tail,/ERROR_END/);
  let position=0,complete='';for(;;){const page=await readLocalResult(directory,'workspace:agent',{file:result.file,position,length:65536});assert.equal(page.error,undefined);complete+=page.content;if(page.eof)break;position=page.next_position;}
  assert.equal(complete,body);assert.equal((await readLocalResult(directory,'other-agent',{file:result.file})).error,'tool_result_not_found');assert.equal((await readLocalResult(directory,'workspace:agent',{file:result.file,position:7})).error,'tool_result_range_invalid');
});

import {Docker} from '../manager/docker.mjs';
test('local Pi background files retain their startup snapshot while later logs grow',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'command-pi-background-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));await prepareLocalResults(directory);
  const id='b'.repeat(48),path=join(directory,id+'.utf8'),log=join(directory,'live.log'),startup='HEAD\n'+'中😀'.repeat(200000)+'\nSTARTED\n';
  writeFileSync(path,startup);writeFileSync(log,startup);
  const result=await localCommandResult(directory,'workspace:agent',id,{running:true,exit_code:null,timed_out:false,truncated:true,output_file:path,log_path:log,head:'HEAD\n',tail:'STARTED\n'});
  assert.equal(result.error,undefined);assert.match(result.notice,/startup snapshot/);assert.match(result.notice,/read_tool_result/);assert.equal(result.log_path,log);
  appendFileSync(log,'LATER_OUTPUT\n');let position=0,restored='';
  for(;;){const page=await readLocalResult(directory,'workspace:agent',{file:result.file,position,length:65536});assert.equal(page.error,undefined);restored+=page.content;if(page.eof)break;position=page.next_position;}
  assert.equal(restored,startup);assert.ok(readFileSync(log,'utf8').endsWith('LATER_OUTPUT\n'));
});

test('Docker stdout frames may split UTF-8 characters in paginated results',async()=>{
  const docker=new Docker(),data=Buffer.from(JSON.stringify({ok:true,result:{data:'中😀'.repeat(1000)}})),frames=[];
  for(let offset=0;offset<data.length;offset+=17){const part=data.subarray(offset,offset+17),header=Buffer.alloc(8);header[0]=1;header.writeUInt32BE(part.length,4);frames.push(header,part);}
  docker.request=async(_method,path)=>path.endsWith('/start')?Buffer.concat(frames):path.endsWith('/json')?{Running:false,ExitCode:0}:{Id:'exec'};
  assert.deepEqual(await docker.runner('computer',{operation_id:'a'.repeat(48)}),{ok:true,result:{data:'中😀'.repeat(1000)}});
});
