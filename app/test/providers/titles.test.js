'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createTitlesProvider, discardTitleTranscript, scheduleTitler } = require('../../src/main/providers/titles.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-titles-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cacheDir = path.join(root, 'cache');
  const titlesFile = path.join(cacheDir, 'session-titles.json');
  const indexFile = path.join(cacheDir, 'index.json');
  fs.mkdirSync(cacheDir, { recursive: true });
  return { root, cacheDir, titlesFile, indexFile };
}

// Titles are minted by spawning the Claude Code CLI (so they bill Pat's plan,
// not the API console). Tests inject `runTitle` in place of that spawn: it
// receives the fully-assembled prompt and returns { text } or { error }, exactly
// what the real CLI wrapper returns. `claudeBin` is stubbed so run() clears its
// "is the CLI resolvable" gate without touching a real install.

test('worker sessions are refused while the same title drive succeeds for an ordinary session', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: {
      worker: { id: 'worker-id', mt: 2, last: '2026-08-04T12:00:00Z', first_prompt: 'BATCH TITLE: secret worker', recent: [] },
      ordinary: { id: 'ordinary-id', mt: 1, last: '2026-08-04T11:00:00Z', first_prompt: 'Port the title generator to Node', recent: [] },
    },
  }));
  const prompts = [];
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    claudeBin: 'stub-claude',
    now: () => new Date('2026-08-04T13:00:00Z'),
    runTitle: async (_bin, _mcp, prompt) => { prompts.push(prompt); return { text: 'Node Session Titles.' }; },
  });

  const result = await provider.run({ all: true });

  assert.equal(result.titled, 1, 'the allowed ordinary drive must reach the model and write a title');
  assert.equal(prompts.length, 1, 'only the ordinary session is titled; the worker is refused before any call');
  assert.match(prompts[0], /Port the title generator to Node/);
  assert.doesNotMatch(prompts[0], /secret worker/);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')), {
    v: 1,
    titles: { 'ordinary-id': 'Node Session Titles' },
    // The depth this title was minted at, so a later pass can tell a name taken
    // from the opening prompt alone from one that has seen the session.
    depths: { 'ordinary-id': 1 },
  });
});

test('a titler-child session (its own claude -p title call) is refused, so the titler never titles its own children', async (t) => {
  // bf8742e mints titles by spawning `claude -p`, and that child is a real
  // session whose transcript lands in the same project dir the titler scans;
  // its opening prompt is the titler's own SYSTEM instruction. Titling it spawns
  // another title call, ad infinitum (2026-08-24: 4,500 junk sessions in seven
  // hours). It must be refused before any call, exactly as a BATCH TITLE worker.
  const files = fixture(t);
  // A real title call, verbatim in shape: SYSTEM (which opens every title prompt)
  // followed by the session it was asked to name. Its unique inner text is the
  // tell that it was itself handed back to the titler.
  const titlerChildPrompt = [
    'You name terminal coding sessions, the way a good chat app names conversations.',
    "The user message contains the session's opening prompt between <session-opening-prompt> markers.",
    '\nTitle this session.\n<session-opening-prompt>\nCHILDONLY refactor the sessiond keeper\n</session-opening-prompt>',
  ].join(' ');
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: {
      child: { id: 'child-id', mt: 2, last: '2026-08-24T08:00:00Z', first_prompt: titlerChildPrompt, recent: [] },
      ordinary: { id: 'ordinary-id', mt: 1, last: '2026-08-24T07:00:00Z', first_prompt: 'ORDINARYONLY port the census mapper', recent: [] },
    },
  }));
  const prompts = [];
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    claudeBin: 'stub-claude',
    now: () => new Date('2026-08-24T09:00:00Z'),
    runTitle: async (_bin, _mcp, prompt) => { prompts.push(prompt); return { text: 'Port Census Mapper' }; },
  });

  const result = await provider.run({ all: true });

  assert.equal(result.titled, 1, 'only the ordinary session is titled; the titler child is refused');
  assert.equal(prompts.length, 1, 'the title call is never itself fed to the titler');
  assert.match(prompts[0], /ORDINARYONLY/u, 'the ordinary session is the one that reached the model');
  assert.doesNotMatch(prompts.join('\n'), /CHILDONLY/u, 'a title call must never itself be titled');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')).titles), ['ordinary-id']);
});

