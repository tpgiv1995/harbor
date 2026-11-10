'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {testSendLog}=require('../support/send-log-fixture.cjs');
const {createProviderSessionLinker}=require('../../src/main/providers/provider-session-link.js');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const native=id=>({kind:'id',value:id});
const idle=fs.readFileSync(path.resolve(__dirname,'../fixtures/codex-box/codex-0.166.0-ultra-empty-120.txt'),'utf8');

test('Node test-context floor disables implicit logs but preserves an injected log',async t=>{
 const injected=testSendLog(t),home=path.join(path.dirname(injected),'fake-home');
 const file=path.resolve(__dirname,'../../src/main/session-send.js'),m=new Module(file,module);m.filename=file;m.paths=Module._nodeModulePaths(path.dirname(file));const req=m.require.bind(m);
 m.require=name=>name==='node:os'?{...require('node:os'),homedir:()=>home}:req(name);m._compile(fs.readFileSync(file,'utf8'),file);
 assert.ok(process.env.NODE_TEST_CONTEXT);
 for(const sendLogFile of [undefined,injected]){
  const send=m.exports.createSessionSend({links:m.exports.createLinkRegistry(),...(sendLogFile?{sendLogFile}:{}),snapshot:async()=>({panes:[{pane_id:'p',agent:'codex',agent_session:native(A),codex_title:{prefix:B}}]}),getSessionMeta:async()=>({provider:'codex'}),terminalBridge:{getState:()=>({})},readPane:async()=> 'Viewing sub-agent: direct input is disabled'});
  await assert.rejects(send.send({sessionId:A,pane:{paneId:'p'},provider:'codex',text:'fixture'}));
 }
 // Diagnostics are fire-and-forget: under a loaded parallel suite a fixed
 // 150 ms was not always enough. Wait for the injected log (written after the
 // omitted case ran), then check the fake home stayed empty.
 for(const until=Date.now()+5000;Date.now()<until&&!(fs.existsSync(injected)&&fs.readFileSync(injected,'utf8').trim());)await new Promise(r=>setTimeout(r,25));
 await new Promise(r=>setTimeout(r,100));
 assert.equal(fs.existsSync(path.join(home,'.cache/harbor/send-log.jsonl')),false);
 assert.ok(fs.readFileSync(injected,'utf8').trim().length>0,'explicit diagnostics remain enabled');
});

test('matching keeper or launch id binds without indexed lineage and survives first apply',async()=>{
 for(const lineage of [undefined,null,{kind:'unknown'},{kind:'custom'}])for(const own of [true,false]){
  const pane={pane_id:'p',agent:'codex',provider_home:path.resolve('/fixture/home'),agent_session:own?native(A):null,argv:['codex','resume',A],codex_title:{prefix:A.slice(0,29),revision:1}};
  const linker=createProviderSessionLinker({listPanes:()=>[pane],lookupTitle:()=>lineage===undefined?null:({id:A,lineage}),readPaneText:async()=>{throw Error('screen temporarily unavailable');},paneAgentProcess:async()=>assert.fail('no process lookup for launch argv')});
  if(own)assert.equal(linker.apply([pane])[0].agent_session.value,A,'first rail draw keeps known identity');
  await linker.resolveNow();assert.equal(linker.get('p'),A);await linker.close();
 }
});

test('null title preserves keeper id and falls through to legacy process discovery',async()=>{
 let pane={pane_id:'p',agent:'codex',agent_session:native(A),codex_title:{prefix:null,revision:0}},queries=0;
 const linker=createProviderSessionLinker({listPanes:()=>[pane],paneAgentProcess:async()=>{queries++;return{startedMs:1,argv:['codex','resume',A]};}});
 assert.equal(linker.apply([pane])[0].agent_session.value,A);await linker.resolveNow();assert.equal(linker.get('p'),A);
 await linker.close();pane={...pane,pane_id:'q',agent_session:null};
 const other=createProviderSessionLinker({listPanes:()=>[pane],paneAgentProcess:async()=>{queries++;return{startedMs:1,argv:['codex','resume',A]};}});
 await other.resolveNow();assert.equal(other.get('q'),A);assert.equal(queries,1);await other.close();
});

