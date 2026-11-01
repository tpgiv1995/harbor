'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const React = require('react');
const { buildSync } = require('esbuild');

// Run the real component's sizing effect. Viewport and text box measurements
// are inputs here; the hidden browser drive separately proves the CSS layout.
// The box is an editable element (plain-text.cjs) that grows with its text, so
// the effect sets its max-height; composer.css makes it scroll past that.
for (const viewport of [844, 400]) for (const extras of [0, 100]) test(`composer caps a long draft at viewport ${viewport}, extra controls ${extras}`, () => {
  const effects = [], refs = []; const listeners = new Map();
  const node = { style: {}, scrollHeight: 280, closest: () => ({ querySelector: () => ({ scrollHeight: extras }) }) };
  const react = { ...React, useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
    useEffect: fn => effects.push(fn), useLayoutEffect: fn => effects.push(fn), useCallback: fn => fn };
  const globals = ['window', 'localStorage', 'ResizeObserver', 'getComputedStyle']; const prior = globals.map(k => [k, Object.getOwnPropertyDescriptor(globalThis, k)]);
  globalThis.window = { innerHeight: 844, visualViewport: { height: viewport, addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener() {} }, addEventListener() {}, removeEventListener() {} };
  globalThis.localStorage = { getItem: () => null };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.getComputedStyle = () => ({ paddingTop: '8', paddingBottom: '8' });
  try {
    const entry = path.resolve(__dirname, '../../web/src/composer/Composer.jsx');
    const code = buildSync({ entryPoints: [entry], bundle: true, external: ['*'], write: false, platform: 'node', format: 'cjs' }).outputFiles[0].text;
    const module = { exports: {} };
    const stubs = { useRpc: () => ({}), useSend: () => ({ queue: { count: 0 } }), useAttachments: () => ({ attachments: [] }), useCapabilities: () => ({ capabilities: {} }), useVoiceDraft: () => ({ voiceState: {} }), useSlashState: () => ({ chrome: {} }), useComposerLiveVoice: () => null, useQuestionReply: () => null,
      composerActions: () => ({ stop: false, sendReady: false }), hasDraft: () => false,
      readPlain: () => '', writePlain() {}, setSelectionOffsets() {} };
    new Function('require', 'module', 'exports', code)(id => id === 'react' ? react : stubs, module, module.exports);
    // The box ref is the first one that starts empty (the caret ref after it
    // does too); the others hold the session id.
    module.exports.Composer({ sessionId: 'toy' }); refs.find((ref) => ref.current === null).current = node;
    for (const effect of effects) effect();
    const cap = Math.max(44, Math.min(150, viewport * .4 - extras - 17));
    assert.ok(parseFloat(node.style.maxHeight) <= cap, `field cap ${node.style.maxHeight} exceeded ${cap}px`);
    assert.ok(parseFloat(node.style.maxHeight) >= Math.min(cap, 44), 'the cap is set, not left to the CSS default');
    window.visualViewport.height = 400;
    assert.equal(typeof listeners.get('resize'), 'function', 'keyboard opening must remeasure without another keystroke');
    listeners.get('resize')(); assert.ok(parseFloat(node.style.maxHeight) <= Math.max(44, Math.min(150, 160 - extras - 17)));
  } finally { for (const [key, descriptor] of prior) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } }
});
