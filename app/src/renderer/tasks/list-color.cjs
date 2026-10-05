'use strict';

// Colour helpers shared by the list picker and by every surface that draws a
// list dot. Pure and dependency-free so the desktop renderer, the mobile
// client and the Node test runner all get identical answers.
//
// A list's colour is now STORED (tasks-model `list.color`). It used to be a
// hash of the list NAME, which meant it was not the user's to choose and
// changed under them on rename. resolveListColor keeps that hash as the
// fallback so every list that predates the field keeps the colour it already
// had on screen.

// The Slate list palette. Same saturation/lightness family as the project
// colours, so a list reads as "a list colour", never as a status.
const LIST_SWATCHES = Object.freeze([
  '#8b9bff', // periwinkle
  '#4ec9b6', // teal
  '#d884c8', // orchid
  '#e0b45c', // amber
  '#6fb0e0', // sky
  '#9ccc8a', // sage
  '#e09a8a', // coral
  '#74b6c6', // slate cyan
]);

function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

/** h 0-359, s/l 0-100 -> #rrggbb */
function hslToHex(h, s, l) {
  const hue = ((Number(h) % 360) + 360) % 360;
  const sat = clamp(Number(s), 0, 100) / 100;
  const lig = clamp(Number(l), 0, 100) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
      : hue < 180 ? [0, c, x]
        : hue < 240 ? [0, x, c]
          : hue < 300 ? [x, 0, c]
            : [c, 0, x];
  const hex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** #rgb or #rrggbb -> { h, s, l }, or null when it is not a colour. */
function hexToHsl(value) {
  if (typeof value !== 'string') return null;
  let raw = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(raw)) raw = raw.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(raw)) return null;
  const r = parseInt(raw.slice(0, 2), 16) / 255;
  const g = parseInt(raw.slice(2, 4), 16) / 255;
  const b = parseInt(raw.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: Math.round(l * 100) };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: Math.round(((h * 60) % 360 + 360) % 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * The one rule for what colour a list draws. Stored colour wins; otherwise the
 * legacy name hash, so nothing changes appearance until the user chooses.
 */
function resolveListColor(list, fallback) {
  const stored = list && typeof list === 'object' ? list.color : null;
  if (typeof stored === 'string' && /^#[0-9a-f]{6}$/i.test(stored)) return stored.toLowerCase();
  return typeof fallback === 'function' ? fallback(list?.name) : fallback;
}

module.exports = { LIST_SWATCHES, hslToHex, hexToHsl, resolveListColor };
