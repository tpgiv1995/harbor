#!/usr/bin/env node
'use strict';

// THE README HERO BANNER.
//
//   env -u DISPLAY -u WAYLAND_DISPLAY node scripts/make-hero.js
//
// Writes docs/hero.png: laid out at 1200x400, rendered at 2x, published at 1760
// wide, which is exactly 2x the 880px column GitHub gives a README image.
//
// Composed rather than generated. A model can draw a banner, but it cannot set
// a wordmark in the product's own typeface, place the product's own icon, or
// keep the three provider marks pixel-accurate, and a README banner that gets
// any of those slightly wrong reads as a mock-up of a product rather than the
// product. So the layout, the type (Schibsted Grotesk, the same family the app
// ships) and the marks are all real assets laid out in CSS; the only generated
// part is app/assets/hero-backdrop.jpg, a texture with no subject in it.
//
// app/assets/hero-backdrop.jpg was generated once, for this project, from this
// prompt, and is committed so the banner regenerates identically:
//
//   Extremely subtle abstract background texture for a software product
//   banner, ultra-wide 21:9. Deep near-black charcoal-navy base. Very faint
//   smoky gradients of muted steel blue drifting from the left, with a single
//   whisper of warm amber light low on the far left, like a distant lamp
//   diffusing through dark haze over water. Very low contrast. No focal point,
//   no objects, no stars, no horizon, no text, no logos, no people. Fine film
//   grain. Cinematic, restrained, editorial. The right two thirds are nearly
//   empty and almost black.
//
// The brief was "some type of hero image, but not too much / overstated", and
// the restraint is deliberate: no product mock-up, no gradient text, no
// superlatives, one accent colour, and the only claim on it is the one the
// README opens with. The provider marks are there because the single most
// common wrong impression of Harbor is that it is a Claude-only tool.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { renderHtmlToPng, dataUri } = require('./lib/render-html.cjs');

const APP_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(APP_ROOT, '..');
const ASSETS = path.join(APP_ROOT, 'assets');
const OUT = path.join(REPO_ROOT, 'docs', 'hero.png');
const LAYOUT = { width: 1200, height: 400 };
const SCALE = 2;
const PRESENT_WIDTH = 1760;

if (!process.env.HARBOR_SHOT_INNER && !process.env.HARBOR_SHOT_HEADED) {
  const result = spawnSync(
    'env',
    ['-u', 'DISPLAY', '-u', 'WAYLAND_DISPLAY', 'xvfb-run', '-a', '--server-args=-screen 0 2800x1200x24',
      process.execPath, __filename],
    { stdio: 'inherit', env: { ...process.env, HARBOR_SHOT_INNER: '1' }, cwd: APP_ROOT },
  );
  process.exit(result.status ?? 1);
}

function font(file, weight) {
  const data = fs.readFileSync(path.join(ASSETS, 'fonts', file)).toString('base64');
  return `@font-face{font-family:'Schibsted Grotesk';font-style:normal;font-weight:${weight};`
    + `src:url(data:font/ttf;base64,${data}) format('truetype');}`;
}

const PROVIDERS = [
  ['logo-claude.svg', 'Claude Code'],
  ['logo-openai.svg', 'Codex'],
  ['logo-cursor.svg', 'Cursor'],
];

// Nine lines, each of which is a thing Harbor actually does and the README
// describes further down. No superlatives and no feature that has to be
// qualified in a footnote: a banner is the one place a reader cannot check.
// Deliberately silent on platform, which the README's own table states honestly
// and which does not belong in three words on a masthead. Three columns of
// three, so a tenth line costs a whole row: cut before adding.
const CAPABILITIES = [
  'Up to sixteen windows on one stage',
  'One command bar drives the selected one',
  'A real terminal behind every window',
  'Prompts and questions answered in place',
  'Files your agents produced, rendered inline',
  'Orchestration queues and workers',
  'A phone client you host yourself',
  'Tasks, and a CLI agents drive on request',
  'Sessions running outside it, adopted on send',
];

