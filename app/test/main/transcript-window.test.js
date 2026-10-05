'use strict';

// MOBILE-3: windowed transcript delivery. A phone on cellular cannot take the
// desktop's full parsed payload. `open(sessionId, { window: { blocks } })`
// trims the EMITTED payload to the most recent N blocks; `page(sessionId,
// { beforeBlockId, count })` walks backward through older blocks on demand,
// reading further back in the file independently of the live-tailing entry.
//
// The desktop default (no `window` hint) must stay byte-identical: these
// tests prove that separately from the windowed/paging behaviour so a
// regression in one can never hide inside the other.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createTranscriptProvider: createTranscriptProviderImpl,
  TranscriptParser,
  MAX_BLOCKS,
  MAX_INITIAL_BYTES,
  DEFAULT_WINDOW_BLOCKS,
} = require('../../src/main/providers/transcript.js');

const TEST_CONTEXT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-transcript-window-context-'));
const createTranscriptProvider = (options) => createTranscriptProviderImpl({
  contextCacheDir: TEST_CONTEXT_DIR,
  ...options,
});

// The SHAPE of a real 360-line excerpt of a large example-app transcript, with
// every human-readable string replaced by synthetic text (2026-08-07).
//
// It began as a real capture, and that is exactly why it had to be rewritten:
// a transcript records whatever was actually said in a working session, so this
// one had inherited client names, a business prospect list, an internal
// security-incident note and a skill roster. Six successive token-level scrub
// passes each reported clean and each missed it, because the identifying
// content was the SENTENCES, not the names in them. One of those passes even
// truncated a company name mid-word and left the fragment.
//
// What is preserved, because the parser reads it: record types, roles, uuids,
// parent links, timestamps, model names, tool names, part types, and the image
// payloads (media_type real, base64 truncated to ~120 chars, so imageFromPart
// still builds a structurally valid data URI). Both fixtures still parse to
// exactly the block counts they always did: 131 blocks / 21 image blocks here,
// 50 / 1 for the tail.
//
// What is NOT preserved: any prose. Do not treat the text in these files as
// evidence of anything, and do not "restore" realism by pasting a real
// transcript back in. If you regenerate them, the invariants that matter are
// that the file parses as JSONL the parser turns into the same block kinds, and
// that it yields more than DEFAULT_WINDOW_BLOCKS (60) blocks, which is what
// makes a windowed open meaningfully smaller than a full one.
const PREFIX_FIXTURE = path.join(__dirname, '../fixtures/transcript-window/prefix-with-images.jsonl');
// The tail of the same session, 150 lines, rewritten the same way.
const TAIL_FIXTURE = path.join(__dirname, '../fixtures/transcript-window/tail-sample.jsonl');

// An optional 100+MB transcript to page against, which is the only way to prove
// paging at a size no committed fixture can reach. It lives in whoever's own
// transcript store, is present on no CI machine and on almost no contributor's,
// and every test against it skips with a named reason when it is absent, so the
// suite never depends on one person's history. Point HARBOR_BIG_TRANSCRIPT at
// any large .jsonl of your own to exercise these two specs.
const REAL_BIG_FILE = process.env.HARBOR_BIG_TRANSCRIPT || path.join(
  os.homedir(), '.claude', 'projects', '-home-you-dev-example-app',
  '667ec2dd-9ee3-497c-9c31-6bf195223550.jsonl',
);
const REAL_BIG_FILE_PRESENT = fs.existsSync(REAL_BIG_FILE);

const TINY_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_URI = `data:image/png;base64,${TINY_PNG_B64}`;

function imagePart(mediaType = 'image/png', data = TINY_PNG_B64) {
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

const TS = '2026-07-18T05:00:00.000Z';
function userLine(content, extra = {}) {
  return { type: 'user', message: { role: 'user', content }, timestamp: TS, uuid: 'u1', ...extra };
}

function writeLines(file, objs, flag = 'a') {
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join('\n') + '\n', { flag });
}

// Compare blocks by content, not by `.key` (live entries mint "b<seq>" keys;
// archive/page reads mint "a<offset>" keys on the same content, by design).
function tuple(block) {
  return [block.kind, block.text || '', block.verb || '', block.chip || ''].join('');
}

