'use strict';

// Gemini's model catalog (2026-11-23): `agy models` prints one `<id>\t<label>` row per model, with the effort baked into
// the id's suffix (`gemini-4-hydrogen-low`). Harbor offers FAMILIES (the id without its effort suffix) and each family's
// own efforts, and launches with `--model <family> --effort <level>`: agy refuses a slug plus a conflicting --effort and
// silently falls back to its Neon High default (measured on 1.5.14), so the two are never sent together.
//
// Same shape as the Cursor and Codex catalogs: a cache file beside them (`gemini-models.json`), read synchronously on
// every `new-session:options`, refreshed by `provider-model-refresh.js` (30 s deadline, windowsHide, a failure keeps the
// last good file, off under HARBOR_E2E and HARBOR_NO_MODEL_DISCOVERY). Only rows whose id begins `gemini-` are offered:
// agy also lists the signed-in account's Claude and GPT-OSS rows, which are not this provider's models.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliCommand } = require('./cli-command.js');
const { resolveGeminiConfigSync, geminiChildEnv } = require('./gemini-config.js');

// Ascending, so a family's levels list in the order a person reads them.
const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`^(.+)-(${EFFORT_ORDER.join('|')})$`);

// agy's own default with no flag (a model with no --model is Neon, and --effort alone moves that family's effort).
const GEMINI_DEFAULT_EFFORT = 'high';
const GEMINI_DEFAULT_FAMILY = 'gemini-4-neon';
// What the menu offers before the first `agy models` has been cached: agy's default family's levels, nothing invented
// about any other model.
const GEMINI_EFFORT_FLOOR = ['low', 'medium', 'high', 'xhigh'];

function parseGeminiModels(text) {
  const rows = [];
  const seen = new Set();
  for (const line of String(text).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
    const cut = line.indexOf('\t');
    if (cut < 0) continue;
    const id = line.slice(0, cut).trim();
    const label = line.slice(cut + 1).trim();
    if (!/^gemini-[\w.-]+$/.test(id) || !label || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, label });
  }
  return rows;
}

// Rows -> families in first-seen order. A row whose id has no effort suffix (the orchestrators) is its own family with
// no efforts, and keeps its label whole.
function geminiFamilies(rows) {
  const families = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.id !== 'string' || typeof row.label !== 'string') continue;
    const match = EFFORT_SUFFIX.exec(row.id);
    const family = match ? match[1] : row.id;
    const entry = families.get(family) || { value: family, label: null, efforts: [] };
    if (match) {
      if (!entry.efforts.includes(match[2])) entry.efforts.push(match[2]);
      if (!entry.label) entry.label = row.label.replace(/\s+\([^()]*\)$/, '');
    } else {
      entry.label = row.label;
    }
    families.set(family, entry);
  }
  for (const entry of families.values()) entry.efforts.sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return [...families.values()];
}

// A full slug (`gemini-4-hydrogen-low`) as { family, effort }, or null for anything without an effort suffix.
function splitGeminiModel(model) {
  const match = EFFORT_SUFFIX.exec(String(model || ''));
  return match ? { family: match[1], effort: match[2] } : null;
}

function readGeminiRows(cacheFile) {
  try {
    const rows = JSON.parse(fs.readFileSync(cacheFile, 'utf8')).rows;
    return Array.isArray(rows) ? rows.filter((m) => m && /^gemini-[\w.-]+$/.test(m.id) && typeof m.label === 'string') : [];
  } catch {
    return [];
  }
}

// What `newSessionOptions` puts in the registry: Default first (no --model: agy's own default), then each family with
// its own levels. With no cache the Default row and the default family's levels stand.
function geminiModelOptions(cacheFile) {
  const families = geminiFamilies(cacheFile ? readGeminiRows(cacheFile) : []);
  const effortsByModel = {};
  for (const family of families) effortsByModel[family.value] = family.efforts;
  // The Default row IS agy's default family, so it carries that family's own levels once they are cached.
  const defaultFamily = effortsByModel[GEMINI_DEFAULT_FAMILY];
  const defaults = defaultFamily?.length ? [...defaultFamily] : [...GEMINI_EFFORT_FLOOR];
  return {
    models: [{ value: 'default', label: 'Gemini default' }, ...families.map(({ value, label }) => ({ value, label }))],
    efforts: defaults,
    effortsByModel: { ...effortsByModel, default: defaults },
    defaultEffort: GEMINI_DEFAULT_EFFORT,
  };
}

