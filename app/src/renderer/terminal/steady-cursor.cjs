'use strict';

// xterm's DOM renderer blinks the cursor with a looping CSS animation, and one
// looping animation composites the whole window at the display rate (see the
// note at the top of styles.css). `cursorBlink: false` alone does not hold: a
// program inside the pty can switch blinking on two ways, and xterm 5.5 obeys
// both by writing the option itself (InputHandler.ts):
//   DECSET 12    CSI ? 12 h    blinking on
//   DECSCUSR     CSI Ps SP q   cursor shape; an odd, zero or missing Ps blinks
// Each sequence is let through to xterm's own handler, so the shape change
// still lands, and the option is put back right after. CommonJS so the test
// requires it directly.
const DECSET_CURSOR_BLINK = 12;

function holdCursorSteady(term, defer = queueMicrotask) {
  const steady = () => { term.options.cursorBlink = false; };
  steady();
  const disposables = [
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.includes(DECSET_CURSOR_BLINK)) defer(steady);
      return false;
    }),
    term.parser.registerCsiHandler({ intermediates: ' ', final: 'q' }, () => {
      defer(steady);
      return false;
    }),
  ];
  return { dispose() { for (const d of disposables) d?.dispose?.(); } };
}

module.exports = { holdCursorSteady };
