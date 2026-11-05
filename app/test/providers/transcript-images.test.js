'use strict';

// On-demand transcript images (2026-11-05): blocks carry { mediaType, id, size },
// the bytes live once in image-store.js, the desktop loads them through
// harbor-image:// and the phone through /transcript-images/<id>. Fixtures are
// synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createImageStore, imageStore, imageIdFor } = require('../../src/main/providers/image-store.js');
const { readPrefixBlocks, MAX_PREFIX_IMAGE_BLOCKS } = require('../../src/main/providers/transcript.js');
const { createTranscriptImageHandler } = require('../../src/server/http/transcript-images.js');

const b64 = (text) => Buffer.from(text).toString('base64');

test('the store keeps each image once, by a hash of its bytes', () => {
  const store = createImageStore();
  const a = store.put('image/png', b64('same picture'));
  const again = store.put('image/png', b64('same picture'));
  assert.equal(a.id, again.id);
  assert.equal(a.id, imageIdFor(b64('same picture')));
  assert.equal(store.stats().images, 1);
  assert.deepEqual(store.get(a.id).bytes, Buffer.from('same picture'));
  assert.equal(store.get(a.id).mediaType, 'image/png');
});

test('the store is bounded by bytes and lets the least recently used image go first', () => {
  const store = createImageStore({ maxBytes: 30 });
  const first = store.put('image/png', b64('0123456789'));   // 10 bytes
  const second = store.put('image/png', b64('abcdefghij'));  // 10 bytes
  store.get(first.id);                                        // first is now the most recent
  const third = store.put('image/png', b64('ABCDEFGHIJKLMNO')); // 15 bytes: 35 > 30, the oldest goes
  assert.equal(store.get(second.id), null, 'the least recently used image was evicted');
  assert.ok(store.get(first.id), 'the image read a moment ago stayed');
  assert.ok(store.get(third.id));
  assert.ok(store.stats().bytes <= 30);
});

test('the store answers nothing for an id that is not one of its hashes', () => {
  const store = createImageStore();
  store.put('image/png', b64('x'));
  assert.equal(store.get('../../etc/passwd'), null);
  assert.equal(store.get(''), null);
  assert.equal(store.get('ABCDEF'), null);
});

test('a window seeds at most MAX_PREFIX_IMAGE_BLOCKS older images; older prompts keep their words', async () => {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), 'harbor-transcript-images-'));
  const file = path.join(dir, 'session.jsonl');
  const total = MAX_PREFIX_IMAGE_BLOCKS + 16;
  const lines = [];
  for (let i = 0; i < total; i += 1) {
    lines.push(JSON.stringify({
      type: 'user',
      timestamp: new Date(Date.UTC(2026, 10, 5, 0, 0, i)).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: `screenshot ${i}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(`synthetic image ${i}`) } }] },
    }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  const blocks = await readPrefixBlocks(file, fs.statSync(file).size, 'claude', { maxUserBlocks: total });
  const withImages = blocks.filter((block) => block.images?.length);
  // The opening keeps its own image, so the bound counts every other image block.
  assert.equal(withImages.length, MAX_PREFIX_IMAGE_BLOCKS + 1, 'the newest images plus the opening');
  assert.ok(withImages.some((block) => block.text === `screenshot ${total - 1}`), 'the newest image is seeded');
  const older = blocks.find((block) => block.text === 'screenshot 5');
  assert.ok(older, 'an older prompt is still there');
  assert.equal(older.images.length, 0, 'its image was not seeded, its words were');
  // Every seeded image is a reference the store can serve.
  for (const block of withImages) assert.ok(imageStore.get(block.images[0].id), `bytes for ${block.text}`);
});

function fakeResponse() {
  return {
    status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers || {}; },
    end(body) { this.body = body ?? null; },
  };
}

test('the phone route serves a stored image and 404s anything else', async () => {
  const store = createImageStore();
  const { id } = store.put('image/jpeg', b64('phone picture'));
  const handler = createTranscriptImageHandler({ store });

  const hit = fakeResponse();
  assert.equal(await handler({ url: `/transcript-images/${id}` }, hit), true);
  assert.equal(hit.status, 200);
  assert.equal(hit.headers['content-type'], 'image/jpeg');
  assert.deepEqual(hit.body, Buffer.from('phone picture'));

  const miss = fakeResponse();
  assert.equal(await handler({ url: `/transcript-images/${'0'.repeat(32)}` }, miss), true);
  assert.equal(miss.status, 404);

  const other = fakeResponse();
  assert.equal(await handler({ url: '/icons/x.png' }, other), false, 'other routes are not this handler\'s');
});

test("a window full of tool screenshots drops them before any prompt of Pat's, text-only or with an image", () => {
  const { TranscriptParser, MAX_BLOCKS } = require('../../src/main/providers/transcript.js');
  const p = new TranscriptParser();
  const ref = { mediaType: 'image/png', id: imageIdFor(b64('s')), size: 1 };
  p.push({ kind: 'user', text: 'my text-only question', ts: '2026-11-05T00:00:00Z' });
  p.push({ kind: 'user', text: 'my question with a picture', images: [ref], ts: '2026-11-05T00:00:01Z' });
  for (let i = 0; i < MAX_BLOCKS + 20; i += 1) p.push({ kind: 'assistant', text: `tool screenshot ${i}`, images: [ref], ts: '2026-11-05T00:01:00Z' });
  assert.equal(p.blocks.length, MAX_BLOCKS);
  assert.ok(p.blocks.some((b) => b.text === 'my text-only question'), 'the text-only prompt stayed');
  assert.ok(p.blocks.some((b) => b.text === 'my question with a picture' && b.images.length === 1), 'the image prompt stayed, image included');
  assert.ok(!p.blocks.some((b) => b.text === 'tool screenshot 0'), 'the oldest tool screenshot went');
});
