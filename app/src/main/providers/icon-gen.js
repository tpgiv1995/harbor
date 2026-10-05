'use strict';

// AUTOMATIC PROJECT ICONS: a project that has earned a row in the rail and has
// no icon gets one generated for it, and the folder watcher repaints it live.
//
// Why this exists at all. Pat's icon set is 56 hand-made app icons, and every
// project added after the set was made falls back to a coloured dot. On Linux
// that gap was filled by a hook that noticed a new project and generated one;
// the hook did not survive the move to the Legion (2026-08-11), so on Windows
// every new project is a dot forever. This is that hook, rebuilt inside Harbor
// where it can see the same project list the rail draws.
//
// THE SLUG RULE IS NOT RESTATED HERE. It is imported from the one module the
// renderer resolves icons with, because a generator that names files by a
// second, reasonable-looking rule writes icons that never resolve: the file
// lands in the folder, the rail keeps its dot, and nothing anywhere reports a
// problem. `iconSlugCandidates` answers both "does this project already have an
// icon" and "what should a new one be called" (the first candidate), so the two
// questions cannot drift apart.
//
// NO PYTHON. The image-gen skill this replaces shells out to a .py; product
// code never spawns Python (2026-08-04, a release blocker), so the same HTTP
// call is made directly. The KEY is read from the skill's own env file, because
// that is where the user's keys already live and a second copy of a secret is a
// second thing to leak.
//
// WHAT IT WILL NOT DO, and each of these is a cost or a surprise Pat would have
// to notice and undo:
//   - It never regenerates an icon that already exists, in any of the label's
//     candidate slugs, from the user's folder OR the bundled one.
//   - It never regenerates a slug it has already attempted. Deleting a
//     generated icon is therefore how you say no, and it stays said.
//   - It never touches a foreign-era project ('win: ' / 'linux: '), because
//     that folder does not exist on this machine and never will.
//   - It never generates for an orchestration scratch worktree (a cwd with a
//     .orch segment), the same classification the rail's Orchestration group
//     uses; those directories are disposable and their icons are pure spend.
//   - It waits until a project looks real: MIN_SESSIONS sessions AND a span of
//     at least MIN_SPAN_MS between its first and last, which is the "after a
//     bit of time" part. A scratch directory used once for ten minutes never
//     reaches it. (The 18 probe directories deleted on 2026-08-12 would each
//     have qualified on session count alone.)
//   - It generates at most PER_RUN_LIMIT icons per pass, so a first launch
//     against a 60-project history is not a 60-image bill.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { iconSlugCandidates, slugifyLabel } = require('../../renderer/stage/project-icon-slug.cjs');
const { projectLabelForCwd } = require('../../shared/project-label.cjs');
const { isOrchestrationCwd } = require('../../shared/sidebar-model.cjs');

const API_URL = 'https://api.openai.com/v1/images/generations';
const MODEL = 'gpt-image-2';
const ICON_PX = 96;
const PER_RUN_LIMIT = 3;
const MIN_SESSIONS = 2;
const MIN_SPAN_MS = 30 * 60_000;
const RETRY_AFTER_MS = 24 * 3_600_000;
const MAX_ATTEMPTS = 3;
const ERA_LABEL = /^(win|linux): /u;
// A drive root is what project-label.cjs answers for a session started at C:\,
// and it is a PLACE, not a project: every stray session anywhere off a dev root
// lands in it, so there is no one thing for an icon to depict. Asking for "an
// app icon representing C" is also just a bad prompt.
const DRIVE_ROOT_LABEL = /^[A-Za-z]:$/u;