function createGeminiModelCatalog(options = {}) {
  const { cacheFile } = options;
  const env = options.env || process.env;
  const home = options.home || os.homedir();
  const platform = options.platform || process.platform;
  const execFile = options.execFile || require('node:util').promisify(require('node:child_process').execFile);
  let pending = null;
  const refresh = () => {
    if (env.HARBOR_E2E === '1' || env.HARBOR_NO_MODEL_DISCOVERY === '1') return Promise.resolve({ ok: false, reason: 'disabled' });
    if (pending) return pending;
    pending = (async () => {
      try {
        const resolved = resolveGeminiConfigSync({ env, home, platform, configuredBin: options.bin });
        if (!resolved) return { ok: false, reason: 'Gemini CLI is not installed' };
        const command = cliCommand(resolved.bin, ['models'], platform);
        const { stdout } = await execFile(command.file, command.args, {
          env: geminiChildEnv(env, { root: resolved.agyHome }), windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024,
        });
        const rows = parseGeminiModels(stdout);
        if (!rows.length) return { ok: false, reason: 'Gemini returned no model rows' };
        await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true });
        await fs.promises.writeFile(`${cacheFile}.tmp`, JSON.stringify({ rows }));
        await fs.promises.rename(`${cacheFile}.tmp`, cacheFile);
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    })().finally(() => { pending = null; });
    return pending;
  };
  return { models: () => geminiModelOptions(cacheFile), refresh };
}

// THE MODEL A GEMINI SESSION WAS GIVEN, NOT THE ONE ITS LAST STEP RAN ON (2026-11-26, Pat: "i started on the gemini
// orchestrator neon model option. but now its showing hydrogen?"). An orchestrator (`gemini-pro-orchestrator-neon`) runs its
// own steps on more than one model: Pat's stamped 56 steps `gemini-4-neon-xhigh` and 52 `gemini-4-hydrogen-xhigh`, in runs,
// so the newest step's slug named Hydrogen on the window's chip, and a resume would have reopened it as plain Hydrogen.
// agy's status-line payload (Harbor's tee, gemini-<id>.json) names the session's model by the LABEL `agy models` prints
// beside its id ("Orchestrator (Neon)" with effort null, "Gemini 4 Neon (High)" with effort "high"), so the label maps back
// to the id exactly. agy's own transcript does not help: its settings note said "Gemini 4 Neon (XHigh)" for that session.
// The tee is trusted unless the transcript went on well past its last write (a conversation continued where no tee runs).
const GEMINI_TEE_STALE_MS = 5 * 60 * 1000;
function geminiIdForLabel(label, rows) {
  const want = String(label || '').trim();
  if (!want) return null;
  const row = (Array.isArray(rows) ? rows : []).find((r) => r && typeof r.label === 'string' && r.label.trim() === want);
  return row && typeof row.id === 'string' ? row.id : null;
}
// { id, label, name, effort } for the chip and a resume, or null when the tee names no model or is stale. `name` drops the
// "(High)" agy appends for the effort, which the chip shows as its own badge; an orchestrator's "(Neon)" is its name.
function geminiChosenModel(tee, rows, { lastStepMs = null } = {}) {
  const label = typeof tee?.model?.display_name === 'string' ? tee.model.display_name.trim() : '';
  if (!label) return null;
  const writtenMs = Number(tee.writtenAtMs) || Date.parse(tee.writtenAt || '') || null;
  if (Number.isFinite(lastStepMs) && writtenMs && lastStepMs - writtenMs > GEMINI_TEE_STALE_MS) return null;
  const level = String(tee.model.effort || '').toLowerCase();
  const effort = EFFORT_ORDER.includes(level) ? level : null;
  const suffix = effort ? new RegExp(`\\s*\\(${effort}\\)$`, 'i') : null;
  const name = suffix && suffix.test(label) ? label.replace(suffix, '') : label;
  return { id: geminiIdForLabel(label, rows), label, name, effort };
}

module.exports = {
  parseGeminiModels, geminiFamilies, splitGeminiModel, geminiModelOptions, createGeminiModelCatalog, readGeminiRows,
  geminiIdForLabel, geminiChosenModel, GEMINI_TEE_STALE_MS,
  GEMINI_DEFAULT_EFFORT, GEMINI_DEFAULT_FAMILY, GEMINI_EFFORT_FLOOR,
};
