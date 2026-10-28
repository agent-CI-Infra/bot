import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

// Separate runtimes emulate browser time zones without changing the test runner's own zone.
function inZone(zone,code,files=['static/app.js']){
  const source=`import {loadConsole} from './test/console-page.mjs';
    const page=loadConsole(${JSON.stringify(files)},()=>[404,{}]);
    process.stdout.write(JSON.stringify(await page.run(${JSON.stringify(code)})));`;
  return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{env:{...process.env,TZ:zone},encoding:'utf8'}));
}

test('timestamps follow the browser zone across day/year boundaries and accept explicit offsets',async t=>{
  for(const [zone,expected,last] of [
    ['UTC','2026-10-27 20:30:00','2026-12-31 23:59:59'],
    ['Asia/Shanghai','2026-10-28 04:30:00','2027-01-01 07:59:59'],
    ['America/Los_Angeles','2026-10-27 13:30:00','2026-12-31 15:59:59'],
    ['Asia/Kathmandu','2026-10-28 02:15:00','2027-01-01 05:44:59'],
  ])await t.test(zone,()=>{
    const actual=inZone(zone,"['2026-10-27T20:30:00.123Z','2026-10-28T04:30:00+08:00','2026-12-31T23:59:59.999Z'].map(timestamp)");
    assert.deepEqual(actual,[expected,expected,last]);
  });
});

test('browser daylight-saving rules apply, and missing or invalid timestamps stay empty',()=>{
  assert.deepEqual(inZone('America/New_York',"['2026-03-08T06:59:59Z','2026-03-08T07:00:00Z','2026-11-01T05:59:59Z','2026-11-01T06:00:00Z'].map(timestamp)"),
    ['2026-03-08 01:59:59','2026-03-08 03:00:00','2026-11-01 01:59:59','2026-11-01 01:00:00']);
  assert.deepEqual(inZone('UTC',"[undefined,null,'','not-a-time'].map(timestamp)"),['','','','']);
  assert.equal(inZone('UTC','timestamp(0)'),'1970-01-01 00:00:00');
});

test('timeline, snapshot stream, project commands, sampling and sync use the same local clock',async t=>{
  for(const [zone,full] of [['Asia/Shanghai','2026-10-28 04:30:00'],['America/Los_Angeles','2026-10-27 13:30:00']])await t.test(zone,()=>{
    const result=inZone(zone,`(() => {
      const at='2026-10-27T20:30:00.123Z',log={created_at:at,content:JSON.stringify({type:'queued',detail:'排队'})};
      const visible=node=>[node.textContent,...node.children.map(visible)].filter(Boolean).join(' ');
      const timeline=step(log).querySelector('time');
      appendSnapshotProgress($('timeline'),log,{type:'snapshot_progress',sha:'abc',files:100,bytes:1000,detail:'已写入 100 个文件'});
      current={id:'101',environment:{tasks:[],commands:[{command:'npm test',created_at:at,kind:'review.issue',object_number:1,exit_code:0}]}};
      usage={id:'101',stats:{running:true,sampled_at:at}};
      return {full:timestamp(at),clock:timeline.textContent,title:timeline.title,dateTime:timeline.dateTime,
        snapshotClock:snapshotProgress.time.textContent,snapshotTitle:snapshotProgress.time.title,snapshotDateTime:snapshotProgress.time.dateTime,
        snapshotOutput:visible(snapshotProgress.output),commands:visible(activityCards()[2]),sampling:visible(usageCard()),
        sync:syncSummary([{account_name:'Fixture',synced_at:at}]),board:boardTime(at)};
    })()`,['static/app.js','static/views.js','static/metrics.js','static/project.js','static/board.js']);
    const clock=full.slice(11,19);
    assert.equal(result.full,full);assert.equal(result.clock,clock);assert.equal(result.title,full);
    assert.equal(result.snapshotClock,clock);assert.equal(result.snapshotTitle,full);
    assert.equal(result.dateTime,'2026-10-27T20:30:00.123Z');assert.equal(result.snapshotDateTime,result.dateTime);
    assert.ok(result.snapshotOutput.includes('['+clock+'] 已写入 100 个文件'));
    assert.ok(result.commands.includes(clock+' · 检视 Issue #1'));assert.ok(result.sampling.includes('采样 '+clock));
    assert.ok(result.sync.includes('同步于 '+clock));assert.ok(result.board.endsWith(full.slice(5,16)));
  });
});
