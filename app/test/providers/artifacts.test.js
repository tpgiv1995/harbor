'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createArtifactsProvider,
  createServeAllowlist,
  extractCandidates,
  artifactKind,
  isExcluded,
} = require('../../src/main/providers/artifacts.js');

// THESE RUN ON EVERY PLATFORM, which is the whole point of them existing.
// The serve allowlist answering false for every artifact is what took the Files
// view down on Windows, and neither the old rule nor its old spec could be
// asked about a platform other than the host's — so the Linux gate, which is
// the only gate, could not have caught it even in principle. Driving the path
// flavour explicitly is the same correction project-label.cjs got on
// 2026-08-12; a `path.win32` case fails on a Linux runner against the old rule.
for (const [label, pathImpl, fixture] of [
  ['win32', path.win32, {
    report: 'C:\\dev\\out\\report.html',
    sibling: 'C:\\dev\\out\\chart.png',
    urlSpelling: 'C:/dev/out/report.html',
    outsider: 'C:\\Windows\\System32\\config\\SAM',
    traversal: 'C:\\dev\\out\\..\\..\\Windows\\System32\\config\\SAM',
  }],
  ['posix', path.posix, {
    report: '/home/you/out/report.html',
    sibling: '/home/you/out/chart.png',
    urlSpelling: '/home/you/out/report.html',
    outsider: '/etc/passwd',
    traversal: '/home/you/out/../../../etc/passwd',
  }],
]) {
  test(`serve allowlist: ${label} paths are allowed in every spelling of themselves`, () => {
    const allowlist = createServeAllowlist(pathImpl);
    allowlist.set([fixture.report]);

    // The indexed file, and the sibling assets an HTML artifact references.
    assert.equal(allowlist.allows(fixture.report), true, 'the indexed artifact');
    assert.equal(allowlist.allows(fixture.sibling), true, 'a sibling asset');
    // THE REGRESSION: a URL round trip hands the handler the '/' spelling, and
    // on win32 the old rule normalised that to backslashes and compared it
    // against a set holding something else, so this was false for everything.
    assert.equal(allowlist.allows(fixture.urlSpelling), true, 'the URL round-trip spelling');
  });

  test(`serve allowlist: ${label} refuses anything outside the indexed set`, () => {
    const allowlist = createServeAllowlist(pathImpl);
    allowlist.set([fixture.report]);
    assert.equal(allowlist.allows(fixture.outsider), false, 'an unrelated file');
    assert.equal(allowlist.allows(fixture.traversal), false, 'a traversal out of a served directory');
    assert.equal(allowlist.allows(''), false);
    assert.equal(allowlist.allows(null), false);
    assert.equal(allowlist.allows(`${fixture.report}\0.png`), false, 'a NUL-spliced path');
  });

  test(`serve allowlist: ${label} collapses the two spellings of one file`, () => {
    // The index keys on this, so a file named both ways in a transcript
    // produces ONE artifact rather than two cards on the same bytes.
    const allowlist = createServeAllowlist(pathImpl);
    assert.equal(allowlist.canonical(fixture.report), allowlist.canonical(fixture.urlSpelling));
  });
}

function line(obj) { return `${JSON.stringify(obj)}\n`; }

test('extractCandidates finds a Write file_path (JSON string, spaces allowed)', () => {
  const raw = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/home/you/Sync/Claude/Outputs/Foo Bar/report.html', content: 'x' } }] },
  });
  assert.deepEqual(extractCandidates(raw), ['/home/you/Sync/Claude/Outputs/Foo Bar/report.html']);
});

test('extractCandidates finds bare and single-quoted paths in Bash commands', () => {
  const raw = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "python3 render.py -o /tmp/out/chart.png && cp /tmp/out/chart.png '/home/you/dev/demo/final chart.png'" } }] },
  });
  const found = extractCandidates(raw);
  assert.ok(found.includes('/tmp/out/chart.png'));
  assert.ok(found.includes('/home/you/dev/demo/final chart.png'));
});

