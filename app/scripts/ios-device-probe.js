#!/usr/bin/env node
'use strict';

// Evaluate JavaScript inside the real Harbor PWA on a USB-paired iPhone.
//
// iOS 12.2+ speaks WebKit's MULTI-TARGET protocol. A bare
// Runtime.evaluate fails with "'Runtime' domain was not found", so commands
// are wrapped in Target.sendMessageToTarget for the page target announced by
// Target.targetCreated. Replies arrive in Target.dispatchMessageFromTarget.

const WebSocket = require('ws');

const DEFAULT_WS = 'ws://127.0.0.1:9222/devtools/page/1';
const CONNECT_TIMEOUT_MS = 15_000;

const RECORDER_SOURCE = String.raw`(function () {
  if (window.__harborRec) window.__harborRec.stop();
  const t0 = Date.now();
  const trace = [];

  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      h: Math.round(r.height), w: Math.round(r.width),
      pos: cs.position,
      tf: cs.transform === 'none' ? 'none' : cs.transform,
      disp: cs.display,
      vis: cs.visibility,
    };
  };

  const snap = (label) => {
    const vv = window.visualViewport;
    trace.push({
      t: Date.now() - t0,
      ev: label,
      innerH: window.innerHeight,
      vvH: Math.round(vv.height),
      vvTop: Math.round(vv.offsetTop),
      vvScale: Number(vv.scale.toFixed(3)),
      scrollY: Math.round(window.scrollY),
      composer: rect('.composer'),
      textarea: rect('.composer textarea'),
      send: rect('.composer-send'),
      nav: rect('.shell-bottom-anchor'),
      shell: rect('.app-shell'),
      conv: rect('.conv'),
    });
    if (trace.length > 400) trace.shift();
  };

  const onVvResize = () => snap('visualViewport:resize');
  const onVvScroll = () => snap('visualViewport:scroll');
  const onFocusIn = (event) => snap('focusin:' + (event.target.tagName || '?'));
  const onFocusOut = (event) => snap('focusout:' + (event.target.tagName || '?'));

  window.visualViewport.addEventListener('resize', onVvResize);
  window.visualViewport.addEventListener('scroll', onVvScroll);
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('focusout', onFocusOut, true);

  window.__harborRec = {
    trace,
    stop() {
      window.visualViewport.removeEventListener('resize', onVvResize);
      window.visualViewport.removeEventListener('scroll', onVvScroll);
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
    },
  };
  snap('baseline');
  return 'recorder installed';
})()`;

function usage() {
  console.error(`Usage:
  node app/scripts/ios-device-probe.js --eval '<expression>'
  node app/scripts/ios-device-probe.js --install-recorder
  node app/scripts/ios-device-probe.js --read-trace

Set IOS_WS to override ${DEFAULT_WS}.`);
}

function parseArgs(argv) {
  if (argv.length === 2 && argv[0] === '--eval') return argv[1];
  if (argv.length === 1 && argv[0] === '--install-recorder') return RECORDER_SOURCE;
  if (argv.length === 1 && argv[0] === '--read-trace') {
    return 'window.__harborRec ? window.__harborRec.trace : null';
  }
  usage();
  process.exitCode = 2;
  return null;
}

function printValue(value) {
  if (typeof value === 'string') console.log(value);
  else if (value === undefined) console.log('undefined');
  else console.log(JSON.stringify(value, null, 2));
}

async function main() {
  const expression = parseArgs(process.argv.slice(2));
  if (expression === null) return;

  const wsUrl = process.env.IOS_WS || DEFAULT_WS;
  const socket = new WebSocket(wsUrl);
  let outerId = 0;
  let innerId = 0;
  let targetId = null;
  let finished = false;
  const pending = new Map();

  const fail = (message) => {
    if (finished) return;
    finished = true;
    process.exitCode = 1;
    console.error(`iOS device probe: ${message}`);
    for (const { reject } of pending.values()) reject(new Error(message));
    pending.clear();
    socket.close();
  };

  const guard = setTimeout(() => {
    fail(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s waiting for a Harbor page target at ${wsUrl}; check the USB pairing, Web Inspector, proxy, and that Harbor is open on the iPhone`);
  }, CONNECT_TIMEOUT_MS);

  const sendToTarget = (method, params = {}) => {
    const messageId = ++innerId;
    return new Promise((resolve, reject) => {
      pending.set(messageId, { resolve, reject });
      socket.send(JSON.stringify({
        id: ++outerId,
        method: 'Target.sendMessageToTarget',
        params: {
          targetId,
          message: JSON.stringify({ id: messageId, method, params }),
        },
      }));
    });
  };

  const run = async () => {
    try {
      await sendToTarget('Runtime.enable').catch(() => {});
      const result = await sendToTarget('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'evaluation failed');
      }
      finished = true;
      clearTimeout(guard);
      printValue(result?.result?.value);
      socket.close();
    } catch (error) {
      fail(`evaluation failed: ${error.message}`);
    }
  };

  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.method === 'Target.targetCreated' && !targetId) {
      const info = message.params?.targetInfo;
      if (info?.type === 'page') {
        targetId = info.targetId;
        run();
      }
      return;
    }
    if (message.method !== 'Target.dispatchMessageFromTarget') return;

    let inner;
    try { inner = JSON.parse(message.params.message); } catch { return; }
    if (!inner.id || !pending.has(inner.id)) return;
    const { resolve, reject } = pending.get(inner.id);
    pending.delete(inner.id);
    if (inner.error) reject(new Error(JSON.stringify(inner.error)));
    else resolve(inner.result);
  });

  socket.on('error', (error) => {
    fail(`cannot connect to ${wsUrl}: ${error.message}; is ios_webkit_debug_proxy running and is an iPhone paired?`);
  });
  socket.on('close', () => {
    clearTimeout(guard);
    if (!finished) fail(`connection to ${wsUrl} closed before a Harbor page target was available`);
  });
}

main().catch((error) => {
  console.error(`iOS device probe: ${error.message}`);
  process.exitCode = 1;
});