test('a title call deletes its own transcript by minted id, and leaves every real session alone', (t) => {
  // The titler mints the child session id, so it knows the one file the CLI
  // wrote and removes it the instant the title is captured. A real session that
  // happens to sit in the same project dir must never be touched.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-titles-discard-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const dirA = path.join(projects, 'C--dev-harbor-app');
  const dirB = path.join(projects, 'C--dev-census-mapper');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  const titleId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const realId = 'ffffffff-0000-1111-2222-333333333333';
  fs.writeFileSync(path.join(dirA, `${titleId}.jsonl`), '{"type":"user"}\n');
  fs.writeFileSync(path.join(dirB, `${realId}.jsonl`), '{"type":"user"}\n');

  const removed = discardTitleTranscript(fs, projects, titleId);

  assert.equal(removed, 1, 'exactly the title call transcript is removed');
  assert.equal(fs.existsSync(path.join(dirA, `${titleId}.jsonl`)), false, 'the title transcript is gone');
  assert.equal(fs.existsSync(path.join(dirB, `${realId}.jsonl`)), true, 'an unrelated real session survives');
});

test('discarding a title transcript is a safe no-op when nothing was written or the root is missing', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-titles-noop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  assert.equal(discardTitleTranscript(fs, projects, 'no-such-id'), 0, 'no matching transcript removes nothing');
  assert.equal(discardTitleTranscript(fs, path.join(root, 'absent'), 'x'), 0, 'a missing projects root does not throw');
});

test('a retryable title failure is retried once before the title is cached', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: { ordinary: { id: 'ordinary-id', mt: 1, last: '2026-08-04T11:00:00Z', first_prompt: 'Retry this title', recent: [] } },
  }));
  let attempts = 0;
  const waits = [];
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    claudeBin: 'stub-claude',
    sleep: async (ms) => waits.push(ms),
    runTitle: async () => {
      attempts += 1;
      if (attempts < 2) return { error: 'exit 1: transient CLI failure' };
      return { text: 'Recovered Title' };
    },
  });

  const result = await provider.run({ all: true });

  assert.equal(result.titled, 1);
  assert.equal(attempts, 2, 'a transient failure is retried exactly once');
  assert.deepEqual(waits, [1500]);
  // The empty MCP config is written so the real CLI spawn skips loading servers.
  assert.deepEqual(fs.readdirSync(files.cacheDir).sort(), ['index.json', 'session-titles.json', 'titler-mcp-empty.json']);
});

test('a login/auth failure is treated as fatal, not retried session by session', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: { ordinary: { id: 'ordinary-id', mt: 1, last: '2026-08-04T11:00:00Z', first_prompt: 'Needs a signed-in CLI', recent: [] } },
  }));
  let attempts = 0;
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    claudeBin: 'stub-claude',
    sleep: async () => {},
    runTitle: async () => { attempts += 1; return { error: 'Invalid API key / not logged in' }; },
  });

  await assert.rejects(provider.run({ all: true }), /not logged in/u);
  assert.equal(attempts, 1, 'an auth failure stops immediately rather than retrying');
});

test('HARBOR_NO_TITLER refuses the scheduler and the same scheduler runs when allowed', async () => {
  const scheduled = [];
  const run = async () => { scheduled.push('ran'); return { titled: 0 }; };
  const setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return 7; };

  const refused = scheduleTitler({ env: { HARBOR_NO_TITLER: '1' }, run, setTimeout });
  assert.equal(refused.scheduled, false);
  assert.deepEqual(scheduled, []);

  const allowed = scheduleTitler({ env: {}, run, setTimeout });
  assert.equal(allowed.scheduled, true);
  assert.equal(scheduled[0].delay, 15_000);
  await scheduled[0].callback();
  assert.deepEqual(scheduled.slice(1), ['ran']);
});

test('HARBOR_TITLER_FORCE refuses E2E by default and allows the same E2E drive when set', async () => {
  const scheduled = [];
  const setTimeout = (callback, delay) => { scheduled.push({ callback, delay }); return 8; };
  const run = async () => { scheduled.push('ran'); return { titled: 0 }; };

  const refused = scheduleTitler({ env: {}, e2eMode: true, run, setTimeout });
  assert.equal(refused.scheduled, false);
  assert.deepEqual(scheduled, []);

  const allowed = scheduleTitler({ env: { HARBOR_TITLER_FORCE: '1' }, e2eMode: true, run, setTimeout });
  assert.equal(allowed.scheduled, true);
  await scheduled[0].callback();
  assert.deepEqual(scheduled.slice(1), ['ran']);
});

test('HARBOR_TITLER_DELAY_MS refuses execution before its delay and allows it at the delay', async () => {
  let callback;
  let delay;
  let runs = 0;
  const scheduled = scheduleTitler({
    env: { HARBOR_TITLER_DELAY_MS: '2345' },
    run: async () => { runs += 1; return { titled: 0 }; },
    setTimeout: (next, ms) => { callback = next; delay = ms; return 9; },
  });

  assert.equal(scheduled.scheduled, true);
  assert.equal(delay, 2345);
  assert.equal(runs, 0, 'the drive must be refused before the configured delay');
  await callback();
  assert.equal(runs, 1, 'the same drive must run when the configured delay elapses');
});

