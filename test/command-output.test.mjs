import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