test('title-only refreshes never query unresolved legacy panes',async()=>{
 let queries=0;const linker=createProviderSessionLinker({listPanes:()=>[{pane_id:'legacy',agent:'cursor'},{pane_id:'t',agent:'codex',codex_title:{prefix:B}}],paneAgentProcess:async()=>{queries++;return null;}});
 assert.equal(typeof linker.resolveTitlesNow,'function');for(let i=0;i<40;i++)await linker.resolveTitlesNow();assert.equal(queries,0);
 await linker.resolveNow();assert.equal(queries,1,'full timer pass still performs legacy discovery');await linker.close();
});

test('null title permits a normal send to reach the input boundary',async t=>{
 const {createSessionSend,createLinkRegistry}=require('../../src/main/session-send.js');let writes=0;
 const send=createSessionSend({links:createLinkRegistry(),sendLogFile:testSendLog(t),sleep:async()=>{},getSessionMeta:async()=>({provider:'codex'}),readPane:async()=>idle,
  snapshot:async()=>({panes:[{pane_id:'p',agent:'codex',agent_session:native(A),codex_title:{prefix:null}}]}),
  terminalBridge:{getState:()=>({controlledPaneId:'p'}),ensureDialogSize:async()=>({ok:true}),sendInput:()=>{writes++;throw Error('input boundary reached');}}});
 await assert.rejects(send.send({sessionId:A,pane:{paneId:'p'},provider:'codex',text:'normal message'}),/input boundary reached/);assert.equal(writes,1);
});

test('new ordinary composer rekeys to the pane once, then binds the materialized root',async()=>{
 let pane={pane_id:'p',workspace_id:'w',agent:'codex',agent_session:native(A),codex_title:{prefix:A,revision:1}},row=null;
 const events=[],writes=[];const linker=createProviderSessionLinker({listPanes:()=>[pane],lookupTitle:()=>row,readPaneText:async()=>idle,
  paneAgentProcess:async()=>assert.fail('no process queries'),rememberLink:async fact=>writes.push(fact),
  annotateSessionIdentity:async(_,identity)=>{pane={...pane,agent_session:native(identity.agentSession)};}});
 linker.emitter.on('link',e=>events.push(e));await linker.resolveNow();pane={...pane,codex_title:{prefix:B,revision:2}};
 await linker.resolveTitlesNow();await linker.resolveTitlesNow();assert.equal(linker.get('p'),'pane:p');assert.equal(events.length,2);assert.equal(events[1].previousSessionId,A);
 assert.equal(writes.length,1,'a provisional id is never stored as a provider identity');
 row={id:B,lineage:{kind:'cli'},path:'/fixture/rollout.jsonl'};pane.provider_home=path.resolve('/fixture/home');await linker.resolveTitlesNow();
 assert.equal(linker.get('p'),B);assert.equal(events.length,3);assert.equal(events[2].previousSessionId,'pane:p');await linker.close();
});

test('side and child screens cannot rekey a parent to a sendable provisional pane',async()=>{
 for(const screen of ['Viewing sub-agent: direct input is disabled','Side from main thread · ctrl+/ to switch · ctrl+c to close']){
  let pane={pane_id:'p',agent:'codex',agent_session:native(A),codex_title:{prefix:A,revision:1}};
  const linker=createProviderSessionLinker({listPanes:()=>[pane],readPaneText:async()=>pane.codex_title.prefix===A?idle:screen,paneAgentProcess:async()=>null});
  await linker.resolveNow();pane={...pane,codex_title:{prefix:B,revision:2}};await linker.resolveTitlesNow();assert.equal(linker.get('p'),A);await linker.close();
 }
});

test('cold duplicate panes bind neither until exactly one screen proves a writer',async()=>{
 for(const screens of [[idle,idle],['transcript selection','transcript selection'],['transcript selection',idle]]){
  const panes=['a','b'].map(pane_id=>({pane_id,agent:'codex',agent_session:native(A),codex_title:{prefix:A,revision:1}}));
  const linker=createProviderSessionLinker({listPanes:()=>panes,readPaneText:async id=>screens[id==='a'?0:1],paneAgentProcess:async()=>null});
  assert.ok(linker.apply(panes).every(p=>p.agent_session===null));await linker.resolveNow();
  assert.deepEqual(linker.all(),screens[0]===idle||screens[1]!==idle?{}:{b:A});await linker.close();
 }
});

