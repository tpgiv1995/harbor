'use strict';

// THE PUBLISHED-SCREENSHOT CORPUS, shared by the desktop and phone captures.
//
// Every project, session, file, task and orchestration batch below was invented
// for these captures. None of it exists outside the run: the capture scripts
// build it into a scratch directory, point a fully isolated Harbor (its own
// config, caches, session store, daemon and HOME) at it, take the pictures, and
// delete it.
//
// It lives in one module because the desktop app and the phone client have to
// photograph THE SAME corpus. Two copies drift, and a README whose phone shot
// shows different projects from its desktop shot is quietly telling the reader
// that one of them is staged.
//
// FIVE THINGS THIS FILE EXISTS TO REMEMBER, each of which cost a capture.
//
// 1. NO ABSOLUTE PATH MAY BE VISIBLE, because the author's home directory is in
//    every one of them. The first multi-provider capture put
//    `/home/<user>/dev/harbor/app/verify/shot/...` into three conversation
//    windows and across the top of the Orch panel, in prose the corpus itself
//    had written. So: the corpus lives at a root with no identity in it
//    (DEFAULT_ROOT below), prose names files by BASENAME only, and the absolute
//    path an artifact needs in order to be discovered is carried on a tool
//    input, which Harbor renders as a basename chip. The capture then ASSERTS
//    that no rendered text contains the real home, because a rule nobody checks
//    is a rule that comes back.
//
// 2. THE CORPUS MUST NOT LIVE UNDER A TEMP ROOT. The rail came up EMPTY for a
//    long time while the conversation windows rendered from the same corpus
//    perfectly, which looked like an indexing bug and is not one:
//    `isScratchSession` in shared/sidebar-model hides any session whose cwd is
//    under /tmp, /var/tmp or the macOS equivalents, because a throwaway
//    directory is not a project. The app was right; the harness had picked
//    exactly the path the app is designed to hide. /dev/shm is a real writable
//    directory with no username in it and is not on that list.
//
// 3. ISOLATING HOME IS REQUIRED, AND IT IS ALSO WHAT MAKES CODEX AND CURSOR
//    POSSIBLE. `provider-history.js` scans ~/.codex/sessions and
//    ~/.cursor/projects from os.homedir(), so without an isolated HOME the rail
//    filled with the real machine's sessions, including real client names. The
//    same fact is the reason this file can PLANT codex and cursor sessions: it
//    writes them into the fixture HOME, in the exact store layout each provider
//    uses, and the real scanner finds them the way it finds real ones.
//
// 4. ARTIFACTS ROOTS ARE TRANSCRIPT ROOTS, NOT OUTPUT DIRECTORIES.
//    `HARBOR_ARTIFACTS_ROOTS` is where artifacts.js looks for `*.jsonl` to read
//    filenames out of; pointing it at the directory holding the artifact FILES
//    finds no transcripts at all, so the Files view was honestly empty and the
//    capture skipped its own screenshot for weeks. It is also why every artifact
//    in this corpus is written by a CLAUDE session: artifacts.js scans the
//    claude transcript store only, so a file produced by a codex or cursor
//    session would be named in a transcript the scan never reads, and the
//    picture would promise a card that the product does not draw.
//
// 5. AN ARTIFACT NEEDS BOTH HALVES. A file counts when a recent transcript
//    NAMES it and it EXISTS with an mtime no older than the naming session's
//    start. Writing the file without mentioning it, or mentioning it without
//    writing it, produces an empty view rather than an error.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOUR = 3600_000;
const MINUTE = 60_000;

// A real directory, writable without privileges, with no username anywhere in
// it, and not on the scratch list. See note 1 and note 2 in the header.
const DEFAULT_ROOT = '/dev/shm/harbor-demo';

// ---------------------------------------------------------------------------
// The conversations.
//
// Ordinary-looking open-source work on three invented projects, across all
// three providers Harbor drives. Order matters: the capture opens windows in
// this order, and the first four are deliberately claude / codex / cursor /
// claude so that no picture of the stage can show a single-vendor tool.
//
// `ends` decides whether a session reads as working or idle, which is a fact
// about the transcript and not a decoration: 'working' leaves a tool call
// without its result (or, for codex, an exec without its output), which is
// exactly the state a session is in mid-turn.
//
// {OUT} is the session's own out/ directory, substituted only into TOOL inputs.
// ---------------------------------------------------------------------------

