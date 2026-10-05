'use strict';
const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const proto=require('../../src/shared/ask-protocol.cjs');const {createAskInbox}=require('../../src/main/providers/ask-inbox.js');
function setup(t,kind,prompt,opts={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'prompt-inbox-'));const inbox=createAskInbox({dir,ownsSession:()=>({paneId:'p'}),...opts});inbox.start();t.after(()=>{inbox.stop();fs.rmSync(dir,{recursive:true,force:true});});const id=kind+'.synthetic';const files=proto.filesFor(dir,id,kind);proto.writeJsonAtomic(files.request,{kind,id,prompt,sessionId:'synthetic',hookPid:process.pid,toolInput:{},at:Date.now()});inbox.scan();return{dir,inbox,id,files};}
test('new lanes have distinct filenames and advertise capabilities without breaking ask heartbeat',t=>{
 const {dir,files,inbox}=setup(t,'elicitation',{mode:'url',url:'https://example.com'});
 assert.equal(files.request.endsWith('.request.json'),false);assert.equal(inbox.list()[0].kind,'elicitation');
 assert.equal(proto.heartbeatFresh(dir),true);assert.equal(proto.heartbeatFresh(dir,Date.now(),30000,'permission'),true);
 proto.writeJsonAtomic(proto.heartbeatPath(dir),{pid:process.pid});assert.equal(proto.heartbeatFresh(dir),true);assert.equal(proto.heartbeatFresh(dir,Date.now(),30000,'elicitation'),false);
});
test('permission persistence comes from measured request, never arbitrary renderer rules',t=>{
 const updates=[{type:'setMode',mode:'acceptEdits',destination:'session'}];
 const {inbox,id,files}=setup(t,'permission',{persistent:{updates}});
 assert.equal(inbox.answer(id,{choice:'always',updatedPermissions:[{type:'setMode',mode:'bypassPermissions'}]}).ok,true);
 assert.deepEqual(proto.readJson(files.answer).decision,{behavior:'allow',updatedPermissions:updates});assert.equal(inbox.answer(id,{choice:'once'}).ok,false);
});
test('permission deny message and elicitation actions reach the correct wire shape',t=>{
 const permission=setup(t,'permission',{persistent:{updates:[]}});
 assert.equal(permission.inbox.decline(permission.id,'Use the blue file').ok,true);
 assert.equal(proto.hookOutputFor({},proto.readJson(permission.files.answer),'permission').hookSpecificOutput.decision.message,'Use the blue file');
 for(const action of ['accept','decline','cancel']){const p=setup(t,'elicitation',{mode:'form',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}});assert.equal(p.inbox.answer(p.id,{action,content:{name:'Blue'}}).ok,true);assert.equal(proto.hookOutputFor({},proto.readJson(p.files.answer),'elicitation').hookSpecificOutput.action,action);}
});
test('invalid form input stays pending; URL open is explicit, safe and does not answer',async t=>{
 const p=setup(t,'elicitation',{mode:'form',schema:{type:'object',properties:{name:{type:'string'}},required:['name']}});assert.equal(p.inbox.answer(p.id,{action:'accept',content:{}}).ok,false);assert.equal(p.inbox.list()[0].answered,false);
 const opened=[];const url=setup(t,'elicitation',{mode:'url',url:'https://example.com/blue'},{openExternal:value=>opened.push(value)});assert.equal(opened.length,0);assert.equal((await url.inbox.answer(url.id,{action:'open-url'})).ok,true);assert.deepEqual(opened,['https://example.com/blue']);assert.equal(url.inbox.list()[0].answered,false);
});
test('unowned new prompt passes and dead hook refuses then disappears',t=>{
 const p=setup(t,'permission',{persistent:{updates:[]}},{ownsSession:()=>null});assert.ok(fs.existsSync(p.files.pass));assert.equal(p.inbox.list().length,0);
 let alive=true;const q=setup(t,'elicitation',{mode:'url',url:'https://example.com'},{pidAlive:()=>alive});alive=false;assert.equal(q.inbox.answer(q.id,{action:'accept'}).ok,false);q.inbox.scan();assert.equal(q.inbox.list().length,0);
});