test('extractCandidates ignores base64 payloads and non-viewable extensions', () => {
  const b64 = 'aGVsbG8vd29ybGQ+cGF0aHMvZmFrZQ=='.repeat(20);
  const raw = JSON.stringify({ data: b64, other: '/home/you/dev/x/notes.txt' });
  assert.deepEqual(extractCandidates(raw), []);
});

test('exclusion rules: build output, VCS, caches, config homes, scratchpads', () => {
  for (const bad of [
    '/home/you/dev/harbor/app/dist/index.html',
    '/home/you/dev/harbor/node_modules/x/logo.svg',
    '/home/you/dev/harbor/.git/img.png',
    '/home/you/.cache/harbor/clipboard-images/shot.png',
    '/home/you/.claude/projects/x/img.png',
    '/tmp/claude-1000/x/scratchpad/probe.png',
  ]) {
    assert.equal(isExcluded(bad), true, bad);
  }
  assert.equal(isExcluded('/home/you/dev/demo/report.html'), false);
});

test('extractCandidates finds a WINDOWS Write file_path, spaces and all', () => {
  // The primary signal this module is built on, in the spelling a Windows host
  // records it. POSIX-only extraction found none of these, which is why the
  // Files view on Windows was showing an accidental subset of the real work.
  const raw = JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'C:\\dev\\Census Files\\report.html', content: 'x' } }] },
  });
  assert.deepEqual(extractCandidates(raw), ['C:\\dev\\Census Files\\report.html']);
});

test('extractCandidates finds windows paths embedded in a Bash command, both separators', () => {
  const raw = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'magick C:\\dev\\a\\chart.png -resize 50% C:/dev/a/out.png' } }] },
  });
  const found = extractCandidates(raw);
  assert.ok(found.includes('C:\\dev\\a\\chart.png'), `backslash form missing: ${JSON.stringify(found)}`);
  assert.ok(found.includes('C:/dev/a/out.png'), `forward-slash form missing: ${JSON.stringify(found)}`);
  // The forward-slash windows path also matches the POSIX bare regex from its
  // first '/', and that fragment must not survive as a second candidate.
  assert.ok(!found.includes('/dev/a/out.png'), `posix fragment leaked: ${JSON.stringify(found)}`);
});

test('extractCandidates finds a SINGLE-QUOTED spaced windows path in a shell command', () => {
  // The missing twin of the POSIX quoted shape (live-caught 2026-08-30): a
  // PowerShell delivery like Copy-Item 'C:\dev\Surveys\Exit Interviews\x.pdf'
  // yielded ZERO candidates, so the whole project never appeared in the Files
  // view. The quotes bound the path, so spaces are allowed.
  const raw = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "Copy-Item 'C:\\dev\\Surveys\\Exit Interviews\\Exit Interview Process Blueprint.pdf' 'C:\\dev\\out\\'" } }] },
  });
  assert.deepEqual(extractCandidates(raw), ['C:\\dev\\Surveys\\Exit Interviews\\Exit Interview Process Blueprint.pdf']);
});

test('extractCandidates finds the same quoted shape with forward slashes', () => {
  const raw = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "open 'C:/dev/Surveys/Exit Interviews/paragap-compare.png'" } }] },
  });
  const found = extractCandidates(raw);
  assert.ok(found.includes('C:/dev/Surveys/Exit Interviews/paragap-compare.png'), `forward-slash quoted form missing: ${JSON.stringify(found)}`);
});

test('extractCandidates finds a DOUBLE-QUOTED spaced windows path embedded in a command', () => {
  // Inside a JSON transcript line the embedded double quotes arrive escaped
  // (\" ... \"), which the whole-string WIN_JSON shape deliberately cannot
  // match. The escaped-quote form has to be its own shape.
  const raw = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'Copy-Item "C:\\dev\\Exit Interviews\\Blueprint Final.pdf" C:\\dev\\out' } }] },
  });
  assert.deepEqual(extractCandidates(raw), ['C:\\dev\\Exit Interviews\\Blueprint Final.pdf']);
});

