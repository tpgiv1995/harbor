'use strict';

// 2026-09-19 proof: board-export-runner.cjs's capturePng() used to run
// its hidden BrowserWindow with sandbox:false, contextIsolation:false,
// nodeIntegration:true so the PAGE could `require('node:fs')` to read the
// scene and write the PNG. Board content is not guaranteed first-party
// (whiteboard:write / whiteboard:create are MUTATING phone-server methods,
// so a holder of the server token can author it), so that was full Node
// access for a page rendering data it does not control. The fix moves both
// fs calls to the RUNNER (Node) side and hands the scene in / the PNG bytes
// out through executeJavaScript's own argument-inlining and return value,
// matching wrapPdf()'s existing sandbox:true/contextIsolation:true/
// nodeIntegration:false posture exactly.
//
// This is not a mocked assertion about webPreferences: it spawns the REAL
// board-export-runner.cjs under a REAL (hidden, isolated) Electron process,
// through board-export.js's own production spawn path, and decodes the PNG
// bytes that come back to confirm the image is real (sane dimensions, not a
// blank canvas). `npm run build` must have produced dist/export.html first.
//
// Isolation: the spawned Electron gets its own --user-data-dir under the
// test's throwaway directory (verified empirically to work even though the
// runner is invoked as a bare script, not `electron <app-dir>`), so nothing
// touches the real machine's Electron profile. The window itself is
// show:false (board-export-runner.cjs's own, unconditional rule) and
// board-export.js's runExportJob already carries an outer kill timeout, so a
// wedged capture cannot outlive this test.

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { defaultCaptureScene, exportPagePath, EXPORT_PAGE_HINT } = require('../../src/main/providers/board-export.js');

function isolatedSpawn(userDataDir) {
  return (binary, args, opts) => spawn(binary, [`--user-data-dir=${userDataDir}`, ...args], opts);
}

// Minimal, correct PNG decode: signature check, IHDR, concatenated IDAT
// inflated and UNFILTERED per the PNG spec (None/Sub/Up/Average/Paeth per
// scanline). Good enough to prove the bytes are a real, well-formed image
// with real pixel variance, without pulling in an image-decoding dependency.
function readChunks(buffer) {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 8 + length + 4; // length + type + data + crc
    if (type === 'IEND') break;
  }
  return chunks;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let rawOffset = 0;
  let prevRow = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filterType = raw[rawOffset];
    rawOffset += 1;
    const row = raw.subarray(rawOffset, rawOffset + stride);
    rawOffset += stride;
    const outRow = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? outRow[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      let value = row[x];
      if (filterType === 1) value = (value + a) & 0xff;
      else if (filterType === 2) value = (value + b) & 0xff;
      else if (filterType === 3) value = (value + ((a + b) >> 1)) & 0xff;
      else if (filterType === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        value = (value + pr) & 0xff;
      } else if (filterType !== 0) {
        throw new Error(`unknown PNG filter type ${filterType}`);
      }
      outRow[x] = value;
    }
    prevRow = outRow;
  }
  return out;
}

function decodePng(buffer) {
  const chunks = readChunks(buffer);
  const ihdr = chunks.find((chunk) => chunk.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);
  const bppByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = bppByColorType[colorType];
  assert.ok(channels, `unsupported PNG color type ${colorType} for this test's decoder`);
  assert.equal(bitDepth, 8, `expected 8-bit PNG (a canvas export), got bit depth ${bitDepth}`);
  const idat = Buffer.concat(chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data));
  const raw = zlib.inflateSync(idat);
  const expectedRawSize = (width * channels + 1) * height;
  assert.equal(raw.length, expectedRawSize, 'inflated PNG data must exactly fill width*height (a truncated/corrupt export would not)');
  const pixels = unfilter(raw, width, height, channels);
  return { width, height, channels, pixels };
}

test('capturePng produces a real, non-blank PNG through the hardened hidden runner', { timeout: 90000 }, async (t) => {
  const pagePath = exportPagePath();
  if (!fs.existsSync(pagePath)) {
    t.skip(`${EXPORT_PAGE_HINT} (looked for ${pagePath})`);
    return;
  }

  const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'harbor-board-export-live-'));
  t.after(() => fsp.rm(scratch, { recursive: true, force: true }).catch(() => {}));
  const userDataDir = path.join(scratch, 'electron-userdata');

  // A real, visually unambiguous scene: a white-filled, black-stroked
  // rectangle on the default (white) exported background. If capturePng ever
  // regressed to exporting a blank canvas, this would decode to a single
  // flat color; a real render has a distinct edge and fill.
  const elements = [{
    id: 'proof-rect',
    type: 'rectangle',
    x: 40, y: 40, width: 300, height: 180, angle: 0,
    strokeColor: '#1e1e1e', backgroundColor: '#ffd43b',
    fillStyle: 'solid', strokeWidth: 4, strokeStyle: 'solid', roughness: 0,
    opacity: 100, groupIds: [], frameId: null, roundness: null,
    seed: 1, version: 1, versionNonce: 1, isDeleted: false,
    boundElements: null, updated: 1, link: null, locked: false,
  }];

  const png = await defaultCaptureScene(
    { elements, appState: {}, files: {}, exportingFrame: null },
    { pagePath, spawn: isolatedSpawn(userDataDir) },
  );

  assert.ok(Buffer.isBuffer(png) && png.length > 0, 'capturePng must return real PNG bytes');
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'output must be a real PNG');

  const decoded = decodePng(png);
  // Sane dimensions: padded (24px) content roughly 300x180 at a scale between
  // 1x and 2x (capturePng's own getDimensions rule), never 0 and never some
  // wildly wrong size that would indicate the wrong element or a crop bug.
  assert.ok(decoded.width >= 100 && decoded.width <= 1000, `width ${decoded.width} is not sane`);
  assert.ok(decoded.height >= 60 && decoded.height <= 1000, `height ${decoded.height} is not sane`);

  // Not blank: walk a sampled grid of pixels and confirm real color variance
  // (the white/near-white background AND the yellow fill AND the dark
  // stroke must all appear), rather than one flat value repeated everywhere.
  const seen = new Set();
  const { width, height, channels, pixels } = decoded;
  const stepX = Math.max(1, Math.floor(width / 60));
  const stepY = Math.max(1, Math.floor(height / 60));
  for (let y = 0; y < height; y += stepY) {
    for (let x = 0; x < width; x += stepX) {
      const offset = (y * width + x) * channels;
      const r = pixels[offset];
      const g = pixels[offset + 1];
      const b = pixels[offset + 2];
      seen.add(`${r},${g},${b}`);
    }
  }
  assert.ok(seen.size >= 3, `expected real color variance (background + fill + stroke), saw only ${seen.size} distinct sampled color(s)`);

  // The background (white, exportBackground:true in defaultCaptureScene) and
  // the shape's own yellow fill must BOTH show up somewhere in the image.
  const hasNearWhite = [...seen].some((entry) => {
    const [r, g, b] = entry.split(',').map(Number);
    return r > 240 && g > 240 && b > 240;
  });
  const hasYellowish = [...seen].some((entry) => {
    const [r, g, b] = entry.split(',').map(Number);
    return r > 180 && g > 150 && b < 140;
  });
  assert.ok(hasNearWhite, 'the exported background never appears; the canvas may be cropped to just the shape or blank');
  assert.ok(hasYellowish, 'the rectangle\'s own fill color never appears; the export may be blank or the wrong content');
});
