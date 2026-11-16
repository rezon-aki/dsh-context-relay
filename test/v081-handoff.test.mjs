import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtempSync, readFileSync, readdirSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRelayHandoffTool } from '../lib/agent/handoff.js';
import { configurePanelStore, clearPanelMemory, panelStateOf } from '../lib/panel-store.js';

// rc.2 dsh-schedule 形状（lib/types/types.d.ts:439-450 / :394-417）：list() 返回分页对象，条目带 target/status。
const page=(items,offset=0)=>({items,shown:items.length,total:items.length,limit:items.length||1,offset});
const task=(id,owner,extra={})=>({id,kind:'every',title:'timer '+id,prompt:'check '+id,everySeconds:20,scheduledAt:'2026-11-01T00:00:00.000Z',status:'active',target:{kind:'session',sessionId:owner},...extra});

function harness({accept = true, dispatchError, disposeError, killError} = {}) {
 const cwd = mkdtempSync(join(tmpdir(), 'relay-v081-'));
 delete globalThis[Symbol.for('dsh-context-relay.handoff.recovery')];
 clearPanelMemory(); configurePanelStore({panelPath:join(cwd,'panel.json')});
 const events = []; const calls = []; const log = [];
 const session = {id:'old',header:{cwd},snapshotEvents:()=>[],requestHeader:()=>undefined};
 const inbox={nextTurn:[],nextStep:[]};
 const child={session:{id:'new',header:{cwd},requestHeader:()=>undefined,snapshotEvents:()=>log},inbox,followup(message){calls.push('dispatch'); if(accept) inbox.nextTurn.push(message); if(dispatchError) throw dispatchError;},cancel(){calls.push('cancel');inbox.nextTurn.length=0;}};
 const services={agents:{async create(){calls.push('create');return {agent:child,async dispose(){calls.push('dispose');if(disposeError) throw disposeError;}}},get:()=>child},agentPresets:{async mount(){}},jobs:{list:(owner)=>owner==='old'?[{id:'job',owner,status:'running',label:'job launch command in checkpoint'}]:[],kill(){calls.push('kill');assert.ok(inbox.nextTurn.length,'must observe acceptance before kill');if(killError) throw killError;}},workspaceRegistry:{async resolveByPath(){return {id:'ws',async attachSession(){}}}}};
 const ctx={get:n=>services[n],logger:{warn(){},info(){}},on(n,f){events.push({n,f});return ()=>{};},effect:f=>f()};
 const tool=createRelayHandoffTool({ctx,currentThresholds:()=>({baseline:.35}),presetId:'relay',inheritOnHandoff:false,workItems:{enabled:false}});
 return {cwd,calls,inbox,session,child,services,ctx,events,run:()=>tool.execute({human_approved:true,status:{goal:'handoff',next_actions:['continue']}},{agent:{session,options:{}}})};
}

test('v081: missing acceptance keeps old work alive and disposes owned child',async()=>{const h=harness({accept:false});const r=await h.run();assert.equal(r.ok,false);assert.equal(r.code,'takeover-unconfirmed');assert.ok(!h.calls.includes('kill'));assert.ok(h.calls.includes('dispose'));assert.equal(panelStateOf('old').handedOff,false);assert.match(readFileSync(r.handoffPath,'utf8'),/takeover-unconfirmed/);});
test('v081: accepted inbox receipt precedes cleanup and is returned',async()=>{const h=harness();const r=await h.run();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.takeover.accepted,true);assert.ok(h.calls.indexOf('dispatch')<h.calls.indexOf('kill'));});
test('v081: stop-old failure persists full recovery and does not silently succeed',async()=>{const detail='failure '.repeat(500);const h=harness({killError:new Error(detail)});const r=await h.run();assert.equal(r.ok,false);assert.equal(r.code,'handoff-cleanup-failed');assert.ok(r.recovery.length);const text=readFileSync(r.handoffPath,'utf8');assert.ok(text.includes(detail));assert.match(text,/job launch command in checkpoint/);assert.match(text,/recovery/);});
test('v081: async dispose failure is returned, not swallowed',async()=>{const h=harness({accept:false,dispatchError:new Error('dispatch'),disposeError:new Error('dispose failed')});const r=await h.run();assert.equal(r.ok,false);assert.match(JSON.stringify(r.recovery),/dispose failed/);assert.ok(!h.calls.includes('kill'));});