async function fullParse(file, provider = 'claude') {
  const parser = new TranscriptParser(provider);
  const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    parser.applyLine(obj);
  }
  return parser.blocks;
}

test('an open with no window hint stays byte-identical to today: full block set, no trimming', async () => {
  const groundTruth = await fullParse(PREFIX_FIXTURE);
  assert.ok(groundTruth.length > DEFAULT_WINDOW_BLOCKS, 'fixture must exceed a default window to be a meaningful test');

  const providerA = createTranscriptProvider({ getSessionMeta: async () => ({ path: PREFIX_FIXTURE }) });
  const updatesA = [];
  providerA.emitter.on('update', (u) => updatesA.push(u));
  await providerA.open('no-hints-at-all');

  const providerB = createTranscriptProvider({ getSessionMeta: async () => ({ path: PREFIX_FIXTURE }) });
  const updatesB = [];
  providerB.emitter.on('update', (u) => updatesB.push(u));
  await providerB.open('explicit-empty-hints', {});

  assert.equal(updatesA[0].replace.length, groundTruth.length, 'unwindowed open emits every block, not a trimmed window');
  assert.deepEqual(updatesA[0].replace.map(tuple), groundTruth.map(tuple));
  assert.deepEqual(updatesA[0].replace.map(tuple), updatesB[0].replace.map(tuple),
    'omitting `window` and passing an empty hints object behave identically');

  providerA.closeAll();
  providerB.closeAll();
});

test('a windowed open emits only the most recent N blocks, priced off the full parser state', async () => {
  const groundTruth = await fullParse(PREFIX_FIXTURE);
  const N = 10;

  const unwindowed = createTranscriptProvider({ getSessionMeta: async () => ({ path: PREFIX_FIXTURE }) });
  const uUpdates = [];
  unwindowed.emitter.on('update', (u) => uUpdates.push(u));
  await unwindowed.open('unwindowed');

  const windowed = createTranscriptProvider({ getSessionMeta: async () => ({ path: PREFIX_FIXTURE }) });
  const wUpdates = [];
  windowed.emitter.on('update', (u) => wUpdates.push(u));
  await windowed.open('windowed', { window: { blocks: N } });

  const initial = wUpdates[0].replace;
  assert.equal(initial.length, N);
  assert.deepEqual(initial.map(tuple), groundTruth.slice(-N).map(tuple), 'windowed open returns the true most-recent N blocks');

  // The context gauge invariant: a windowed payload is never priced off the
  // partial window. header.contextTokens/contextPct come from the same full
  // parser state as the unwindowed open of the identical file.
  assert.equal(wUpdates[0].header.contextTokens, uUpdates[0].header.contextTokens);
  assert.equal(wUpdates[0].header.contextPct, uUpdates[0].header.contextPct);

  const initialKB = Buffer.byteLength(JSON.stringify(initial), 'utf8') / 1024;
  const fullKB = Buffer.byteLength(JSON.stringify(uUpdates[0].replace), 'utf8') / 1024;
  assert.ok(initialKB < fullKB, `windowed payload (${initialKB.toFixed(1)}KB) must be smaller than the full payload (${fullKB.toFixed(1)}KB)`);

  unwindowed.closeAll();
  windowed.closeAll();
});

test('paging backward from a windowed open exactly reconstructs the full real transcript', async () => {
  const groundTruth = await fullParse(PREFIX_FIXTURE);
  const N = 8;
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: PREFIX_FIXTURE }) });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('page-reconstruct', { window: { blocks: N } });

  const initial = updates[0].replace;
  const older = [];
  let cursor = initial[0].key;
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard < 100) {
    const res = await provider.page('page-reconstruct', { beforeBlockId: cursor, count: 12 });
    assert.equal(res.ok, true);
    if (!res.blocks.length) { hasMore = res.hasMore; guard += 1; continue; }
    older.unshift(...res.blocks);
    cursor = res.blocks[0].key;
    hasMore = res.hasMore;
    guard += 1;
  }
  assert.equal(hasMore, false, 'paging terminates at the true start of the file');

  const reconstructed = [...older, ...initial];
  assert.equal(reconstructed.length, groundTruth.length);
  assert.deepEqual(reconstructed.map(tuple), groundTruth.map(tuple), 'the full transcript is recovered in original order with no gaps or duplicates');

  provider.closeAll();
});