function html() {
  return `<!doctype html><meta charset="utf-8">
<style>
${font('SchibstedGrotesk-Regular.ttf', 400)}
${font('SchibstedGrotesk-SemiBold.ttf', 600)}
  * { box-sizing: border-box; }
  html, body { margin: 0; width: ${LAYOUT.width}px; height: ${LAYOUT.height}px; overflow: hidden; }
  body {
    position: relative;
    background: #0b0d11;
    font-family: 'Schibsted Grotesk', ui-sans-serif, system-ui, sans-serif;
    color: #e8eaef;
    -webkit-font-smoothing: antialiased;
  }
  .bg {
    position: absolute; inset: 0;
    background-image: url("${dataUri(path.join(ASSETS, 'hero-backdrop.jpg'), 'image/jpeg')}");
    background-size: cover; background-position: 28% 55%;
    opacity: .92;
  }
  /* Keep the right side quiet so the provider column sits on near-black, and
     stop the texture ever competing with the wordmark. */
  .veil {
    position: absolute; inset: 0;
    background: linear-gradient(96deg, rgba(11,13,17,.30) 0%, rgba(11,13,17,.62) 44%, rgba(11,13,17,.92) 78%, #0b0d11 100%);
  }
  /* One hairline, warm at the harbour end and cool at the other, fading out
     before it reaches the edge so it reads as a rule and not as a progress bar. */
  .edge { position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
    background: linear-gradient(90deg, #d97757 0%, #8a7fd6 38%, #6ea8fe 62%, rgba(110,168,254,0) 100%); opacity: .75; }

  .wrap { position: relative; height: 100%; display: flex; flex-direction: column;
    justify-content: center; gap: 30px; padding: 0 66px 0 64px; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; }

  .lockup { display: flex; align-items: center; gap: 20px; }
  .lockup img { width: 74px; height: 74px; border-radius: 17px; display: block;
    box-shadow: 0 10px 30px rgba(0,0,0,.5); }
  .name { font-size: 52px; font-weight: 600; letter-spacing: -.028em; line-height: 1; }
  .tagline { margin-top: 20px; font-size: 20px; line-height: 1.45; color: #b3b9c6; }
  .meta { margin-top: 9px; font-size: 14.5px; color: #737b8a; letter-spacing: .005em; }

  .drives-label { font-size: 11px; letter-spacing: .17em; color: #5f6674; margin-bottom: 15px; }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
  .row span { font-size: 16px; color: #c2c8d4; }
  .row img { width: 21px; height: 21px; display: block; flex: none; }

  .caps { display: grid; grid-template-columns: 1fr 1fr 1fr; column-gap: 34px; row-gap: 11px;
    padding-top: 26px; border-top: 1px solid rgba(255,255,255,.07); }
  .cap { display: flex; align-items: baseline; gap: 10px; font-size: 14.5px; color: #949bab; }
  .cap i { width: 4px; height: 4px; border-radius: 50%; background: #6ea8fe; opacity: .8;
    flex: none; transform: translateY(-3px); }
</style>
<body>
  <div class="bg"></div><div class="veil"></div>
  <div class="wrap">
    <div class="top">
      <div>
        <div class="lockup">
          <img src="${dataUri(path.join(ASSETS, 'icon-512.png'))}" alt="">
          <div class="name">Harbor</div>
        </div>
        <div class="tagline">Run and monitor many coding-agent sessions at once.</div>
        <div class="meta">A desktop app, plus a phone client you host yourself.</div>
      </div>
      <div class="drives">
        <div class="drives-label">DRIVES</div>
        ${PROVIDERS.map(([file, label]) => `<div class="row"><img src="${dataUri(path.join(ASSETS, file))}" alt=""><span>${label}</span></div>`).join('')}
      </div>
    </div>
    <div class="caps">
      ${CAPABILITIES.map((text) => `<div class="cap"><i></i>${text}</div>`).join('')}
    </div>
  </div>
  <div class="edge"></div>
</body>`;
}

async function main() {
  // Rendered and scaled outside docs/, then copied in, so a failure between the
  // two cannot leave a half-published banner in the repository. Same rule as the
  // two capture scripts.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-hero-'));
  try {
    const staged = path.join(work, 'hero.png');
    await renderHtmlToPng({
      html: html(), width: LAYOUT.width, height: LAYOUT.height, scale: SCALE, out: staged,
    });
    const scaled = `${staged}.scaled.png`;
    const result = spawnSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', staged,
      '-vf', `scale=${PRESENT_WIDTH}:-1:flags=lanczos`, '-compression_level', '100', scaled,
    ]);
    if (result.status === 0 && fs.existsSync(scaled)) {
      fs.renameSync(scaled, staged);
      process.stdout.write(`scaled hero.png to ${PRESENT_WIDTH}px (${Math.round(fs.statSync(staged).size / 1024)}KB)\n`);
    } else {
      fs.rmSync(scaled, { force: true });
      process.stdout.write(`left hero.png at full size (ffmpeg: ${result.error?.code || result.status})\n`);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.copyFileSync(staged, OUT);
    process.stdout.write(`published ${OUT}\n`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`make-hero failed: ${error.message}\n`);
  process.exit(1);
});