const SESSIONS = [
  {
    key: 'release-workflow',
    provider: 'claude',
    dir: 'demo/harbor',
    title: 'Wire the release workflow',
    model: 'claude-opus-5',
    ends: 'idle',
    blocks: [
      ['user', 'The tagged build produces installers but nothing publishes them. Wire the release step and tell me what it will and will not do.'],
      ['assistant', 'The workflow builds on all three runners and uploads to the run\'s artifact tab, which is not a distribution channel: downloading one means knowing a tag was pushed, finding the run, and being signed in.\n\nI have attached the installers to a draft release instead, so a maintainer publishes deliberately. Unsigned binaries should not go public on a tag push alone.'],
      ['edit', {
        file: '.github/workflows/build.yml',
        old: '      - uses: actions/upload-artifact@v4\n        with:\n          path: dist/*',
        new: '      - uses: softprops/action-gh-release@v2\n        with:\n          draft: true\n          files: dist/*',
      }],
      ['assistant', 'One caveat worth stating in the release notes rather than leaving to be discovered: nothing here is code-signed, so SmartScreen and Gatekeeper will both warn. I have written the accept-the-warning steps out per platform.'],
      ['write', { file: '{OUT}/release-checklist.pdf', lines: 34 }],
      ['assistant', 'release-checklist.pdf ends on the one step nobody can automate: a human decides the draft becomes a release.'],
    ],
  },
  {
    key: 'shared-cache',
    provider: 'codex',
    dir: 'demo/notes-api',
    title: 'Port the rate limiter onto the shared cache',
    model: 'gpt-5.6-sol',
    ends: 'working',
    blocks: [
      ['user', 'Move the limiter off the per-process map and onto the shared cache, then show me what breaks under two workers.'],
      ['assistant', 'The per-process map made each worker enforce the limit on its own, so N workers allowed N times the configured rate. That is not a tuning problem, it is the wrong denominator.\n\nThe counter now lives in the shared cache under a per-client key with the window in the key itself, so an expiring window needs no sweep.'],
      ['exec', 'npm test -- limiter --workers 2'],
      ['assistant', 'Two workers now agree. The test that would have caught the original asserts the TOTAL across workers rather than each worker\'s own count, which is the assertion a single-process suite could never make.'],
      ['exec', 'npm test -- limiter --workers 8'],
      ['assistant', 'Eight workers agree too, which is the part worth checking: the key is the client and the window, not the worker, so the count does not care how many of them there are.\n\nOne behaviour changed and it should be written down rather than discovered. A client whose window expires mid-request now refills from the cache rather than from a local timer, so the first request of a new window can take one extra round trip.'],
      ['exec', 'node bench/limiter.js --compare main'],
    ],
  },
  {
    key: 'nav-breakpoints',
    provider: 'cursor',
    dir: 'demo/site',
    title: 'Tighten the mobile nav breakpoints',
    model: 'composer-1',
    ends: 'idle',
    blocks: [
      ['user', 'The nav collapses too late. Between 700 and 820 it overlaps the logo.'],
      ['assistant', 'The breakpoint was picked from a design width rather than measured from the content: the nav needs 812px before it can sit beside a 168px logo, so every width under that overlapped and 768 only happened to look fine on one machine.'],
      ['shell', 'rg -n "min-width: 768" src/styles'],
      ['assistant', 'Three rules shared that number and only one of them was about the nav. I have moved the nav to a container query on its own row, so it collapses when IT runs out of room rather than when the viewport crosses a number somebody typed.'],
      ['grep', { pattern: '@container', path: 'src/styles/nav.css' }],
      ['assistant', 'Measured across 320 to 1440 in 4px steps: 281 widths checked, no overlap anywhere.'],
    ],
  },
  {
    key: 'rate-limiter',
    provider: 'claude',
    dir: 'demo/notes-api',
    title: 'Rate limiter drops the first request',
    model: 'claude-opus-5',
    ends: 'working',
    blocks: [
      ['user', 'The rate limiter rejects the very first request from a new client. Only sometimes.'],
      ['assistant', 'Reproduced it: the bucket is created with zero tokens and refilled on a timer, so a request arriving before the first tick sees an empty bucket. "Sometimes" is whether you arrive inside the first interval.'],
      ['write', { file: '{OUT}/latency-p95.svg', lines: 41 }],
      ['assistant', 'Buckets now start full and refill from there, and latency-p95.svg plots before and after at each percentile: the fix costs nothing above p50, it only removes the cliff at the start of a window.\n\nRunning the suite that would have caught it, which asserts the first request of a brand-new client.'],
      ['bash', 'npm test -- limiter'],
    ],
  },
  {
    key: 'dark-mode',
    provider: 'claude',
    dir: 'demo/site',
    title: 'Dark mode reads wrong on system default',
    model: 'claude-opus-5',
    ends: 'idle',
    blocks: [
      ['user', 'Dark mode is fine when you pick it, wrong when the OS picks it.'],
      ['assistant', 'The palette only exists inside the media query, so with no explicit choice the tokens fall back to whatever the host paints. Defining the light palette on bare :root and overriding under the query fixes both paths.'],
      ['write', { file: '{OUT}/palette-preview.html', lines: 28 }],
      ['assistant', 'palette-preview.html puts the three states side by side (explicit light, explicit dark, system default) so they can be compared without toggling the OS.'],
      ['write', { file: '{OUT}/contrast-audit.svg', lines: 36 }],
      ['assistant', 'contrast-audit.svg is the same tokens measured against WCAG. Two pairs failed AA in the old dark palette and both were text on a raised surface, which is the combination the media query never defined.'],
      // A render, not a Write: "Wrote theme-transition.mp4 - 2 lines" is what a
      // Write block says about a video, and it is nonsense. The command stays
      // relative so no absolute path is drawn; the absolute path an artifact
      // needs in order to be discovered rides on the tool RESULT, which Harbor
      // does not render.
      ['bash', {
        command: 'ffmpeg -y -framerate 25 -i frames/%03d.png -crf 24 out/theme-transition.mp4',
        result: 'wrote {OUT}/theme-transition.mp4 (4.6s, 26 KB)',
      }],
      ['assistant', 'theme-transition.mp4 is the same page crossfading between the two palettes, which is easier to review than two screenshots side by side when what you are checking is whether anything jumps.'],
    ],
  },
  {
    key: 'fixtures',
    provider: 'claude',
    dir: 'demo/notes-api',
    title: 'Migrate the fixtures',
    model: 'claude-opus-5',
    ends: 'idle',
    blocks: [
      ['user', 'Move the fixtures off the shared database.'],
      ['assistant', 'Done. Each suite now builds its own, so a run cannot depend on what another one left behind.'],
      ['write', { file: '{OUT}/coverage-report.html', lines: 52 }],
      ['assistant', 'coverage-report.html is the run after the split. Coverage moved by a tenth of a point, which is the honest answer: isolated fixtures make the suite trustworthy, not larger.'],
    ],
  },
];

// Which session writes which artifact, and what goes in it. Authored rather
// than screenshotted: an SVG is exact at any size and needs no generator, and
// the two HTML pages are what the Files view's offscreen thumbnailer renders.
// One artifact of every kind the Files view can render, because the view draws
// a filter chip per kind and a greyed-out Video chip beside a caption that
// claims video renders inline reads as "video does not work".
const ARTIFACTS = [
  { session: 'release-workflow', name: 'release-checklist.pdf', kind: 'typst' },
  { session: 'rate-limiter', name: 'latency-p95.svg', kind: 'svg' },
  { session: 'fixtures', name: 'coverage-report.html', kind: 'html' },
  { session: 'dark-mode', name: 'palette-preview.html', kind: 'html' },
  { session: 'dark-mode', name: 'contrast-audit.svg', kind: 'svg' },
  { session: 'dark-mode', name: 'theme-transition.mp4', kind: 'video' },
];