test('page() never re-reads the tail: it refuses cleanly on an unknown session and a missing beforeBlockId', async () => {
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: PREFIX_FIXTURE }) });
  const missingSession = await provider.page('never-opened', { beforeBlockId: 'b0', count: 5 });
  assert.equal(missingSession.ok, false);

  await provider.open('needs-cursor');
  const missingCursor = await provider.page('needs-cursor', { count: 5 });
  assert.equal(missingCursor.ok, false);

  provider.closeAll();
});

test('windowed open skips the eager prefix-image scan; paging back still resolves the image', async () => {
  // Mirrors the existing unwindowed fixture shape (test/providers/transcript.test.js,
  // "provider recovers an image before the initial tail window"): an image
  // and a sentinel, then >1MB of padding so the tail read genuinely skips a
  // prefix, then a recent line. For a WINDOWED open, seedPrefixImages is
  // skipped at open time (the batch's sanctioned optimization: readPrefixImageBlocks
  // was measured at 481ms on the real 147MB file and is pure overhead for a
  // window that only shows a handful of recent blocks up front). The image
  // must still resolve, with full fidelity, once the client pages back to it.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-transcript-window-img-'));
  const file = path.join(dir, 'windowed-image.jsonl');
  writeLines(file, [userLine([{ type: 'text', text: 'old screenshot' }, imagePart()])], 'w');
  writeLines(file, [userLine('very-old-sentinel')]);
  // Just enough padding to push the image past MAX_INITIAL_BYTES into the
  // skipped-prefix region (unlike the unwindowed fixture in
  // test/providers/transcript.test.js, which pads to 5MB+ because it only
  // needs ONE eager streaming scan). A windowed page() call re-parses each
  // chunk it reads, so a deliberately small margin keeps the archive region
  // this test walks a single, fast chunk instead of megabytes of filler.
  const row = `${JSON.stringify(userLine('old text'))}\n`;
  const paddingRows = Math.ceil((MAX_INITIAL_BYTES + 20_000) / Buffer.byteLength(row));
  fs.appendFileSync(file, row.repeat(paddingRows));
  writeLines(file, [userLine('recent tail')]);

  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: file }) });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('windowed-image', { window: { blocks: 5 } });

  const initial = updates[0].replace;
  assert.equal(initial.length, 5);
  assert.equal(initial.some((b) => b.images?.length), false, 'the old image is not in the trimmed initial window');
  assert.equal(initial.some((b) => b.text === 'very-old-sentinel'), false, 'the sentinel is skipped-prefix, not eagerly loaded');

  let cursor = initial[0].key;
  let found = null;
  let hasMore = true;
  for (let i = 0; i < 40 && !found && hasMore; i += 1) {
    const res = await provider.page('windowed-image', { beforeBlockId: cursor, count: 50 });
    assert.equal(res.ok, true);
    if (!res.blocks.length) { hasMore = res.hasMore; continue; }
    found = res.blocks.find((b) => b.images?.[0]?.dataUri === TINY_PNG_URI);
    cursor = res.blocks[0].key;
    hasMore = res.hasMore;
  }
  assert.ok(found, 'the prefix image resolves once the client pages back to it');

  provider.closeAll();
  await fsp.rm(dir, { recursive: true, force: true });
});

test('a plain tail excerpt opened windowed still yields real recent blocks', async () => {
  const groundTruth = await fullParse(TAIL_FIXTURE);
  const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: TAIL_FIXTURE }) });
  const updates = [];
  provider.emitter.on('update', (u) => updates.push(u));
  await provider.open('tail-windowed', { window: { blocks: 6 } });
  assert.deepEqual(updates[0].replace.map(tuple), groundTruth.slice(-6).map(tuple));
  provider.closeAll();
});

// --- Real 108MB-file proof (DONE WHEN: "verified against the actual file") ---
// Skipped everywhere except this machine, where the real transcript store
// lives; the fixtures above already carry the CI-safe, committed proof for
// the same logic at small scale.