test('cold duplicate evidence can settle on a later bounded read without a title change',async()=>{
 let now=0,second=idle;const panes=['a','b'].map(pane_id=>({pane_id,agent:'codex',agent_session:native(A),codex_title:{prefix:A,revision:1}}));
 const linker=createProviderSessionLinker({clock:()=>now,listPanes:()=>panes,readPaneText:async id=>id==='a'?idle:second,paneAgentProcess:async()=>null});
 await linker.resolveNow();assert.deepEqual(linker.all(),{});second='transcript selection';now=5000;await linker.resolveNow();assert.deepEqual(linker.all(),{a:A});await linker.close();
});

test('an exact native continuation draft submits with Enter without retyping or lossy normalization',async t=>{
 const {createSessionSend,createLinkRegistry}=require('../../src/main/session-send.js');
 const text='Read our previous conversation and let\u2019s continue where we left off.\n\nSaved conversation: /fixture/old.jsonl';
 const screen=idle.replace('Ask Codex to do anything',text),writes=[];
 const send=createSessionSend({links:createLinkRegistry(),sendLogFile:testSendLog(t),platform:'win32',sleep:async()=>{},getSessionMeta:async()=>({provider:'codex'}),readPane:async()=>screen,
  snapshot:async()=>({panes:[{pane_id:'p',agent:'codex',agent_session:native(A),codex_title:{prefix:B}}]}),
  terminalBridge:{getState:()=>({controlledPaneId:'p'}),ensureDialogSize:async()=>({ok:true}),sendInput:(_,data)=>{writes.push(data);throw Error('input boundary reached');}}});
 await assert.rejects(send.send({sessionId:'pane:p',pane:{paneId:'p'},provider:'codex',text}),/input boundary reached/);
 assert.deepEqual(writes,['\r']);
});

test('bridge refresh and pane chatter invoke only the lightweight title pass',async t=>{
 const {EventEmitter}=require('node:events'),{createSidebarBridge}=require('../../src/main/sidebar-bridge.js');
 let full=0,titles=0,onEvent;const history=new EventEmitter();Object.assign(history,{listSessions:async()=>[],sessionHomes:async()=>({})});
 const sub=new EventEmitter();sub.close=()=>{};
 const linker={emitter:new EventEmitter(),apply:p=>p,start(){},close(){},resolveNow:async()=>{full++;},resolveTitlesNow:async()=>{titles++;}};
 const bridge=createSidebarBridge({history,providerHistory:null,delegationIndex:null,providerSessionLinker:linker,
  createControlClient:()=>({bootstrap:async options=>{onEvent=options.onEvent;return{snapshot:{workspaces:[],panes:[]},subscription:sub};}})});
 t.after(()=>bridge.close());bridge.emitter.on('error',()=>{});await bridge.start();
 for(let i=0;i<40;i++){onEvent({event:'pane.updated',data:{pane:{pane_id:'legacy',agent:'cursor'}}});await bridge.refreshHistory();}
 assert.equal(full,0);assert.ok(titles>0);await bridge.resolveProviderSessions();assert.equal(full,1);
});

test('view markers must belong to the current prompt or terminal footer',()=>{
 const {codexThreadView}=require('../../src/main/session-send.js');
 assert.equal(codexThreadView('› Viewing sub-agent: direct input is disabled\nGPT-6 low'), 'child');
 assert.equal(codexThreadView('› Ask a follow-up\nGPT-6 low · Side from main thread · ctrl+/ to switch · ctrl+c to close'), 'side');
 assert.equal(codexThreadView('› Viewing sub-agent: direct input is disabled\n› Ask a follow-up\nGPT-6 low'),null);
 assert.equal(codexThreadView('Old quoted text: Side from main thread · ctrl+/ to switch · ctrl+c to close\n› Ask a follow-up\nGPT-6 low'),null);
});
