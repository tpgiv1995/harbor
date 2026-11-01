'use strict';
// Once the app's watcher sends the names it saw (noteChanged), an index pass
// re-checks only those transcripts and folders instead of listing every
// project folder and statting every transcript (2026-11-01: 4,064 folders and
// 8,638 transcripts per pass, in the desktop and again in the phone server).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryIndex } = require('../../src/main/providers/history-index.js');

const ID = (n) => `${String(n).repeat(8)}-2222-3333-4444-555555555555`.slice(0, 36);
const record = (text, cwd = 'C:\\dev\\thing') => `${JSON.stringify({
  type: 'user', timestamp: '2026-10-31T12:00:00.000Z', cwd,
  message: { role: 'user', content: [{ type: 'text', text }] },
})}\n`;

function fixture() {
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'hb-index-inc-'));
  const projectsDir = path.join(tmp, 'projects');
  const project = (name) => path.join(projectsDir, name);
  const transcript = (name, n) => path.join(project(name), `${ID(n)}.jsonl`);
  for (const [name, n, text] of [['C--dev-thing', 1, 'first'], ['C--dev-thing', 3, 'third'], ['C--dev-gone', 5, 'fifth']]) {
    fs.mkdirSync(project(name), { recursive: true });
    fs.writeFileSync(transcript(name, n), record(text));
  }
  const cacheDir = (label) => { const dir = path.join(tmp, `cache-${label}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
  return { projectsDir, project, transcript, cacheDir };
}

const fresh = (f, label) => createHistoryIndex({ projectsDir: f.projectsDir, cacheDir: f.cacheDir(label), refreshFloorMs: 0 }).refreshIndex();

test('reported adds, appends, deletes and folders give exactly what a full walk gives', () => {
  const f = fixture();
  const index = createHistoryIndex({ projectsDir: f.projectsDir, cacheDir: f.cacheDir('hinted'), refreshFloorMs: 0 });
  index.noteChanged([]);
  index.refreshIndex();

  fs.appendFileSync(f.transcript('C--dev-thing', 1), record('first, continued'));
  fs.writeFileSync(f.transcript('C--dev-thing', 2), record('second'));
  fs.rmSync(f.transcript('C--dev-thing', 3));
  fs.mkdirSync(f.project('C--dev-new'), { recursive: true });
  fs.writeFileSync(f.transcript('C--dev-new', 4), record('fourth', 'C:\\dev\\new'));
  fs.rmSync(f.project('C--dev-gone'), { recursive: true });
  index.noteChanged([
    path.join('C--dev-thing', `${ID(1)}.jsonl`),
    path.join('C--dev-thing', `${ID(2)}.jsonl`),
    path.join('C--dev-thing', `${ID(3)}.jsonl`),
    'C--dev-new',
    'C--dev-gone',
    path.join('C--dev-thing', ID(1), 'subagents', 'agent-x.jsonl'), // never listed
  ]);
  const incremental = index.refreshIndex();
  assert.deepStrictEqual(incremental, fresh(f, 'full'));
  assert.deepStrictEqual(Object.values(incremental).map((entry) => entry.id).sort(), [ID(1), ID(2), ID(4)].sort());
});

test('a pass with nothing reported lists no project folder and stats no transcript', () => {
  const f = fixture();
  let listings = 0; let stats = 0;
  const spy = { ...fs, readdirSync: (...a) => { if (String(a[0]).startsWith(f.projectsDir)) listings += 1; return fs.readdirSync(...a); }, statSync: (...a) => { if (String(a[0]).startsWith(f.projectsDir)) stats += 1; return fs.statSync(...a); } };
  const index = createHistoryIndex({ projectsDir: f.projectsDir, cacheDir: f.cacheDir('spy'), refreshFloorMs: 0, fs: spy });
  index.noteChanged([]);
  const first = index.refreshIndex();
  assert.ok(listings > 0 && stats > 0, 'the first pass walks');
  listings = 0; stats = 0;
  const second = index.refreshIndex();
  assert.strictEqual(listings, 0);
  assert.strictEqual(stats, 0);
  assert.deepStrictEqual(second, first);
});

test('an unreported transcript stays unseen until a nameless event forces a full walk', () => {
  const f = fixture();
  const index = createHistoryIndex({ projectsDir: f.projectsDir, cacheDir: f.cacheDir('nameless'), refreshFloorMs: 0 });
  index.noteChanged([]);
  index.refreshIndex();
  fs.writeFileSync(f.transcript('C--dev-thing', 6), record('sixth'));
  assert.ok(!Object.values(index.refreshIndex()).some((entry) => entry.id === ID(6)), 'hinted passes really skip unreported files');
  index.noteChanged([null]);
  const after = index.refreshIndex();
  assert.ok(Object.values(after).some((entry) => entry.id === ID(6)));
  assert.deepStrictEqual(after, fresh(f, 'after-null'));
});

test('without hints every pass is a full walk (the CLI picker and oracle comparisons)', () => {
  const f = fixture();
  const index = createHistoryIndex({ projectsDir: f.projectsDir, cacheDir: f.cacheDir('plain'), refreshFloorMs: 0 });
  index.refreshIndex();
  fs.writeFileSync(f.transcript('C--dev-thing', 7), record('seventh'));
  assert.ok(Object.values(index.refreshIndex()).some((entry) => entry.id === ID(7)));
});

test('a rebuild walks everything even while hinting', () => {
  const f = fixture();
  const index = createHistoryIndex({ projectsDir: f.projectsDir, cacheDir: f.cacheDir('rebuild'), refreshFloorMs: 0 });
  index.noteChanged([]);
  index.refreshIndex();
  fs.writeFileSync(f.transcript('C--dev-thing', 8), record('eighth'));
  assert.ok(Object.values(index.refreshIndex(true)).some((entry) => entry.id === ID(8)));
});