test('v081: event admission receipt is sufficient even after inbox was claimed', async()=> {
 const h=harness({accept:false}); h.child.followup=message=>h.child.session.snapshotEvents=()=>[{type:'agent/inbox/spliced',seq:7,data:{inserted:[message]}}];
 const r=await h.run(); assert.equal(r.takeover.evidence,'agent/inbox/spliced'); assert.equal(r.takeover.seq,7);
});
test('v081: controller failure parks and reuses exactly one destination',async()=>{
 const h=harness({accept:false});let created=0;h.services.sessionController={async create(){created++;return {sessionId:'new'};}};
 h.services.agents.list=()=>[h.child];const failed=await h.run();assert.equal(failed.code,'takeover-unconfirmed');assert.ok(h.calls.includes('cancel'));
 h.child.followup=message=>h.inbox.nextTurn.push(message);const retried=await h.run();assert.equal(retried.ok,true,JSON.stringify(retried));assert.equal(created,1);assert.equal(retried.createdVia,'recovery-reuse');
});
test('v081: accepted destination with cleanup failure is never duplicated',async()=>{
 const h=harness({killError:new Error('cancel rejected')});const first=await h.run();const second=await h.run();assert.equal(first.code,'handoff-cleanup-failed');assert.equal(second.code,'recovery-required');assert.equal(h.calls.filter(x=>x==='create').length,1);
});
test('v081: rc.2 schedule retarget failure records recovery with the exact edit request',async()=>{
 const h=harness();h.services.jobs=undefined;const calls=[];h.services.schedule={async list(){return page([task('s','old')]);},async edit(q){calls.push(q);throw new Error('edit rejected');}};
 const r=await h.run();assert.equal(r.code,'handoff-cleanup-failed');assert.deepEqual(calls,[{id:'s',action:'update',patch:{target:{kind:'session',sessionId:r.sessionId}}}]);assert.match(readFileSync(r.handoffPath,'utf8'),/migrate-schedule:s/);assert.match(JSON.stringify(r.recovery),/edit rejected/);
});
test('v081: invalid phase is zero side effect',async()=>{
 const h=harness();const t=createRelayHandoffTool({ctx:h.ctx,currentThresholds:()=>({}),presetId:'relay'});const r=await t.execute({human_approved:true,status:{phase:'bad'}},{agent:{session:h.session}});assert.equal(r.code,'handoff-invalid');assert.deepEqual(h.calls,[]);
});
test('v081: drain failure stops before jobs and persists recovery',async()=>{
 const h=harness();h.services.subagents={async listDescendants(){return [];},async drainDescendants(){throw new Error('drain failed');}};
 const r=await h.run();assert.equal(r.code,'handoff-cleanup-failed');assert.ok(!h.calls.includes('kill'));assert.match(readFileSync(r.handoffPath,'utf8'),/drain failed/);
});
test('v081: rc.2 schedule vanished before cleanup is reported not-found, not a cleanup failure',async()=>{
 const h=harness();h.services.jobs=undefined;h.services.schedule={async list(){return page([task('s','old')]);},async edit(){return {id:'s',code:'schedule_not_found'};}};
 const r=await h.run();assert.equal(r.ok,true,JSON.stringify(r));assert.equal(r.handover.cleanup.schedules[0].action,'not-found');assert.equal(r.handover.cleanup.errors.length,0);
});
test('v081: inventory failure has no destination or file effects',async()=>{
 const h=harness();h.services.jobs.list=()=>{throw new Error('inventory failed');};const r=await h.run();assert.equal(r.code,'handoff-preflight-failed');assert.equal(r.handoffPath,undefined);assert.deepEqual(h.calls,[]);
});
test('v081: rejected asynchronous dispatch is awaited and child is disposed',async()=>{
 const h=harness();h.child.followup=async()=>{throw new Error('async rejected');};const r=await h.run();assert.equal(r.code,'followup-failed');assert.ok(h.calls.includes('dispose'));assert.ok(!h.calls.includes('kill'));
});
test('v081: accepted recovery manifest survives loss of process memory',async()=>{
 const h=harness({killError:new Error('cancel rejected')});await h.run();delete globalThis[Symbol.for('dsh-context-relay.handoff.recovery')];const r=await h.run();assert.equal(r.code,'recovery-required');assert.equal(h.calls.filter(x=>x==='create').length,1);assert.match(JSON.stringify(r.recovery),/cancel rejected/);
});
function handoffFile(h) { const dir=join(h.cwd,'.scratch','context-relay');return join(dir,readdirSync(dir).find(name=>/^handoff-\d+\.md$/.test(name))); }
test('v081 fix: schedule prompt and cleanup error credentials never persist',async()=>{
 const h=harness();h.services.jobs=undefined;const secret='sk-'+ 'Q'.repeat(30);h.services.schedule={async list(){return page([task('s','old',{prompt:'Bearer '+secret})]);},async edit(){throw new Error('api_key='+secret);}};
 const r=await h.run();assert.equal(r.code,'handoff-cleanup-failed');for(const name of readdirSync(join(h.cwd,'.scratch','context-relay'))){if(!name.endsWith('.md')&&!name.endsWith('.json'))continue;assert.ok(!readFileSync(join(h.cwd,'.scratch','context-relay',name),'utf8').includes(secret),name);}assert.match(readFileSync(r.handoffPath,'utf8'),/REDACTED/);assert.ok(!JSON.stringify(r.recovery).includes(secret));
});
test('v081 fix: terminal handoff symlink refuses journal before old-work mutation',async()=>{
 const h=harness();const victim=join(h.cwd,'victim');writeFileSync(victim,'unchanged');let swapped=false;const list=h.services.jobs.list;h.services.jobs.list=owner=>{if(h.inbox.nextTurn.length&&!swapped){const path=handoffFile(h);unlinkSync(path);symlinkSync(victim,path);swapped=true;}return list(owner);};
 const r=await h.run();assert.equal(r.code,'handoff-cleanup-failed');assert.equal(readFileSync(victim,'utf8'),'unchanged');assert.ok(!h.calls.includes('kill'));assert.match(JSON.stringify(r.recovery),/symbolic link/);
});
test('v081 fix: fsync failure before each destructive step blocks interrupt kill and schedule edit',async()=>{
 for(const target of ['interrupt-subagent:child','cancel-job:job','migrate-schedule:s']){
  const h=harness();if(target.startsWith('interrupt'))h.services.subagents={async listDescendants(){return [{kind:'child',id:'child',mode:'continuable',activity:'running'}];},interrupt(){h.calls.push('interrupt');}};
  if(target.startsWith('migrate')){h.services.jobs=undefined;h.services.schedule={async list(){return page([task('s','old')]);},async edit(){h.calls.push('schedule-edit');return {id:'s'};}};}
  const original=fs.fsyncSync;let injected=false;fs.fsyncSync=fd=>{const path=readlinkSync('/proc/self/fd/'+fd);if(/handoff-\d+\.md\.tmp-/.test(path)&&readFileSync(path,'utf8').includes('"step": "'+target+'"')){injected=true;throw new Error('journal fsync injected');}return original(fd);};syncBuiltinESMExports();
  let r;try{r=await h.run();}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
  assert.equal(injected,true,target);assert.equal(r.code,'handoff-cleanup-failed');assert.ok(!h.calls.includes('interrupt'));assert.ok(!h.calls.includes('kill'));assert.ok(!h.calls.includes('schedule-edit'));assert.match(JSON.stringify(r.recovery),/journal fsync injected/);
 }
});
test('v081 fix: diagnostic descendant preflight preserves all old work and creates no destination',async()=>{
 const h=harness();h.services.subagents={async listDescendants(){return [{kind:'diagnostic',id:'broken-child',reason:'catalog corrupt'}];},interrupt(){h.calls.push('interrupt');},async drainDescendants(){h.calls.push('drain');}};
 h.services.schedule={async list(){return page([]);},async edit(){h.calls.push('schedule-edit');}};
 const r=await h.run();assert.equal(r.code,'handoff-preflight-failed');assert.equal(r.handoffPath,undefined);assert.deepEqual(h.calls,[]);assert.match(JSON.stringify(r.recovery),/subagents diagnostic broken-child: catalog corrupt/);assert.equal(panelStateOf('old').handedOff,false);
});
test('v081 fix: completed action fsync failure stops later schedule migration',async()=>{
 const h=harness();h.services.schedule={async list(){return page([task('s','old')]);},async edit(){h.calls.push('schedule-edit');return {id:'s'};}};
 const original=fs.fsyncSync;let injected=false;fs.fsyncSync=fd=>{const path=readlinkSync('/proc/self/fd/'+fd);if(/handoff-\d+\.md\.tmp-/.test(path)){const text=readFileSync(path,'utf8');if(text.includes('"step": "cancel-job:job",\n  "state": "completed"')){injected=true;throw new Error('post-action fsync injected');}}return original(fd);};syncBuiltinESMExports();
 let r;try{r=await h.run();}finally{fs.fsyncSync=original;syncBuiltinESMExports();}
 assert.equal(injected,true);assert.equal(r.code,'handoff-cleanup-failed');assert.ok(h.calls.includes('kill'));assert.ok(!h.calls.includes('schedule-edit'));assert.match(JSON.stringify(r.recovery),/post-action fsync injected/);assert.match(JSON.stringify(r.recovery),/killed/);
});

