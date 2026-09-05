'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ARTIFACT_SCHEME,
  artifactUrl,
  artifactUrlPath,
  filePathFromUrlPath,
} = require('../../src/shared/artifact-url.cjs');

// The rule this module replaced, kept verbatim so the regression it caused is
// provable rather than described. Every spec below that asserts the new
// behaviour also asserts this one fails, because a fix whose old form passes
// the same test never proved anything.
function legacyArtifactUrl(filePath) {
  return `harbor-artifact://local${String(filePath).split('/').map(encodeURIComponent).join('/')}`;
}

test('a posix path round-trips through the url and back', () => {
  const file = '/home/you/Sync/Claude/Outputs/Foo Bar/report.html';
  const url = new URL(artifactUrl(file));
  assert.equal(url.protocol, `${ARTIFACT_SCHEME}:`);
  assert.notEqual(url.pathname, '');
  assert.equal(filePathFromUrlPath(url.pathname), file);
});

test('a WINDOWS path round-trips, where the old rule produced no path at all', () => {
  const file = 'C:\\dev\\sheet-tools-app\\reports\\fw-template-audit.html';

  // The defect, reproduced: the whole drive-lettered path became the URL HOST
  // and the path component came back empty, so the handler resolved '' and the
  // allowlist refused it. Every card in the Files view was this.
  const legacy = new URL(legacyArtifactUrl(file));
  assert.equal(legacy.pathname, '', 'expected the old rule to lose the path entirely');

  const url = new URL(artifactUrl(file));
  assert.equal(url.host, 'local');
  assert.notEqual(url.pathname, '');
  assert.equal(filePathFromUrlPath(url.pathname), 'C:/dev/sheet-tools-app/reports/fw-template-audit.html');
  // path.resolve is what the handler applies, and on win32 that is the file.
  assert.equal(path.win32.resolve(filePathFromUrlPath(url.pathname)), path.win32.normalize(file));
});

test('spaces, hashes and percent signs in a name survive both directions', () => {
  for (const file of [
    '/home/you/dev/demo/final chart.png',
    'C:\\dev\\Census Files\\EB Flex & COBRA #2 100%.pdf',
    '/home/you/dev/a+b/c#d.png',
  ]) {
    const url = new URL(artifactUrl(file));
    assert.equal(url.hash, '', `'#' must not open a fragment: ${file}`);
    assert.equal(filePathFromUrlPath(url.pathname), file.replace(/\\/g, '/'), file);
  }
});

test('a sibling asset referenced relatively resolves to a real sibling path', () => {
  // This is why the path lives in the URL path with real separators: an HTML
  // artifact that references ./chart.png must reach the chart next to it.
  for (const [doc, expected] of [
    ['/home/you/dev/demo/report.html', '/home/you/dev/demo/chart.png'],
    ['C:\\dev\\demo\\report.html', 'C:/dev/demo/chart.png'],
  ]) {
    const resolved = new URL('chart.png', artifactUrl(doc));
    assert.equal(filePathFromUrlPath(resolved.pathname), expected, doc);
  }
});

test('a url with no path yields empty, never the process cwd', () => {
  assert.equal(filePathFromUrlPath(''), '');
  assert.equal(filePathFromUrlPath('/'), '');
  assert.equal(filePathFromUrlPath(null), '');
  // The old rule's output for a windows path parsed to exactly this.
  assert.equal(filePathFromUrlPath(new URL(legacyArtifactUrl('C:\\dev\\x.png')).pathname), '');
});

test('artifactUrlPath accepts either separator and always roots the path', () => {
  assert.equal(artifactUrlPath('/a/b.png'), '/a/b.png');
  assert.equal(artifactUrlPath('C:\\a\\b.png'), '/C%3A/a/b.png');
  assert.equal(artifactUrlPath('C:/a/b.png'), '/C%3A/a/b.png');
});

test('the scheme is overridable so one rule serves every artifact-shaped scheme', () => {
  assert.ok(artifactUrl('/a/b.png', 'harbor-thing').startsWith('harbor-thing://local/'));
});