const PALETTE_HTML = `<!doctype html><meta charset="utf-8"><title>Palette preview</title>
<style>
 :root{--bg:#ffffff;--fg:#14161a;--muted:#5c6370;--card:#f3f4f6;--line:#e3e5e9;--accent:#3b82f6}
 @media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0f13;--fg:#e8e9ec;--muted:#8b909a;--card:#171a20;--line:#242832;--accent:#6ea8fe}}
 body{margin:0;font:15px/1.65 ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:44px 48px}
 h1{font-size:23px;font-weight:620;letter-spacing:-.01em;margin:0 0 6px}
 p.lede{color:var(--muted);margin:0 0 30px;max-width:62ch}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
 .state{border:1px solid var(--line);border-radius:12px;overflow:hidden}
 .state h2{font-size:11.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0;padding:12px 16px;border-bottom:1px solid var(--line)}
 .swatches{padding:16px;display:grid;gap:10px}
 .sw{height:46px;border-radius:8px;display:flex;align-items:center;padding:0 14px;font-size:13px}
 .sw.bg{background:var(--bg);border:1px solid var(--line)}
 .sw.card{background:var(--card)}
 .sw.accent{background:var(--accent);color:#fff}
 table{border-collapse:collapse;margin-top:34px;width:100%;font-size:13px}
 th,td{text-align:left;padding:9px 12px;border-bottom:1px solid var(--line)}
 th{color:var(--muted);font-weight:560;letter-spacing:.05em;text-transform:uppercase;font-size:11px}
 code{font:12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--accent)}
</style>
<h1>Palette preview</h1>
<p class="lede">The same three tokens under an explicit light choice, an explicit dark choice, and no choice at all. The third column is the one that was wrong.</p>
<div class="grid">
  <div class="state"><h2>Explicit light</h2><div class="swatches"><div class="sw bg">Surface</div><div class="sw card">Raised</div><div class="sw accent">Accent</div></div></div>
  <div class="state"><h2>Explicit dark</h2><div class="swatches"><div class="sw bg">Surface</div><div class="sw card">Raised</div><div class="sw accent">Accent</div></div></div>
  <div class="state"><h2>System default</h2><div class="swatches"><div class="sw bg">Surface</div><div class="sw card">Raised</div><div class="sw accent">Accent</div></div></div>
</div>
<table>
  <tr><th>Token</th><th>Light</th><th>Dark</th><th>Defined on</th></tr>
  <tr><td><code>--bg</code></td><td>#ffffff</td><td>#0d0f13</td><td>:root, then the query</td></tr>
  <tr><td><code>--card</code></td><td>#f3f4f6</td><td>#171a20</td><td>:root, then the query</td></tr>
  <tr><td><code>--accent</code></td><td>#3b82f6</td><td>#6ea8fe</td><td>:root, then the query</td></tr>
</table>
`;

const COVERAGE_HTML = `<!doctype html><meta charset="utf-8"><title>Suite coverage after the fixture split</title>
<style>
 :root{--bg:#ffffff;--fg:#14161a;--muted:#5c6370;--line:#e4e6ea;--ok:#1f9d55;--warn:#c98a12}
 @media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0d0f13;--fg:#e8e9ec;--muted:#8b909a;--line:#242832;--ok:#4ade80;--warn:#facc15}}
 body{margin:0;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--fg);padding:44px 48px}
 h1{font-size:23px;font-weight:620;margin:0 0 5px;letter-spacing:-.01em}
 p.lede{color:var(--muted);margin:0 0 28px}
 .totals{display:flex;gap:40px;margin-bottom:30px}
 .t b{display:block;font-size:31px;font-weight:640;letter-spacing:-.02em}
 .t span{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
 table{border-collapse:collapse;width:100%;font-size:13.5px}
 th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
 th{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:560}
 td.n{text-align:right;font-variant-numeric:tabular-nums}
 .bar{height:6px;border-radius:3px;background:var(--line);overflow:hidden;width:160px}
 .bar i{display:block;height:100%;background:var(--ok)}
 .bar.w i{background:var(--warn)}
 code{font:12.5px/1 ui-monospace,SFMono-Regular,Menlo,monospace}
</style>
<h1>Suite coverage after the fixture split</h1>
<p class="lede">Every suite builds its own fixtures. 412 tests, no shared database.</p>
<div class="totals">
  <div class="t"><b>96.4%</b><span>statements</span></div>
  <div class="t"><b>91.2%</b><span>branches</span></div>
  <div class="t"><b>0</b><span>shared fixtures</span></div>
</div>
<table>
  <tr><th>File</th><th>Statements</th><th></th><th class="n">Uncovered</th></tr>
  <tr><td><code>limiter/window.js</code></td><td>98.9%</td><td><div class="bar"><i style="width:99%"></i></div></td><td class="n">3</td></tr>
  <tr><td><code>limiter/cache-key.js</code></td><td>100%</td><td><div class="bar"><i style="width:100%"></i></div></td><td class="n">0</td></tr>
  <tr><td><code>notes/store.js</code></td><td>94.1%</td><td><div class="bar"><i style="width:94%"></i></div></td><td class="n">9</td></tr>
  <tr><td><code>notes/index.js</code></td><td>78.6%</td><td><div class="bar w"><i style="width:79%"></i></div></td><td class="n">21</td></tr>
</table>
`;

