'use strict';

// What a Gemini pane needs on disk before `agy` starts (2026-11-23).
//
//   <cacheDir>/gemini/statusline.cmd         the status line command agy runs (a `.cmd` wrapper around the tee script)
//   <cacheDir>/gemini/settings-<hash>.json   one file per working folder, handed to agy as `--settings <file>`:
//                                            { statusLine: { type: 'command', command: <wrapper> },
//                                              trustedWorkspaces: [<cwd>], showFeedbackSurvey: false }
//
// `--settings` is session-only (agy: "never saved"), so none of this touches the profile's own settings.json, and the
// trust entry skips the per-folder trust dialog for THIS session only (a dialog that would take the first Harbor send).
//
// Why a `.cmd`: agy runs the status line command through `cmd /c` and a quoted path with a space in it fails (measured
// on agy 1.5.14: `'"C:\Program Files\nodejs\node.exe"' is not recognized`), so the command in the settings is the wrapper's
// own space-free path and every space-bearing path (node, the script) lives INSIDE the wrapper file.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readGeminiRows, geminiChosenModel } = require('./gemini-model-catalog.js');
const { contextDirFromEnv } = require('./gemini-status-tee.cjs');

const TEE_SCRIPT = path.join(__dirname, 'gemini-status-tee.cjs');
const TEE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;

function folderKey(cwd) {
  return crypto.createHash('sha1').update(String(cwd).replace(/[\\/]+$/, '').toLowerCase()).digest('hex').slice(0, 12);
}

function geminiDir(cacheDir) {
  return path.join(cacheDir, 'gemini');
}

function settingsPathFor(cwd, cacheDir) {
  return path.join(geminiDir(cacheDir), `settings-${folderKey(cwd)}.json`);
}

function wrapperPathFor(cacheDir) {
  return path.join(geminiDir(cacheDir), 'statusline.cmd');
}

