'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCodexTitles, readClaudeTitles } = require('../../src/main/providers/native-session-titles.cjs');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');
const record = x => JSON.stringify(x) + '\n';

test('Codex uses the most recent native name and tolerates an incomplete last index record', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-titles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'session_index.jsonl'),[
    {id:'a',thread_name:'Native title',updated_at:'2026-09-29'},
    {id:'a',thread_name:'Older title',updated_at:'2026-09-28'},
  ].map(record).join('')+'{"id":');
  assert.equal((await readCodexTitles(dir)).get('a'),'Native title');
  fs.appendFileSync(path.join(dir,'session_index.jsonl'),'\n'+record({id:'a',thread_name:'Renamed in Codex',updated_at:'2026-09-30'}));
  assert.equal((await readCodexTitles(dir)).get('a'),'Renamed in Codex');
});

test('Claude preserves custom names buried in history and picks up later renames incrementally', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-titles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'chat.jsonl');
  fs.writeFileSync(file,record({type:'custom-title',customTitle:'My Claude name'})+record({type:'assistant',message:'x'.repeat(1100000)})+record({type:'summary',summary:'Auto summary'}));
  const first=readClaudeTitles(file);assert.equal(first.native_title,'My Claude name');assert.equal(first.native_summary,'Auto summary');
  fs.appendFileSync(file,JSON.stringify({type:'custom-title',customTitle:'Renamed in Claude'}));
  const next=readClaudeTitles(file,first);assert.equal(next.native_title,'Renamed in Claude');
  fs.appendFileSync(file,'\n'+record({type:'assistant',message:'continued'}));
  assert.equal(readClaudeTitles(file,next).native_title,'Renamed in Claude');
  fs.writeFileSync(file,record({type:'summary',summary:'Replaced file'}));
  assert.equal(readClaudeTitles(file,next).native_title,null);
});

test('Claude native names take precedence over Harbor generated titles in the actual index', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-index-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const projectsDir=path.join(dir,'projects');const project=path.join(projectsDir,'demo');fs.mkdirSync(project,{recursive:true});
  const id='11111111-2222-3333-4444-555555555555';
  fs.writeFileSync(path.join(project,`${id}.jsonl`), record({type:'user',cwd:dir,timestamp:new Date().toISOString(),message:{role:'user',content:'Original request'}})+record({type:'custom-title',customTitle:'My exact Claude name'}));
  const cacheDir=path.join(dir,'cache');fs.mkdirSync(cacheDir);fs.writeFileSync(path.join(cacheDir,'session-titles.json'),JSON.stringify({titles:{[id]:'Harbor generated name'}}));
  const index=createHistoryIndex({projectsDir,cacheDir,profiles:[]});
  assert.equal(Object.values(index.refreshIndex())[0].title,'My exact Claude name');
});

test('Claude ai-title names a session: the last one wins, a rename beats it, another session\'s is ignored', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-titles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const file=path.join(dir,`${id}.jsonl`);
  fs.writeFileSync(file,record({type:'ai-title',aiTitle:'First guess',sessionId:id})+record({type:'summary',summary:'Old summary'})+record({type:'ai-title',aiTitle:'Fix the login loop',sessionId:id}));
  const first=readClaudeTitles(file);assert.equal(first.native_ai_title,'Fix the login loop');assert.equal(first.native_title,null);
  fs.appendFileSync(file,record({type:'ai-title',aiTitle:'Ignored: another session',sessionId:'ffffffff-0000-0000-0000-000000000000'}));
  const next=readClaudeTitles(file,first);assert.equal(next.native_ai_title,'Fix the login loop');
  // A request copy can carry the marks in its tool schemas; it is skipped, not decoded as a name.
  fs.appendFileSync(file,record({type:'api-request-shape',tools:[{input_schema:{properties:{summary:{type:'string'}}}}],note:'"ai-title"'})+record({type:'ai-title',aiTitle:'Login loop fixed',sessionId:id}));
  const last=readClaudeTitles(file,next);assert.equal(last.native_ai_title,'Login loop fixed');assert.equal(last.native_summary,'Old summary');
});

test('an index entry cached before ai-title existed rescans its transcript once, without a cache bump', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-titles-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';const file=path.join(dir,`${id}.jsonl`);
  fs.writeFileSync(file,record({type:'ai-title',aiTitle:'Named before the upgrade',sessionId:id})+record({type:'assistant',message:'x'}));
  // What an older reader stored: an offset past the ai-title it never looked for.
  const older={native_title:null,native_summary:null,title_offset:fs.statSync(file).size};
  fs.appendFileSync(file,record({type:'assistant',message:'continued'}));
  assert.equal(readClaudeTitles(file,older).native_ai_title,'Named before the upgrade');
});

test('the index titles by ai-title over summary and Harbor names, but not over a rename or a batch worker prompt', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-index-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const projectsDir=path.join(dir,'projects');const project=path.join(projectsDir,'demo');fs.mkdirSync(project,{recursive:true});
  const a='11111111-2222-3333-4444-555555555555';const b='66666666-7777-8888-9999-000000000000';const c='99999999-8888-7777-6666-555555555555';
  const opening=(text)=>record({type:'user',cwd:dir,timestamp:new Date().toISOString(),message:{role:'user',content:text}});
  fs.writeFileSync(path.join(project,`${a}.jsonl`),opening('Original request')+record({type:'summary',summary:'Summary name'})+record({type:'ai-title',aiTitle:'Claude named it',sessionId:a}));
  fs.writeFileSync(path.join(project,`${b}.jsonl`),opening('Original request')+record({type:'ai-title',aiTitle:'Claude named it',sessionId:b})+record({type:'custom-title',customTitle:'Renamed by me'}));
  fs.writeFileSync(path.join(project,`${c}.jsonl`),opening('BATCH TITLE: Census pass')+record({type:'ai-title',aiTitle:'Census pass worker',sessionId:c}));
  const cacheDir=path.join(dir,'cache');fs.mkdirSync(cacheDir);fs.writeFileSync(path.join(cacheDir,'session-titles.json'),JSON.stringify({titles:{[a]:'Harbor generated name',[b]:'Harbor generated name'}}));
  const entries=Object.values(createHistoryIndex({projectsDir,cacheDir,profiles:[]}).refreshIndex());
  assert.equal(entries.find(e=>e.id===a).title,'Claude named it');
  assert.equal(entries.find(e=>e.id===b).title,'Renamed by me');
  assert.match(entries.find(e=>e.id===c).title,/^BATCH TITLE: Census pass/);
});
