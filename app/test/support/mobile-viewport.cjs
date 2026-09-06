'use strict';

// The one place the phone gate's viewport is decided.
//
// It used to be the literal `{ width: 430, height: 932 }` copied into a dozen
// specs and scripts. 932 is the DEVICE height of a 430pt iPhone, which is not
// what the app ever gets: Harbor's phone client runs as an installed PWA in
// standalone display mode, where the web view starts BELOW the status bar. On
// the Dynamic Island sizes that status bar is 59pt, so the app sees 873, and
// the 34pt home indicator strip lives INSIDE that as safe-area-inset-bottom
// rather than being subtracted from it.
//
//   932 device  −  59 status bar  =  873 app viewport
//                                    ( of which the last 34 are safe-area )
//
// That 59px error is not cosmetic: a gate that lays the app out 59px taller
// than the phone does can never see content pushed under the fold, which is
// most of what goes wrong on a phone.
//
// DERIVED, NOT DEVICE-MEASURED. Nobody has run a probe on the actual handset
// against this number (scripts/ios-device-probe.js can, over USB). So the
// gate deliberately does not stake everything on 873 being exactly right:
// SIZES below carries portrait, the device height, and landscape, and the
// layout assertions run against all of them. A layout that only works at one
// height is the bug this file exists to stop, so proving height-independence
// is worth more than pinning the perfect number.
const PORTRAIT = Object.freeze({ width: 430, height: 873 });

// Rotated. Chrome is far more expensive here (a fixed header and the composer
// eat a much larger share of 430px), which is exactly why it needs a case.
const LANDSCAPE = Object.freeze({ width: 932, height: 430 });

// The old assumption, kept ON PURPOSE as a third case rather than deleted: if
// the app is correct at 873 and at 932 it is not depending on either.
const DEVICE_FULL = Object.freeze({ width: 430, height: 932 });

const SIZES = Object.freeze([
  Object.freeze({ name: 'portrait', ...PORTRAIT }),
  Object.freeze({ name: 'device-full', ...DEVICE_FULL }),
  Object.freeze({ name: 'landscape', ...LANDSCAPE }),
]);

// The xvfb screen has to hold the widest and tallest case at once, or the
// browser silently clamps the viewport and the measurements become fiction.
const SCREEN = Object.freeze({
  width: Math.max(...SIZES.map((s) => s.width)),
  height: Math.max(...SIZES.map((s) => s.height)),
});

module.exports = { PORTRAIT, LANDSCAPE, DEVICE_FULL, SIZES, SCREEN };
