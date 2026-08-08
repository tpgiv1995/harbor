'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { discoverProfiles } = require('../config/homes.js');

const CACHE_VERSION = 2;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/;
const UUID_BARE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const NOISE_PREFIXES = [
  '<command-name>', '<command-message>', '<local-command-stdout', '<system-reminder',
  '<task-notification', '[SYSTEM NOTIFICATION', 'Caveat: The messages below',
  '[Request interrupted',
];
const SETTINGS_COMMANDS = new Set([
  '/effort', '/model', '/fast', '/config', '/permissions', '/theme',
  '/statusline', '/compact', '/clear', '/resume',
]);
const HEAD_LINE_CAP = 400;
const HEAD_BYTE_CAP = 2_000_000;
const TAIL_BYTES = 65_536;
const PROJECT_LABEL_WIDTH = 26;
const TITLE_MAX = 110;

function codePointSlice(value, limit) {
  const points = Array.from(value);
  return points.length <= limit ? value : points.slice(0, limit).join('');
}

function codePointLength(value) {
  if (!/[\uD800-\uDBFF]/u.test(value)) return value.length;
  let length = 0;
  for (const unused of value) length += 1;
  return length;
}

function padCodePoints(value, width) {
  const length = Array.from(value).length;
  return length >= width ? value : `${value}${' '.repeat(width - length)}`;
}

function cleanText(value, limit) {
  let text = String(value).replace(/\s+/gu, ' ').trim();
  if (Array.from(text).length > limit) text = `${codePointSlice(text, limit - 1)}…`;
  return text;
}

function jsonObject(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function extractUserText(obj) {
  if (obj.type !== 'user' || obj.isSidechain || obj.isMeta) return null;
  const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
  const { content } = message;
  let text = null;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    const item = content.find((candidate) => candidate && typeof candidate === 'object' && candidate.type === 'text');
    if (item) text = item.text;
  }
  if (typeof text !== 'string' || !text.trim()) return null;
  const leading = text.trimStart();
  return NOISE_PREFIXES.some((prefix) => leading.startsWith(prefix)) ? null : text;
}

function splitLines(text) {
  const lines = text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/u);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function scanHeadLines(file, visit) {
  const parts = [];
  const fd = fs.openSync(file, 'r');
  let characters = 0;
  let lineCount = 0;
  let stopped = false;
  try {
    while (!stopped) {
      const chunk = Buffer.allocUnsafe(256 * 1024);
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      let start = 0;
      while (start < count) {
        const index = chunk.indexOf(0x0a, start);
        if (index < 0 || index >= count) break;
        parts.push(chunk.subarray(start, index + 1));
        const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts);
        let line = buffer.toString('utf8');
        if (line.endsWith('\r\n')) line = `${line.slice(0, -2)}\n`;
        lineCount += 1;
        characters += codePointLength(line);
        parts.length = 0;
        start = index + 1;
        if (visit(line) || lineCount >= HEAD_LINE_CAP || characters > HEAD_BYTE_CAP) {
          stopped = true;
          break;
        }
      }
      if (!stopped && start < count) parts.push(chunk.subarray(start, count));
    }
    if (!stopped && parts.length) {
      const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      visit(buffer.toString('utf8'));
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readTail(file, size, window) {
  const start = Math.max(0, size - window);
  const length = size - start;
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, start);
  } finally {
    fs.closeSync(fd);
  }
  let slice = buffer;
  if (start > 0) {
    const newline = buffer.indexOf(0x0a);
    slice = newline < 0 ? Buffer.alloc(0) : buffer.subarray(newline + 1);
  }
  return splitLines(slice.toString('utf8'));
}