// cmd.exe reads the command line itself, so the path it is handed must hold nothing it would split or interpret.
const CMD_SAFE = /^[^\s"&|<>^%!()]+$/;

function wrapperText({ execPath, script, electron }) {
  return [
    '@echo off',
    // Under Harbor the interpreter is Electron's own exe, which only behaves as node with this variable.
    ...(electron ? ['set "ELECTRON_RUN_AS_NODE=1"'] : []),
    `"${execPath}" "${script}"`,
    '',
  ].join('\r\n');
}

function writeIfDifferent(file, text, fsImpl) {
  try {
    if (fsImpl.readFileSync(file, 'utf8') === text) return false;
  } catch { /* absent: write it */ }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fsImpl.writeFileSync(temp, text);
  fsImpl.renameSync(temp, file);
  return true;
}

// Old per-conversation tee files: one small file per conversation never goes away on its own, so a launch sweeps the
// ones nobody has written for two weeks (plus orphaned temp files). Bounded work: one readdir.
function pruneTeeFiles(contextDir, { fsImpl = fs, now = Date.now(), maxAgeMs = TEE_MAX_AGE_MS } = {}) {
  let removed = 0;
  let names = [];
  try { names = fsImpl.readdirSync(contextDir); } catch { return 0; }
  for (const name of names) {
    if (!/^gemini-[0-9a-f-]{36}\.json(\.tmp-\d+)?$/i.test(name)) continue;
    const file = path.join(contextDir, name);
    try {
      if (now - fsImpl.statSync(file).mtimeMs > maxAgeMs) { fsImpl.rmSync(file, { force: true }); removed += 1; }
    } catch { /* gone already */ }
  }
  return removed;
}

// Writes the wrapper and this folder's settings; returns the `--settings` path. When the wrapper's path would not
// survive `cmd /c` (a space in the cache folder), the status line is left out rather than shipped broken: the pane
// still works, the linker falls back to folder and start time.
function prepareGeminiLaunch({
  cwd, cacheDir, contextDir = null, execPath = process.execPath, script = TEE_SCRIPT,
  electron = Boolean(process.versions.electron), platform = process.platform, fsImpl = fs, now = Date.now,
}) {
  const wrapper = wrapperPathFor(cacheDir);
  // showFeedbackSurvey: agy's "How's the CLI experience so far?" survey replaces the prompt box after a turn and holds
  // it until a key answers it, so every Harbor send to that window failed with "no prompt box" (2026-11-25).
  const settings = { trustedWorkspaces: [cwd], showFeedbackSurvey: false };
  let statusLine = false;
  if (platform === 'win32' && CMD_SAFE.test(wrapper)) {
    writeIfDifferent(wrapper, wrapperText({ execPath, script, electron }), fsImpl);
    settings.statusLine = { type: 'command', command: wrapper };
    statusLine = true;
  }
  const file = settingsPathFor(cwd, cacheDir);
  writeIfDifferent(file, `${JSON.stringify(settings, null, 2)}\n`, fsImpl);
  if (contextDir) pruneTeeFiles(contextDir, { fsImpl, now: now() });
  return { settingsFile: file, wrapper: statusLine ? wrapper : null, statusLine };
}

// The model a conversation was given, so a resume reopens it on that model. A resume with no --model starts agy's own
// default (Neon High, the quota-expensive one), the way a Codex resume without its recovered model would. First choice is
// the model agy's status line named for this conversation (Harbor's tee, mapped from its label to agy's id through the
// cached `agy models` list): an orchestrator's steps run on other models, and the newest step's slug reopened
// "Orchestrator (Neon)" as plain Hydrogen (2026-11-26; geminiChosenModel). Otherwise the slug on its newest
// PLANNER_RESPONSE. Null when nothing can be read: the launch then names no model, honestly.
const GEMINI_MODEL_RE = /^gemini-[\w.-]+$/;
function teeChosenModelId(contextDir, modelsFile, conversationId, lastStepMs, fsImpl) {
  try {
    const tee = JSON.parse(fsImpl.readFileSync(path.join(contextDir, `gemini-${conversationId}.json`), 'utf8'));
    if (tee?.conversation_id && tee.conversation_id !== String(conversationId)) return null;
    const chosen = geminiChosenModel(tee, readGeminiRows(modelsFile), { lastStepMs });
    return chosen?.id && GEMINI_MODEL_RE.test(chosen.id) ? chosen.id : null;
  } catch {
    return null;
  }
}
function lastGeminiModel(stateDir, conversationId, {
  fsImpl = fs, maxBytes = 2 * 1024 * 1024,
  contextDir = contextDirFromEnv(process.env), modelsFile = path.join(os.homedir(), '.cache', 'harbor', 'gemini-models.json'),
} = {}) {
  const file = path.join(stateDir, 'brain', String(conversationId), '.system_generated', 'logs', 'transcript_full.jsonl');
  let handle = null;
  try {
    handle = fsImpl.openSync(file, 'r');
    const size = fsImpl.fstatSync(handle).size;
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    fsImpl.readSync(handle, buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    if (start > 0) lines.shift(); // the cut head line
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].includes('"PLANNER_RESPONSE"')) continue;
      try {
        const record = JSON.parse(lines[i]);
        if (record.type === 'PLANNER_RESPONSE' && GEMINI_MODEL_RE.test(record.model || '')) {
          const stepMs = Date.parse(record.created_at || '');
          return teeChosenModelId(contextDir, modelsFile, conversationId, Number.isFinite(stepMs) ? stepMs : null, fsImpl) || record.model;
        }
      } catch { /* a torn or unparsable line is skipped */ }
    }
    return teeChosenModelId(contextDir, modelsFile, conversationId, null, fsImpl);
  } catch {
    return teeChosenModelId(contextDir, modelsFile, conversationId, null, fsImpl);
  } finally {
    if (handle !== null) { try { fsImpl.closeSync(handle); } catch { /* ignore */ } }
  }
}

module.exports = {
  lastGeminiModel,
  TEE_SCRIPT, TEE_MAX_AGE_MS, CMD_SAFE, folderKey, geminiDir, settingsPathFor, wrapperPathFor, wrapperText,
  pruneTeeFiles, prepareGeminiLaunch,
};