test(
  'paging walks back into the real 108MB transcript with correct, monotonic ordering',
  { skip: !REAL_BIG_FILE_PRESENT && 'real transcript store not present on this machine' },
  async (t) => {
    // Bounded on purpose: this file's 3394 lines average ~32KB each (some
    // individual lines run past 500KB of inline tool-result payload), so
    // walking all the way to byte 0 means parsing a large fraction of a
    // 108MB file. A real mobile client pages a handful of screens back, not
    // the whole history in one sitting; this proves the archive path is
    // correct and keeps making progress against the actual file without
    // turning the test suite into a full-file scan.
    const provider = createTranscriptProvider({ getSessionMeta: async () => ({ path: REAL_BIG_FILE }) });
    t.after(() => provider.closeAll());
    const updates = [];
    provider.emitter.on('update', (u) => updates.push(u));
    const opened = await provider.open('real-big-paging', { window: { blocks: 20 } });
    assert.equal(opened.ok, true);

    const initial = updates[0].replace;
    assert.ok(initial.length <= 20);

    let cursor = initial[0]?.key;
    let totalOlder = 0;
    let hasMore = Boolean(cursor);
    let pages = 0;
    let lastArchiveOffset = Infinity;
    let reachedArchive = false;
    const PAGES_TO_WALK = 5;
    while (hasMore && pages < PAGES_TO_WALK) {
      const res = await provider.page('real-big-paging', { beforeBlockId: cursor, count: 30 });
      assert.equal(res.ok, true);
      pages += 1;
      if (!res.blocks.length) { hasMore = res.hasMore; continue; }
      totalOlder += res.blocks.length;
      const archiveOffsets = res.blocks
        .map((b) => (/^a(\d+)$/.exec(b.key) || [])[1])
        .filter(Boolean)
        .map(Number);
      if (archiveOffsets.length) {
        reachedArchive = true;
        assert.ok(archiveOffsets[archiveOffsets.length - 1] < lastArchiveOffset,
          'each archive page is strictly older (lower file offset) than the previous cursor');
        lastArchiveOffset = archiveOffsets[0];
      }
      cursor = res.blocks[0].key;
      hasMore = res.hasMore;
    }

    assert.ok(totalOlder > 0, 'paging recovered at least some older blocks from the real file');
    assert.ok(reachedArchive, 'paging walked past the live tail window into the independently-read prefix (archive) region');
    console.log(`[transcript-window] real 108MB file: recovered ${totalOlder} older blocks across ${pages} page() calls (hasMore=${hasMore})`);
  },
);

test(
  'windowed payload size vs the unwindowed default, measured against the real 108MB transcript',
  { skip: !REAL_BIG_FILE_PRESENT && 'real transcript store not present on this machine' },
  async (t) => {
    const unwindowed = createTranscriptProvider({ getSessionMeta: async () => ({ path: REAL_BIG_FILE }) });
    const uUpdates = [];
    unwindowed.emitter.on('update', (u) => uUpdates.push(u));
    await unwindowed.open('real-big-default');

    const windowed = createTranscriptProvider({ getSessionMeta: async () => ({ path: REAL_BIG_FILE }) });
    const wUpdates = [];
    windowed.emitter.on('update', (u) => wUpdates.push(u));
    await windowed.open('real-big-windowed', { window: { blocks: DEFAULT_WINDOW_BLOCKS } });

    t.after(() => { unwindowed.closeAll(); windowed.closeAll(); });

    const fullKB = Buffer.byteLength(JSON.stringify(uUpdates[0].replace), 'utf8') / 1024;
    const windowedKB = Buffer.byteLength(JSON.stringify(wUpdates[0].replace), 'utf8') / 1024;
    assert.ok(windowedKB <= fullKB, 'windowed payload must never exceed the unwindowed payload for the same file');
    console.log(`[transcript-window] real 108MB file: unwindowed=${fullKB.toFixed(1)}KB (${uUpdates[0].replace.length} blocks) vs windowed(${DEFAULT_WINDOW_BLOCKS})=${windowedKB.toFixed(1)}KB (${wUpdates[0].replace.length} blocks)`);
  },
);