// ---------------------------------------------------------------------------
// A session is named twice: once from its opening prompt, once more when the
// session has actually gone somewhere. See MATURE_DEPTH in titles.js.
// ---------------------------------------------------------------------------

function titleDrive(files, replies, overrides = {}) {
  const prompts = [];
  let n = 0;
  const provider = createTitlesProvider({
    cacheDir: files.cacheDir,
    titlesFile: files.titlesFile,
    claudeBin: 'stub-claude',
    now: () => new Date('2026-08-12T13:00:00Z'),
    runTitle: async (_bin, _mcp, prompt) => {
      prompts.push(prompt);
      const text = replies[Math.min(n, replies.length - 1)];
      n += 1;
      return { text };
    },
    ...overrides,
  });
  return { provider, prompts };
}

function writeIndex(files, entry) {
  fs.writeFileSync(files.indexFile, JSON.stringify({
    v: 2,
    files: { only: { id: 'sid', mt: 1, last: '2026-08-12T12:00:00Z', ...entry } },
  }));
}

// Two-sided ON PURPOSE. Re-naming has to HAPPEN when the session grows, and it
// has to STOP: a rail row that renames itself on every pass cannot be found
// from memory, which is the whole job of the title.
test('a session named from its opening prompt is renamed once it has gone somewhere, then left alone', async (t) => {
  const files = fixture(t);
  writeIndex(files, { first_prompt: 'the build is broken', recent: [] });
  const first = titleDrive(files, ['Investigate Broken Build']);
  assert.equal((await first.provider.run({ all: true })).titled, 1);
  assert.equal(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')).titles.sid, 'Investigate Broken Build');

  // The same session, three prompts later: the work turned out to be something
  // the opening line never mentioned.
  writeIndex(files, {
    first_prompt: 'the build is broken',
    recent: ['it is the windows path separator', 'port the launcher argv', 'add a regression test'],
  });
  const second = titleDrive(files, ['Fix Windows Launcher Path Handling']);
  const result = await second.provider.run({ all: true });

  assert.equal(result.titled, 1);
  assert.equal(result.renamed, 1, 'this replaced a name rather than minting a new one');
  assert.match(second.prompts[0], /windows path separator/u, 'the later prompts must reach the model');
  const sidecar = JSON.parse(fs.readFileSync(files.titlesFile, 'utf8'));
  assert.equal(sidecar.titles.sid, 'Fix Windows Launcher Path Handling');
  assert.equal(sidecar.depths.sid, 4);

  // Third pass, nothing new to learn: it must not spend another call.
  const third = titleDrive(files, ['Some Third Name']);
  assert.equal((await third.provider.run({ all: true })).titled, 0);
  assert.equal(third.prompts.length, 0, 'a matured title is final');
  assert.equal(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')).titles.sid, 'Fix Windows Launcher Path Handling');
});

test('a title from a sidecar written before depths existed is treated as opening-prompt-only', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.titlesFile, JSON.stringify({ v: 1, titles: { sid: 'Old Shallow Name' } }));
  writeIndex(files, {
    first_prompt: 'look at this',
    recent: ['actually the census mapper is dropping rows', 'and the totals are off by one'],
  });
  const drive = titleDrive(files, ['Fix Census Mapper Row Drop']);

  const result = await drive.provider.run({ all: true });

  assert.equal(result.renamed, 1, 'an undepthed title is exactly the shallow case this feature exists for');
  assert.equal(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')).titles.sid, 'Fix Census Mapper Row Drop');
});

test('a resumed session whose tail repeats its opening request is not growth, and buys no second title', async (t) => {
  const files = fixture(t);
  fs.writeFileSync(files.titlesFile, JSON.stringify({ v: 1, titles: { sid: 'Existing Name' }, depths: { sid: 1 } }));
  writeIndex(files, { first_prompt: 'run the gate', recent: ['run the gate', '  RUN THE GATE  '] });
  const drive = titleDrive(files, ['Should Not Happen']);

  assert.equal((await drive.provider.run({ all: true })).titled, 0);
  assert.equal(drive.prompts.length, 0);
});

test('an untitled session still gets its first name, and later prompts are deduped into its context', async (t) => {
  const files = fixture(t);
  writeIndex(files, { first_prompt: 'set up the legion', recent: ['set up the legion', 'now the icons'] });
  const drive = titleDrive(files, ['Set Up Legion Machine']);

  const result = await drive.provider.run({ all: true });

  assert.equal(result.titled, 1);
  assert.equal(result.renamed, 0);
  const context = drive.prompts[0];
  assert.match(context, /now the icons/u);
  assert.equal(context.match(/set up the legion/giu).length, 1, 'the opener must not be repeated back as a later prompt');
  assert.equal(JSON.parse(fs.readFileSync(files.titlesFile, 'utf8')).depths.sid, 2);
});
