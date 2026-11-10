'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {createProviderSessionLinker}=require('../../src/main/providers/provider-session-link.js');
const {publishProviderLink}=require('../../src/main/providers/provider-link-events.js');
const {createSessionSend,createLinkRegistry,codexThreadView}=require('../../src/main/session-send.js');
const {testSendLog}=require('../support/send-log-fixture.cjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const native=value=>({kind:'id',value});
const idle=fs.readFileSync(path.resolve(__dirname,'../fixtures/codex-box/codex-0.166.0-ultra-empty-120.txt'),'utf8');
const locked=fs.readFileSync(path.resolve(__dirname,'../fixtures/codex-box/codex-0.167.0-writer-remapped.txt'),'utf8');
const pane=(id,identity,prefix=identity)=>({pane_id:id,workspace_id:'w',agent:'codex',provider_home:path.resolve('/fixture/home'),cwd:'/fixture/project',agent_session:identity?native(identity):null,codex_title:{prefix,revision:1}});

test('an inconclusive first frame is retried by the full pass and rekeys the window',async()=>{
 let now=0,screen='redrawing',reads=0;const p=pane('p',A,B);
 const linker=createProviderSessionLinker({clock:()=>now,listPanes:()=>[p],readPaneText:async()=>{reads++;return screen;},paneAgentProcess:async()=>null});
 await linker.resolveTitlesNow();assert.equal(linker.get('p'),null);
 for(let i=0;i<40;i++)await linker.resolveTitlesNow();assert.equal(reads,1,'event churn does not poll the screen');
 screen=idle;now=5000;await linker.resolveNow();assert.equal(linker.get('p'),'pane:p');assert.equal(reads,2);await linker.close();
});

test('three read failures do not exhaust recovery when a writer becomes readable',async()=>{
 let now=0,reads=0;const p=pane('p',A,B);
 const linker=createProviderSessionLinker({clock:()=>now,listPanes:()=>[p],readPaneText:async()=>{if(++reads<=3)throw Error('transient');return idle;},paneAgentProcess:async()=>null});
 for(let i=0;i<4;i++){now=i*5000;await linker.resolveNow();}
 assert.equal(reads,4);assert.equal(linker.get('p'),'pane:p');await linker.close();
});

test('inconclusive evidence gets a minute of five-second recovery, then a slower clock',async()=>{
 let now=0,reads=0,screen='redrawing';const p=pane('p',A,B);
 const linker=createProviderSessionLinker({clock:()=>now,listPanes:()=>[p],readPaneText:async()=>{reads++;return screen;},paneAgentProcess:async()=>null});
 for(let i=0;i<=12;i++){now=i*5000;await linker.resolveNow();}assert.equal(reads,13);
 screen=idle;now=65000;await linker.resolveNow();assert.equal(reads,13);now=90000;await linker.resolveNow();assert.equal(linker.get('p'),'pane:p');await linker.close();
});

test('an ordinary view refusal refreshes the title and the next pane send is accepted',async t=>{
 let screen='redrawing';const p=pane('p',A,B),links=createLinkRegistry(),writes=[];
 const linker=createProviderSessionLinker({listPanes:()=>[p],readPaneText:async()=>screen,paneAgentProcess:async()=>null});
 linker.emitter.on('link',link=>publishProviderLink(link,links,()=>{}));await linker.resolveTitlesNow();links.set(A,{paneId:'p',workspaceId:'w'});
 const send=createSessionSend({sendLogFile:testSendLog(t),links,sleep:async()=>{},getSessionMeta:async()=>({provider:'codex'}),snapshot:async()=>({panes:[p]}),readPane:async()=>screen,
  recheckProviderTitle:async id=>{screen=idle;return linker.recheckTitle(id);},
  terminalBridge:{getState:()=>({controlledPaneId:'p'}),ensureDialogSize:async()=>({ok:true}),sendInput:(_,data)=>{writes.push(data);screen=data==='\r'?idle:idle.replace('Ask Codex to do anything',data.replace(/\x1b\[(?:200|201)~/g,''));return{ok:true};}}});
 await assert.rejects(send.send({sessionId:A,pane:{paneId:'p'},provider:'codex',text:'first message'}),{code:'CODEX_THREAD_VIEW_CHANGED'});
 assert.equal(linker.get('p'),'pane:p');assert.deepEqual(writes,[]);
 assert.equal((await send.send({sessionId:'pane:p',pane:{paneId:'p'},provider:'codex',text:'first message'})).ok,true);assert.equal(writes.length,2);await linker.close();
});

test('restart provisional rekey cannot rename a root held by another live pane',async()=>{
 const p=pane('p',A,B),q=pane('q',A,A),events=[],links=createLinkRegistry();links.set(A,{paneId:'q',workspaceId:'w'});
 const linker=createProviderSessionLinker({listPanes:()=>[p,q],readPaneText:async()=>idle,paneAgentProcess:async()=>null});
 linker.emitter.on('link',link=>publishProviderLink(link,links,(_,payload)=>events.push(payload)));await linker.resolveNow();
 assert.equal(events.some(e=>e.sessionId==='pane:p'&&e.replacesKey===A),false);assert.equal(links.get(A).paneId,'q');await linker.close();
});

test('a pane arriving during metadata persistence protects its window before publication',async()=>{
 let p=pane('p',A),panes=[p],blocked=false,release;const events=[];
 const linker=createProviderSessionLinker({listPanes:()=>panes,lookupTitle:prefix=>prefix===B?{id:B,lineage:{kind:'cli'}}:null,readPaneText:async()=>idle,paneAgentProcess:async()=>null,
  annotateSessionIdentity:async(_,identity)=>{p.agent_session=native(identity.agentSession);},rememberLink:async fact=>{if(blocked&&fact.id===B)await new Promise(r=>{release=r;});}});
 linker.emitter.on('link',e=>events.push(e));await linker.resolveNow();p.codex_title={prefix:B,revision:2};blocked=true;
 const resolving=linker.resolveNow();while(!release)await new Promise(r=>setImmediate(r));panes.push(pane('q',A));release();await resolving;
 assert.equal(events.at(-1).sessionId,B);assert.equal(events.at(-1).previousSessionId,null);await linker.close();
});

test('writer notice is rechecked on the slow full clock after r retry clears it',async()=>{
 let now=0,screen=locked,reads=0;const p=pane('p',A);
 const linker=createProviderSessionLinker({clock:()=>now,listPanes:()=>[p],readPaneText:async()=>{reads++;return screen;},paneAgentProcess:async()=>null});
 await linker.resolveNow();screen=idle;for(let i=1;i<6;i++){now=i*5000;await linker.resolveNow();}assert.equal(reads,1);
 now=30000;await linker.resolveNow();assert.equal(reads,2);assert.equal(linker.get('p'),A);await linker.close();
});

test('title-less Codex and Cursor duplicate panes retain their native identities',async()=>{
 for(const agent of ['codex','cursor']){
  const panes=['p','q'].map(pane_id=>({pane_id,agent,agent_session:native(A)}));const linker=createProviderSessionLinker({listPanes:()=>panes,paneAgentProcess:async()=>null});
  assert.deepEqual(linker.apply(panes).map(p=>p.agent_session),[native(A),native(A)]);await linker.resolveNow();assert.deepEqual(linker.apply(panes).map(p=>p.agent_session),[native(A),native(A)]);await linker.close();
 }
});

test('exact native draft disappearing before deliver never sends raw text by keyboard',async t=>{
 const text='Read our previous conversation and let\u2019s continue.',draft=idle.replace('Ask Codex to do anything',text),writes=[];let reads=0;
 const send=createSessionSend({sendLogFile:testSendLog(t),links:createLinkRegistry(),platform:'win32',sleep:async()=>{},getSessionMeta:async()=>({provider:'codex'}),snapshot:async()=>({panes:[pane('p',A)]}),readPane:async()=>++reads===1?draft:idle,
  terminalBridge:{getState:()=>({controlledPaneId:'p'}),ensureDialogSize:async()=>({ok:true}),sendInput:(_,data)=>{writes.push(data);throw Error('keyboard boundary');}}});
 await assert.rejects(send.send({sessionId:A,pane:{paneId:'p'},provider:'codex',text}),e=>e.code==='CODEX_DRAFT_CHANGED'&&/Your text is kept/.test(e.message));assert.deepEqual(writes,[]);
});

test('fresh unique indexed rows with unmigrated lineage bind when the screen proves a writer',async()=>{
 for(const lineage of [null,{kind:'custom'}]){
  const p=pane('p',null,B);const linker=createProviderSessionLinker({listPanes:()=>[p],lookupTitle:()=>({id:B,lineage}),readPaneText:async()=>idle,paneAgentProcess:async()=>null});
  await linker.resolveNow();assert.equal(linker.get('p'),B);await linker.close();
 }
});

test('already-named startup restores provisional windows without metadata writes or history link events',async()=>{
 for(const indexed of [true,false]){
 const p=pane('p',A),meta={path:'/fixture/rollout.jsonl',profileId:'fixture',configHome:p.provider_home},events=[],restores=[],launches=[],routes=createLinkRegistry();let writes=0;
 const linker=createProviderSessionLinker({profiles:[{id:'fixture',provider:'codex',configHome:p.provider_home}],listPanes:()=>[p],lookupSessionMeta:()=>indexed?meta:null,
  lookupRememberedLink:async()=>({id:A,provider:'codex',cwd:p.cwd,profileId:'fixture',configHome:p.provider_home,transcriptPath:meta.path}),
  rememberLink:async()=>{writes++;},paneAgentProcess:async()=>null});linker.emitter.on('link',e=>events.push(e));
 linker.emitter.on('restore',e=>{restores.push(e);require('../../src/main/providers/provider-link-events.js').restoreProviderLink(e,routes,(_,payload)=>launches.push(payload));});
 await linker.resolveNow();assert.equal(linker.get('p'),A);assert.equal(writes,0);assert.deepEqual(events,[]);assert.equal(restores.length,1);assert.equal(routes.get(A).paneId,'p');assert.deepEqual(launches.map(e=>e.replacesKey),['pane:p','live:p']);await linker.close();
 }
});

test('provisional sends refuse child and side views, including clipped footers',async t=>{
 for(const key of ['pane:p','live:p']) for(const screen of ['› Viewing sub-agent: direct input is disabled\n  GPT-6 · /fixture','› Ask a follow-up question\n  GPT-6 low F… Side from main thread · ctrl+/ to switch · ctrl+c to close','› Ask a follow-up question\n  GPT-6 low F… Side from main thread · ctrl+/ to']){
  assert.equal(codexThreadView(screen),screen.includes('Viewing sub-agent')?'child':'side');
  const writes=[],send=createSessionSend({sendLogFile:testSendLog(t),links:createLinkRegistry(),getSessionMeta:async()=>({provider:'codex'}),snapshot:async()=>({panes:[pane('p',A,B)]}),readPane:async()=>screen,
   terminalBridge:{getState:()=>({controlledPaneId:'p'}),sendInput:(_,text)=>writes.push(text)}});
  await assert.rejects(send.send({sessionId:key,pane:{paneId:'p'},provider:'codex',text:'never into another view'}),e=>e.code==='CODEX_THREAD_VIEW_CHANGED'&&/Your text is kept/.test(e.message));assert.deepEqual(writes,[]);
 }
});

test('warnings rows preserve writable evidence at 50 and 80 columns',async()=>{
 const {codexWritableComposer}=require('../../src/main/session-send.js');
 const narrow=fs.readFileSync(path.resolve(__dirname,'../fixtures/codex-box/codex-0.166.0-clipped-draft-50.txt'),'utf8');
 for(const screen of [narrow,'› Ask Codex to do anything\n\n  GPT-6 low · /fixture\n                                                     ⚠ 1 warning · f2 to view']){
  assert.equal(codexWritableComposer(screen),true);
  const linker=createProviderSessionLinker({listPanes:()=>[pane('p',A,B)],readPaneText:async()=>screen,paneAgentProcess:async()=>null});
  await linker.resolveTitlesNow();assert.equal(linker.get('p'),'pane:p');await linker.close();
 }
});

test('provisional warnings and incomplete frames reach the existing delivery gate',async t=>{
 for(const key of ['pane:p','live:p']) for(const screen of [idle+'\n  ⚠ 1 warning · f2 to view','› Ask a follow-up question','', 'Waiting for startup']){
  const writes=[];let delivered=false;
  const send=createSessionSend({sendLogFile:testSendLog(t),links:createLinkRegistry(),getSessionMeta:async()=>({provider:'codex'}),snapshot:async()=>({panes:[pane('p',A,B)]}),readPane:async()=>screen,
   terminalBridge:{getState:()=>({controlledPaneId:'p'}),holdControl:()=>{delivered=true;throw Object.assign(Error('delivery boundary'),{code:'DELIVERY_BOUNDARY'});},sendInput:(_,text)=>writes.push(text)}});
  await assert.rejects(send.send({sessionId:key,pane:{paneId:'p'},provider:'codex',text:'synthetic message'}),{code:'DELIVERY_BOUNDARY'});
  assert.equal(delivered,true);assert.deepEqual(writes,[]);
 }
});

test('root mismatch refusal returns while its title recheck is still pending',async t=>{
 let release,called=false;const pending=new Promise(r=>{release=r;}),writes=[];
 const send=createSessionSend({sendLogFile:testSendLog(t),links:createLinkRegistry(),getSessionMeta:async()=>({provider:'codex'}),snapshot:async()=>({panes:[pane('p',A,B)]}),readPane:async()=>idle,
  recheckProviderTitle:()=>{called=true;return pending;},terminalBridge:{getState:()=>({controlledPaneId:'p'}),sendInput:(_,text)=>writes.push(text)}});
 const refusal=send.send({sessionId:A,pane:{paneId:'p'},provider:'codex',text:'kept message'}).then(()=>null,e=>e);
 let timer;try{
  const result=await Promise.race([refusal,new Promise(r=>{timer=setTimeout(()=>r('blocked'),500);})]);
  assert.equal(called,true);assert.equal(result.code,'CODEX_THREAD_VIEW_CHANGED');assert.match(result.message,/Your text is kept/);assert.deepEqual(writes,[]);
 }finally{clearTimeout(timer);release();await refusal;}
});

test('a writer-locked pane stays hidden while a requested recheck reads fresh evidence',async()=>{
 const p=pane('p',A);let release,reads=0;
 const linker=createProviderSessionLinker({listPanes:()=>[p],readPaneText:async()=>++reads===1?locked:new Promise(r=>{release=r;}),paneAgentProcess:async()=>null});
 await linker.resolveNow();assert.equal(linker.apply([p])[0].agent_session,null);
 const recheck=linker.recheckTitle('p');while(!release)await new Promise(r=>setImmediate(r));
 try{assert.equal(linker.apply([p])[0].agent_session,null);}finally{release(idle);await recheck;await linker.close();}
 assert.equal(linker.get('p'),A);
});

test('null/id flapping is ignored and real title changes coalesce to one persist per tick',()=>{
 const {createCodexTitleIdentity,CODEX_IDENTITY_PIN,coalesceTitleWrites}=require('../../src/daemon/codex-title-identity.js');
 let current=null,writes=0,notifications=0;const queued=[];
 const persist=coalesceTitleWrites(()=>{writes++;assert.equal(current,B);},fn=>queued.push(fn));
 const observe=createCodexTitleIdentity({agent:'codex',argv:['--no-daemon',CODEX_IDENTITY_PIN],onTitle:id=>{notifications++;current=id;persist();}});
 observe(A);for(let i=0;i<10000;i++){observe('overlay');observe(A);}assert.equal(notifications,1);
 for(let i=0;i<1000;i++){observe(A);observe(B);}assert.equal(current,B);assert.equal(queued.length,1);assert.equal(writes,0);queued.shift()();assert.equal(writes,1);
 observe(A);observe(B);queued.shift()();assert.equal(writes,2);
});