const LATENCY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600" role="img" aria-label="request latency by percentile, before and after">
  <rect width="960" height="600" fill="#0d0f13"/>
  <g font-family="ui-sans-serif,system-ui,sans-serif">
    <text x="56" y="62" font-size="26" font-weight="600" fill="#e8e9ec" letter-spacing="-0.3">Request latency by percentile</text>
    <text x="56" y="90" font-size="15" fill="#8b90a0">40k requests, before and after the empty-bucket fix</text>
  </g>
  <g stroke="#242832" stroke-width="1">
    <line x1="96" y1="480" x2="904" y2="480"/><line x1="96" y1="392" x2="904" y2="392"/>
    <line x1="96" y1="304" x2="904" y2="304"/><line x1="96" y1="216" x2="904" y2="216"/>
    <line x1="96" y1="128" x2="904" y2="128"/>
  </g>
  <g font-family="ui-monospace,Menlo,monospace" font-size="12" fill="#8b90a0" text-anchor="end">
    <text x="84" y="485">0</text><text x="84" y="397">20</text><text x="84" y="309">40</text>
    <text x="84" y="221">60</text><text x="84" y="133">80 ms</text>
  </g>
  <polyline fill="none" stroke="#f2a25c" stroke-width="3" stroke-linejoin="round"
    points="140,462 262,455 384,444 506,420 628,362 750,238 872,150"/>
  <polyline fill="none" stroke="#6ea8fe" stroke-width="3" stroke-linejoin="round"
    points="140,464 262,458 384,449 506,432 628,404 750,356 872,318"/>
  <g fill="#f2a25c">
    <circle cx="628" cy="362" r="4.5"/><circle cx="750" cy="238" r="4.5"/><circle cx="872" cy="150" r="4.5"/>
  </g>
  <g fill="#6ea8fe">
    <circle cx="628" cy="404" r="4.5"/><circle cx="750" cy="356" r="4.5"/><circle cx="872" cy="318" r="4.5"/>
  </g>
  <g font-family="ui-monospace,Menlo,monospace" font-size="12.5" fill="#8b90a0" text-anchor="middle">
    <text x="140" y="510">p50</text><text x="262" y="510">p75</text><text x="384" y="510">p90</text>
    <text x="506" y="510">p95</text><text x="628" y="510">p99</text><text x="750" y="510">p99.9</text><text x="872" y="510">max</text>
  </g>
  <g font-family="ui-sans-serif,system-ui,sans-serif" font-size="14">
    <rect x="140" y="540" width="26" height="3" rx="1.5" fill="#f2a25c"/>
    <text x="176" y="546" fill="#c9ccd4">before</text>
    <rect x="256" y="540" width="26" height="3" rx="1.5" fill="#6ea8fe"/>
    <text x="292" y="546" fill="#c9ccd4">after</text>
  </g>
</svg>
`;

const CONTRAST_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="600" viewBox="0 0 960 600" role="img" aria-label="contrast audit of the palette tokens">
  <rect width="960" height="600" fill="#ffffff"/>
  <g font-family="ui-sans-serif,system-ui,sans-serif">
    <text x="56" y="66" font-size="26" font-weight="600" fill="#14161a" letter-spacing="-0.3">Contrast audit</text>
    <text x="56" y="94" font-size="15" fill="#5c6370">Every text-on-surface pair in the palette, measured against WCAG 2.2</text>
  </g>
  <g font-family="ui-sans-serif,system-ui,sans-serif" font-size="11.5" fill="#5c6370" letter-spacing="0.6">
    <text x="56" y="146">PAIR</text><text x="470" y="146">RATIO</text><text x="614" y="146">AA</text><text x="716" y="146">AAA</text><text x="838" y="146">THEME</text>
  </g>
  <line x1="56" y1="158" x2="904" y2="158" stroke="#e4e6ea"/>
  <g font-family="ui-sans-serif,system-ui,sans-serif" font-size="14.5" fill="#14161a">
    <text x="56" y="192">Body on surface</text><text x="56" y="238">Body on raised</text>
    <text x="56" y="284">Muted on surface</text><text x="56" y="330">Muted on raised</text>
    <text x="56" y="376">Accent on surface</text><text x="56" y="422">On-accent on accent</text>
  </g>
  <g font-family="ui-monospace,Menlo,monospace" font-size="14" fill="#14161a" text-anchor="end">
    <text x="516" y="192">15.8:1</text><text x="516" y="238">14.1:1</text><text x="516" y="284">6.4:1</text>
    <text x="516" y="330">3.9:1</text><text x="516" y="376">4.9:1</text><text x="516" y="422">3.6:1</text>
  </g>
  <g font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5" font-weight="600">
    <g fill="#1f9d55"><text x="614" y="192">pass</text><text x="614" y="238">pass</text><text x="614" y="284">pass</text><text x="614" y="376">pass</text></g>
    <g fill="#c0392b"><text x="614" y="330">fail</text><text x="614" y="422">fail</text></g>
    <g fill="#1f9d55"><text x="716" y="192">pass</text><text x="716" y="238">pass</text><text x="716" y="284">pass</text></g>
    <g fill="#9aa1ad"><text x="716" y="330">-</text><text x="716" y="376">-</text><text x="716" y="422">-</text></g>
  </g>
  <g font-family="ui-sans-serif,system-ui,sans-serif" font-size="12.5" fill="#5c6370">
    <text x="838" y="192">both</text><text x="838" y="238">both</text><text x="838" y="284">both</text>
    <text x="838" y="330">dark</text><text x="838" y="376">both</text><text x="838" y="422">dark</text>
  </g>
  <g stroke="#eef0f3"><line x1="56" y1="210" x2="904" y2="210"/><line x1="56" y1="256" x2="904" y2="256"/>
    <line x1="56" y1="302" x2="904" y2="302"/><line x1="56" y1="348" x2="904" y2="348"/><line x1="56" y1="394" x2="904" y2="394"/></g>
  <rect x="56" y="462" width="848" height="84" rx="10" fill="#fdf3f2" stroke="#f3d7d4"/>
  <g font-family="ui-sans-serif,system-ui,sans-serif">
    <text x="80" y="496" font-size="14.5" font-weight="600" fill="#8c2f26">Both failures are text on a raised surface, and both are dark-only.</text>
    <text x="80" y="522" font-size="14" fill="#7d4a44">That is the one combination the media query never defined.</text>
  </g>
</svg>
`;

const CHECKLIST_TYPST = `#set page(width: 8.5in, height: 11in, margin: (x: 1in, y: 1in))
#set text(font: ("DejaVu Sans", "Liberation Sans"), size: 10.5pt)
#set par(leading: 0.72em)

#text(size: 20pt, weight: 600)[Release checklist]
#v(2pt)
#text(size: 10.5pt, fill: luma(110))[demo/harbor: what a tagged build does, and what a person still has to do]
#v(16pt)
#line(length: 100%, stroke: 0.5pt + luma(200))
#v(14pt)

#text(size: 12pt, weight: 600)[Automatic on a version tag]
#v(6pt)
#list(
  [Build on all three runners: linux, windows, macos.],
  [Produce .AppImage, .deb, .exe and .dmg into dist/.],
  [Attach every installer to a #text(weight: 600)[draft] release.],
)
#v(14pt)

#text(size: 12pt, weight: 600)[Not automatic, on purpose]
#v(6pt)
#list(
  [Publishing the draft. A tag push must not be able to publish binaries on its own.],
  [Code signing. Nothing here is signed, so both SmartScreen and Gatekeeper will warn.],
  [The warning copy in the release notes: say what the warning looks like and how to accept it.],
)
#v(14pt)

#text(size: 12pt, weight: 600)[What the user sees, unsigned]
#v(8pt)
#table(
  columns: (1fr, 2.1fr),
  stroke: 0.5pt + luma(210),
  inset: 8pt,
  [#text(weight: 600)[Platform]], [#text(weight: 600)[What happens on first run]],
  [Windows], [SmartScreen: "Windows protected your PC". More info, then Run anyway.],
  [macOS], [Right-click the app and choose Open, or clear the quarantine attribute.],
  [Linux], [Make the AppImage executable first.],
)
#v(18pt)
#text(size: 9.5pt, fill: luma(120))[Written for the demo corpus. Every name in this document is invented.]
`;

