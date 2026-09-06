'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../../src/renderer', rel), 'utf8');

// 2026-09-06 renderer OOM (0xE0000008 every 3-4h): the heap snapshot held
// ~2000 copies of the sidebar model, reachable only through the chain of V8
// closure contexts that React's useCallback builds across renders of the root
// App (every memoized callback keeps its render's context; that context's
// slots hold older memoized callbacks; and so on back to boot). The fix is a
// trampoline useCallback whose memoized function holds a ref and nothing else.
// The behavioural proof is scripts/drive-render-leak-win.js (1648KB retained
// per model push at pre-fix HEAD, 2KB with the swap); these pins keep the
// swap from being "simplified" back to the react import.
test('the root App takes useCallback from the unchained hook, never from react', () => {
  const src = read('index.jsx');
  assert.match(src, /import \{ useCallback \} from '\.\/use-callback\.js';/);
  const reactImport = src.match(/import React, \{([^}]*)\} from 'react';/);
  assert.ok(reactImport, 'React named import present');
  assert.doesNotMatch(reactImport[1], /\buseCallback\b/);
});

test('the unchained useCallback memoizes a trampoline over a ref on the same deps', () => {
  const src = read('use-callback.js');
  assert.match(src, /export function useCallback\(fn, deps\)/);
  assert.match(src, /const latest = useRef\(fn\);\s*\n\s*latest\.current = fn;/);
  assert.match(src, /return useMemo\(\(\) => \(\.\.\.args\) => latest\.current\(\.\.\.args\), deps\);/);
  // Nothing from the caller's render may be captured by the memoized function.
  assert.doesNotMatch(src, /useMemo\(\(\) => fn\b/);
});
