'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {createUsageProvider,fetchOauthUsage}=require('../../src/main/providers/usage.js');
test('Codex routes to its reader, keeps weekly primary weekly, and coalesces concurrent reads',async()=>{
 let calls=0;const usage=createUsageProvider({profiles:[{id:'c',provider:'codex',configHome:'/codex'}],readFile:async()=>{throw Error('Claude reader must not run')},fetchCodexUsage:async home=>{assert.equal(home,'/codex');calls++;await new Promise(r=>setTimeout(r,10));return {weeklyPct:60,weeklyResetsAt:2000000000,updatedAt:new Date().toISOString()}}});
 const results=await Promise.all([usage.getUsage('c'),usage.getUsage('c')]);assert.equal(results[0].weeklyPct,60);assert.equal(results[0].fiveHourPct,undefined);assert.equal(calls,1);await usage.getUsage('c');assert.equal(calls,1);
});
test('Codex unavailable errors are provider-specific and contain no raw errors',async()=>{
 const p=createUsageProvider({profiles:[{id:'c',provider:'codex',configHome:'/codex'}],fetchCodexUsage:async()=>{throw Error('secret')}});const r=await p.getUsage('c');assert.equal(r.unavailable,true);assert.match(r.reason,/Codex/);assert.doesNotMatch(r.reason,/secret|Claude/);
});
test('remote kill switch also disables Codex',async()=>{
 let calls=0;const p=createUsageProvider({profiles:[{id:'c',provider:'codex',configHome:'/codex'}],fetchRemoteUsage:null,fetchCodexUsage:async()=>{calls++}});await p.getUsage('c');assert.equal(calls,0);
});
test('Claude can use an injected app-managed credential reader when no file exists',async()=>{
 const r=await fetchOauthUsage('/claude',{readCredentials:async()=>({claudeAiOauth:{accessToken:'fixture',expiresAt:9999999999999}}),readFile:async()=>{throw Error('missing')},fetchImpl:async(_,o)=>{assert.equal(o.headers.authorization,'Bearer fixture');return {ok:true,json:async()=>({five_hour:{utilization:22}})}}});assert.equal(r.payload.rate_limits.five_hour.used_percentage,22);
});
test('Codex maps duration instead of primary/secondary position and ignores unrelated buckets',()=>{
 const {mapCodexUsage}=require('../../src/main/providers/codex-usage.js');
 const r=mapCodexUsage({rateLimitsByLimitId:{codex:{primary:{usedPercent:60,windowDurationMins:10080,resetsAt:2000000000}}}},new Date('2026-09-22'));
 assert.equal(r.weeklyPct,60);assert.equal(r.fiveHourPct,undefined);
 assert.equal(mapCodexUsage({rateLimitsByLimitId:{other:{primary:{usedPercent:99,windowDurationMins:300}}}}),null);
});
test('Claude missing login produces an actionable reason without a network request',async()=>{
 const r=await fetchOauthUsage('/claude',{readCredentials:async()=>({claudeAiOauth:{expiresAt:0}}),reportUnavailable:true,fetchImpl:async()=>{throw Error('must not call')}});assert.match(r.reason,/sign in/i);assert.equal(r.unavailable,true);
});
test('Codex protocol initializes before reading limits and closes without starting a session',async()=>{
 const {EventEmitter}=require('node:events');const {PassThrough,Writable}=require('node:stream');
 const {fetchCodexUsage}=require('../../src/main/providers/codex-usage.js');
 const child=new EventEmitter();child.stdout=new PassThrough();let killed=false;child.kill=()=>{killed=true};const sent=[];
 child.stdin=new Writable({write(chunk,encoding,done){const m=JSON.parse(chunk);sent.push(m.method);if(m.id===1)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:1,result:{}})+'\n'));if(m.id===2)queueMicrotask(()=>child.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:12,windowDurationMins:300},secondary:{usedPercent:60,windowDurationMins:10080}}}})+'\n'));done()}});
 const r=await fetchCodexUsage('/test-home',{env:{PATH:'/bin',ELECTRON_RUN_AS_NODE:'1'},spawnImpl:(file,args,options)=>{assert.deepEqual(args,['app-server','--stdio']);assert.equal(options.env.CODEX_HOME,'/test-home');assert.equal(options.env.ELECTRON_RUN_AS_NODE,undefined);return child}});
 assert.deepEqual(sent,['initialize','initialized','account/rateLimits/read']);assert.equal(r.fiveHourPct,12);assert.equal(r.weeklyPct,60);assert.equal(killed,true);
});
