'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TranscriptParser, readPrefixBlocks, createTranscriptProvider, MAX_IMAGE_BLOCKS } = require('../../src/main/providers/transcript.js');
const { applyTranscriptUpdate } = require('../../src/shared/transcript-blocks.cjs');
const ts = '2026-01-01T00:00:00.000Z';
const user = content => ({ type: 'user', timestamp: ts, message: { content } });
const queue = (operation, content) => ({ type: 'queue-operation', operation, content, timestamp: ts });
const attachment = prompt => ({ type: 'attachment', timestamp: ts, attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt } });
const image = i => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: `synthetic${i}` } });
function fixture(t, records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-transcript-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'synthetic.jsonl');
  fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  return { dir, file };
}
test('prefix reserves forty human prompts independently of peer traffic', async t => {
  const {file} = fixture(t, [user('human question'), ...Array.from({length:50}, (_,i)=>queue('enqueue', `<cross-session-message from-name="helper">status ${i}</cross-session-message>`))]);
  const blocks = await readPrefixBlocks(file, fs.statSync(file).size);
  assert.ok(blocks.some(b=>b.text==='human question'));
  assert.equal(blocks.filter(b=>b.peer).length, 0);
});
test('prefix retains an older prompt image even after forty newer text prompts', async t => {
  const {file} = fixture(t, [user([{type:'text',text:'picture question'}, image(0)]), ...Array.from({length:41},(_,i)=>user(`question ${i}`))]);
  const blocks = await readPrefixBlocks(file, fs.statSync(file).size);
  assert.ok(blocks.some(b=>b.text==='picture question' && b.images?.length));
});
test('text-only queued_command survives a read that missed enqueue and does not duplicate one it saw', () => {
  const p = new TranscriptParser();
  p.applyLine(attachment('boundary question'));
  assert.equal(p.blocks[0]?.text, 'boundary question');
  const q = new TranscriptParser();
  q.applyLine(queue('enqueue','one question'));
  q.applyLine(queue('remove','one question'));
  q.applyLine(attachment('one question'));
  assert.equal(q.blocks.length,1);
});
test('idle dequeue followed by normal user record updates one bubble, while repeated sends stay distinct', () => {
  const p = new TranscriptParser();
  p.applyLine(queue('enqueue','same question'));
  const key=p.blocks[0].key;
  p.applyLine(queue('dequeue'));
  const changed=p.applyLine(user('same question'));
  assert.equal(p.blocks.length,1);
  assert.equal(p.blocks[0].key,key);
  assert.ok(changed.includes(key));
  p.applyLine(user('same question'));
  assert.equal(p.blocks.length,2);
});
// 2026-11-05: images are references with no cap of their own (image-store.js),
// so these two tests now pin the replacement rules instead of payload eviction.
test('when images crowd the window, tool screenshots leave before a human prompt and its image', () => {
  const p = new TranscriptParser();
  p.applyLine(user([{type:'text',text:'keep my words'},image(0)]));
  let rendered=structuredClone(p.blocks);
  for(let i=1;i<=MAX_IMAGE_BLOCKS;i++) {
    const before=new Set(p.blocks.map(b=>b.key));
    const changed=p.applyLine(user([{type:'tool_result',tool_use_id:`tool${i}`,content:[image(i)]}]));
    rendered=applyTranscriptUpdate(rendered, {append:structuredClone(p.blocks.filter(b=>!before.has(b.key))),changed:structuredClone(p.blocks.filter(b=>changed.includes(b.key))),removed:[...before].filter(k=>!p.blocks.some(b=>b.key===k))});
  }
  assert.equal(p.blocks.find(b=>b.text==='keep my words')?.images?.length,1);
  assert.equal(rendered.find(b=>b.text==='keep my words')?.images?.length,1);
  assert.equal(p.blocks.filter(b=>b.images?.length).length,MAX_IMAGE_BLOCKS);
});
test('every image prompt that fits the window keeps its image (no separate image cap)', () => {
  const p=new TranscriptParser();
  for(let i=0;i<MAX_IMAGE_BLOCKS;i++) p.applyLine(user([{type:'text',text:`question ${i}`},image(i)]));
  assert.equal(p.blocks.filter(b=>b.images?.length).length,MAX_IMAGE_BLOCKS);
  assert.ok(p.blocks.some(b=>b.text==='question 0' && b.images.length===1));
});
test('prefix queue state crosses the initial tail boundary and consumed opening is not stale', async t => {
  const padding={type:'ignored',data:'x'.repeat(1048500)};
  const {dir,file}=fixture(t,[queue('enqueue','opening'),queue('remove','opening'),attachment('opening'),...Array.from({length:42},(_,i)=>user(`intermediate ${i}`)),queue('enqueue','crossing'),padding,queue('remove','crossing'),attachment('crossing'),user('tail question')]);
  const provider=createTranscriptProvider({home:dir,contextCacheDir:dir,getSessionMeta:async()=>({path:file}),watchFactory:()=>({on(){},close(){}})});
  t.after(()=>provider.closeAll());
  const updates=[];provider.emitter.on('update',u=>updates.push(u));
  await provider.open('synthetic');
  const blocks=updates.find(u=>u.replace)?.replace;
  assert.equal(blocks.filter(b=>b.text==='opening').length,1);
  assert.equal(blocks.find(b=>b.text==='opening').queueState,'delivered');
  assert.equal(blocks.filter(b=>b.text==='crossing').length,1);
  assert.equal(blocks.find(b=>b.text==='crossing').queueState,'delivered');
  assert.equal(updates.at(-1).header.queue,null);
});