// ── C15（REVIEW-IMPL 缺口2/3）：可选盘点抛错降级 + schedule_conflict 重读重试 1 次 ──
test('v081 C15: schedule.list 抛错降级 skipped=N/A+warn，不触发 preflight fail（缺口3）',async()=>{
 const h=harness();h.services.jobs=undefined;h.services.schedule={async list(){throw new Error('schedule storage boom');},async edit(){throw new Error('must not migrate');}};
 const r=await h.run();assert.equal(r.ok,true,JSON.stringify(r));assert.ok(r.handover.inventory.skipped.includes('schedule'));assert.deepEqual(r.handover.inventory.errors,[]);assert.deepEqual(r.handover.inventory.schedules,[]);assert.deepEqual(r.handover.cleanup.schedules,[]);assert.match(r.summary,/定时任务 N\/A/);assert.ok(h.calls.includes('create'),'交接仍建新会话');
});
test('v081 C15: schedule_conflict → 重读一次带最新 updatedAt 重试 edit，成功记 transferred（缺口2）',async()=>{
 const h=harness();h.services.jobs=undefined;const edits=[];const views=[];let n=0;
 h.services.schedule={async list(){return page([task('s','old')]);},async view(q){views.push(q);return task('s','old',{updatedAt:'2026-11-16T01:00:00.000Z'});},async edit(q){edits.push(q);n+=1;if(n===1)return {id:'s',code:'schedule_conflict'};return task('s',q.patch.target.sessionId);}};
 const r=await h.run();assert.equal(r.ok,true,JSON.stringify(r));assert.deepEqual(views,[{id:'s'}]);assert.equal(edits.length,2);assert.equal(edits[1].expectedUpdatedAt,'2026-11-16T01:00:00.000Z');assert.equal(r.handover.cleanup.schedules[0].action,'transferred');assert.deepEqual(r.handover.cleanup.errors,[]);
});
test('v081 C15: schedule_conflict 重试仍冲突 → 清理失败留 recovery，只重试 1 次（缺口2）',async()=>{
 const h=harness();h.services.jobs=undefined;const edits=[];h.services.schedule={async list(){return page([task('s','old')]);},async view(){return task('s','old',{updatedAt:'2026-11-16T01:00:00.000Z'});},async edit(q){edits.push(q);return {id:'s',code:'schedule_conflict'};}};
 const r=await h.run();assert.equal(r.code,'handoff-cleanup-failed');assert.equal(edits.length,2,'只重试 1 次（共 2 次 edit）');assert.match(JSON.stringify(r.recovery),/schedule_conflict/);assert.equal(r.handover.cleanup.schedules[0].action,'pending');
});