// The house style, described from the set it has to sit beside: 96px glossy
// rounded-square app icons, one centred emblem on a saturated gradient, soft 3D
// shading, no lettering. Text is called out twice because image models add it
// unprompted, and a project name baked into a 96px icon is illegible mush.
function promptFor(label) {
  const subject = String(label).replace(/[-_/\\]+/gu, ' ').trim();
  return [
    `A polished mobile app icon representing "${subject}".`,
    'Rounded-square icon, glossy iOS-style: one single centred symbolic object,',
    'rendered with soft three-dimensional shading and a gentle highlight,',
    'on a rich saturated colour gradient background.',
    'Simple, bold, instantly readable at very small size, centred with even margins.',
    'NO text, NO words, NO letters, NO numbers, NO logos, no watermark, no border frame.',
  ].join(' ');
}

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// The image-gen skill's env file, in its format: KEY=value lines, optionally
// quoted. An absent key is not an error anywhere in this module; it is simply a
// machine that does not generate icons, and the dot is a supported look.
function loadKey(env, keyFiles) {
  if (env.HARBOR_ICON_GEN_KEY) return env.HARBOR_ICON_GEN_KEY.trim();
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY.trim();
  for (const file of keyFiles) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('OPENAI_API_KEY=')) continue;
      const value = trimmed.slice('OPENAI_API_KEY='.length).trim().replace(/^(['"])(.*)\1$/u, '$2');
      if (value) return value;
    }
  }
  return null;
}

/**
 * Group the history index into projects the rail would show.
 * One entry per label: how many sessions, and the span they cover.
 */