test('a single-quoted windows path with no viewable extension yields nothing', () => {
  const raw = JSON.stringify({
    message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: "type 'C:\\dev\\Exit Interviews\\notes.txt'" } }] },
  });
  assert.deepEqual(extractCandidates(raw), []);
});

test('a windows session scratchpad is excluded, exactly like the posix one', () => {
  // Same rule, both spellings: a scratchpad holds throwaway probe renders.
  assert.equal(isExcluded('C:\\Users\\you\\AppData\\Local\\Temp\\claude\\C--dev-harbor\\9b33-2ba5\\scratchpad\\probe.png'), true);
  assert.equal(isExcluded('/tmp/claude-1000/x/scratchpad/probe.png'), true);
  // And the windows spelling of every other exclusion.
  assert.equal(isExcluded('C:\\dev\\harbor\\node_modules\\x\\logo.svg'), true);
  assert.equal(isExcluded('C:\\dev\\harbor\\app\\dist\\index.html'), true);
  assert.equal(isExcluded('C:\\Users\\you\\.claude\\projects\\x\\img.png'), true);
  // A real deliverable that merely lives on a drive is not excluded.
  assert.equal(isExcluded('C:\\dev\\demo\\report.html'), false);
});

test('artifactKind classifies extensions', () => {
  assert.equal(artifactKind('/a/b.html'), 'html');
  assert.equal(artifactKind('/a/b.PNG'), 'image');
  assert.equal(artifactKind('/a/b.pdf'), 'pdf');
  assert.equal(artifactKind('/a/b.mp4'), 'video');
  assert.equal(artifactKind('/a/b.txt'), null);
});

test('provider lists produced files, drops read-only mentions and dead paths, serves siblings', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-artifacts-'));
  const projectsRoot = path.join(tmp, 'projects');
  const projectDir = path.join(projectsRoot, '-home-you-dev-demo');
  fs.mkdirSync(projectDir, { recursive: true });
  const outDir = path.join(tmp, 'out');
  fs.mkdirSync(outDir, { recursive: true });

  const produced = path.join(outDir, 'report.html');
  fs.writeFileSync(produced, '<h1>report</h1>');
  const sibling = path.join(outDir, 'chart.png');
  fs.writeFileSync(sibling, 'png');
  const preExisting = path.join(outDir, 'old-photo.png');
  fs.writeFileSync(preExisting, 'old');
  const old = Date.now() / 1000 - 60 * 60 * 24 * 30;
  fs.utimesSync(preExisting, old, old);

  const sessionStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(projectDir, 'sess-abc.jsonl'), [
    line({ type: 'user', timestamp: sessionStart, cwd: '/home/you/dev/demo', message: { content: 'make me a report' } }),
    line({ type: 'assistant', timestamp: sessionStart, message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: produced, content: 'x' } }] } }),
    line({ type: 'assistant', timestamp: sessionStart, message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: preExisting } }] } }),
    line({ type: 'assistant', timestamp: sessionStart, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: `ls ${path.join(outDir, 'missing.png')}` } }] } }),
  ].join(''));

  const provider = createArtifactsProvider({
    roots: [projectsRoot],
    cacheFile: path.join(tmp, 'cache.json'),
  });
  const { ok, artifacts } = await provider.list();
  assert.equal(ok, true);
  assert.deepEqual(artifacts.map((a) => a.path), [produced]);
  assert.equal(artifacts[0].kind, 'html');
  assert.equal(artifacts[0].sessionId, 'sess-abc');
  assert.equal(artifacts[0].cwd, '/home/you/dev/demo');

  // Serve allowlist: the artifact, its sibling assets, nothing else.
  assert.equal(provider.isServable(produced), true);
  assert.equal(provider.isServable(sibling), true);
  assert.equal(provider.isServable('/etc/passwd'), false);
  assert.equal(provider.isServable(`${outDir}/../../etc/passwd`), false);

  // THE INVARIANT THE FILES VIEW RESTS ON: anything the provider lists, it
  // will also serve. Both halves were true on Linux and the second was false
  // for EVERY artifact on Windows (the index held the raw '/dev/x.png'
  // spelling; isServable compared a path.normalize'd '\dev\x.png'), so the
  // scheme 403'd every image, iframe and PDF and artifacts:thumb refused
  // before generating a single preview. State the contract, not one side.
  for (const artifact of artifacts) {
    assert.equal(provider.isServable(artifact.path), true, `listed but not servable: ${artifact.path}`);
    assert.equal(path.isAbsolute(artifact.path), true, `not absolute: ${artifact.path}`);
    assert.equal(artifact.path, path.resolve(artifact.path), `not canonical: ${artifact.path}`);
  }
  // Any equivalent spelling of an indexed path is servable, because both sides
  // canonicalize. A URL round-trip hands the handler the '/' spelling.
  assert.equal(provider.isServable(produced.replace(/\\/g, '/')), true);

  // Second list reuses the cache (transcript unchanged) and still verifies
  // existence fresh: deleting the artifact drops it.
  fs.rmSync(produced);
  const again = await provider.list();
  assert.deepEqual(again.artifacts, []);
});

