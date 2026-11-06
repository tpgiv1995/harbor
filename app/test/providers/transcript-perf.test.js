'use strict';

// Perf lane B (2026-11-06): three measured resource bugs in the transcript
// provider. Every test is two-sided: the assertion below fails on the code
// before the change (it stored every parsed image, polled with an emit every
// time, and re-streamed the whole skipped prefix on every open). Fixtures are
// synthetic and live in temp dirs; no real daemon or ~/.claude store is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { realTmpDir } = require('../support/real-tmpdir.js');
const { createImageStore, imageStore, DEFAULT_MAX_BYTES } = require('../../src/main/providers/image-store.js');
const {
  createTranscriptProvider,
  getPrefixSeed,
  clearPrefixSeedCache,
  prefixCacheEntries,
  prefixScanStats,
  readArchiveBlocksBeforeOffset,
  SOURCE_RECORD,
  MAX_PREFIX_IMAGE_BLOCKS,
  MAX_INITIAL_BYTES,
} = require('../../src/main/providers/transcript.js');

const RUN = crypto.randomBytes(6).toString('hex'); // keeps image bytes unique to this run
const b64 = (label) => Buffer.from(`perf-${RUN}-${label}`).toString('base64');
const imagePart = (label) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64(label) } });
const TS = '2026-11-06T00:00:00.000Z';
const promptLine = (text, labels = []) => ({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'text', text }, ...labels.map(imagePart)] } });
const screenshotLine = (label) => ({ type: 'user', timestamp: TS, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${label}`, content: [imagePart(label)] }] } });
const assistantLine = (text) => ({ type: 'assistant', timestamp: TS, message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] } });
const queueLine = (operation, content) => ({ type: 'queue-operation', operation, content, timestamp: TS });

function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(realTmpDir(), `harbor-perf-${name}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const write = (file, records) => fs.writeFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
const append = (file, records) => fs.appendFileSync(file, `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
// Byte offset just after record `count` (a record boundary), for cutting a file.
function offsetAfter(file, count) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  return Buffer.byteLength(`${lines.slice(0, count).join('\n')}\n`);
}
// What a seed means, comparable across copies: blocks with their source marks, queue refs as indexes.
function normalize(seed) {
  const index = (block) => (block ? seed.blocks.indexOf(block) : null);
  return JSON.parse(JSON.stringify({
    blocks: seed.blocks.map((block) => ({ ...block, __src: block[SOURCE_RECORD] ?? null })),
    pending: seed.queue.pending.map((item) => ({ ...item, block: index(item.block) })),
    byText: seed.queue.byText.map(([key, block]) => [key, index(block)]),
    dequeued: seed.queue.dequeued ? { ...seed.queue.dequeued, block: index(seed.queue.dequeued.block) } : null,
  }));
}

// ---------------------------------------------------------------------- B1

test('B1: the image store holds 128 MB, not 384, and reports what it still has', () => {
  assert.equal(DEFAULT_MAX_BYTES, 128 * 1024 * 1024);
  const store = createImageStore({ maxBytes: 20 });
  const a = store.put('image/png', Buffer.from('0123456789').toString('base64'));
  assert.equal(store.has(a.id), true);
  store.put('image/png', Buffer.from('abcdefghij').toString('base64'));
  store.put('image/png', Buffer.from('ABCDEFGHIJ').toString('base64'));
  assert.equal(store.has(a.id), false, 'the least recently used image was evicted and has() says so');
  assert.equal(store.get(a.id), null, 'an evicted image still answers nothing, which the window shows as "no longer loaded"');
  assert.equal(store.has('../../x'), false);
});

test('B1: the prefix scan stores only the pictures a window can use, not every picture it parses', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b1-prefix');
  const file = path.join(dir, 'session.jsonl');
  const records = [];
  for (let i = 0; i < 150; i += 1) records.push(promptLine(`question ${i}`, [`prompt-${i}`]));
  for (let i = 0; i < 60; i += 1) records.push(screenshotLine(`shot-${i}`));
  write(file, records);
  const before = imageStore.stats().images;
  const seed = await getPrefixSeed(file, fs.statSync(file).size);
  const stored = imageStore.stats().images - before;
  const withImages = seed.blocks.filter((block) => block.images?.length);
  assert.equal(withImages.length, MAX_PREFIX_IMAGE_BLOCKS + 1, 'the newest 64 pictures plus the opening, as before');
  assert.ok(stored <= MAX_PREFIX_IMAGE_BLOCKS + 1, `stored ${stored} images; before this change it stored all 210`);
  for (const block of withImages) assert.ok(imageStore.get(block.images[0].id), 'every picture a block carries is servable');
  const shot = withImages.filter((block) => block.kind === 'assistant').at(-1);
  assert.deepEqual(imageStore.get(shot.images[0].id).bytes, Buffer.from(`perf-${RUN}-shot-59`));
});

test('B1: a paging chunk stores the pictures of the blocks it returns, not of the whole chunk', async (t) => {
  const dir = tempDir(t, 'b1-page');
  const file = path.join(dir, 'session.jsonl');
  const records = [];
  for (let i = 0; i < 120; i += 1) records.push(promptLine(`older ${i}`, [`page-${i}`]));
  write(file, records);
  const before = imageStore.stats().images;
  const { blocks } = await readArchiveBlocksBeforeOffset(file, 'claude', fs.statSync(file).size, 10);
  const stored = imageStore.stats().images - before;
  assert.equal(blocks.length, 10);
  assert.equal(stored, 10, `stored ${stored} images; before this change it stored all 120 parsed in the chunk`);
  for (const block of blocks) assert.ok(block.images[0].id && imageStore.get(block.images[0].id), 'returned pictures are servable');
});

// ---------------------------------------------------------------------- B3

// A transcript that exercises everything the seed carries: prompts past the
// 40-prompt cap, more than 64 pictures, tool screenshots, peer messages, and
// queue entries whose enqueue and remove straddle the cut points.
function richFixture(file) {
  const records = [];
  const cuts = {};
  for (let i = 0; i < 130; i += 1) {
    records.push(promptLine(`prompt ${i}`, i % 3 === 0 ? [`rich-p-${i}`] : []));
    if (i % 4 === 0) records.push(screenshotLine(`rich-s-${i}`));
    if (i % 9 === 0) records.push(queueLine('enqueue', `<cross-session-message from-name="helper">status ${i}</cross-session-message>`));
    if (i === 50) { records.push(queueLine('enqueue', 'typed while busy A')); cuts.pendingA = records.length; }
    if (i === 52) records.push(queueLine('remove', 'typed while busy A'));
    if (i === 90) { records.push(queueLine('enqueue', 'typed while busy B')); cuts.pendingB = records.length; }
    if (i === 95) records.push({ type: 'attachment', timestamp: TS, attachment: { type: 'queued_command', origin: { kind: 'human' }, prompt: [{ type: 'text', text: 'typed while busy B' }, imagePart('rich-late')] } });
    if (i === 60) { records.push(queueLine('enqueue', 'typed then dequeued')); records.push(queueLine('dequeue')); cuts.dequeued = records.length; }
    records.push(assistantLine(`reply ${i}`));
    if (i === 40) cuts.mid = records.length;
  }
  write(file, records);
  cuts.end = records.length;
  return cuts;
}

test('B3: a reopen of the same file reads no prefix bytes and returns what a full scan returns', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-hit');
  const file = path.join(dir, 'session.jsonl');
  const cuts = richFixture(file);
  const end = offsetAfter(file, cuts.pendingB);
  const cold = await getPrefixSeed(file, end);
  assert.equal(cold.mode, 'miss');
  const streamedCold = prefixScanStats.bytesStreamed;
  assert.equal(streamedCold, end);
  const warm = await getPrefixSeed(file, end);
  assert.equal(warm.mode, 'hit');
  assert.equal(prefixScanStats.bytesStreamed, streamedCold, 'before this change the second open streamed the prefix again');
  const fresh = await getPrefixSeed(file, end, 'claude', 40, { cache: false });
  assert.deepEqual(normalize(warm), normalize(fresh));
  assert.ok(warm.queue.pending.some((item) => item.block), 'the enqueue still waiting at the cut travels with its bubble');
});

test('B3: a file that only grew streams just the new range and merges to exactly what one longer scan gives', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-grow');
  const file = path.join(dir, 'session.jsonl');
  const cuts = richFixture(file);
  const stops = [cuts.mid, cuts.pendingA, cuts.dequeued, cuts.pendingB, cuts.end].map((count) => offsetAfter(file, count));
  let previous = 0;
  let streamed = 0;
  for (const stop of stops) {
    const mark = prefixScanStats.bytesStreamed;
    const grown = await getPrefixSeed(file, stop);
    streamed += prefixScanStats.bytesStreamed - mark; // the cached path only, not the reference scan below
    const fresh = await getPrefixSeed(file, stop, 'claude', 40, { cache: false });
    assert.deepEqual(normalize(grown), normalize(fresh), `merged seed at ${stop} equals a full scan`);
    assert.equal(grown.mode, previous ? 'extended' : 'miss');
    previous = stop;
  }
  assert.equal(streamed, stops.at(-1), 'the sum of the ranges is the file once, not once per open');
  // The old behaviour would have streamed the sum of every end offset.
  assert.ok(stops.reduce((sum, stop) => sum + stop, 0) > stops.at(-1) * 2);
  const grownAgain = await getPrefixSeed(file, stops.at(-1));
  assert.equal(grownAgain.mode, 'hit');
});

test('B3: each caller owns its copy; changing one never changes the cached seed', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-copy');
  const file = path.join(dir, 'session.jsonl');
  richFixture(file);
  const size = fs.statSync(file).size;
  const first = await getPrefixSeed(file, size);
  const reference = normalize(first);
  for (const block of first.blocks) { block.text = 'mutated'; block.queueState = 'mutated'; if (block.images) block.images.push({ id: 'x' }); }
  first.queue.pending.length = 0;
  const second = await getPrefixSeed(file, size);
  assert.equal(second.mode, 'hit');
  assert.deepEqual(normalize(second), reference);
});

test('B3: a rewritten file, a shorter offset or a mid-record end is never served from the cache', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-guard');
  const file = path.join(dir, 'session.jsonl');
  write(file, Array.from({ length: 60 }, (_, i) => promptLine(`original ${i}`)));
  const size = fs.statSync(file).size;
  await getPrefixSeed(file, size);
  // Same path, same length, different content: the fingerprint catches it.
  const original = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, original.replaceAll('original', 'rewrite!'));
  assert.equal(fs.statSync(file).size, size);
  const rewritten = await getPrefixSeed(file, size);
  assert.equal(rewritten.mode, 'miss');
  assert.ok(rewritten.blocks.some((block) => block.text === 'rewrite! 59'));
  assert.ok(!rewritten.blocks.some((block) => block.text === 'original 59'));
  // An older, shorter offset is answered by a scan and leaves the longer cached scan alone.
  const shortEnd = offsetAfter(file, 20);
  const shorter = await getPrefixSeed(file, shortEnd);
  assert.equal(shorter.mode, 'miss');
  assert.equal((await getPrefixSeed(file, size)).mode, 'hit');
  // An end in the middle of a record cannot be resumed from, so it is not cached.
  const entries = prefixCacheEntries();
  const odd = await getPrefixSeed(file, shortEnd + 7);
  assert.equal(odd.mode, 'miss');
  assert.equal((await getPrefixSeed(file, shortEnd + 7)).mode, 'miss');
  assert.equal(prefixCacheEntries(), entries);
});

test('B3: a cached seed whose pictures the store has since evicted is scanned again, so they come back', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-evict');
  const file = path.join(dir, 'session.jsonl');
  write(file, Array.from({ length: 5 }, (_, i) => promptLine(`with picture ${i}`, [`evict-${i}`])));
  const size = fs.statSync(file).size;
  await getPrefixSeed(file, size);
  const real = imageStore.has;
  imageStore.has = () => false; // as if the store had dropped them all
  let after;
  try { after = await getPrefixSeed(file, size); } finally { imageStore.has = real; }
  assert.equal(after.mode, 'miss', 'a hit that would hand out unservable pictures is refused');
  assert.ok(after.blocks.every((block) => block.images.every((ref) => imageStore.get(ref.id))));
});

// Astra review 2026-11-06, finding 9: four entries could not cover a restored
// stage of sixteen windows, so a reload rescanned every window from byte 0.
test('B3: sixteen windows reopened are all served from the cache, and it stays bounded', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-bound');
  const files = [];
  for (let i = 0; i < 16; i += 1) {
    const file = path.join(dir, `s${i}.jsonl`);
    write(file, [promptLine(`file ${i}`)]);
    files.push(file);
    await getPrefixSeed(file, fs.statSync(file).size);
  }
  const modes = [];
  for (const file of files) modes.push((await getPrefixSeed(file, fs.statSync(file).size)).mode);
  assert.deepEqual(modes, Array(16).fill('hit'), 'a second pass over sixteen windows rescans none');
  for (let i = 16; i < 24; i += 1) {
    const file = path.join(dir, `s${i}.jsonl`);
    write(file, [promptLine(`file ${i}`)]);
    await getPrefixSeed(file, fs.statSync(file).size);
  }
  assert.ok(prefixCacheEntries() <= 16, `holds ${prefixCacheEntries()}`);
});

// Astra review 2026-11-06, finding 4: the cache compared only the first and
// last 4 KB, so a same-size rewrite of the middle was served as a hit.
test('B3: a same-size rewrite in the middle of the prefix is not served from the cache', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-middle');
  const file = path.join(dir, 'session.jsonl');
  write(file, Array.from({ length: 400 }, (_, i) => promptLine(`prompt number ${String(i).padStart(3, '0')}`)));
  const size = fs.statSync(file).size;
  await getPrefixSeed(file, size);
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('prompt number 365', 'prompt NUMBER 365'));
  assert.equal(fs.statSync(file).size, size, 'same length, both ends untouched');
  const again = await getPrefixSeed(file, size);
  assert.equal(again.mode, 'miss');
  assert.ok(again.blocks.some((block) => block.text === 'prompt NUMBER 365'));
});

// Astra review 2026-11-06, finding 2: on a long session the parser trims the
// opening away, and its deferred picture was never stored, so the seed carried
// an id-less reference that replaced the opening window's real one.
test('B1: the opening prompt keeps a servable picture on a session long enough to trim it', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b1-opening');
  const file = path.join(dir, 'long.jsonl');
  const records = [promptLine('the opening prompt', ['long-open'])];
  for (let i = 0; i < 310; i += 1) records.push(promptLine(`picture prompt ${i}`, [`long-${i}`]));
  const filler = 'x'.repeat(900);
  for (let i = 0; i < Math.ceil((MAX_INITIAL_BYTES * 1.4) / 1000); i += 1) records.push(assistantLine(`${i} ${filler}`));
  records.push(promptLine('the latest question'));
  write(file, records);
  const priorHomes = process.env.HARBOR_BEACON_HOMES;
  process.env.HARBOR_BEACON_HOMES = path.join(dir, 'no-homes');
  t.after(() => { if (priorHomes === undefined) delete process.env.HARBOR_BEACON_HOMES; else process.env.HARBOR_BEACON_HOMES = priorHomes; });
  const provider = makeProvider(file, dir);
  t.after(() => provider.closeAll());
  let opened = null;
  provider.emitter.on('update', (update) => { if (update.replace) opened = update.replace; });
  await provider.open('long');
  const opening = opened.find((block) => block.text === 'the opening prompt');
  assert.ok(opening, 'the opening is shown');
  assert.equal(opening.images.length, 1);
  assert.ok(opening.images[0].id && imageStore.get(opening.images[0].id), 'and its picture can be served');
});

// A transcript larger than the window a tile reads (MAX_INITIAL_BYTES), so an
// open really has a skipped prefix to seed.
function bigSession(file, extra = 0) {
  const records = [promptLine('the opening prompt', ['big-open'])];
  for (let i = 0; i < 20; i += 1) records.push(promptLine(`early question ${i}`, i % 5 === 0 ? [`big-${i}`] : []));
  const filler = 'x'.repeat(900);
  for (let i = 0; i < Math.ceil((MAX_INITIAL_BYTES * 1.4 + extra) / 1000); i += 1) records.push(assistantLine(`${i} ${filler}`));
  records.push(promptLine('the latest question'));
  write(file, records);
}
function makeProvider(file, context) {
  return createTranscriptProvider({
    contextCacheDir: context,
    getSessionMeta: async () => ({ path: file }),
    watchFactory: () => ({ on: () => {}, close: () => {} }),
  });
}

test('B3: reopening a window on a large session streams no prefix and shows the same conversation', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-open');
  const file = path.join(dir, 'big.jsonl');
  bigSession(file);
  const priorHomes = process.env.HARBOR_BEACON_HOMES;
  process.env.HARBOR_BEACON_HOMES = path.join(dir, 'no-homes');
  t.after(() => { if (priorHomes === undefined) delete process.env.HARBOR_BEACON_HOMES; else process.env.HARBOR_BEACON_HOMES = priorHomes; });
  const provider = makeProvider(file, dir);
  t.after(() => provider.closeAll());
  const opens = [];
  provider.emitter.on('update', (update) => { if (update.replace) opens.push(update.replace); });
  await provider.open('big');
  const afterFirst = prefixScanStats.bytesStreamed;
  assert.ok(afterFirst > 0, 'the first open scans the prefix');
  provider.closeAll(); // closeAll latches; build a new provider as a reload would
  const second = makeProvider(file, dir);
  t.after(() => second.closeAll());
  second.emitter.on('update', (update) => { if (update.replace) opens.push(update.replace); });
  await second.open('big');
  assert.equal(prefixScanStats.bytesStreamed, afterFirst, 'before this change every open streamed the prefix again');
  assert.equal(opens.length, 2);
  assert.deepEqual(opens[1], opens[0], 'the cached open shows the same blocks');
  assert.equal(opens[0][0].text, 'the opening prompt', 'the opening prompt is still the first row');
  assert.ok(opens[0].some((block) => block.text === 'early question 19'));
  // Reference answer: no cache at all.
  clearPrefixSeedCache();
  const third = makeProvider(file, dir);
  t.after(() => third.closeAll());
  third.emitter.on('update', (update) => { if (update.replace) opens.push(update.replace); });
  await third.open('big');
  assert.deepEqual(opens[2], opens[0], 'and the same as a cold open');
});

test('B3: after the file grows, the next open scans only the bytes that left the tail window', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-open-grow');
  const file = path.join(dir, 'big.jsonl');
  bigSession(file);
  const priorHomes = process.env.HARBOR_BEACON_HOMES;
  process.env.HARBOR_BEACON_HOMES = path.join(dir, 'no-homes');
  t.after(() => { if (priorHomes === undefined) delete process.env.HARBOR_BEACON_HOMES; else process.env.HARBOR_BEACON_HOMES = priorHomes; });
  const first = makeProvider(file, dir);
  t.after(() => first.closeAll());
  await first.open('big');
  const firstEnd = prefixScanStats.bytesStreamed;
  first.closeAll();
  append(file, [promptLine('a new picture question', ['big-new']), ...Array.from({ length: 700 }, (_, i) => assistantLine(`more ${i} ${'y'.repeat(900)}`))]);
  const second = makeProvider(file, dir);
  t.after(() => second.closeAll());
  const updates = [];
  second.emitter.on('update', (update) => { if (update.replace) updates.push(update.replace); });
  await second.open('big');
  const delta = prefixScanStats.bytesStreamed - firstEnd;
  const growth = fs.statSync(file).size - firstEnd; // the new tail start moved by about the growth
  assert.ok(delta > 0 && delta < growth + 5000, `scanned ${delta} new bytes for ${growth} grown`);
  assert.ok(prefixScanStats.bytesStreamed < fs.statSync(file).size, 'never the whole file again');
  assert.ok(updates[0].some((block) => block.text === 'the opening prompt'));
});

// ---------------------------------------------------------------------- B2

function pollFixture(t, { recordsOnDisk, beaconHome, sessionId = 'poll', providerOptions = {} } = {}) {
  const dir = tempDir(t, 'b2');
  const context = path.join(dir, 'context');
  fs.mkdirSync(context, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  write(file, recordsOnDisk || [promptLine('hello'), assistantLine('hi there')]);
  const priorHomes = process.env.HARBOR_BEACON_HOMES;
  process.env.HARBOR_BEACON_HOMES = beaconHome || path.join(dir, 'no-homes');
  const provider = createTranscriptProvider({
    contextCacheDir: context,
    getSessionMeta: async () => ({ path: file }),
    watchFactory: () => ({ on: () => {}, close: () => {} }),
    ...providerOptions,
  });
  t.after(() => {
    provider.closeAll();
    if (priorHomes === undefined) delete process.env.HARBOR_BEACON_HOMES; else process.env.HARBOR_BEACON_HOMES = priorHomes;
  });
  const updates = [];
  provider.emitter.on('update', (update) => updates.push(update));
  return { dir, context, file, provider, updates, sessionId };
}

test('B2: a poll that finds nothing new sends nothing; a real change still goes out at once', async (t) => {
  const { provider, updates, file, sessionId } = pollFixture(t);
  await provider.open(sessionId);
  assert.equal(updates.length, 1, 'the open sends the conversation');
  for (let i = 0; i < 5; i += 1) await provider.refresh(sessionId);
  assert.equal(updates.length, 1, 'five idle polls, no pushes (before this change: five more)');
  append(file, [assistantLine('a new reply')]);
  await provider.refresh(sessionId);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[1].append.map((block) => block.text), ['a new reply']);
  await provider.refresh(sessionId);
  assert.equal(updates.length, 2, 'and quiet again afterwards');
});

test('B2: a header value that changes only because the owner died still goes out', async (t) => {
  let alive = true;
  const { provider, updates, file, sessionId } = pollFixture(t, {
    recordsOnDisk: [promptLine('take as long as needed')],
    providerOptions: {
      readProcessCmdline: () => { if (!alive) throw Object.assign(new Error('gone'), { code: 'ENOENT' }); return '/bin/claude\0--resume\0x\0'; },
    },
  });
  fs.writeFileSync(path.join(path.dirname(file), 'context', `${sessionId}.json`), JSON.stringify({ pid: 424242 }));
  await provider.open(sessionId);
  assert.equal(updates.at(-1).header.processAlive, true);
  assert.equal(updates.at(-1).header.working, true);
  await provider.refresh(sessionId);
  const quiet = updates.length;
  alive = false;
  await provider.refresh(sessionId);
  assert.equal(updates.length, quiet + 1);
  assert.equal(updates.at(-1).header.processAlive, false);
  assert.equal(updates.at(-1).header.working, false);
});

test('B2: the working shimmer settles when the clock passes its freshness limit, with no new records', async (t) => {
  const { provider, updates, sessionId } = pollFixture(t, { recordsOnDisk: [promptLine('a prompt nobody has answered')] });
  await provider.open(sessionId);
  assert.equal(updates.at(-1).header.working, true);
  await provider.refresh(sessionId);
  assert.equal(updates.length, 1, 'nothing changed yet, nothing sent');
  const realNow = Date.now;
  t.mock.method(Date, 'now', () => realNow() + 200_000); // past the 180-second limit
  await provider.refresh(sessionId);
  assert.equal(updates.length, 2, 'the header changed only because time passed, and went out');
  assert.equal(updates.at(-1).header.working, false);
  assert.deepEqual(updates.at(-1).append, []);
});

test('B2: the liveness beacon is read at most once per cache window, and again after it', async (t) => {
  const dir = tempDir(t, 'b2-beacon-home');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, 'statusline-state'), { recursive: true });
  const beacon = path.join(home, 'statusline-state', 'poll.json');
  fs.writeFileSync(beacon, '{}');
  const stale = new Date(Date.now() - 41 * 60_000);
  fs.utimesSync(beacon, stale, stale);
  const { provider, updates, file, sessionId } = pollFixture(t, {
    beaconHome: home,
    providerOptions: { beaconCacheMs: 300 },
  });
  fs.utimesSync(file, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));
  const realStat = fsp.stat;
  let beaconStats = 0;
  fsp.stat = async (target, ...rest) => { if (String(target).includes('statusline-state')) beaconStats += 1; return realStat(target, ...rest); };
  t.after(() => { fsp.stat = realStat; });
  await provider.open(sessionId);
  assert.equal(updates.at(-1).header.processAlive, false, 'beacon and transcript both stale: the owner is gone');
  assert.equal(beaconStats, 1);
  fs.utimesSync(beacon, new Date(), new Date()); // the statusline repaints
  for (let i = 0; i < 4; i += 1) await provider.refresh(sessionId);
  assert.equal(beaconStats, 1, 'four polls inside the window stat the beacon zero more times (before: four more)');
  assert.equal(updates.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 350));
  await provider.refresh(sessionId);
  assert.equal(beaconStats, 2, 'after the window it is read again');
  assert.equal(updates.at(-1).header.processAlive, true, 'and the repaint shows');
});

test('B2: the statusline tee is parsed again only when its file changed', async (t) => {
  const { provider, updates, context, sessionId } = pollFixture(t);
  const tee = path.join(context, `${sessionId}.json`);
  fs.writeFileSync(tee, JSON.stringify({ used_percentage: 41, context_window_size: 1_000_000, pid: 99999 }));
  const realRead = fsp.readFile;
  let teeReads = 0;
  fsp.readFile = async (target, ...rest) => { if (path.resolve(String(target)) === path.resolve(tee)) teeReads += 1; return realRead(target, ...rest); };
  t.after(() => { fsp.readFile = realRead; });
  await provider.open(sessionId);
  assert.equal(updates.at(-1).header.contextPct, 41);
  const afterOpen = teeReads;
  assert.equal(afterOpen, 1);
  for (let i = 0; i < 4; i += 1) await provider.refresh(sessionId);
  assert.equal(teeReads, afterOpen, 'four polls with the tee untouched read it zero more times (before: four more)');
  fs.writeFileSync(tee, JSON.stringify({ used_percentage: 63, context_window_size: 1_000_000, pid: 99999 }));
  const later = new Date(Date.now() + 2000);
  fs.utimesSync(tee, later, later);
  await provider.refresh(sessionId);
  assert.equal(teeReads, afterOpen + 1);
  assert.equal(updates.at(-1).header.contextPct, 63, 'a changed tee is picked up and sent');
});

// Astra review round 2, N3: a hit with the same tail start left the cache's
// whole-file stamp from the first scan, so after the file grew, a same-size
// rewrite of a kept prompt was served stale.
test('B3: after a hit on a grown file, a same-size rewrite is still caught', async (t) => {
  clearPrefixSeedCache();
  const dir = tempDir(t, 'b3-grown-rewrite');
  const file = path.join(dir, 'session.jsonl');
  // Long prompts, so the newest forty (the ones a seed shows) span more than
  // the sampled 4 KB ranges and prompt 370 sits between samples.
  write(file, Array.from({ length: 400 }, (_, i) => promptLine(`prompt number ${String(i).padStart(3, '0')} ${'p'.repeat(2000)}`)));
  const end = fs.statSync(file).size;
  await getPrefixSeed(file, end);
  append(file, [assistantLine('a small reply after the prefix')]);
  assert.equal((await getPrefixSeed(file, end)).mode, 'hit', 'the prefix is unchanged; the file grew past it');
  await new Promise((resolve) => setTimeout(resolve, 20));
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('prompt number 370 ', 'prompt NUMBER 370 '));
  const again = await getPrefixSeed(file, end);
  assert.equal(again.mode, 'miss');
  assert.ok(again.blocks.some((block) => block.text.startsWith('prompt NUMBER 370 ')));
});
