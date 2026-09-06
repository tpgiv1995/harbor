'use strict';

// Thumbnails for the Artifacts grid, so every card shows a real preview
// (Pat, 2026-07-25: "so i see a preview of everything"). Images render
// themselves; this generates first-page/first-frame/rendered-page previews
// for the rest:
// - pdf: pdftoppm (poppler) first page
// - video: ffmpeg first frame
// - html: an offscreen Electron window loads the artifact through the same
//   allowlisted scheme the viewer uses and captures the paint (injected by
//   the composition root; this module never touches BrowserWindow itself)
//
// Everything is on demand (the renderer asks per card), serialized through a
// small queue, and cached on disk keyed by path+mtime, so a thumb is generated
// once per file version ever. Any failure returns null and the card keeps its
// glyph; a missing tool must never break the view.

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cache', 'harbor', 'artifact-thumbs');
const THUMB_WIDTH = 480;

function cacheKey(filePath, mtimeMs) {
  const hash = crypto.createHash('sha1').update(`${filePath}`).digest('hex').slice(0, 20);
  return `${hash}-${Math.round(mtimeMs)}.png`;
}

function createArtifactThumbs(options = {}) {
  // ENV OUTRANKS THE COMPOSED OPTION, deliberately, and this is not a style
  // choice. An env override is part of the ISOLATION SURFACE: it is how a
  // harness keeps a driven app out of the real cache. This module read
  // `options.cacheDir || env` until 2026-07-29, which is the exact inversion
  // that let an isolated e2e app write Pat's real artifacts index a day earlier
  // (artifacts.js had the same shape; the config-store refactor started passing
  // an explicit option at the composition root and silently deactivated the
  // escape, with no test failing until a spec happened to see real data).
  // Nothing passes cacheDir here yet, so this was a landmine rather than a live
  // bug, and it is being defused now because harborConfig.paths.cacheDir exists
  // and wiring it in is the obvious next change.
  const cacheDir = process.env.HARBOR_ARTIFACT_THUMBS_DIR
    || options.cacheDir
    || DEFAULT_CACHE_DIR;
  const execFile = options.execFile || require('node:child_process').execFile;
  const captureHtml = options.captureHtml || null; // async (filePath) => PNG Buffer | null
  const generators = {
    pdf: options.pdfGenerator || pdfThumb,
    video: options.videoGenerator || videoThumb,
    html: options.htmlGenerator || htmlThumb,
  };
  const inFlight = new Map();

  function run(cmd, args, timeoutMs = 20000) {
    return new Promise((resolve) => {
      execFile(cmd, args, { timeout: timeoutMs }, (error) => resolve(!error));
    });
  }

  async function pdfThumb(filePath, outPath) {
    // pdftoppm pads the page number by total page count, so render into a
    // scratch dir and take whatever single file it produced.
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'harbor-thumb-'));
    try {
      const ok = await run('pdftoppm', ['-png', '-f', '1', '-l', '1', '-scale-to', String(THUMB_WIDTH), filePath, path.join(scratch, 'p')]);
      if (!ok) return false;
      const produced = (await fs.readdir(scratch)).find((name) => name.endsWith('.png'));
      if (!produced) return false;
      await fs.copyFile(path.join(scratch, produced), outPath);
      return true;
    } finally {
      await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }

  async function videoThumb(filePath, outPath) {
    // 0.5s in skips fade-from-black openings; a clip shorter than that gets a
    // second try at the very first frame.
    if (await run('ffmpeg', ['-y', '-ss', '0.5', '-i', filePath, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, outPath])) {
      const stat = await fs.stat(outPath).catch(() => null);
      if (stat?.size) return true;
    }
    if (!(await run('ffmpeg', ['-y', '-i', filePath, '-frames:v', '1', '-vf', `scale=${THUMB_WIDTH}:-2`, outPath]))) return false;
    const stat = await fs.stat(outPath).catch(() => null);
    return Boolean(stat?.size);
  }

  async function htmlThumb(filePath, outPath) {
    if (!captureHtml) return false;
    const png = await captureHtml(filePath).catch(() => null);
    if (!png || !png.length) return false;
    await fs.writeFile(outPath, png);
    return true;
  }

  // Serialize generation: captures and converters are heavyweight, and the
  // renderer fires a burst of requests when a big list lands.
  let queue = Promise.resolve();

  async function generate(kind, filePath, outPath) {
    const generator = generators[kind];
    if (!generator) return false;
    await fs.mkdir(cacheDir, { recursive: true });
    return generator(filePath, outPath);
  }

  return {
    cacheDir,
    // Returns the cached thumb path for this exact file version, generating it
    // once if needed; null means "no preview", never an error.
    async thumbFor({ path: filePath, mtimeMs, kind }) {
      if (!filePath || !Number.isFinite(mtimeMs)) return null;
      const outPath = path.join(cacheDir, cacheKey(filePath, mtimeMs));
      const cached = await fs.stat(outPath).catch(() => null);
      if (cached?.size) return outPath;
      const key = outPath;
      if (!inFlight.has(key)) {
        const job = queue.then(async () => {
          try {
            return (await generate(kind, filePath, outPath)) ? outPath : null;
          } catch {
            return null;
          } finally {
            inFlight.delete(key);
          }
        });
        inFlight.set(key, job);
        queue = job.then(() => {}, () => {});
      }
      return inFlight.get(key);
    },
  };
}

module.exports = { createArtifactThumbs, cacheKey, THUMB_WIDTH };