test('a session that only READ an old image never claims it as output', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-artifacts-'));
  const projectsRoot = path.join(tmp, 'projects');
  const projectDir = path.join(projectsRoot, '-home-x');
  fs.mkdirSync(projectDir, { recursive: true });
  const oldImage = path.join(tmp, 'legacy.png');
  fs.writeFileSync(oldImage, 'x');
  const old = Date.now() / 1000 - 60 * 60 * 24 * 365;
  fs.utimesSync(oldImage, old, old);
  fs.writeFileSync(path.join(projectDir, 'sess-read.jsonl'), line({
    timestamp: new Date().toISOString(),
    cwd: '/home/x',
    message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: oldImage } }] },
  }));
  const provider = createArtifactsProvider({ roots: [projectsRoot], cacheFile: path.join(tmp, 'c.json') });
  const { artifacts } = await provider.list();
  assert.deepEqual(artifacts, []);
});

test('a warm disk cache serves instantly, with existence still fresh, and the parse refresh lands later', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-artifacts-'));
  const projectsRoot = path.join(tmp, 'projects');
  const projectDir = path.join(projectsRoot, '-home-x');
  fs.mkdirSync(projectDir, { recursive: true });
  const produced = path.join(tmp, 'made.html');
  fs.writeFileSync(produced, '<h1>x</h1>');
  const sessionStart = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const transcript = path.join(projectDir, 'sess-warm.jsonl');
  fs.writeFileSync(transcript, line({
    type: 'assistant', timestamp: sessionStart, cwd: '/home/x',
    message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: produced, content: 'x' } }] },
  }));
  const cacheFile = path.join(tmp, 'cache.json');

  const first = createArtifactsProvider({ roots: [projectsRoot], cacheFile });
  const seeded = await first.list();
  assert.deepEqual(seeded.artifacts.map((a) => a.path), [produced]);

  // Second provider over the SAME cache file, with the transcript DELETED: a
  // blocking re-parse would find nothing, so the artifact appearing on the
  // FIRST call proves the disk cache was served without waiting on a parse.
  fs.rmSync(transcript);
  let clock = Date.now();
  const second = createArtifactsProvider({ roots: [projectsRoot], cacheFile, now: () => clock });
  const served = await second.list();
  assert.deepEqual(served.artifacts.map((a) => a.path), [produced]);

  // Existence is verified fresh even on the stale path: delete the artifact
  // itself and the very next call drops it, no parse required.
  fs.rmSync(produced);
  const gone = await second.list();
  assert.deepEqual(gone.artifacts, []);

  // And the background refresh converges: past the staleness window, the
  // deleted transcript leaves the candidate set on the next collection, so a
  // recreated artifact file must NOT come back (its only mention is gone).
  fs.writeFileSync(produced, '<h1>back</h1>');
  clock += 61_000;
  const deadline = Date.now() + 5_000;
  let after = await second.list();
  while (after.artifacts.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    after = await second.list();
  }
  assert.deepEqual(after.artifacts, []);
});