// ---------------------------------------------------------------------------
// Orchestration. A queue file exactly where the delegate provider looks for it
// (a sha1 of the REALPATH of the workspace, because that is what claude-delegate
// hashes), plus its event log and the worker registry.
// ---------------------------------------------------------------------------

const QUEUE_ID = 'q-demo-harbor-0001';

function orchestrationQueue(workspace, now) {
  const at = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString();
  return {
    queue_id: QUEUE_ID,
    workspace,
    updated_at: at(2),
    sprint_plan: {
      1: { label: 'Packaging' },
      2: { label: 'Docs and setup' },
    },
    batches: [
      {
        id: 'batch-1',
        sprint: 1,
        title: 'Pin the electron-builder targets per platform',
        status: 'done',
        priority: 'high',
        worker: 'codex-worker',
        dispatch_count: 1,
        created_at: at(96),
        started_at: at(94),
        completed_at: at(71),
        updated_at: at(71),
        last_result_excerpt: 'Targets pinned. One config now builds linux, windows and macos.',
      },
      {
        id: 'batch-2',
        sprint: 1,
        title: 'Draft-release step, never publish on a tag alone',
        status: 'done',
        priority: 'high',
        worker: 'codex-worker',
        dispatch_count: 1,
        created_at: at(96),
        started_at: at(70),
        completed_at: at(44),
        updated_at: at(44),
        last_result_excerpt: 'Upload replaced with a draft release. A maintainer publishes by hand.',
      },
      {
        id: 'batch-3',
        sprint: 1,
        title: 'Checksums and a reproducible-build comparison',
        status: 'active',
        priority: 'normal',
        worker: 'cursor-worker',
        dispatch_count: 1,
        created_at: at(96),
        started_at: at(21),
        updated_at: at(2),
        last_event: 'rebuilding twice to compare digests',
      },
      {
        id: 'batch-4',
        sprint: 2,
        title: 'Per-platform install notes, including the unsigned warnings',
        status: 'pending',
        priority: 'normal',
        worker: 'claude-worker',
        dispatch_count: 0,
        created_at: at(96),
        updated_at: at(96),
      },
      {
        id: 'batch-5',
        sprint: 2,
        title: 'Verify the AppImage on a machine with no Node installed',
        status: 'pending',
        priority: 'low',
        worker: 'claude-worker',
        dispatch_count: 0,
        created_at: at(96),
        updated_at: at(96),
      },
    ],
  };
}

function orchestrationEvents(now) {
  const at = (minutesAgo) => new Date(now - minutesAgo * MINUTE)
    .toISOString().replace('T', ' ').slice(0, 16);
  return [
    { t: at(96), msg: 'queue imported: 5 batches across 2 sprints' },
    { t: at(94), msg: 'batch-1 dispatched to codex-worker' },
    { t: at(71), msg: 'batch-1 done in 23m' },
    { t: at(70), msg: 'batch-2 dispatched to codex-worker' },
    { t: at(44), msg: 'batch-2 done in 26m' },
    { t: at(21), msg: 'batch-3 dispatched to cursor-worker' },
    { t: at(2), msg: 'batch-3 rebuilding twice to compare digests' },
  ];
}

// ---------------------------------------------------------------------------
// Writers.
// ---------------------------------------------------------------------------

function mungedClaudeDir(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

// The munge cursor applies to a cwd for its project directory name. Must match
// cursorProjectDir in providers/transcript.js and mungeCwd in
// providers/provider-history.js, or the planted session is found by neither.
function mungedCursorDir(cwd) {
  return String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]/g, '-');
}

function uuidFor(index) {
  const n = String(index);
  return `0000000${n}-1111-4222-8333-44444444444${n}`;
}

function claudeToolBlock(kind, spec, outDir) {
  const swap = (value) => String(value).replace('{OUT}', outDir);
  if (kind === 'edit') {
    return { name: 'Edit', input: { file_path: swap(spec.file), old_string: spec.old, new_string: spec.new } };
  }
  if (kind === 'write') {
    return { name: 'Write', input: { file_path: swap(spec.file), content: 'x\n'.repeat(spec.lines) } };
  }
  if (kind === 'bash') {
    return typeof spec === 'string'
      ? { name: 'Bash', input: { command: swap(spec) } }
      : { name: 'Bash', input: { command: swap(spec.command) }, result: swap(spec.result) };
  }
  if (kind === 'grep') return { name: 'Grep', input: { pattern: spec.pattern, path: spec.path } };
  throw new Error(`demo-corpus: unknown claude tool block '${kind}'`);
}

