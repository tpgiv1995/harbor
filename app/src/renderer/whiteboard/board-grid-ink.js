// Excalidraw's line grid draws with two hard-coded pale greys (#dddddd bold, #e5e5e5
// regular) and relies on its dark theme's CSS filter to make them dark on a dark canvas.
// The Board runs the LIGHT theme on a dark canvas (the filter would flip every colour the
// user picked, see board-ink.cjs), so those greys would glare. There is no API for the grid
// colour, so the static board canvas's strokeStyle setter swaps exactly those two values for
// grid greys that suit a dark canvas.
//
// It is narrow on purpose: only the two exact values, only on a canvas inside an
// `.excalidraw` root that carries the `static` class, and only while the board canvas is
// dark. Exports render on detached canvases and never reach it. Nothing else in the page is
// affected and an element coloured a different grey is untouched.

const GRID_FROM_BOLD = '#dddddd';
const GRID_FROM_REGULAR = '#e5e5e5';
const GRID_TO_BOLD = '#2b3447';
const GRID_TO_REGULAR = '#1f2738';

let darkCanvas = true;
let installed = false;

export function setGridInkDark(dark) {
  darkCanvas = Boolean(dark);
}

export function installGridInk() {
  if (installed || typeof CanvasRenderingContext2D === 'undefined') return;
  const proto = CanvasRenderingContext2D.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'strokeStyle');
  if (!desc || !desc.get || !desc.set) return;
  installed = true;
  Object.defineProperty(proto, 'strokeStyle', {
    configurable: true,
    enumerable: desc.enumerable,
    get() { return desc.get.call(this); },
    set(value) {
      if (darkCanvas && (value === GRID_FROM_BOLD || value === GRID_FROM_REGULAR)) {
        const canvas = this.canvas;
        if (canvas && canvas.classList && canvas.classList.contains('static') && canvas.closest('.excalidraw')) {
          desc.set.call(this, value === GRID_FROM_BOLD ? GRID_TO_BOLD : GRID_TO_REGULAR);
          return;
        }
      }
      desc.set.call(this, value);
    },
  });
}
