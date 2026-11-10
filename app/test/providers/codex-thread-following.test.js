'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createProviderSessionLinker } = require('../../src/main/providers/provider-session-link.js');
const { codexTitleIndex } = require('../../src/main/providers/provider-session-link.js');
const { createSidebarBridge } = require('../../src/main/sidebar-bridge.js');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

test('keeper title observer requires no filesystem, SQLite or timers and has no output retry hook', async () => {
  const file = path.resolve(__dirname, '../../src/daemon/codex-title-identity.js');
  const calls = [], exports = {};
  const context = { module: { exports }, exports, require: name => {
    if (/fs|sqlite/.test(name)) { calls.push(name); throw Error('forbidden IO module'); }
    return require(name);
  }, setTimeout: () => assert.fail('timer'), setInterval: () => assert.fail('timer') };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  const m = context.module.exports, titles = [];
  const observe = m.createCodexTitleIdentity({ agent: 'codex', argv: ['--no-daemon', m.CODEX_IDENTITY_PIN],
    onTitle: prefix => titles.push(prefix), onIdentity: () => assert.fail('keeper annotated') });
  for (let i = 0; i < 14601; i++) await observe(A.slice(0,29) + '...');
  assert.equal(observe.retry, undefined); assert.deepEqual(calls, []);
  assert.deepEqual(titles, [A.slice(0,29)]);
});

test('fresh title leaves identity unset so the old main can perform its first binding', async () => {
  const m = require('../../src/daemon/codex-title-identity.js'); let identity = null, prefix;
  const observe = m.createCodexTitleIdentity({ agent: 'codex', argv: ['--no-daemon', m.CODEX_IDENTITY_PIN],
    isRootThread: () => true, onIdentity: id => { identity = id; }, onTitle: value => { prefix = value; } });
  await observe(A);
  assert.equal(identity, null, 'fd0e90a skips panes named before its first binding');
  assert.equal(prefix, A);
});

test('a second live pane cannot steal a thread already linked to the first', async () => {
  let panes = [{ pane_id:'a', agent:'codex', codex_title:{prefix:A,revision:1}, agent_session:{kind:'id',value:A} }]; const events=[];
  const linker=createProviderSessionLinker({listPanes:()=>panes,paneAgentProcess:async()=>null});
  linker.emitter.on('link',e=>events.push(e)); await linker.resolveNow();
  panes.push({pane_id:'b',agent:'codex',codex_title:{prefix:A,revision:1},agent_session:{kind:'id',value:A}}); await linker.resolveNow();
  assert.equal(events.length,1); assert.equal(linker.get('b'),null);
  assert.equal(linker.apply(panes)[1].agent_session,null); linker.close();
});

test('first rail publication does not wait for a slow provider resolver', async t => {
  let release; const blocked=new Promise(r=>{release=r;});
  const history=new EventEmitter();Object.assign(history,{listSessions:async()=>[],sessionHomes:async()=>({})});
  const subscription=new EventEmitter();subscription.close=()=>{};
  const linker={emitter:new EventEmitter(),apply:p=>p,resolveNow:()=>blocked,start(){},close(){}};
  const bridge=createSidebarBridge({history,providerHistory:null,providerSessionLinker:linker,delegationIndex:null,
    createControlClient:()=>({bootstrap:async()=>({snapshot:{workspaces:[{workspace_id:'w',label:'Fixture',cwd:'/fixture'}],panes:[{pane_id:'a',workspace_id:'w',cwd:'/fixture',agent:'codex'}]},subscription})})});
  t.after(()=>{release();bridge.close();});bridge.emitter.on('error',()=>{});
  const start=bridge.start(); await new Promise(r=>setTimeout(r,50));
  const rows=bridge.getState().model.projects.flatMap(p=>p.sessions);
  assert.equal(rows.length,1,'live rail must publish while resolution is pending'); release();await start;
});

test('title linking uses indexed lineage only, preserves unknown/child views, and follows a new root once', async () => {
  const home=path.resolve('/fixture/home'), events=[],annotations=[];
  let row=null,pane={pane_id:'p',agent:'codex',provider_home:home,codex_title:{prefix:A.slice(0,29),revision:1},agent_session:null};
  const linker=createProviderSessionLinker({listPanes:()=>[pane],lookupTitle:()=>row,
    paneAgentProcess:async()=>assert.fail('title panes never query processes'),
    annotateSessionIdentity:async(_,identity)=>{annotations.push(identity.agentSession);pane={...pane,agent_session:{kind:'id',value:identity.agentSession}};}});
  linker.emitter.on('link',e=>events.push(e));
  for(let i=0;i<14601;i++)await linker.resolveNow();assert.deepEqual(annotations,[]);
  row={id:A,provider:'codex',configHome:home,lineage:{kind:'cli',parentThreadId:null}};await linker.resolveNow();
  pane={...pane,codex_title:{prefix:B.slice(0,29),revision:2}};row=null;await linker.resolveNow();assert.equal(linker.get('p'),A);
  for(const lineage of [{kind:'subagent',parentThreadId:A},{kind:'guardian',parentThreadId:null},{kind:'unknown'}]){
    row={...row,id:B,lineage};await linker.resolveNow();assert.equal(linker.get('p'),A);
  }
  row={id:B,lineage:{kind:'cli',parentThreadId:null}};await linker.resolveNow();await linker.resolveNow();
  assert.deepEqual(annotations,[A,B]);assert.deepEqual(events.map(e=>e.previousSessionId),[null,A]);linker.close();
});