function projectsFromIndex(index, { home, platform }) {
  const files = index && typeof index.files === 'object' ? index.files : {};
  const byLabel = new Map();
  const seen = new Set();
  for (const entry of Object.values(files)) {
    if (!entry || !entry.cwd || !entry.id) continue;
    // One row per SESSION: the index is keyed by file, and a session resumed in
    // another config home appears once per home, which would treble its count.
    const key = `${entry.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const label = projectLabelForCwd(entry.cwd, home, platform);
    if (!label) continue;
    // An orchestration worktree is not a project, by the SAME rule the rail
    // groups by. Before this check the generator spent three real image calls
    // on .orch/batch-* scratch dirs (2026-08-21), each of which will be gone
    // in a week while its icon lingers forever.
    if (isOrchestrationCwd({ cwd: entry.cwd, label })) continue;
    const start = Date.parse(entry.start || '') || null;
    const last = Date.parse(entry.last || '') || null;
    const current = byLabel.get(label) || { label, sessions: 0, first: null, last: null };
    current.sessions += 1;
    if (start && (current.first === null || start < current.first)) current.first = start;
    if (last && (current.last === null || last > current.last)) current.last = last;
    byLabel.set(label, current);
  }
  return [...byLabel.values()];
}

function createIconGenerator(options = {}) {
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const cacheDir = options.cacheDir || path.join(home, '.cache', 'harbor');
  const indexFile = options.indexFile || path.join(cacheDir, 'index.json');
  const stateFile = options.stateFile || path.join(cacheDir, 'icon-gen.json');
  const iconsDir = options.iconsDir;
  const keyFiles = options.keyFiles || [
    path.join(home, '.config', 'image-gen', '.env'),
    path.join(home, '.config', 'harbor', 'icon-gen.env'),
  ];
  const fetchImpl = options.fetch || globalThis.fetch;
  const logger = options.logger || console;
  const now = options.now || (() => Date.now());
  const perRunLimit = Number(options.perRunLimit ?? env.HARBOR_ICON_GEN_LIMIT ?? PER_RUN_LIMIT);
  const minSessions = Number(options.minSessions ?? MIN_SESSIONS);
  const minSpanMs = Number(options.minSpanMs ?? MIN_SPAN_MS);
  // Injected so the planner and the tests never need Electron. In the app this
  // is nativeImage: the API returns 1024px and the set on disk is 96px, and an
  // icon that is ten times the size of its neighbours is a different feature.
  const resizeToPng = options.resizeToPng || ((buffer) => buffer);
  // Injected so a test can plan against a directory listing without the whole
  // provider; in the app this is the live project-icon provider's own list().
  const listIcons = options.listIcons;

  function readState() {
    const value = loadJson(stateFile);
    const attempts = value && value.attempts && typeof value.attempts === 'object' ? value.attempts : {};
    return { v: 1, attempts: { ...attempts } };
  }

  function writeState(state) {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    const temporary = path.join(path.dirname(stateFile), `.icon-gen-${process.pid}-${now()}.tmp`);
    fs.writeFileSync(temporary, JSON.stringify(state));
    fs.renameSync(temporary, stateFile);
  }

  // Every slug already spoken for. Read from the live provider when one is
  // supplied, so this cannot disagree with the set the renderer is actually
  // resolving against; `bundledSlugs` carries the build-time set, which the
  // provider's listing does not cover and which resolves ahead of nothing but
  // the dot.
  async function existingSlugs() {
    const bundled = new Set(options.bundledSlugs || []);
    if (listIcons) {
      const listing = await listIcons();
      for (const slug of Object.keys(listing?.icons || {})) bundled.add(slug);
      return bundled;
    }
    let entries;
    try { entries = await fsp.readdir(iconsDir); } catch { return bundled; }
    for (const name of entries) {
      const extension = path.extname(name).toLowerCase();
      if (!extension) continue;
      bundled.add(name.slice(0, -extension.length).toLowerCase());
    }
    return bundled;
  }

  function attemptBlocks(record) {
    if (!record) return false;
    // A SUCCESS IS FOREVER. The icon it wrote may be gone because the user
    // deleted it, and regenerating it is Harbor arguing with them.
    if (record.status === 'ok') return true;
    if (Number(record.tries || 0) >= MAX_ATTEMPTS) return true;
    return now() - Number(record.at || 0) < RETRY_AFTER_MS;
  }

  /** Projects that want an icon, newest activity first. Pure: generates nothing. */
  async function plan() {
    const index = loadJson(indexFile);
    if (!index) return [];
    const taken = await existingSlugs();
    const state = readState();
    const candidates = [];
    for (const project of projectsFromIndex(index, { home, platform })) {
      const { label } = project;
      if (ERA_LABEL.test(label) || DRIVE_ROOT_LABEL.test(label)) continue;
      const slugs = iconSlugCandidates(label);
      if (!slugs.length) continue;
      if (slugs.some((candidate) => taken.has(candidate))) continue;
      // The CANONICAL slug, not a pick from the candidate list. The list is
      // ordered for LOOKUP (raw label first so an already-slug-shaped label
      // needs no transformation, parent/leaf fallbacks last), and both ends of
      // it are wrong to write: the raw label can carry '/' and capitals, and
      // the last entry is a nested label's PARENT, so 'Surveys/Intake' would
      // have been saved as surveys.png and quietly claimed its parent's row.
      const slug = slugifyLabel(label);
      if (!slug) continue;
      if (attemptBlocks(state.attempts[slug])) continue;
      if (project.sessions < minSessions) continue;
      const span = (project.last || 0) - (project.first || 0);
      if (!(span >= minSpanMs)) continue;
      candidates.push({ label, slug, sessions: project.sessions, span, last: project.last || 0 });
    }
    candidates.sort((a, b) => b.last - a.last);
    return candidates;
  }

  async function generateOne(key, candidate) {
    const response = await fetchImpl(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, prompt: promptFor(candidate.label), size: '1024x1024', n: 1 }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    }
    const data = await response.json();
    const b64 = data?.data?.[0]?.b64_json;
    if (!b64) throw new Error('response carried no image');
    const full = Buffer.from(b64, 'base64');
    const sized = resizeToPng(full, ICON_PX);
    if (!sized || !sized.length) throw new Error('resize produced no bytes');
    await fsp.mkdir(iconsDir, { recursive: true });
    // Written through a temp file in the SAME directory: the icons folder is
    // watched, and a watcher that wakes on a half-written PNG indexes a file
    // Chromium then refuses to decode, which is a permanent dot for a slug that
    // will never be retried.
    const target = path.join(iconsDir, `${candidate.slug}.png`);
    const temporary = path.join(iconsDir, `.${candidate.slug}.${process.pid}.tmp`);
    await fsp.writeFile(temporary, sized);
    await fsp.rename(temporary, target);
    return target;
  }

  async function run(runOptions = {}) {
    if (env.HARBOR_NO_ICON_GEN === '1') return { generated: 0, skipped: 'disabled' };
    if (!iconsDir) return { generated: 0, skipped: 'no-icons-dir' };
    const candidates = await plan();
    if (!candidates.length) return { generated: 0, candidates: 0 };
    const key = loadKey(env, keyFiles);
    // Reported rather than thrown: a machine with no key is a supported
    // machine, and the caller logs this once instead of every scheduled pass.
    if (!key) return { generated: 0, candidates: candidates.length, skipped: 'no-key' };
    if (runOptions.dryRun) return { generated: 0, candidates: candidates.length, plan: candidates };

    const state = readState();
    const limit = Math.max(0, Number(runOptions.limit ?? perRunLimit));
    let generated = 0;
    const failures = [];
    for (const candidate of candidates.slice(0, limit)) {
      const prior = state.attempts[candidate.slug];
      try {
        const file = await generateOne(key, candidate);
        state.attempts[candidate.slug] = { status: 'ok', at: now(), label: candidate.label };
        generated += 1;
        logger.log?.(`harbor icon-gen: generated ${path.basename(file)} for ${candidate.label}`);
      } catch (error) {
        state.attempts[candidate.slug] = {
          status: 'failed',
          at: now(),
          tries: Number(prior?.tries || 0) + 1,
          error: String(error?.message || error).slice(0, 200),
          label: candidate.label,
        };
        failures.push({ slug: candidate.slug, error: String(error?.message || error) });
      }
      writeState(state);
    }
    if (failures.length) logger.warn?.(`harbor icon-gen: ${failures.length} failed (${failures[0].error})`);
    return { generated, candidates: candidates.length, failures };
  }

  return { plan, run, paths: { iconsDir, indexFile, stateFile, keyFiles } };
}

// Same posture as scheduleTitler: a delayed first pass so a launch is never
// competing with indexing, then a regular repeat, because a project becomes
// eligible by AGEING and nothing will wake us when it does.
function scheduleIconGen(options = {}) {
  const env = options.env || process.env;
  if (env.HARBOR_NO_ICON_GEN === '1') return { scheduled: false, reason: 'disabled' };
  if (options.e2eMode && env.HARBOR_ICON_GEN_FORCE !== '1') return { scheduled: false, reason: 'e2e' };
  const setTimer = options.setInterval || setInterval;
  const setOnce = options.setTimeout || setTimeout;
  const delay = Number(env.HARBOR_ICON_GEN_DELAY_MS || 90_000);
  // Once a DAY, per Pat (2026-08-22: "45 min is overkill, i just wanted to
  // make sure it wasnt broken"). The startup pass still covers a fresh boot,
  // so a project born mid-day gets its icon on the next launch or within a
  // day, whichever comes first.
  const every = Number(env.HARBOR_ICON_GEN_INTERVAL_MS || 24 * 3_600_000);
  const pass = async () => {
    try {
      const result = await options.run();
      options.onResult?.(result);
    } catch (error) {
      (options.logger || console).warn('harbor icon-gen failed:', error.message);
    }
  };
  const first = setOnce(pass, delay);
  first?.unref?.();
  const timer = setTimer(pass, every);
  timer?.unref?.();
  return { scheduled: true, timer, first, delay, every };
}

module.exports = {
  ICON_PX,
  createIconGenerator,
  projectsFromIndex,
  promptFor,
  scheduleIconGen,
};
