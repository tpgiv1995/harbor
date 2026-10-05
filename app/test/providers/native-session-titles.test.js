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