for (const [name,records,expected] of [
  ['a later image prompt straddling the byte cutoff', [user('first'),user([{type:'text',text:'crossing picture'},image('z'.repeat(1100000))]),user('tail')], ['first','crossing picture','tail']],
  ['an opening prompt that already belongs to the tail', [{type:'ignored',data:'z'.repeat(1100000)},user('first'),user('tail')], ['first','tail']],
  ['distinct prompts with equal text and timestamp stay distinct', [user('repeat'),user('repeat'),{type:'ignored',data:'z'.repeat(1100000)},user('tail')], ['repeat','repeat','tail']],
]) test(name, async t => {
  const {dir,file}=fixture(t,records);
  const provider=createTranscriptProvider({home:dir,contextCacheDir:dir,getSessionMeta:async()=>({path:file}),watchFactory:()=>({on(){},close(){}})});
  t.after(()=>provider.closeAll());
  const updates=[];provider.emitter.on('update',u=>updates.push(u));
  await provider.open('synthetic');
  assert.deepEqual(updates.find(u=>u.replace).replace.filter(b=>b.kind==='user').map(b=>b.text),expected);
});

test('evicted queued bubbles release their parser references as well as their screen slots', () => {
  const p = new TranscriptParser();
  for (let i=0;i<300;i++) {
    p.applyLine(queue('enqueue', `question ${i}`));
    p.applyLine(queue('remove', `question ${i}`));
    p.applyLine(attachment(`question ${i}`));
  }
  assert.ok(p.queuedByText.size <= p.blocks.length);
  assert.ok([...p.queuedByText.values()].every(b=>p.blocks.includes(b)));
});

test('a peer bubble evicted during its own push never enters the image lookup', () => {
  const p = new TranscriptParser();
  for (let i=0;i<240;i++) p.applyLine(user(`human ${i}`));
  for (let i=0;i<300;i++) {
    const text=`<cross-session-message from-name="helper">update ${i}</cross-session-message>`;
    p.applyLine(queue('enqueue',text));
    p.applyLine(queue('remove',text));
  }
  assert.ok([...p.queuedByText.values()].every(b=>p.blocks.includes(b)));
  assert.equal(p.queuePending.length,0);
});