function parseTranscript(file) {
  let cwd = null;
  let start = null;
  let summary = null;
  let firstPrompt = null;
  let commandName = null;
  scanHeadLines(file, (line) => {
    const obj = jsonObject(line);
    if (!obj) return false;
    if (cwd === null && obj.cwd) cwd = obj.cwd;
    if (start === null && obj.timestamp) start = obj.timestamp;
    if (summary === null && obj.type === 'summary' && obj.summary) summary = obj.summary;
    if (firstPrompt === null) {
      const candidate = extractUserText(obj);
      if (candidate) firstPrompt = candidate;
    }
    if (obj.type === 'user' && (commandName === null || SETTINGS_COMMANDS.has(commandName.split(/\s+/u)[0]))) {
      const message = obj.message && typeof obj.message === 'object' ? obj.message : {};
      let raw = '';
      if (typeof message.content === 'string') raw = message.content;
      else if (Array.isArray(message.content)) {
        raw = message.content
          .filter((item) => item && typeof item === 'object' && item.type === 'text')
          .map((item) => typeof item.text === 'string' ? item.text : '')
          .join(' ');
      }
      const command = raw.match(/<command-name>(\/[^<]+)<\/command-name>/u);
      if (command) {
        let candidate = command[1].trim();
        const args = raw.match(/<command-args>([^<]*)<\/command-args>/u);
        if (args && args[1].trim()) candidate = `${candidate} ${args[1].trim()}`;
        if (commandName === null || !SETTINGS_COMMANDS.has(candidate.split(/\s+/u)[0])) commandName = candidate;
      }
    }
    return Boolean(cwd && start && firstPrompt);
  });

  let last = null;
  const recent = [];
  const size = fs.statSync(file).size;
  for (const window of [TAIL_BYTES, 1_048_576]) {
    const tail = readTail(file, size, window);
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const obj = jsonObject(tail[index]);
      if (!obj) continue;
      if (last === null && obj.timestamp) last = obj.timestamp;
      if (summary === null && obj.type === 'summary' && obj.summary) summary = obj.summary;
      if (recent.length < 3) {
        const candidate = extractUserText(obj);
        if (candidate) recent.push(cleanText(candidate, 240));
      }
      if (last && summary && recent.length >= 3) break;
    }
    if (last || size <= window) break;
  }
  recent.reverse();
  const title = summary || firstPrompt || commandName;
  return {
    cwd,
    start,
    last,
    title: title ? cleanText(title, TITLE_MAX) : null,
    first_prompt: firstPrompt ? cleanText(firstPrompt, 1200) : null,
    command: commandName ? cleanText(commandName, TITLE_MAX) : null,
    recent,
  };
}

function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isNaN(ms) ? null : new Date(ms);
}

function formatNumber(value, width) {
  return String(value).padStart(width, '0');
}

function formatDate(date, includeDate = true) {
  const datePart = `${formatNumber(date.getFullYear(), 4)}-${formatNumber(date.getMonth() + 1, 2)}-${formatNumber(date.getDate(), 2)}`;
  const timePart = `${formatNumber(date.getHours(), 2)}:${formatNumber(date.getMinutes(), 2)}`;
  return includeDate ? `${datePart} ${timePart}` : timePart;
}

