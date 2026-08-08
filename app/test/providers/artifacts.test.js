'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createArtifactsProvider,
  extractCandidates,
  artifactKind,
  isExcluded,
} = require('../../src/main/providers/artifacts.js');

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