test('resident prefix index is home-scoped and refuses collisions',()=>{
 const home=path.resolve('/fixture/one'),other=path.resolve('/fixture/two');
 const row={id:A,provider:'codex',configHome:home};
 let lookup=codexTitleIndex([row]);assert.equal(lookup(A.slice(0,29),home),row);assert.equal(lookup(A,other),null);
 lookup=codexTitleIndex([row,{...row,id:A.slice(0,-1)+'2'}]);assert.equal(lookup(A.slice(0,29),home),null);assert.equal(lookup(A,home),row);
});

test('a writer-locked root is excluded while its bounded recheck clock has not elapsed',async()=>{
 const home=path.resolve('/fixture/home'),pane={pane_id:'reader',agent:'codex',provider_home:home,codex_title:{prefix:A,revision:1},agent_session:{kind:'id',value:A}};
 let reads=0;const linker=createProviderSessionLinker({listPanes:()=>[pane],lookupTitle:()=>({id:A,lineage:{kind:'cli'}}),
  readPaneText:async()=>{reads++;return fs.readFileSync(path.resolve(__dirname,'../fixtures/codex-box/codex-0.167.0-writer-remapped.txt'),'utf8');},
  annotateSessionIdentity:async()=>assert.fail('reader annotated'),paneAgentProcess:async()=>assert.fail('process lookup')});
 for(let i=0;i<40;i++)await linker.resolveNow();assert.equal(linker.get('reader'),null);assert.equal(linker.apply([pane])[0].agent_session,null);assert.equal(reads,1);linker.close();
});

test('unreadable pane evidence does not spin between full timer ticks and close drains an in-flight write',async()=>{
 const pane={pane_id:'p',agent:'codex',provider_home:path.resolve('/fixture/home'),codex_title:{prefix:A,revision:1}};
 let reads=0;const linker=createProviderSessionLinker({clock:()=>0,listPanes:()=>[pane],lookupTitle:()=>({id:A,lineage:{kind:'cli'}}),
  readPaneText:async()=>{reads++;throw Error('unavailable');},paneAgentProcess:async()=>assert.fail('process lookup')});
 for(let i=0;i<14601;i++)await linker.resolveNow();assert.equal(reads,1);await linker.close();
 let release;const slow=createProviderSessionLinker({listPanes:()=>[{pane_id:'p',agent:'codex',agent_session:{kind:'id',value:A}}],
  rememberLink:()=>new Promise(r=>{release=r;}),paneAgentProcess:async()=>null});
 const tick=slow.resolveNow();while(!release)await new Promise(r=>setImmediate(r));let closed=false;
 const closing=slow.close().then(()=>{closed=true;});await new Promise(r=>setImmediate(r));assert.equal(closed,false);
 release();await closing;await tick;assert.equal(closed,true);assert.equal(slow.get('p'),null);
});

test('daemon subscription publishes a title prefix change even before an identity exists',()=>{
 const {SessionSubscription}=require('../../src/main/session-daemon/client.js');
 const pane={pane_id:'p',agent:'codex',agent_session:null,codex_title:{prefix:null,revision:0}};
 const emitted=[],sub={closed:false,panes:new Map([['p',pane]]),emit:(...args)=>emitted.push(args)};
 SessionSubscription.prototype._apply.call(sub,{panes:[{...pane,codex_title:{prefix:A.slice(0,29),revision:1}}],workspaces:[],tabs:[],layouts:[]});
 assert.equal(emitted.filter(e=>e[1]?.event==='pane.updated').length,1);
});

test('a root send while /side is displayed refuses without writes and retains its route', async t=>{
 const {createSessionSend,createLinkRegistry}=require('../../src/main/session-send.js');
 const links=createLinkRegistry();links.set(A,{paneId:'p',workspaceId:'w'});const writes=[];
 let prefix=B.slice(0,29);const send=createSessionSend({sendLogFile:require('../support/send-log-fixture.cjs').testSendLog(t),links,getSessionMeta:async()=>({provider:'codex'}),
  readPane:async()=> 'Ask a follow-up question\nSide from main thread · ctrl+/ to switch · ctrl+c to close',
  snapshot:async()=>({panes:[{pane_id:'p',agent:'codex',agent_session:{kind:'id',value:A},codex_title:{prefix}}]}),
  terminalBridge:{getState:()=>({controlledPaneId:'p'}),sendInput:(...args)=>writes.push(args)}});
 await assert.rejects(send.send({sessionId:A,provider:'codex',text:'root message'}),{code:'CODEX_THREAD_VIEW_CHANGED'});
 assert.deepEqual(writes,[]);assert.equal(links.get(A).paneId,'p');
});