function createHistoryIndex(options = {}) {
  const home = path.resolve(options.home || os.homedir());
  const projectsDir = options.projectsDir || path.join(home, '.claude', 'projects');
  const cacheDir = options.cacheDir || path.join(home, '.cache', 'harbor');
  const cacheFile = options.cacheFile || path.join(cacheDir, 'index.json');
  const titlesFile = options.titlesFile || path.join(cacheDir, 'session-titles.json');
  const profiles = Array.isArray(options.profiles) ? options.profiles : null;

  function projectLabel(cwd) {
    if (!cwd) return '(unknown)';
    if (cwd.includes('\\') || /^[A-Za-z]:/u.test(cwd)) {
      const withoutDrive = cwd.replace(/^[A-Za-z]:[\\/]?/u, '');
      const parts = withoutDrive.split(/[\\/]+/u).filter(Boolean);
      return parts.length ? `win: ${parts.slice(-2).join('/')}` : 'win: ?';
    }
    if (cwd === home) return '~';
    const dev = path.join(home, 'dev');
    if (cwd === dev) return 'dev';
    if (cwd.startsWith(`${dev}${path.sep}`)) return path.relative(dev, cwd);
    if (cwd.startsWith(`${home}${path.sep}`)) {
      const parts = path.relative(home, cwd).split(path.sep);
      return parts.length > 1 ? parts.slice(-2).join(path.sep) : parts[0];
    }
    return cwd.split(path.sep).slice(-2).join(path.sep);
  }

  function loadGeneratedTitles() {
    try {
      const data = JSON.parse(fs.readFileSync(titlesFile, 'utf8'));
      return data && typeof data === 'object' && data.titles && typeof data.titles === 'object' && !Array.isArray(data.titles)
        ? data.titles : {};
    } catch {
      return {};
    }
  }

  function applyGeneratedTitles(files) {
    const titles = loadGeneratedTitles();
    for (const entry of Object.values(files)) {
      const generated = titles[entry.id];
      if (!generated || String(entry.title || '').trimStart().startsWith('BATCH TITLE:')) continue;
      entry.title = cleanText(String(generated), TITLE_MAX);
    }
    return files;
  }

  function loadCache() {
    try {
      const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      if (data.v === CACHE_VERSION && data.files && typeof data.files === 'object') return data.files;
    } catch { /* an absent or invalid cache is empty */ }
    return {};
  }

  function saveCache(files) {
    fs.mkdirSync(cacheDir, { recursive: true });
    const temporary = path.join(cacheDir, `.index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(temporary, JSON.stringify({ v: CACHE_VERSION, files }));
    fs.renameSync(temporary, cacheFile);
  }

  function discover() {
    const found = [];
    let directories;
    try { directories = fs.readdirSync(projectsDir); } catch { return found; }
    for (const directory of directories) {
      const directoryPath = path.join(projectsDir, directory);
      let directoryStat;
      try { directoryStat = fs.statSync(directoryPath); } catch { continue; }
      if (!directoryStat.isDirectory()) continue;
      let names;
      try { names = fs.readdirSync(directoryPath); } catch { continue; }
      for (const name of names) {
        if (!UUID_RE.test(name)) continue;
        const file = path.join(directoryPath, name);
        try {
          const stat = fs.statSync(file);
          found.push([name.slice(0, -6), file, stat.mtimeMs / 1000, stat.size]);
        } catch { /* a file can disappear during discovery */ }
      }
    }
    return found;
  }

  function refreshIndex(rebuild = false, env = process.env) {
    const cache = rebuild ? {} : loadCache();
    const fresh = {};
    const pending = [];
    for (const [id, file, mt, sz] of discover()) {
      const cached = cache[file];
      if (cached && cached.mt === mt && cached.sz === sz) fresh[file] = cached;
      else pending.push([id, file, mt, sz]);
    }
    for (const [id, file, mt, sz] of pending) {
      try { fresh[file] = { ...parseTranscript(file), id, mt, sz }; } catch { /* unreadable transcripts are skipped */ }
    }
    if ((pending.length || Object.keys(fresh).length !== Object.keys(cache).length) && env.HARBOR_INDEX_READ_ONLY !== '1') saveCache(fresh);
    return applyGeneratedTitles(fresh);
  }

  function entryLastDate(entry) {
    return parseTimestamp(entry.last) || new Date(entry.mt * 1000);
  }

  function flagValue(args, flag) {
    const index = args.indexOf(flag);
    if (index + 1 >= args.length || args[index + 1].startsWith('--')) throw new Error(`harbor-index: ${flag} requires a value`);
    return args[index + 1];
  }

  function parseSince(spec) {
    const now = new Date();
    if (spec === 'today') {
      const start = new Date(now);
      start.setHours(6, 0, 0, 0);
      if (now < start) start.setDate(start.getDate() - 1);
      return start;
    }
    const relative = String(spec).match(/^(\d+)([dhw])$/u);
    if (relative) {
      const scales = { d: 86_400_000, h: 3_600_000, w: 604_800_000 };
      return new Date(now.getTime() - Number(relative[1]) * scales[relative[2]]);
    }
    const absolute = String(spec).match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (absolute) {
      const result = new Date(Number(absolute[1]), Number(absolute[2]) - 1, Number(absolute[3]));
      if (!Number.isNaN(result.getTime())) return result;
    }
    throw new Error(`harbor-index: bad --since value: '${spec}' (use today, 7d, 36h, 2w, or YYYY-MM-DD)`);
  }

  function newestById(index) {
    const best = new Map();
    for (const [file, entry] of Object.entries(index)) {
      const current = best.get(entry.id);
      if (!current || entry.mt > current[1].mt) best.set(entry.id, [file, entry]);
    }
    return [...best.values()];
  }

  function emit(args, env) {
    const index = refreshIndex(args.includes('--rebuild'), env);
    const since = args.includes('--since') ? parseSince(flagValue(args, '--since')) : null;
    const projectFilter = args.includes('--project') ? flagValue(args, '--project').toLowerCase() : null;
    const showAll = args.includes('--all');
    const rows = [];
    for (const [, entry] of newestById(index)) {
      const label = projectLabel(entry.cwd);
      if (projectFilter && !label.toLowerCase().includes(projectFilter) && !String(entry.cwd || '').toLowerCase().includes(projectFilter)) continue;
      const last = entryLastDate(entry);
      if (since && last < since) continue;
      let title = entry.title;
      if (!title && !showAll) continue;
      if (!title) title = '(no user messages)';
      rows.push([last, entry.id, label, title, entry.first_prompt, entry.cwd]);
    }
    rows.sort((a, b) => b[0] - a[0]);
    const withFirstPrompt = args.includes('--with-first-prompt');
    const withCwd = args.includes('--with-cwd');
    const out = rows.map(([last, id, label, title, firstPrompt, cwd]) => {
      const shownLabel = withFirstPrompt ? label : padCodePoints(codePointSlice(label, PROJECT_LABEL_WIDTH), PROJECT_LABEL_WIDTH);
      let line = `${id}\t${formatDate(last)}\t${shownLabel}\t${title}`;
      if (withFirstPrompt) line += `\t${codePointSlice(String(firstPrompt || '').replace(/[\t\n]/g, ' '), 300)}`;
      if (withCwd) line += `\t${String(cwd || '').replace(/[\t\n]/g, ' ')}`;
      return line;
    });
    return out.length ? `${out.join('\n')}\n` : '';
  }

  function tree(args, env) {
    const index = refreshIndex(false, env);
    const showAll = args.includes('--all');
    const expanded = new Set(String(env.HIST_EXPANDED || '').split('\n').filter(Boolean));
    const groups = new Map();
    for (const [, entry] of newestById(index)) {
      if (!entry.title && !showAll) continue;
      const label = projectLabel(entry.cwd);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push([entryLastDate(entry), entry.id, entry.title || '(no user messages)', entry.cwd]);
    }
    const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((row) => row[0])) - Math.max(...a[1].map((row) => row[0])));
    const out = [];
    for (const [label, sessions] of ordered) {
      sessions.sort((a, b) => b[0] - a[0]);
      const caret = expanded.has(label) ? '▾' : '▸';
      const count = sessions.length;
      out.push(`P:${label}\t${caret} ${padCodePoints(label, 28)} ${String(count).padStart(4)} session${count !== 1 ? 's' : ''}   last ${formatDate(sessions[0][0])}`);
      if (expanded.has(label)) {
        const cwd = sessions[0][3];
        if (cwd && !cwd.includes('\\')) out.push(`N:${cwd}\t      +  new session here`);
        for (const [last, id, title] of sessions.slice(0, 12)) out.push(`S:${id}\t      └ ${formatDate(last)}  ${title}`);
        const hidden = sessions.length - 12;
        if (hidden > 0) out.push(`M:${label}\t      … ${hidden} more session${hidden !== 1 ? 's' : ''} (enter: full list)`);
      }
    }
    out.push('F:-\t+  new session in any folder...');
    return `${out.join('\n')}\n`;
  }

  function buildHomeMap() {
    // With no configured profiles, the homes are DISCOVERED from the machine
    // rather than assumed. This used to be a literal three-entry list ending in
    // a `.claude-<person's-name>` directory nobody else owns, which meant an
    // unconfigured index scored every session against one specific person's
    // account layout and attributed nothing on anybody else's.
    const homes = profiles && profiles.length
      ? profiles.filter((profile) => profile && profile.configHome && profile.id).map((profile, index) => [index, profile.configHome, profile.id])
      : discoverProfiles(home).map((profile, index) => [index, profile.configHome, profile.id]);
    const scores = new Map();
    const score = (id, index, amount) => {
      if (!scores.has(id)) scores.set(id, Array(homes.length).fill(0));
      scores.get(id)[index] += amount;
    };
    for (const [index, root] of homes) {
      try {
        for (const line of splitLines(fs.readFileSync(path.join(root, 'history.jsonl'), 'utf8'))) {
          const obj = jsonObject(line);
          if (obj && obj.sessionId) score(obj.sessionId, index, 2);
        }
      } catch { /* a profile need not have history */ }
      for (const directory of ['session-env', 'file-history']) {
        try {
          for (const name of fs.readdirSync(path.join(root, directory))) if (UUID_BARE_RE.test(name)) score(name.slice(0, 36), index, 1);
        } catch { /* a profile need not have artifacts */ }
      }
    }
    const result = {};
    for (const [id, values] of scores) {
      const top = Math.max(...values);
      if (top > 0 && values.filter((value) => value === top).length === 1) result[id] = homes[values.indexOf(top)][2];
    }
    return result;
  }

  function hydrate(args, env) {
    const days = args.includes('--days') ? Number(flagValue(args, '--days')) : 7;
    const per = args.includes('--per') ? Number(flagValue(args, '--per')) : 6;
    const maxProjects = args.includes('--max-projects') ? Number(flagValue(args, '--max-projects')) : 9;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const homes = buildHomeMap();
    const groups = new Map();
    for (const [, entry] of newestById(refreshIndex(false, env))) {
      const cwd = entry.cwd;
      if (!entry.title || !cwd || cwd.includes('\\')) continue;
      try { if (!fs.statSync(cwd).isDirectory()) continue; } catch { continue; }
      const label = projectLabel(cwd);
      if (!groups.has(label)) groups.set(label, []);
      groups.get(label).push([entryLastDate(entry), entry.id, entry.title, cwd]);
    }
    const ordered = [...groups.entries()].sort((a, b) => Math.max(...b[1].map((row) => row[0])) - Math.max(...a[1].map((row) => row[0])));
    const kept = ordered.filter(([, sessions]) => new Date(Math.max(...sessions.map((row) => row[0]))) >= cutoff).slice(0, maxProjects);
    const out = [];
    for (const [label, sessions] of kept) {
      sessions.sort((a, b) => b[0] - a[0]);
      for (const [, id, title, cwd] of sessions.slice(0, per)) {
        const titleText = String(title);
        let tab = codePointSlice(titleText.replace(/\s+/gu, ' '), 24);
        if (tab.includes(' ') && Array.from(titleText).length > 24) tab = tab.slice(0, tab.lastIndexOf(' '));
        out.push(`${label}\t${cwd}\t${id}\t${homes[id] || 'team'}\t${tab}`);
      }
    }
    return out.length ? `${out.join('\n')}\n` : '';
  }

  function findEntry(index, id) {
    const matches = Object.entries(index).filter(([, entry]) => entry.id === id);
    if (!matches.length) return [null, null];
    return matches.reduce((best, candidate) => candidate[1].mt > best[1].mt ? candidate : best);
  }

  function meta(id, env) {
    let index = applyGeneratedTitles(loadCache());
    let [file, entry] = findEntry(index, id);
    if (!entry) {
      index = refreshIndex(false, env);
      [file, entry] = findEntry(index, id);
    }
    if (!entry) throw new Error(`harbor-index: session ${id} not found`);
    return `${JSON.stringify({ id, cwd: entry.cwd, project: projectLabel(entry.cwd), title: entry.title, path: file, home: buildHomeMap()[id] || null })}\n`;
  }

  function humanSize(value) {
    let number = value;
    for (const unit of ['B', 'KB', 'MB', 'GB']) {
      if (number < 1024 || unit === 'GB') return unit === 'B' ? `${number.toFixed(0)} ${unit}` : `${number.toFixed(1)} ${unit}`;
      number /= 1024;
    }
    return '';
  }

  function preview(id, env) {
    let index = applyGeneratedTitles(loadCache());
    if (!Object.keys(index).length) index = refreshIndex(false, env);
    const [file, entry] = findEntry(index, id);
    if (!entry) return `session ${id} not in index yet (press ctrl-r to reload)\n`;
    const last = entryLastDate(entry);
    const lines = [entry.title || '(no title)', '─'.repeat(40), `project      ${projectLabel(entry.cwd)}`, `directory    ${entry.cwd || '(unknown)'}`];
    const start = parseTimestamp(entry.start);
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    if (start) lines.push(`started      ${weekdays[start.getDay()]} ${formatDate(start)}`);
    lines.push(`last active  ${weekdays[last.getDay()]} ${formatDate(last)}`, `size         ${humanSize(entry.sz || 0)}`, `session id   ${id}`);
    if (entry.first_prompt) lines.push('', 'first prompt:', `  ${entry.first_prompt}`);
    if (entry.recent && entry.recent.length) lines.push('', 'recent prompts:', ...entry.recent.map((prompt) => `  • ${prompt}`));
    return `${lines.join('\n')}\n`;
  }

  function run(argv, env = process.env) {
    const [command, ...args] = argv;
    if (command === 'emit') return emit(args, env);
    if (command === 'tree') return tree(args, env);
    if (command === 'hydrate') return hydrate(args, env);
    if (command === 'meta' && args.length) return meta(args[0], env);
    if (command === 'preview' && args.length) return preview(args[0], env);
    throw new Error('harbor-index: invalid command');
  }

  return { run, refreshIndex, buildHomeMap, parseTranscript, projectLabel };
}

function createHistoryIndexWorker(options = {}) {
  let worker = null;
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  function rejectPending(error) {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  }

  function ensureWorker() {
    if (closed) throw new Error('history index worker is closed');
    if (worker) return worker;
    worker = new Worker(__filename, {
      workerData: { historyIndexWorker: true, options },
    });
    worker.unref();
    worker.on('message', (message) => {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (!pending.size && worker) worker.unref();
      if (message.error) {
        const error = new Error(message.error.message);
        error.name = message.error.name || 'Error';
        error.code = message.error.code;
        request.reject(error);
      } else {
        request.resolve(message.result);
      }
    });
    worker.on('error', (error) => rejectPending(error));
    worker.on('exit', (code) => {
      const exited = worker;
      worker = null;
      if (!closed && exited) rejectPending(new Error(`history index worker exited with code ${code}`));
    });
    return worker;
  }

  function request(method, args = []) {
    const target = ensureWorker();
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      target.ref();
      target.postMessage({ id, method, args });
    });
  }

  return {
    run: (argv, env = {}) => request('run', [argv, env]),
    buildHomeMap: () => request('buildHomeMap'),
    close: async () => {
      if (closed) return;
      closed = true;
      rejectPending(new Error('history index worker closed'));
      const target = worker;
      worker = null;
      if (target) await target.terminate();
    },
  };
}

module.exports = { CACHE_VERSION, createHistoryIndex, createHistoryIndexWorker, parseTranscript };

if (!isMainThread && workerData && workerData.historyIndexWorker) {
  const index = createHistoryIndex(workerData.options || {});
  parentPort.on('message', (message) => {
    try {
      let result;
      if (message.method === 'run') {
        const [argv, env] = message.args;
        result = index.run(argv, { ...process.env, ...env });
      } else if (message.method === 'buildHomeMap') {
        result = index.buildHomeMap();
      } else {
        throw new Error(`unknown history index worker method: ${message.method}`);
      }
      parentPort.postMessage({ id: message.id, result });
    } catch (error) {
      parentPort.postMessage({
        id: message.id,
        error: { name: error.name, message: error.message, code: error.code },
      });
    }
  });
}