function writeClaudeSession(session, { projectsDir, cwd, outDir, id, startMs }) {
  const dir = path.join(projectsDir, mungedClaudeDir(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: 'summary', summary: session.title, leafUuid: id })];
  const lastIndex = session.blocks.length - 1;
  session.blocks.forEach(([kind, spec], n) => {
    const uuid = `${id.slice(0, 30)}${String(n).padStart(6, '0')}`;
    const timestamp = new Date(startMs + n * MINUTE).toISOString();
    const base = { uuid, sessionId: id, cwd, timestamp };
    if (kind === 'user') {
      lines.push(JSON.stringify({
        ...base,
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: spec }] },
      }));
      return;
    }
    if (kind === 'assistant') {
      lines.push(JSON.stringify({
        ...base,
        type: 'assistant',
        message: { role: 'assistant', model: session.model, stop_reason: 'end_turn', content: [{ type: 'text', text: spec }] },
      }));
      return;
    }
    const tool = claudeToolBlock(kind, spec, outDir);
    lines.push(JSON.stringify({
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        model: session.model,
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: `toolu_${n}`, name: tool.name, input: tool.input }],
      },
    }));
    // A session that ENDS on a tool call with no result is a session mid-turn,
    // which is what makes its window read as working. Every other call resolves.
    if (!(n === lastIndex && session.ends === 'working')) {
      lines.push(JSON.stringify({
        ...base,
        uuid: `${uuid}r`,
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${n}`, content: tool.result || 'ok' }] },
      }));
    }
  });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// Codex's own store layout and its own line shapes.
//
// WHICH SHAPE MATTERS, and getting it wrong is how a fixture quietly stops
// describing the product. Codex 0.147.0 moved an INTERACTIVE session's
// conversation out of `event_msg` user_message/agent_message and into the
// `event_msg` `item_completed` item stream (found 2026-08-08 on a real 4.5MB
// rollout that parsed to sixteen tool actions and zero text; see CLAUDE.md).
// The older event pair is still written by `codex_exec` runs and is still
// parsed for the historical corpus, so emitting it here would have exercised
// the back-compat path while the file claimed to be an interactive 0.147.0
// session. This writes what an interactive 0.147.0 session actually writes:
// session_meta, turn_context for the model, `item_completed` items of type
// UserMessage / AgentMessage (part-type casing differs by role in the real
// bytes, 'text' for the user and 'Text' for the agent), and every shell step as
// a custom_tool_call named `exec` whose input is the JS snippet codex writes
// (`const r = await tools.exec_command({...})`), paired with its output line.
function writeCodexSession(session, { home, cwd, id, startMs }) {
  const day = new Date(startMs);
  const pad = (n) => String(n).padStart(2, '0');
  const dir = path.join(
    home, '.codex', 'sessions',
    String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()),
  );
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date(startMs).toISOString().slice(0, 19).replace(/:/g, '-');
  const file = path.join(dir, `rollout-${stamp}-${id}.jsonl`);
  const lines = [];
  const at = (n) => new Date(startMs + n * MINUTE).toISOString();
  const lastIndex = session.blocks.length - 1;
  lines.push(JSON.stringify({
    timestamp: at(0),
    type: 'session_meta',
    payload: {
      session_id: id, id, timestamp: at(0), cwd,
      originator: 'codex_cli_rs', cli_version: '0.147.0', source: 'interactive',
    },
  }));
  lines.push(JSON.stringify({
    timestamp: at(0),
    type: 'turn_context',
    payload: { cwd, model: session.model, approval_policy: 'on-request', summary: 'auto' },
  }));
  session.blocks.forEach(([kind, spec], n) => {
    const timestamp = at(n + 1);
    if (kind === 'user' || kind === 'assistant') {
      const user = kind === 'user';
      lines.push(JSON.stringify({
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: {
            id: `item_${n}`,
            type: user ? 'UserMessage' : 'AgentMessage',
            content: [{ type: user ? 'text' : 'Text', text: spec }],
          },
        },
      }));
      return;
    }
    if (kind !== 'exec') throw new Error(`demo-corpus: unknown codex block '${kind}'`);
    const callId = `call_demo${n}`;
    lines.push(JSON.stringify({
      timestamp, type: 'response_item',
      payload: {
        type: 'custom_tool_call', id: `ctc_demo${n}`, status: 'completed', call_id: callId,
        name: 'exec',
        input: `const r = await tools.exec_command({"cmd":${JSON.stringify(spec)},"yield_time_ms":10000});\nreturn r;`,
      },
    }));
    if (n === lastIndex && session.ends === 'working') return;
    lines.push(JSON.stringify({
      timestamp, type: 'response_item',
      payload: {
        type: 'custom_tool_call_output', id: `ctco_demo${n}`, call_id: callId,
        output: [{ type: 'input_text', text: 'Script completed\nWall time 2.1 seconds\nOutput:\n' }],
      },
    }));
  });
  if (session.ends !== 'working') {
    lines.push(JSON.stringify({
      timestamp: at(session.blocks.length + 1),
      type: 'event_msg',
      payload: { type: 'task_complete' },
    }));
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// Cursor's store layout and line shapes, taken from real cursor-agent
// transcripts: one object per message, role at the top level, the user's text
// wrapped in <user_query>, and tools carrying cursor's own input keys
// (Shell{command,description}, Grep{pattern,path}).
function writeCursorSession(session, { home, cwd, id, startMs }) {
  const dir = path.join(home, '.cursor', 'projects', mungedCursorDir(cwd), 'agent-transcripts', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [];
  const at = (n) => new Date(startMs + n * MINUTE).toISOString();
  const lastIndex = session.blocks.length - 1;
  session.blocks.forEach(([kind, spec], n) => {
    const timestamp = at(n);
    if (kind === 'user') {
      lines.push(JSON.stringify({
        role: 'user', timestamp,
        message: {
          content: [{ type: 'text', text: `<timestamp>${timestamp}</timestamp>\n<user_query>\n${spec}\n</user_query>` }],
        },
      }));
      return;
    }
    if (kind === 'assistant') {
      lines.push(JSON.stringify({
        role: 'assistant', timestamp,
        message: { content: [{ type: 'text', text: spec }] },
      }));
      return;
    }
    const tool = kind === 'shell'
      ? { name: 'Shell', input: { command: spec, description: 'search the stylesheet' } }
      : kind === 'grep'
        ? { name: 'Grep', input: { pattern: spec.pattern, path: spec.path } }
        : null;
    if (!tool) throw new Error(`demo-corpus: unknown cursor block '${kind}'`);
    lines.push(JSON.stringify({
      role: 'assistant', timestamp,
      message: { content: [{ type: 'tool_use', id: `tu_demo${n}`, name: tool.name, input: tool.input }] },
    }));
    if (n === lastIndex && session.ends === 'working') return;
    lines.push(JSON.stringify({
      role: 'assistant', timestamp,
      message: { content: [{ type: 'tool_result', tool_use_id: `tu_demo${n}`, is_error: false, content: 'ok' }] },
    }));
  });
  if (session.ends !== 'working') lines.push(JSON.stringify({ type: 'turn_ended', status: 'completed' }));
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

// The one artifact that cannot be authored as text: a video. Rendered from the
// SAME page palette-preview.html is, once in each palette, and crossfaded, so it
// is a real recording of a real artifact rather than a test pattern standing in
// for one. Asynchronous and therefore separate from buildCorpus, which is
// synchronous: callers run it before launching the app, because the artifact
// index only counts a file that exists by the time it scans.
async function buildVideoArtifacts(sessions, { renderHtmlToPng }) {
  const written = [];
  for (const artifact of ARTIFACTS.filter((entry) => entry.kind === 'video')) {
    const session = sessions.find((entry) => entry.key === artifact.session);
    if (!session) continue;
    const outDir = path.join(session.cwd, 'out');
    const target = path.join(outDir, artifact.name);
    const frames = [];
    try {
      // DARK first, and not arbitrarily: the thumbnailer takes a video's FIRST
      // frame, and starting light made this card a near-twin of the
      // palette-preview.html card sitting beside it in the same project. Ending
      // on light is also the direction the fix in that session went.
      for (const theme of ['dark', 'light']) {
        const frame = path.join(outDir, `.frame-${theme}.png`);
        await renderHtmlToPng({
          // The page is a document, so it scrolls; a recording of it should not
          // carry a scrollbar down one edge of every frame.
          html: `${PALETTE_HTML}<style>html,body{overflow:hidden}</style>`,
          width: 960, height: 640, scale: 1, out: frame, themeSource: theme,
        });
        frames.push(frame);
      }
      const result = spawnSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-loop', '1', '-t', '3', '-i', frames[0],
        '-loop', '1', '-t', '3', '-i', frames[1],
        '-filter_complex', '[0:v][1:v]xfade=transition=fade:duration=1.4:offset=1.6,format=yuv420p[v]',
        '-map', '[v]', '-r', '25', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24',
        '-movflags', '+faststart', target,
      ]);
      if (result.status !== 0) throw new Error((result.stderr || '').toString().trim().split('\n')[0] || 'ffmpeg failed');
      written.push(target);
    } catch (error) {
      // A missing ffmpeg or a failed encode costs one card, never the capture.
      process.stdout.write(`demo-corpus: no video artifact (${error.message})\n`);
    } finally {
      for (const frame of frames) fs.rmSync(frame, { force: true });
    }
  }
  return written;
}

function writeArtifact(artifact, outDir) {
  // Video is produced asynchronously by buildVideoArtifacts; the transcript
  // still names it here, which is the half of the contract this function owns.
  if (artifact.kind === 'video') return false;
  fs.mkdirSync(outDir, { recursive: true });
  const target = path.join(outDir, artifact.name);
  if (artifact.kind === 'svg') {
    fs.writeFileSync(target, artifact.name === 'latency-p95.svg' ? LATENCY_SVG : CONTRAST_SVG);
    return true;
  }
  if (artifact.kind === 'html') {
    fs.writeFileSync(target, artifact.name === 'palette-preview.html' ? PALETTE_HTML : COVERAGE_HTML);
    return true;
  }
  const source = path.join(outDir, `${path.parse(artifact.name).name}.typ`);
  fs.writeFileSync(source, CHECKLIST_TYPST);
  const result = spawnSync('typst', ['compile', source, target], { encoding: 'utf8' });
  fs.rmSync(source, { force: true });
  // A missing or unhappy typst degrades to a smaller gallery. It must never
  // fail the capture: the PDF is one card, the corpus is the point.
  if (result.status !== 0) {
    process.stdout.write(`demo-corpus: no PDF artifact (typst: ${result.error?.code || (result.stderr || '').trim().split('\n')[0] || 'failed'})\n`);
    return false;
  }
  return true;
}

// Both captures begin by DELETING their root, and both take that root from an
// environment variable. That is a recursive delete one typo away from something
// real, so the rule is stated once, here, and enforced before the delete rather
// than trusted to the caller: an absolute path, at least two segments deep, not
// a system or home directory, and named after this project. Refusing to delete
// a directory nobody named `harbor-*` costs nothing and is the difference
// between a bad run and a bad day.
const PROTECTED_ROOTS = new Set(['/', '/home', '/root', '/usr', '/etc', '/var', '/tmp', '/dev', '/dev/shm', '/opt', '/srv']);

function prepareRoot(root) {
  const target = path.resolve(String(root || ''));
  const segments = target.split(path.sep).filter(Boolean);
  const home = os.homedir();
  if (!path.isAbsolute(target) || segments.length < 2) {
    throw new Error(`demo-corpus: refusing to use '${target}' as a corpus root; it is too shallow to delete safely`);
  }
  if (PROTECTED_ROOTS.has(target) || target === home) {
    throw new Error(`demo-corpus: refusing to use '${target}' as a corpus root; it is a system or home directory`);
  }
  if (!/^harbor[-.]/.test(path.basename(target))) {
    throw new Error(`demo-corpus: refusing to use '${target}' as a corpus root; its last segment must be named harbor-* so this never deletes a directory it did not create`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });
  return target;
}

// Build the whole corpus under `root`. Returns everything a capture needs to
// point an isolated Harbor at it.
function buildCorpus(root, options = {}) {
  const now = options.now || Date.now();
  const projectsDir = path.join(root, 'projects');
  // HOME is the root itself, so every cwd Harbor renders is one segment shorter
  // and the fixture's provider stores sit where their scanners look for them.
  const home = root;
  const delegateDir = path.join(root, 'delegate');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });

  const sessions = SESSIONS.map((session, index) => {
    const id = uuidFor(index);
    const cwd = path.join(home, session.dir);
    fs.mkdirSync(cwd, { recursive: true });
    const outDir = path.join(cwd, 'out');
    // Newest first, so the rail's most recent rows are the ones the capture
    // opens. One hour apart makes the relative times read naturally.
    const startMs = now - (index + 1) * HOUR;
    // Artifacts BEFORE the transcript that names them: the file's mtime must
    // not be older than the naming session's start, and the session starts in
    // the past, so writing them now satisfies that in the only direction that
    // matters.
    const written = ARTIFACTS
      .filter((artifact) => artifact.session === session.key)
      .filter((artifact) => writeArtifact(artifact, outDir))
      .map((artifact) => artifact.name);
    const context = { projectsDir, home, cwd, outDir, id, startMs };
    const file = session.provider === 'codex' ? writeCodexSession(session, context)
      : session.provider === 'cursor' ? writeCursorSession(session, context)
        : writeClaudeSession(session, context);
    return { ...session, id, cwd, file, artifacts: written };
  });

  // The orchestration queue belongs to the project the first session is in, so
  // the Orch view and the stage are talking about the same work.
  const workspace = (() => {
    const target = path.join(home, 'demo', 'harbor');
    try { return fs.realpathSync(target); } catch { return path.resolve(target); }
  })();
  const digest = crypto.createHash('sha1').update(workspace).digest('hex').slice(0, 12);
  fs.mkdirSync(path.join(delegateDir, 'queues'), { recursive: true });
  fs.mkdirSync(path.join(delegateDir, 'events'), { recursive: true });
  fs.writeFileSync(
    path.join(delegateDir, 'queues', `${digest}.json`),
    `${JSON.stringify(orchestrationQueue(workspace, now), null, 2)}\n`,
  );
  fs.writeFileSync(
    path.join(delegateDir, 'events', `${QUEUE_ID}.jsonl`),
    `${orchestrationEvents(now).map((event) => JSON.stringify(event)).join('\n')}\n`,
  );
  fs.writeFileSync(path.join(delegateDir, 'workers.json'), `${JSON.stringify({
    workers: {
      'worker-codex-1': { name: 'codex-worker · batch-2', workspace, session_id: 'worker-codex-1' },
      'worker-cursor-1': { name: 'cursor-worker · batch-3', workspace, session_id: 'worker-cursor-1' },
    },
  }, null, 2)}\n`);

  return { root, projectsDir, home, delegateDir, sessions, workspace };
}

// The isolated config an app or server reads for these captures. Every provider
// is enabled because the whole point of the pictures is that Harbor drives
// three of them.
function buildConfig(root, { projectsDir, home, cacheDir, userData }) {
  return {
    version: 1,
    setup: { completed: true, completedAt: new Date().toISOString(), appVersion: '0.1.0' },
    platform: { os: 'linux', herdrBin: 'herdr', herdrSocket: path.join(root, 'herdr.sock'), shell: '/bin/bash' },
    profiles: [
      { id: 'personal', label: 'Personal', letter: 'P', color: '#6fa8d8', provider: 'claude', configHome: path.join(home, '.claude'), email: 'you@example.com', isDefault: true },
      { id: 'team', label: 'Team', letter: 'T', color: '#d68a5a', provider: 'claude', configHome: path.join(home, '.claude-team'), email: 'you@example.com', isDefault: false },
    ],
    providers: {
      claude: { enabled: true, bin: 'claude' },
      codex: { enabled: true, bin: 'codex' },
      cursor: { enabled: true, bin: 'cursor-agent' },
    },
    paths: {
      projectsDir,
      cacheDir,
      delegateStateDir: path.join(root, 'delegate'),
      binDir: path.join(root, 'bin'),
      projectIconsDir: path.join(root, 'icons'),
      tasksFile: path.join(root, 'tasks.json'),
    },
    workflows: [],
    orchestration: {
      enabled: true,
      launcher: path.join(root, 'bin', 'claude-delegate'),
      researchCommand: '/orchestrate-research',
      executionCommand: '/orchestrate-execution',
      stateDir: path.join(root, 'delegate'),
    },
    newSessionDefaults: { provider: 'claude', model: 'opus', effort: 'xhigh' },
    userData,
  };
}

// The rail's usage meters read a per-account statusline tee out of the cache
// directory, which on a real machine Claude Code writes on every statusline
// repaint. With no tee the meters draw two rows of "--", which in a published
// picture reads as a broken app rather than as an account nobody has run today.
// This writes the same file in the same shape, per profile, for this run only.
function seedUsage(cacheDir, now = Date.now()) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const seconds = (ms) => Math.round(ms / 1000);
  const accounts = [
    ['personal', { five: 38, week: 61, cost: 24.18, fiveIn: 2.4 * HOUR, weekIn: 3.2 * 24 * HOUR }],
    ['team', { five: 12, week: 47, cost: 9.62, fiveIn: 4.1 * HOUR, weekIn: 5.6 * 24 * HOUR }],
  ];
  for (const [account, sample] of accounts) {
    fs.writeFileSync(path.join(cacheDir, `usage-${account}.json`), `${JSON.stringify({
      account_email: 'you@example.com',
      updated_at: new Date(now - 40_000).toISOString(),
      rate_limits: {
        five_hour: { used_percentage: sample.five, resets_at: seconds(now + sample.fiveIn) },
        seven_day: { used_percentage: sample.week, resets_at: seconds(now + sample.weekIn) },
      },
      cost: { total_cost_usd: sample.cost },
    }, null, 2)}\n`);
  }
}

// Seed the Tasks view through the REAL CLI (bin/harbor-tasks) pointed at this
// run's own tasks file: same writer, same reducer, same document the app reads,
// so the Tasks picture is the real surface rather than a mock.
function seedTasks(repoRoot, tasksFile) {
  const env = { ...process.env, HARBOR_TASKS_FILE: tasksFile };
  const task = (...args) => spawnSync(path.join(repoRoot, 'bin', 'harbor-tasks'), args, { env, encoding: 'utf8' });
  task('list-add', 'Harbor');
  task('add', 'Ship the release workflow', '--list', 'Harbor', '--due', 'today', '--star');
  task('add', 'Write the setup guide for Windows', '--list', 'Harbor', '--due', '+2d');
  task('add', 'Check the installer warning copy', '--parent', 'Write the setup guide for Windows');
  task('add', 'Reply to the packaging question', '--list', 'Harbor');
  task('add', 'Read the tailnet ACL docs', '--list', 'Harbor', '--due', '+5d');
  task('add', 'Rotate the demo token', '--list', 'Harbor');
  task('done', 'Rotate the demo token');
}

module.exports = {
  SESSIONS,
  ARTIFACTS,
  DEFAULT_ROOT,
  prepareRoot,
  buildCorpus,
  buildVideoArtifacts,
  buildConfig,
  seedTasks,
  seedUsage,
  mungedClaudeDir,
  mungedCursorDir,
  QUEUE_ID,
};
