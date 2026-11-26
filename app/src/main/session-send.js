'use strict';

// The command bar's engine. A tile's session may be (a) live in a daemon pane,
// (b) historical (resumable), or (c) live somewhere Harbor cannot reach (a
// terminal outside Harbor). This module resolves which, acquires pty control,
// and delivers the composed text; resuming first when needed and refusing
// honestly when it cannot deliver (a silently dropped prompt is the one
// unforgivable failure mode here).

const { EventEmitter } = require('node:events');
const { AsyncLocalStorage } = require('node:async_hooks');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { parseMenu, menuArrowToward, MENU_KEYS } = require('./menu-parse.js');
const { parseGeminiFirstRun, answerGeminiFirstRun, isGeminiFirstRunAction } = require('./gemini-first-run.js');
const { parseGenericList, locateRow } = require('./generic-list.js');
const { parseWorkMeter } = require('./work-meter.js');
const { isDividerLine, isPromptEdgeLine } = require('../shared/divider.cjs');
const { withLock } = require('../shared/os-lock.cjs');
const peerInbox = require('../shared/peer-inbox.cjs');
const { mergeAsk, normalizeAsk, currentQuestionIndex, isReviewMenu, answeredFromStrip, CHAT_ROW_RE } = require('./ask-question.js');
const { readCodexRolloutCwd: codexRolloutCwd } = require('./providers/provider-session-link.js');
const { readTranscriptTailRecords } = require('./providers/transcript.js');
const { planResumeNudge } = require('./resume-nudge.js');
const { stripInvisible, dropAllInvisible } = require('../shared/invisible-chars.cjs');
const { resolveContextDir } = require('./isolation.js');

// Claude Code's project-dir munge: every non-alphanumeric cwd character
// becomes '-' ('/home/you/dev/harbor' -> '-home-you-dev-harbor').
function claudeProjectDir(cwd, home = os.homedir()) {
  return path.join(home, '.claude', 'projects', String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-'));
}

function codexDayDir(home, date) {
  return path.join(
    home, '.codex', 'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

// Antigravity CLI (`agy`, the Gemini provider) keeps every conversation under
// its home's brain folder, whatever folder it ran in:
// <home>\.gemini\antigravity-cli\brain\<uuid>\.system_generated\logs\transcript_full.jsonl
// (the plain transcript.jsonl cuts long fields, so it can never confirm a long
// message). The home is the profile root, which agy follows through USERPROFILE.
const GEMINI_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const geminiStoreDir = (home = os.homedir()) => path.join(home, '.gemini', 'antigravity-cli');
const geminiBrainDir = (home = os.homedir()) => path.join(geminiStoreDir(home), 'brain');
const geminiTranscriptFile = (home, id) => path.join(geminiBrainDir(home), String(id), '.system_generated', 'logs', 'transcript_full.jsonl');
// A transcript path the rail may hold as the CUT copy names the sibling that is
// whole; anything else is returned as it came.
const GEMINI_CUT_COPY_RE = /([\\/]\.system_generated[\\/]logs[\\/])transcript\.jsonl$/;
function geminiWholeTranscriptPath(file) {
  const named = String(file || '');
  if (!GEMINI_CUT_COPY_RE.test(named)) return named;
  const whole = named.replace(GEMINI_CUT_COPY_RE, '$1transcript_full.jsonl');
  return fsSync.existsSync(whole) ? whole : named;
}
// The prompt history of the home a Gemini transcript lives in
// (<home>\.gemini\antigravity-cli\history.jsonl), or null for any other path.
const GEMINI_TRANSCRIPT_IN_HOME_RE = /^(.*[\\/]\.gemini[\\/]antigravity-cli)[\\/]brain[\\/][^\\/]+[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/i;
function geminiHistoryPathFor(file) {
  const found = GEMINI_TRANSCRIPT_IN_HOME_RE.exec(String(file || ''));
  return found ? path.join(found[1], 'history.jsonl') : null;
}

// Where each provider keeps the transcripts a NEW pane could have just written.
// A provider this module does not know lists NOTHING: it used to fall through to
// the Claude project folder, so a fourth provider launched in a folder that had
// Claude sessions was linked to a Claude conversation (2026-11-23 map, item 2).
function providerTranscriptDirs(provider, cwd, home = os.homedir(), date = new Date()) {
  if (!provider || provider === 'claude') return [claudeProjectDir(cwd, home)];
  if (provider === 'codex') {
    // Yesterday too: a session launched before midnight writes its rollout
    // into the NEXT day's directory, and a scan of today alone would then
    // count every one of yesterday's rollouts as brand new.
    const yesterday = new Date(date.getTime() - 24 * 60 * 60_000);
    return [codexDayDir(home, date), codexDayDir(home, yesterday)];
  }
  if (provider === 'cursor') {
    // Runs of non-alphanumerics collapse to ONE dash, as Cursor names the
    // folder and as provider-history.js, transcript.js and provider-session-
    // link.js all read it: 'C:\dev\x' is 'C-dev-x'. The per-character form
    // made 'C--dev-x', which no Windows path ever produces.
    const project = String(cwd || '').replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-');
    return [path.join(home, '.cursor', 'projects', project, 'agent-transcripts')];
  }
  if (provider === 'gemini') return [geminiBrainDir(home)];
  return [];
}

async function transcriptFiles(provider, cwd, home = os.homedir()) {
  const files = [];
  for (const dir of providerTranscriptDirs(provider, cwd, home)) {
    if (provider === 'cursor') {
      const ids = await fs.readdir(dir).catch(() => []);
      for (const id of ids) files.push({ id, file: path.join(dir, id, `${id}.jsonl`) });
    } else if (provider === 'gemini') {
      const ids = await fs.readdir(dir).catch(() => []);
      for (const id of ids.filter((name) => GEMINI_ID_RE.test(name))) files.push({ id, file: geminiTranscriptFile(home, id) });
    } else {
      const names = await fs.readdir(dir).catch(() => []);
      for (const name of names.filter((item) => item.endsWith('.jsonl'))) {
        const id = provider === 'codex'
          ? name.match(/([0-9a-f]{8}-[0-9a-f-]{27})\.jsonl$/i)?.[1]
          : name.slice(0, -6);
        if (id) files.push({ id, file: path.join(dir, name) });
      }
    }
  }
  return files;
}

// A folder path as one comparable string: slashes one way, no trailing slash, a
// file:/// URI undone, case folded on Windows. Used to ask "did this
// conversation start in the pane's folder".
function sameFolder(a, b, platform = process.platform) {
  const norm = (value) => {
    let text = String(value || '').trim();
    if (/^file:\/\/\//i.test(text)) { try { text = decodeURIComponent(text.replace(/^file:\/\/\//i, '')); } catch { text = text.replace(/^file:\/\/\//i, ''); } }
    text = text.replace(/\\/g, '/').replace(/\/+$/, '');
    return platform === 'win32' ? text.toLowerCase() : text;
  };
  const left = norm(a);
  return Boolean(left) && left === norm(b);
}

// Provisional session<->pane links. The sidebar model learns pane<->session
// pairs from daemon agent detection, which can lag on a busy daemon; the
// launch flows KNOW the pairing the moment the fresh pane appears (snapshot
// diff), so they record it here and the renderer merges it immediately.
function createLinkRegistry({ ttlMs = 15 * 60_000 } = {}) {
  const emitter = new EventEmitter();
  const links = new Map(); // sessionId -> { paneId, workspaceId, at }
  const prune = () => {
    const cutoff = Date.now() - ttlMs;
    for (const [id, link] of links) if (link.at < cutoff) links.delete(id);
  };
  return {
    emitter,
    set(sessionId, { paneId, workspaceId }) {
      if (!sessionId || !paneId) return;
      links.set(sessionId, { paneId, workspaceId: workspaceId || null, at: Date.now() });
      emitter.emit('update');
    },
    dropPane(paneId) {
      for (const [id, link] of links) {
        if (link.paneId === paneId) links.delete(id);
      }
      emitter.emit('update');
    },
    get(sessionId) {
      prune();
      return links.get(sessionId) || null;
    },
    all() {
      prune();
      return Object.fromEntries([...links].map(([id, l]) => [id, { paneId: l.paneId, workspaceId: l.workspaceId }]));
    },
  };
}

// A dialog can be as tall as the pane, and panes are grown to 60 rows so
// Claude's dialogs fit in them (terminalBridge.ensureDialogSize). Reading fewer
// lines than the pane is tall would re-create the very clipping the resize
// removed, one layer further out. EVERY parseMenu read uses this: the card and
// the send-refusal must never disagree about whether a menu is on screen.
const MENU_READ_LINES = 90;

// "Claude has stopped repainting", without demanding two BYTE-identical reads.
// The composer footer carries live numbers (cost, context, elapsed) and the
// status line re-renders on its own, so byte equality made settling a matter of
// luck; and any pane resize during the wait changes the wrap width, which broke
// it outright. Compare what the screen SAYS: drop the trailing status lines and
// collapse whitespace.
function settleKey(screen) {
  const lines = String(screen || '').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  // The last two rendered lines are the model/cost status line and the mode
  // hint; both tick on their own while nothing is actually happening.
  return lines.slice(0, Math.max(0, lines.length - 2)).join('\n').replace(/[ \t]+/g, ' ').trim();
}


// Claude draws its COMPOSER inside a box: a full-width divider immediately
// above the "❯" line. That divider, not the pointer, is what tells a composer
// apart from a dialog, and both halves of that were live-caught on 2026-07-28.
//
// The pointer alone is not enough in EITHER direction. Pat's window put a
// "needs your answer" panel over a session that was simply idle with a draft
// typed into it ("❯ push the guard"), because the old test demanded a LONE
// pointer and a composer with text in it did not match. And widening it to
// "any ❯ line" would have broken the other way on the /rewind dialog that was
// on that very pane an hour later, whose selected row is "❯ (current)": no
// number, no chrome, and it genuinely does need an answer.
const NUMBERED_ROW_RE = /^\s*(?:❯\s*)?\d+\.\s+\S/;
function isComposerLine(lines, i) {
  const line = lines[i] ?? '';
  if (!/^\s*❯(?:\s|$)/.test(line)) return false;
  if (NUMBERED_ROW_RE.test(line)) return false;        // a menu row, not a prompt
  if (/^\s*❯\s*$/.test(line)) return true;             // an empty composer
  return isPromptEdgeLine(lines[i - 1]);             // else require the box edge
}

// A DRAFT THAT STARTS WITH A NUMBER IS STILL A DRAFT (2026-10-13, Pat: "whats
// this bug?"). He answered three numbered questions with "1. yes ... 2. ...
// 3. ...", so the prompt line read "❯ 1. yes - do we need", which is exactly a
// menu's selected row. isComposerLine refused it for that reason, the pointer
// row test called the pane blocked, and the send stopped with "a prompt
// appeared in the session while Harbor was typing" 0.2 s after typing. The
// answer panel then offered keys over his own draft; its Enter submitted the
// message, and the retry typed it a second time, so Claude got it twice.
//
// The whole box decides, not the first line: Claude's prompt is the last two
// dividers on screen with the glyph line directly under the top one, and the
// tail under the bottom one is only its status lines. A menu row can sit under
// a divider (AskUserQuestion's "Chat about this" does, in every capture), but
// nothing closes it from below. This also covers a draft too tall for the
// prompt line to be in the ten-line tail, where the draft's own words ("Do you
// want", "Enter to confirm") used to read as dialog chrome. Dialog keys UNDER
// the box mean it is not the prompt, which leaves the older tests in charge.
// Fixtures: test/fixtures/composer-vs-dialog/*-numbered-draft-2.1.296.txt.
function endsAtPrompt(lines, tailLength) {
  const found = composerBox(lines.join('\n'));
  if (!found || found.bottom < lines.length - tailLength) return false;
  const under = lines.slice(found.bottom + 1).join('\n');
  return !BLOCKED_CHROME_RE.test(under) && !DIALOG_CANCEL_RE.test(under);
}

// AN ENTER IS NOT A SUBMISSION (2026-09-23). Two image sends into a session
// with a 48MB transcript typed their text and image into Claude's composer and
// neither Enter submitted; both messages sat there until a third send's Enter
// carried all of it, that send's "/compact" glued onto the end. Measured against
// the real CLI 2.1.280 in an isolated pty: when the text and the Enter reach
// Claude in ONE read, which is what happens when a busy CLI does not read its
// input for the 160ms between Harbor's two writes, the Enter is taken as part of
// the text and nothing submits. Whether the bytes coalesce is the console's
// call, not ours (the same single write submitted in two fresh panes and not in
// a third), so no delay makes it impossible; checking the result does.
//
// The same drive showed the timing has no useful bound: the first message into
// a freshly started CLI had its real Enter swallowed, and a second after the
// Enter the composer did not even show the text yet, because the CLI had not
// read its input at all. So the verdict is read off the screen until it is
// decided, rather than once at a fixed delay.
//
// The composer is the box between the LAST two dividers, first line the prompt
// glyph. Three answers:
//   holds    the box ENDS with this send: the tail of the typed text (the cursor
//            sits at the end, so a box too short for a long draft still shows
//            its end), Claude's "[Pasted text #N +M lines]" placeholder for a
//            large paste, or an image-only send's own marker. Ends with, not
//            contains: an empty box can carry a hint or a suggested prompt, and
//            a spare Enter must never be pressed into one of those.
//   taken    the box does not hold it and the send is echoed ABOVE the box,
//            where Claude draws a submitted prompt and a message queued behind
//            a running turn alike.
//   pending  neither yet: the CLI has not drawn the text.
// A screen with no composer box on it at all answers `nobox`.
// Whitespace is dropped before comparing, because the box re-wraps the text
// and pads its lines. Fixtures: test/fixtures/composer-enter/.
//
// Two prompt shapes measured on CLI 2.1.295 (2026-10-09) that this used to call
// `pending` or `nobox` while the text sat right there: a SINGLE-LINE message
// somewhere past 800 characters collapses to "[Pasted text #1]" with no line
// count (799 drew literally, 1,599 collapsed), and a message starting with "!"
// switches the prompt to shell mode, which draws "!" where the "❯" would be.
const SEND_TAIL_CHARS = 24;
const PASTE_PLACEHOLDER_RE = /\[Pastedtext#\d+(?:\+\d+lines)?\]/;
// Comfortably under the measured collapse point; a long send that still draws
// literally matches on its tail first, so this only ever ADDS the placeholder.
const PASTE_COLLAPSE_CHARS = 700;
const mayCollapseToPlaceholder = (text) => /\n/.test(String(text || '')) || String(text || '').length >= PASTE_COLLAPSE_CHARS;
// A LONG LINE TYPED IN ONE WRITE LOSES ALL BUT ITS LAST 1,024 CHARACTERS
// (2026-11-04, Pat: "i keep having text get cut off in this chat"). Claude CLI
// 2.1.316 on Windows reads typed input in 1,024-character pieces and keeps only
// the LAST piece of a run that arrives without paste markers: a 1,611-character
// line reached the prompt as its last 587 characters, a 2,600-character line as
// its last 552 (isolated probe, no Harbor involved). The count is characters,
// not bytes: 690 characters of accents or emoji (over 1,024 bytes) arrived
// whole. Every one-line send over 1,024 since Oct 30 was cut this way (five, all
// "could not confirm"), while every send with a line break went as a paste and
// arrived whole up to 8,165 characters. A bracketed paste is one piece however
// it is read (a 2,600-character one-line paste submitted whole, transcript
// checked), so anything long enough to be at risk goes as a paste, the same
// mark the gate already treats as possibly drawn as "[Pasted text #N]".
const asPaste = (text) => `\x1b[200~${text}\x1b[201~`;
const typedPayload = (text) => (mayCollapseToPlaceholder(text) ? asPaste(text) : text);
const PROMPT_GLYPH_RE = /^\s*[❯!]/;
// Dim text Claude draws in an EMPTY box that is an instruction, not a draft or
// a prediction (the welcome hint is also dropped by the keeper's reader).
const CLAUDE_BOX_HINT_RE = /^(?:Try ".*"|Press up to edit queued messages)$/;
const squashSpace = (value) => String(value || '').replace(/\s+/g, '');
// What a screen SAYS near its bottom (the prompt box, the status line, the
// spinner), not how it is laid out: whitespace and box-drawing dropped, last
// 400 characters. The keeper reflowing a frozen CLI's last frame on a resize
// changes line breaks and edge lengths, never these; a CLI that drew anything
// (a spinner tick, its timer, text) changes them. Used wherever "the CLI drew
// since" is evidence (Sol's review, round three: a resize alone had counted).
const screenContent = (screen) => String(screen || '').replace(/[\s\u2500-\u257F]/g, '').slice(-400);

// CLAUDE DRAWS A PASTED IMAGE PATH AS AN IMAGE CHIP (2026-10-14, Pat from the
// phone: "FYI" with a screenshot refused after three minutes, and the next
// session's "What's the deal? Fix please" with a screenshot refused while
// Claude had in fact submitted it). harbor-server has no clipboard, so a phone
// image goes in as its upload's path on an "Image:" line above the message,
// pasted because of that newline. CLI 2.1.299's paste handler, read from the
// binary: split the paste at every newline and at every space that starts a
// path, attach each segment naming a .png/.jpg/.jpeg/.gif/.webp file as an
// image, then insert one [Image #N] chip per image FOLLOWED BY the remaining
// segments joined with newlines. The prompt showed "[Image #13]Image:" over
// "FYI"; the check wanted the 24-character tail of "Image: <path>\nFYI", which
// ends in the path, so it could never match a message shorter than that. When
// no image could be read the CLI inserts the paste unchanged, so both forms
// count. Returns the (whitespace-free) text that follows the chips and how many
// images the paste names, or null for a send with no image path in it.
//
// 2.1.311 STOPPED ATTACHING A PATH THAT SHARES ITS LINE WITH OTHER WORDS
// (2026-10-28; changelog: "pasting text that mentions an image file ...
// attaching the image and dropping its path"). A line now converts only when
// every segment of it is a path, so "Image: <path>" stayed literal text: the
// image reached Claude as a path to Read and never as an attachment
// (drive-prompt-gate-win.js on 2.1.312). A Claude pane therefore gets each
// path quoted on a line of its own, which converts on 2.1.299 through 2.1.312
// alike, before or after the text (measured with no model turn, 2.1.310 and
// 2.1.312: "[Image #1]FYI").
const IMAGE_PATH_RE = /\.(png|jpe?g|gif|webp)$/i;
const IMAGE_CHIPS_RE = /\[Image#\d+\]/g;
const countImageChips = (inside) => (inside.match(IMAGE_CHIPS_RE) || []).length;
const unquote = (value) => ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  ? value.slice(1, -1)
  : value);
const isImagePathSegment = (segment) => IMAGE_PATH_RE.test(unquote(segment.trim()));
function textAfterImageChips(text) {
  const segments = String(text || '').split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap((segment) => segment.split('\n'))
    .filter((segment) => segment.trim());
  const imageCount = segments.filter(isImagePathSegment).length;
  if (!imageCount) return null;
  const words = segments.filter((segment) => !isImagePathSegment(segment)).join('\n');
  return { rest: squashSpace(words), words, imageCount };
}
// CLAUDE DRAWS THE REST OF A SLASH WORD AFTER THE CURSOR (2026-11-04, Pat from
// the phone: "I'm in a death loop on this mobile session where it won't let me
// send messages"). His message ended "Send to me via /dm", and the prompt drew
// it as "Send to me via /dml-log +3". CLI 2.1.316, read from the binary: in
// prompt mode, when the text before the cursor ends in a "/word" and the list
// of matching commands is not open, the prompt draws the first match's
// remaining letters right after that word, plus " +N" when N more commands
// match. It is drawn, not typed: only Tab takes it, and Enter submits exactly
// what was typed (the binary's return handler submits the value; every state
// driven against the real CLI submitted the typed text). A plain-text read
// cannot see that it is dim, so it is matched by its shape, and only when the
// send itself ends in a slash word (the cursor sits at the end of what Harbor
// typed). The list form, drawn ABOVE the box, never reaches the box. Bash
// mode's history completion is drawn the same way but can be any text, so a
// "!" send gets no such slack. Fixture: composer-enter/slash-ghost-2.1.316.txt.
// The completion is read off the box text BEFORE whitespace is dropped: its
// letters touch the typed word, and only " +N" has a space. Squashed, "via
// /dm now please" would end in "nowplease" and pass for one.
const SLASH_WORD_END_RE = /(?:^|\s)\/[\w:.-]*$/;
const SLASH_GHOST_TAIL_RE = /([\w:.-]*)( \+\d+)?$/;
// What a box would read without a drawn completion at its end, whitespace
// dropped like `inside`: one reading per place the typed word could stop, or
// none when `text` does not end in a slash word. `raw` is the box's own text
// (composerBox `raw`), line breaks and single spaces intact.
function slashGhostRests(raw, text) {
  return slashGhostDrafts(raw, text).map(squashSpace);
}
// The same readings as drawn, spaces kept (drawnSpacingAgrees).
function slashGhostDrafts(raw, text) {
  const value = String(text || '');
  if (/^\s*!/.test(value) || !SLASH_WORD_END_RE.test(value)) return [];
  const box = String(raw || '').replace(/\s+$/, '');
  const [, word, count = ''] = SLASH_GHOST_TAIL_RE.exec(box);
  const base = box.slice(0, box.length - word.length - count.length);
  const rests = [];
  for (let typed = 0; typed <= word.length; typed += 1) {
    if (typed === word.length && !count) continue; // nothing drawn after the word
    // The completion touches the typed word: never a space in front of it.
    const before = base + word.slice(0, typed);
    if (!before || /\s$/.test(before)) continue;
    rests.push(before);
  }
  return rests;
}
// Does the box end with `needle` (whitespace dropped) followed by nothing but
// Claude's drawn completion of the send's last slash word? `exact` wants the
// box to be exactly `needle` plus that completion.
function slashGhostFollows(raw, needle, text, { exact = false } = {}) {
  if (!needle) return false;
  return slashGhostRests(raw, text).some((rest) => (exact ? rest === needle : rest.endsWith(needle)));
}
const endsWithSend = (found, needle, text) => found.inside.endsWith(needle) || slashGhostFollows(found.raw, needle, text);
function composerBox(screen) {
  const lines = String(screen || '').split('\n');
  let bottom = -1;
  let top = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!isPromptEdgeLine(lines[i])) continue;
    if (bottom < 0) { bottom = i; continue; }
    top = i;
    break;
  }
  const box = top < 0 ? [] : lines.slice(top + 1, bottom);
  if (!box.length || !PROMPT_GLYPH_RE.test(box[0])) return null;
  const shell = /^\s*!/.test(box[0]);
  const raw = box.join('\n').replace(PROMPT_GLYPH_RE, '');
  return { lines, top, bottom, box, shell, raw, inside: squashSpace(raw) };
}
// A DRAFT IS THIS SEND ONLY WITH THIS SEND'S SPACES (Sol's review, round
// thirty-eight). The box is compared with whitespace dropped because the
// prompt wraps a message wherever it likes; but a draft that differs from the
// send only in its spaces is another message ("releasenotes.txt" is not
// "release notes.txt"), and an Enter-only retry would send it. Inside a drawn
// row the spaces must be the text's own, run for run; where the prompt broke
// a row the text may hold a space run, nothing (a word cut in two), or one
// line break per row break. What a screen cannot settle (a tab, an indented
// line) is never this send on the screen's word alone.
function drawnSpacingAgrees(raw, text) {
  const typed = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  if (/\t/.test(typed) || /\n[ \t]/.test(typed)) return false;
  const rows = String(raw || '').split('\n').map((row) => row.trim());
  while (rows.length && !rows[0]) rows.shift();
  while (rows.length && !rows.at(-1)) rows.pop();
  let at = 0;
  for (let r = 0; r < rows.length;) {
    if (typed.slice(at, at + rows[r].length) !== rows[r]) return false;
    at += rows[r].length;
    r += 1;
    if (r === rows.length) break;
    let breaks = 1;
    while (r < rows.length && !rows[r]) { breaks += 1; r += 1; }
    const run = /^[ \n]*/.exec(typed.slice(at))[0];
    const newlines = run.split('\n').length - 1;
    if (newlines ? newlines !== breaks : breaks !== 1) return false;
    at += run.length;
  }
  return at === typed.length;
}
// A screen settles a draft alone only when no row of it runs on into the next
// (round thirty-nine): at such a break "release" / "notes.txt" reads as
// "releasenotes.txt" cut in two just as well as "release notes.txt" wrapped at
// its space. A BLANK row between two rows is no wrap (a wrap never draws one),
// so paragraphs each on one row, as Codex's own continuation draft is drawn,
// are settled; chips never are, since a chip never says which picture it is.
const drawnWithoutWraps = (raw) => {
  const rows = String(raw || '').split('\n').map((row) => row.trim());
  while (rows.length && !rows[0]) rows.shift();
  while (rows.length && !rows.at(-1)) rows.pop();
  return rows.length > 0 && rows.every((row, n) => n === 0 || !row || !rows[n - 1]);
};
// Picture chips out of a drawn draft: a row of nothing but chips goes whole.
const draftWords = (draft) => String(draft || '').split('\n')
  .filter((row) => !/^\s*(?:\[Image\s*#\d+\]\s*)+$/.test(row))
  .map((row) => row.replace(/\[Image\s*#\d+\]\s?/g, ''))
  .join('\n');
// The same draft in two frames (round thirteen): the box text is unchanged,
// whitespace dropped (a reflow is not a change), allowing only Claude's drawn
// completion of the send's last slash word to come or go.
function sameComposerDraft(a, b, text) {
  const x = composerBox(a);
  const y = composerBox(b);
  if (!x || !y) return false;
  if (x.inside === y.inside) return true;
  const xs = new Set([x.inside, ...slashGhostRests(x.raw, text)]);
  return [y.inside, ...slashGhostRests(y.raw, text)].some((rest) => xs.has(rest));
}
function composerSendState(screen, { text = '', pasted = false, imageMarker = null } = {}) {
  const found = composerBox(screen);
  if (!found) return 'nobox';
  const { lines, top, inside } = found;
  const above = squashSpace(lines.slice(0, top).join('\n'));
  // In shell mode the typed "!" IS the glyph, so the box shows the rest.
  const shown = found.shell ? squashSpace(text).replace(/^!/, '') : squashSpace(text);
  const tail = shown.slice(-SEND_TAIL_CHARS);
  const marker = squashSpace(imageMarker);
  // The same send with its image paths drawn as chips (textAfterImageChips),
  // which only counts while the box actually shows a chip.
  const chipped = found.shell ? null : textAfterImageChips(text);
  const chipTail = chipped ? chipped.rest.slice(-SEND_TAIL_CHARS) : '';
  if (tail ? endsWithSend(found, tail, text) : Boolean(marker && inside.endsWith(marker))) return 'holds';
  if (chipped && countImageChips(inside) > 0
    && (chipTail ? endsWithSend(found, chipTail, text) : /\[Image#\d+\]$/.test(inside))) return 'holds';
  if (pasted && new RegExp(`${PASTE_PLACEHOLDER_RE.source}$`).test(inside)) return 'holds';
  if (tail ? above.includes(tail) : Boolean(marker && above.includes(marker))) return 'taken';
  if (chipTail && above.includes(chipTail)) return 'taken';
  if (pasted && PASTE_PLACEHOLDER_RE.test(above)) return 'taken';
  return 'pending';
}

// CODEX'S PROMPT BOX (Codex 0.165.0, read from real 120-column captures,
// 2026-10-29). The box is the LAST line that starts with "›" plus the lines
// wrapped under it; the transcript draws earlier prompts with the same glyph,
// which is why it is the last one. Under the box sits one footer line
// ("GPT-6.1-Sol low · <folder> · <thread title>"), and the title can repeat a
// message, so the footer is never read as part of the box (the default status
// line, tui/src/chatwidget.rs DEFAULT_STATUS_LINE_ITEMS; no home sets its own).
// A selection list draws its highlighted row with the same glyph ("› 1. Update
// now", "› 1. Trust and continue") and has no model footer, only key hints
// ("enter continue · esc skip"), so a numbered row over no footer is a dialog;
// a message that starts "1. " still sits over the footer. A paste over 1,000
// characters is drawn as "[Pasted Content N chars]", N counting characters (an
// Enter Codex swallowed into the paste adds one).
//
// ON ULTRA EFFORT THE BOX IS DRAWN WITH "»" (2026-11-05, Pat: "codex not working
// on new session"). Codex 0.166.0 starts with "›" and, once startup ends,
// redraws its box as "» Ask Codex to do anything" on ultra and on no other
// effort (measured in a throwaway home on gpt-6-astra and gpt-6.1-sol at every
// effort; a draft keeps "»"), while the transcript keeps "›" for earlier
// prompts. Knowing only "›", Harbor saw no box in any Ultra pane and refused
// every send with "Codex is not showing its prompt box". Either mark is the
// box; it is still the LAST such line, and every other rule here is unchanged.
// Extra time a Codex box may take to show a pasted message, on top of the base
// wait: 3 ms per character, about four times the slowest rate measured
// (2026-11-05, see CODEX_HOLD_POLLS in createSessionSend). Shared with the
// cross-session typer (C:\tools\harbor-peek\type.cjs).
const CODEX_ABSORB_MS_PER_CHAR = 3;
const codexAbsorbAllowanceMs = (text) => [...String(text || '')].length * CODEX_ABSORB_MS_PER_CHAR;
const CODEX_PROMPT_RE = /^[›»](?:\s|$)/u;
const CODEX_LIST_ROW_RE = /^[›»]\s*\d+\.\s/u;
const CODEX_FOOTER_RE = /^\s+\S.*?\s·\s(?:~|[A-Za-z]:|\/)/u;
const CODEX_PASTE_RE = /^\[PastedContent(\d+)chars\](?:#\d+)?$/;
const CODEX_LARGE_PASTE_CHARS = 1000;
// WHILE A TURN RUNS, OR ONCE THE BOX HOLDS TEXT, THE LINE UNDER THE BOX IS KEY
// HINTS, NOT THE STATUS LINE (2026-10-31, a send into a working Astra pane):
// "tab to queue message" with "21% context left" at the right edge. Read as part
// of the box, it made every send into a busy Codex look unshown. The hint words
// are the binary's own spans (" to queue message", " for shortcuts", " to edit
// previous message", " for agents"), each after one or two key names.
const CODEX_HINT_FOOTER_RE = /^\s+(?:\S+\s+){0,2}(?:to queue message|to queue|for shortcuts|to edit previous message|for agents)\b|^\s+\S.*\b\d{1,3}% context left\s*$/u;
// An empty box draws one of these dim hints (Codex 0.165.0 and 0.166.0 binaries);
// a plain-text screen read cannot see dimness, so they are matched by text.
const CODEX_EMPTY_HINTS = new Set(['AskCodextodoanything', 'Askafollow-upquestion']);
// These read-only notices replace the composer but leave historical prompt
// rows on screen. Their final key hints own input, including single letters
// that start or fork a chat. Match the footer, not quoted notice text above a
// recovered composer. The daemon carries the same provider-specific veto.
const CODEX_PROVIDER_NOTICE_RE = /(?:^|\s)n\s+start\s+fresh\s*·\s*esc\s+other\s+chats\s*$/u;
const CODEX_WRITER_NOTICE_RE = /(?:^|\s)r\s+retry\s+f\s+fork\s+(?:(?:←\/)?esc\s+command\s+center\s+)?(?:esc\/)?(?:ctrl\+c|⌃c)\/q\s+exit(?:\s+\S+\s+transcript)?\s*$/u;
function codexReadOnlyNotice(screen) {
  const tail = String(screen || '').trimEnd().split('\n').slice(-8).join(' ');
  if (CODEX_PROVIDER_NOTICE_RE.test(tail)) return 'provider';
  return CODEX_WRITER_NOTICE_RE.test(tail) ? 'writer' : null;
}
function codexThreadView(screen) {
  const lines = String(screen || '').trimEnd().split('\n').filter(line => line.trim()).slice(-10);
  const prompt = lines.filter(line => /^\s*[›»❯]\s*/u.test(line)).at(-1) || '';
  if (/^\s*[›»❯]\s*Viewing sub-agent\b.*direct input is disabled\s*$/iu.test(prompt)) return 'child';
  const footer = lines.slice(Math.max(lines.lastIndexOf(prompt) + 1, lines.length - 3));
  if (/\bSide from\b/i.test(footer.join(' '))) return 'side';
  return null;
}
function codexWritableComposer(screen) {
  if (codexThreadView(screen) || codexReadOnlyNotice(screen)) return false;
  const lines = String(screen || '').trimEnd().split('\n');
  if (/^\s*⚠\s*\d+/u.test(lines.at(-1) || '')) lines.pop();
  const last = lines.filter(line => line.trim()).at(-1) || '';
  return (CODEX_FOOTER_RE.test(last) || CODEX_HINT_FOOTER_RE.test(last)) && codexBoxState(screen) !== 'noprompt';
}
// A FRESH CODEX TAKES ITS FIRST MESSAGE BEFORE IT HAS A BOX AGAIN (measured on
// 0.166.0, 2026-11-01): Enter moves the message into the conversation as
// "› <message>" with "Waiting for startup · esc cancel" under it, and no box
// is drawn until startup ends. That row is not a box, and the echo of exactly
// this message above it is the evidence that Codex took it (codexStartupEcho).
// Only the whole measured layout counts (Astra's round 4: the phrase anywhere
// under a prompt let a two-line draft pass as delivered): the status row is the
// LAST row on screen, no status line or key hints of a box sit between it and
// the last "›" row, and the echo is every row in between, paragraph breaks
// included. Checked only after this sender's own Enter.
const CODEX_STARTUP_STATUS_RE = /^\s*Waiting for startup\b.*\besc cancel\s*$/u;
function codexStartupLayout(lines) {
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 1 || !CODEX_STARTUP_STATUS_RE.test(lines[last])) return null;
  for (let i = last - 1; i >= 0; i -= 1) {
    if (!CODEX_PROMPT_RE.test(lines[i])) continue;
    if (lines.slice(i + 1, last).some((line) => CODEX_FOOTER_RE.test(line) || CODEX_HINT_FOOTER_RE.test(line) || CODEX_STARTUP_STATUS_RE.test(line))) return null;
    return { prompt: i, status: last };
  }
  return null;
}
function codexStartupEcho(screen, sent = {}) {
  const lines = String(screen || '').split('\n');
  const layout = codexStartupLayout(lines);
  if (!layout) return false;
  const echo = squashSpace(lines.slice(layout.prompt, layout.status).join('\n').replace(CODEX_PROMPT_RE, ''));
  return Boolean(echo) && (echo === squashSpace(sent.text) || codexBoxCarries(echo, sent.text || '', sent.extra || 0));
}
function codexPromptBox(screen) {
  if (codexReadOnlyNotice(screen)) return null;
  const lines = String(screen || '').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const footer = lines.length > 1 && (CODEX_FOOTER_RE.test(lines.at(-1)) || CODEX_HINT_FOOTER_RE.test(lines.at(-1)));
  // Transcript selection/search displays earlier user rows with the same prompt
  // marker. Its navigation footer (or overlay heading) owns input, not a composer.
  const navigation = lines.at(-1)?.trim() || '';
  if (/(?:enter\/q(?:\/esc)? close|enter copy(?: & latest)?\s*·\s*(?:esc clear\s*·\s*)?q close)$/u.test(navigation)
    || (!footer && (
      lines.some(line => /^\s*\/\s+T R A N S C R I P T\s+\//u.test(line))
      || (/\besc(?: cancel)?(?: · query limited to 4 KiB)?$/u.test(navigation)
        && /^\s*Find: /u.test(lines.at(-2) || ''))
    ))) return null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!CODEX_PROMPT_RE.test(lines[i])) continue;
    if (CODEX_LIST_ROW_RE.test(lines[i]) && !footer) return null;
    // A submitted message waiting on startup is not a box (codexStartupEcho).
    if (codexStartupLayout(lines)?.prompt === i) return null;
    let end = footer && lines.length - 1 > i ? lines.length - 1 : lines.length;
    // A ROW UNDER THE STATUS LINE (measured 2026-11-01: "⚠ 1 · f2" right-aligned
    // below "GPT-6-Luna low · <folder>") made the last line unrecognisable, so
    // the status line itself was read as part of the message and no long send
    // into that pane could ever match. The box ends at the first blank row that
    // is followed by the status line, wherever that sits.
    if (!footer) {
      for (let j = i + 2; j < lines.length; j += 1) {
        if (!lines[j - 1].trim() && (CODEX_FOOTER_RE.test(lines[j]) || CODEX_HINT_FOOTER_RE.test(lines[j]))) { end = j; break; }
      }
    }
    // A DRAFT TALLER THAN THE BOX IS CLIPPED, AND CODEX MARKS IT (measured on
    // 0.166.0, 2026-11-01: 989 characters at 50 columns showed only the last
    // 12 rows, with "↑" at the right edge of the first). The marker is not
    // text: it is taken off the row and kept as `clipped`, the only evidence
    // that a box showing the END of a message is showing all it can.
    let clipped = false;
    for (let k = i; k < end; k += 1) {
      const unmarked = lines[k].replace(/\s{2,}[↑↓]\s*$/u, '');
      if (unmarked !== lines[k]) { clipped = true; lines[k] = unmarked; }
    }
    // `head`: the prompt row and the rows wrapped under it, up to the first
    // blank row, which is where the box ends whatever footer Codex draws.
    let headEnd = i + 1;
    while (headEnd < end && lines[headEnd].trim()) headEnd += 1;
    return {
      inside: squashSpace(lines.slice(i, end).join('\n').replace(CODEX_PROMPT_RE, '')),
      raw: lines.slice(i, end).join('\n').replace(CODEX_PROMPT_RE, ''),
      head: squashSpace(lines.slice(i, headEnd).join('\n').replace(CODEX_PROMPT_RE, '')),
      clipped,
    };
  }
  return null;
}
// What the box holds that is not its own empty hint: '' for an empty box, null
// when no box is drawn. Read from the box's own rows (head), so a footer this
// code has never seen cannot make an empty box look full.
function codexBoxDraft(screen) {
  const box = codexPromptBox(screen);
  if (!box) return null;
  return CODEX_EMPTY_HINTS.has(box.head) ? '' : box.head;
}
// The draft in words a person recognises: pasted blocks by size, text by its start.
function describeCodexDraft(draft) {
  const pastes = [...String(draft).matchAll(/\[PastedContent(\d+)chars\]/g)].map((m) => Number(m[1]));
  if (pastes.length && !String(draft).replace(/\[PastedContent\d+chars\](?:#\d+)?/g, '').trim()) {
    return pastes.length === 1 ? `a pasted block of ${pastes[0]} characters` : `${pastes.length} pasted blocks (${pastes.join(', ')} characters)`;
  }
  return 'other text';
}
// ONE MESSAGE CAN BE DRAWN AS TYPED CHARACTERS AROUND A PASTED BLOCK
// (2026-11-01, Pat: cross-session messages into Astra "killing my workflow").
// On Windows Codex reads a paste as keystrokes, and when the first one reaches
// it a moment before the rest (a loaded machine, a keeper write split in two),
// that character is inserted as typed and only the remainder becomes the paste,
// drawn "F[Pasted Content 1182 chars]". The old test (the whole box must be ONE
// placeholder) called that unshown, so no Enter was ever pressed for it; Fable's
// 1,183-character message to Astra was most likely stranded this way (inferred
// from its counts; no screen from that moment was kept). Reproduced on the real Codex 0.166.0 by writing the first
// character 40 ms ahead (test/fixtures/codex-box/codex-0.166.0-split-paste-154.txt).
// The walk is exact (tightened after Astra's adversarial review, same night):
// - Codex collapses only a paste of more than 1,000 characters, so a
//   "[Pasted Content N chars]" with N at or under that is literal text the
//   message itself contains, matched like any typed run.
// - A typed run must be the message's own characters at exactly that point,
//   whitespace skipped (whitespace is never drawn in the squashed box).
// - A placeholder consumes exactly N characters. Only the LAST segment may be
//   one short: an Enter swallowed into the paste lands at its end and is
//   counted (see CODEX_PASTE_RE). No other slack, so a typed run can never
//   re-read characters a paste already consumed.
// - Whitespace right before a placeholder may have been typed (and so not
//   drawn) or pasted; both readings are tried, nothing else is skipped.
// - The walk must end at the message's end; trailing message whitespace is
//   allowed only after a typed run (where it would not be drawn).
// - A large placeholder can also be the message's own literal text (a message
//   ABOUT "[Pasted Content 1200 chars]"), so both readings are tried.
// A match through a placeholder proves only that the box is SHAPED like this
// message (its hidden text cannot be read), so codexBoxMatch reports it as
// `opaque` and an Enter-only retry also needs a record of having typed it.
// Whether the 0.166.0 split itself is what stranded Fable's 1,183 characters is
// an INFERENCE (no screen from that moment was kept); the shape is measured.
const CODEX_PASTE_SEG_RE = /\[PastedContent(\d+)chars\](?:#\d+)?/g;
// `extra`: Enters this sender itself pressed into its own paste, each of which
// Codex may have swallowed as a newline (one more in the last count). Only an
// owned box is matched with it (ownsCodexBox).
function codexBoxCarries(box, text, extra = 0) {
  const chars = [...String(text)];
  const isSpace = (ch) => /\s/u.test(ch);
  const segments = [];
  let last = 0;
  for (const match of String(box).matchAll(CODEX_PASTE_SEG_RE)) {
    if (Number(match[1]) <= CODEX_LARGE_PASTE_CHARS) continue; // literal text, not a paste
    if (match.index > last) segments.push({ typed: String(box).slice(last, match.index) });
    segments.push({ pasted: Number(match[1]), literal: match[0] });
    last = match.index + match[0].length;
  }
  if (last < String(box).length) segments.push({ typed: String(box).slice(last) });
  if (!segments.some((segment) => segment.pasted !== undefined)) return false;
  const matchTyped = (typed, from) => {
    let at = from;
    for (const ch of typed) {
      while (at < chars.length && isSpace(chars[at])) at += 1;
      if (chars[at] !== ch) return -1;
      at += 1;
    }
    return at;
  };
  let positions = new Set([0]);
  segments.forEach((segment, index) => {
    const lastSegment = index === segments.length - 1;
    const next = new Set();
    for (const at of positions) {
      if (segment.pasted !== undefined) {
        // Typed whitespace before the paste is not drawn: try each split.
        for (let start = at; start <= chars.length; start += 1) {
          next.add(start + segment.pasted);
          if (lastSegment) for (let j = 1; j <= Math.max(1, extra); j += 1) next.add(start + segment.pasted - j);
          if (!isSpace(chars[start] ?? '')) break;
        }
        const literalEnd = matchTyped(segment.literal, at);
        if (literalEnd >= 0) next.add(literalEnd);
      } else {
        const end = matchTyped(segment.typed, at);
        if (end >= 0) next.add(end);
      }
    }
    positions = next;
  });
  const lastTyped = segments[segments.length - 1].typed !== undefined;
  return [...positions].some((at) => at === chars.length
    || (lastTyped && at < chars.length && chars.slice(at).every(isSpace)));
}

// CODEX DROPS MOST NON-ASCII PUNCTUATION AND SYMBOLS (2026-11-01, Pat from the
// phone: three sends to Astra refused while he watched). On Windows Codex reads
// keystrokes, and a pasted ’ “ ” … – — never reaches its box: Pat's
// "didn’t…" arrived as "didnt", so the box never matched his text, Harbor
// (rightly) pressed no Enter, and his retries then met his own first try as
// "other text". Measured on Codex 0.166.0 on Windows one character at a time
// (2026-11-01, two rounds): LOST are U+00A0, ° « × · ÷ ± § ¼ © ® ¿, every
// U+2010-U+2044 punctuation mark tried, U+2060, the zero-width joiner (an emoji
// sequence "👩‍💻" arrives as "👩💻"), combining marks (a decomposed é arrives as
// e), € ™ ≈, arrows, the minus sign, ✓ ✔ ★ and box drawing; KEPT are letters
// with accents (é ü ï), U+02BC, everything from U+3000 up that was tried (CJK
// punctuation 。、「, full-width ！, the ideographic space) and emoji. The rule
// below follows that: the text is composed first (NFC, so a decomposed é
// survives as é), a phone's smart punctuation becomes its ASCII twin so the
// meaning arrives, and any other character Codex would drop is left out before
// typing and named, so the box then shows exactly what was typed. The measured
// build is Windows only: runSend applies this on win32 alone.
// Meaning can still change (a path holding an en dash now holds a hyphen), but
// Codex itself would have deleted that character outright.
const CODEX_ASCII_TWINS = new Map(Object.entries({
  '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", 'ʹ': "'",
  '“': '"', '”': '"', '„': '"', '‟': '"', '″': '"', '«': '"', '»': '"',
  '…': '...', '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', '―': '-', '−': '-',
  '•': '-', '·': '-', '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '×': 'x',
  '≤': '<=', '≥': '>=', '≠': '!=', '™': '(TM)', '©': '(c)', '®': '(R)', '€': 'EUR',
  '÷': '/', '±': '+/-', '≈': '~', '¼': '1/4', '½': '1/2', '¾': '3/4', '¹': '^1', '²': '^2', '³': '^3',
}));
// Every change codexSafeText made, in words (an invisible space by name).
function codexChangeNote(safe) {
  const name = (ch) => (/\s/u.test(ch) ? `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} (a special space)` : ch);
  const parts = [];
  const swaps = (safe.mapped || []).map(([from, to]) => `${name(from)} as ${to === ' ' ? 'a plain space' : to}`).join(', ');
  if (swaps) parts.push(`with ${swaps}`);
  if (safe.composed) parts.push('with accents joined to their letters (one character each)');
  const dropped = [...new Set(safe.dropped || [])].map(name).join(' ');
  if (dropped) parts.push(`without ${dropped}`);
  return parts.length ? `Codex cannot show some characters, so this went ${parts.join('; ')}` : null;
}
function codexSafeText(text) {
  const dropped = [];
  const mapped = []; // [original, twin], each once, in order of first use
  let out = '';
  for (const ch of String(text ?? '').normalize('NFC')) {
    const code = ch.codePointAt(0);
    if (code < 0x80 || code >= 0x3000) { out += ch; continue; }
    const twin = CODEX_ASCII_TWINS.get(ch);
    if (twin !== undefined) { out += twin; if (!mapped.some(([from]) => from === ch)) mapped.push([ch, twin]); continue; }
    if (/[\p{L}\p{Nd}]/u.test(ch)) { out += ch; continue; }
    if (/\p{Zs}/u.test(ch)) { out += ' '; if (!mapped.some(([from]) => from === ch)) mapped.push([ch, ' ']); continue; }
    dropped.push(ch); // punctuation, symbols, joiners and marks: Codex drops them
  }
  return { text: out, dropped, mapped, composed: String(text ?? '').normalize('NFC') !== String(text ?? '') };
}

// What the box says about this message: `state` is 'noprompt' (no box: a
// dialog, a list, a TUI still starting), 'exact' (the box holds this message
// and nothing else), 'holds' (the box ends with it) or 'other' (empty, its dim
// hint, or something else); `opaque` is true when 'exact' rests on a pasted
// block whose text the screen cannot show.
// Image chips are set aside only when this send attached images
// (`imageMarker`): a chip in the box of a text-only send is someone else's.
function codexBoxMatch(screen, { text = '', imageMarker = null, extra = 0 } = {}) {
  const box = codexPromptBox(screen);
  if (!box) return { state: 'noprompt', opaque: false, clipped: false };
  const clipped = box.clipped;
  const shown = squashSpace(text);
  if (!shown) {
    const marker = squashSpace(imageMarker);
    return { state: marker && box.inside.endsWith(marker) ? 'holds' : 'other', opaque: false, clipped };
  }
  const plain = imageMarker ? box.inside.replace(IMAGE_CHIPS_RE, '') : box.inside;
  // A box that reads like this message character for character is still
  // unverifiable when it shows a real-sized placeholder: the message may only
  // SPELL one ("F[Pasted Content 1182 chars]") while the box hides a paste.
  // (The old whole-placeholder shortcut with two characters of slack in
  // either direction is gone; codexBoxCarries decides every placeholder.)
  const hidesPaste = [...plain.matchAll(CODEX_PASTE_SEG_RE)].some((m) => Number(m[1]) > CODEX_LARGE_PASTE_CHARS);
  if (box.inside === shown || plain === shown) return { state: 'exact', opaque: hidesPaste, clipped };
  if (codexBoxCarries(plain, text, extra)) return { state: 'exact', opaque: true, clipped };
  return { state: box.inside.endsWith(shown.slice(-SEND_TAIL_CHARS)) ? 'holds' : 'other', opaque: false, clipped };
}
function codexBoxState(screen, sent = {}) {
  return codexBoxMatch(screen, sent).state;
}

// ---- ANTIGRAVITY CLI (`agy`, the Gemini provider): THE BOX AND ITS DIALOGS ----
// Measured on agy 1.5.14 in a 120-column ConPTY (docs/orchestration/2026-11-23-
// gemini-provider/AGY-FACTS.md section 2; real screens in test/fixtures/
// gemini-box/). The prompt box is the rows BETWEEN THE LAST TWO full-width
// rules (U+2500 only, never the hyphens of the Terms page or the corners of the
// colour-scheme preview): a first row that starts "> " (or is a bare ">"), and
// continuation rows indented two spaces (no ">"). The empty box draws a dim
// mode placeholder ("Auto mode: ... (shift+tab to cycle)") or, in default
// mode, a bare ">". A submitted prompt is echoed ABOVE the box as "> text"
// under a SHORT rule, so the echo is never the box.
// What a dialog looks like: no box at all (the permission menu draws one rule
// under "Command" and a numbered list with a pointer under it; the trust,
// colour-scheme and Terms pages draw no rule), and the rows below the last rule
// are the dialog's own. A numbered row or a "Navigate" hint there therefore
// means a dialog owns the keys, and digits typed into it ANSWER it (probe p16:
// the key 1 approved a command). The slash menu is the one list that hangs
// under a real box: its footer says "tab Complete".
// A custom statusLine REPLACES the bottom status row ("? for shortcuts" idle,
// "esc to cancel" working), so the status words are a hint, never a gate.
const GEMINI_RULE_RE = /^\s*\u2500{10,}\s*$/u;
const GEMINI_PROMPT_ROW_RE = /^>(?:[ \t]|$)/;
const GEMINI_MODE_HINT_RE = /^(?:Auto|Accept-edits|Plan) mode:.*\(shift\+tab to cycle\)$/;
const GEMINI_DIALOG_WORDS_RE = /Run this command\?|Accept this file edit\?|Requesting permission for/;
const GEMINI_NAVIGATE_RE = /\u2191\/\u2193 Navigate/;
const GEMINI_SLASH_MENU_RE = /tab Complete/;
const GEMINI_FIRST_RUN_RE = /Terms of Service & Data Use|Choose your color scheme|Welcome to Antigravity CLI/;
const GEMINI_TRUST_RE = /Do you trust the contents of this project/;
// A big paste is drawn as ONE placeholder, not as text (measured 2026-11-23: a
// single line over 1,000 characters is "[Pasted text #1 1001 chars]", 999 shows
// whole; 16 or more lines is "[Pasted text #1 +16 lines]", 15 shows whole; the
// count is the characters or lines pasted, though a 1,853-character line drew
// 1,871). What the placeholder holds cannot be read off the screen.
const GEMINI_PASTE_RE = /^\[Pasted text #(\d+) (?:(\d+) chars|\+(\d+) lines)\]$/;
const GEMINI_STATUS_IDLE_RE = /^\s*\? for shortcuts\b/;
const GEMINI_STATUS_WORKING_RE = /^\s*esc to cancel\b/;
// agy's feedback survey ("proactive feedback"), measured live on agy 1.5.14
// (2026-11-25; fixture agy-1.5.14-feedback-survey-120.txt).
// After a turn it REPLACES the box, no rules drawn, with two rows just above the
// status row, and it stays up until a key answers it:
//    How's the CLI experience so far? Help us improve:
//    [1] Good  [2] Fine  [3] Bad  [0] Skip
// It is not consent or a permission, so a send presses 0 (Skip) and goes on.
// Harbor's launches switch it off (showFeedbackSurvey: false, gemini-launch.js);
// this is for sessions started before that, or a profile that turns it back on.
const GEMINI_SURVEY_QUESTION_RE = /^\s*How['’]s the CLI experience so far\?/;
const GEMINI_SURVEY_OPTIONS_RE = /^\s*\[1\] Good\s+\[2\] Fine\s+\[3\] Bad\s+\[0\] Skip\s*$/;
// The survey owns the keys only when its two rows are the last thing drawn above
// the status row (one row under them at most): words quoted higher up in a reply
// are prose, never the survey.
function geminiSurveyShown(screen) {
  const rows = String(screen || '').split('\n').filter((row) => row.trim());
  const options = rows.findLastIndex((row) => GEMINI_SURVEY_OPTIONS_RE.test(row));
  // agy's background-task panel (its rows and rules) can sit between the survey and the status row (2026-11-25).
  const after = rows.slice(options + 1).filter((row) => !GEMINI_PANEL_ROW_RE.test(row) && !GEMINI_RULE_RE.test(row));
  return options > 0 && after.length <= 1 && GEMINI_SURVEY_QUESTION_RE.test(rows[options - 1]);
}
// A message sent while agy works is QUEUED, not refused (measured live on agy
// 1.5.14, 2026-11-25): the box empties and the message waits as a row above it,
// "▸ <first line>" (a longer one cut with "..."), the newest followed by
// "(alt+m to send immediately)", and the status row says "Press up to edit
// queued messages". When the turn ends agy sends EVERY queued message as ONE
// prompt, joined by line breaks, so the transcript never holds one of them
// alone; agy's prompt history (history.jsonl) records each the moment it is
// queued, which is what confirms it (geminiHistoryScanner).
const GEMINI_QUEUED_ROW_RE = /^▸ (.*?)(?:\s+\(alt\+m to send immediately\))?\s*$/u;
function geminiQueuedShown(screen, text) {
  const first = squashSpace(String(text || '').trim().split('\n')[0]);
  if (!first) return false;
  return String(screen || '').split('\n').some((row) => {
    const found = GEMINI_QUEUED_ROW_RE.exec(row.replace(/\s+$/, ''));
    if (!found) return false;
    const shown = squashSpace(found[1].replace(/(?:\.\.\.|…)$/u, ''));
    return shown.length > 0 && (shown === first || (shown.length >= Math.min(first.length, 12) && first.startsWith(shown)));
  });
}
// agy's questions draw their own words or "↑/↓ Navigate" (every one measured: trust, first-run, permission;
// AGY-FACTS.md). A numbered row alone is no mark: a reply's numbered list read as a permission question
// (2026-11-25), and an echoed prompt that starts "1." would too.
function geminiDialogRows(rows) {
  return rows.some((row) => GEMINI_DIALOG_WORDS_RE.test(row)
    || (GEMINI_NAVIGATE_RE.test(row) && !rows.some((other) => GEMINI_SLASH_MENU_RE.test(other))));
}
// agy's background-task panel (measured live on agy 1.5.14, 2026-11-25): while subagents or background commands run, agy
// lists them UNDER the box, one indented row each behind a status mark, closed by a rule of its own, with the status row last:
//   "  ● Agent(self: <name>) · Gemini 4 Neon  <activity> · 9m24s"
//   "  ● [21:47:12] python "C:\...\scra... running"
// The box's bottom rule is the panel's top, so the last two rules frame the TASKS, not the box: Harbor saw no box, and Claude's
// reader made a reply's numbered list a "Gemini is asking" card (Pat, 2026-11-25, four agents running). The row test is the
// shape, not the words, so a task kind not seen yet is still a panel row. The box's own rows never match it (its first row is
// ">" at column 0), nor do a question's (numbered options, "↑/↓ Navigate") or the slash menu's ("/name").
const GEMINI_PANEL_ROW_RE = /^\s{1,4}[^\w\s]\s+\S/u;
// The index into `rules` of the last rule above agy's trailing panels: the task panel is stepped over (a run of rules with only
// panel rows between them), so what is left at the end is the box's bottom rule, or a dialog's.
function geminiLastRuleAbovePanels(lines, rules) {
  let last = rules.length - 1;
  while (last >= 1) {
    const between = lines.slice(rules[last - 1] + 1, rules[last]).filter((row) => row.trim());
    if (!between.length || !between.every((row) => GEMINI_PANEL_ROW_RE.test(row))) break;
    last -= 1;
  }
  return last;
}
// The prompt box, or null when none is drawn (a dialog, a first-run page, a
// pane still starting). `inside` is the draft with whitespace dropped ('' for
// an empty box or its mode placeholder); `raw` keeps the rows' own spacing.
function geminiPromptBox(screen) {
  const lines = String(screen || '').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  const rules = [];
  lines.forEach((line, i) => { if (GEMINI_RULE_RE.test(line)) rules.push(i); });
  if (rules.length < 2) return null;
  const last = geminiLastRuleAbovePanels(lines, rules);
  if (last < 1) return null;
  const bottom = rules[last];
  const top = rules[last - 1];
  // Under a task panel the box is drawn full width like the panel's own rules; an earlier prompt's echo sits under a SHORT
  // rule, so a pair of unequal rules there is not the box.
  if (last < rules.length - 1 && lines[top].trim().length !== lines[bottom].trim().length) return null;
  const below = lines.slice(bottom + 1);
  // The survey draws no rules, so the last two can be the short ones over an
  // earlier prompt's echo: with the survey at the bottom there is no box at all.
  if (bottom - top < 2 || geminiDialogRows(below) || geminiSurveyShown(screen)) return null;
  const rows = lines.slice(top + 1, bottom).map((row) => row.replace(/\s+$/, ''));
  if (!GEMINI_PROMPT_ROW_RE.test(rows[0])) return null;
  const raw = rows.map((row, i) => (i === 0 ? row.replace(/^>[ \t]?/, '') : row.replace(/^ {1,2}/, ''))).join('\n');
  const hint = GEMINI_MODE_HINT_RE.test(raw.replace(/\s+/g, ' ').trim());
  const pasted = GEMINI_PASTE_RE.exec(raw.trim());
  const status = below.filter((row) => row.trim()).at(-1) || '';
  return {
    raw,
    inside: hint ? '' : squashSpace(raw),
    paste: pasted ? { n: Number(pasted[1]), chars: pasted[2] ? Number(pasted[2]) : null, lines: pasted[3] ? Number(pasted[3]) : null } : null,
    menuOpen: below.some((row) => GEMINI_SLASH_MENU_RE.test(row)),
    status: GEMINI_STATUS_IDLE_RE.test(status) ? 'idle' : GEMINI_STATUS_WORKING_RE.test(status) ? 'working' : 'unknown',
  };
}
// A paste placeholder is compatible with a message when its count could be that
// message's: the line count to within one (a swallowed Enter may add a row), the
// character count to within the 1% agy was seen to add and a little more. It
// proves nothing about WHICH text it holds; the caller decides whose paste it is.
function geminiPasteFits(paste, text) {
  const body = String(text || '');
  if (!paste || !body) return false;
  if (paste.lines != null) return Math.abs(paste.lines - body.split('\n').length) <= 1;
  const chars = [...body].length;
  return paste.chars >= Math.floor(chars * 0.98) - 2 && paste.chars <= Math.ceil(chars * 1.1) + 64;
}
// What a draft is, for a person: a paste by its size, text by its start.
function describeGeminiDraft(raw) {
  const pasted = GEMINI_PASTE_RE.exec(String(raw || '').trim());
  if (pasted) return pasted[2] ? `a pasted block of ${Number(pasted[2]).toLocaleString('en-US')} characters` : `a pasted block of ${pasted[3]} lines`;
  const words = String(raw || '').replace(/\s+/g, ' ').trim();
  return `text ("${words.slice(0, 40)}${words.length > 40 ? '...' : ''}")`;
}
// What the box says about this message: 'noprompt' (no box), 'exact' (it holds
// this message and nothing else), 'placeholder' (it holds ONE paste placeholder
// whose size fits this message), 'empty' (nothing, or its mode placeholder) or
// 'other' (some other draft). Whitespace is dropped on both sides, as the box
// re-wraps and indents what was typed. There is no "ends with": whether a long
// draft clips or collapses in the box is not measured, so a partial match is
// never enough to press Enter.
function geminiBoxMatch(screen, { text = '' } = {}) {
  const box = geminiPromptBox(screen);
  if (!box) return { state: 'noprompt', draft: null, menuOpen: false, status: 'unknown' };
  const shown = squashSpace(text);
  const state = box.inside === '' ? 'empty' : box.inside === shown ? 'exact' : box.paste && geminiPasteFits(box.paste, text) ? 'placeholder' : 'other';
  return { state, draft: box.inside, raw: box.raw, paste: box.paste, menuOpen: box.menuOpen, status: box.status };
}
const geminiBoxState = (screen, sent = {}) => geminiBoxMatch(screen, sent).state;
// Why there is no box: 'first-run' (colour scheme, Terms of Service & Data Use:
// the person's consent, never answered by Harbor), 'trust' (the folder dialog),
// 'survey' (the feedback survey, skipped), 'permission' (a numbered question),
// 'menu' (another list) or 'unknown'.
function geminiBlockedKind(screen) {
  const text = String(screen || '');
  if (!text.trim()) return 'blank';
  if (GEMINI_FIRST_RUN_RE.test(text)) return 'first-run';
  if (GEMINI_TRUST_RE.test(text)) return 'trust';
  if (geminiSurveyShown(text)) return 'survey';
  const lines = text.split('\n');
  const rules = [];
  lines.forEach((line, i) => { if (GEMINI_RULE_RE.test(line)) rules.push(i); });
  // With agy's background-task panel at the bottom, the dialog's rows sit above the panel's rules (2026-11-25).
  const above = rules.length ? geminiLastRuleAbovePanels(lines, rules) : -1;
  const last = above < 0 ? -1 : above < rules.length - 1 ? (above >= 1 ? rules[above - 1] : -1) : rules[above];
  const below = last >= 0 ? lines.slice(last + 1) : lines;
  if (geminiDialogRows(below)) return 'permission';
  if (GEMINI_NAVIGATE_RE.test(text)) return 'menu';
  return 'unknown';
}
// A Gemini dialog owns the screen: its question words, or a first-run or trust
// page, in the last rows, and no Claude composer glyph under them (Claude can
// QUOTE these words in prose above its own composer). parseMenu is shaped for
// Claude's pointer: it reads agy's permission menu as a menu with options 2 to
// 4 (the pointer row "> 1." is not its pointer), and a card built on that would
// steer by arrow keys it has no way to check, onto "Persist to settings.json".
// The window shows the generic answer panel (raw screen, direct keys) instead.
function geminiDialogOwnsScreen(screen) {
  const lines = String(screen || '').split('\n').filter((line) => line.trim()).slice(-30);
  const tail = lines.join('\n');
  if (/[\u276f\u256d]/u.test(lines.slice(-10).join('\n'))) return false;
  return GEMINI_DIALOG_WORDS_RE.test(tail) || GEMINI_FIRST_RUN_RE.test(tail) || GEMINI_TRUST_RE.test(tail);
}
// The words a USER_INPUT record holds: agy wraps what was typed in
// <USER_REQUEST>...</USER_REQUEST> and follows it with its own metadata
// sections. The closing tag counts only when a metadata section or the end
// follows it, so a message that quotes the tag is read whole.
// Gemini's name in messages; the other providers keep the id they always showed.
const providerLabel = (provider) => (provider === 'gemini' ? 'Gemini' : provider);
// Written into the profile's settings.json by agy itself (docs: "persists across
// sessions"), or purges the sign-in the Carrier Bridge worker shares: Harbor never
// types them for anyone (AGY-FACTS sections 2 and 5).
const GEMINI_PERSISTING_COMMAND_RE = /^\/(model|effort|logout)(?=\s|$)/i;
function geminiUserRequest(content) {
  if (typeof content !== 'string') return null;
  const found = /^\s*<USER_REQUEST>\n?([\s\S]*?)\n?<\/USER_REQUEST>(?=\s*(?:<ADDITIONAL_METADATA>|<USER_SETTINGS_CHANGE>|$))/.exec(content);
  return found ? found[1] : null;
}

// CLAUDE'S SESSIONS VIEW IS NOT THIS CONVERSATION (measured on CLI 2.1.295,
// 2026-10-09). The ← key at an empty prompt moves the conversation "to the
// background" and opens a list of sessions whose input reads "describe a task
// for a new session". It looks like a composer (a box, a pointer, text), so
// every composer test above passes on it, and a message typed there plus Enter
// CREATES A NEW BACKGROUND SESSION from the text. Driven against the real CLI:
// Harbor reported "sent" in half a second and the conversation never got it.
// Identified only where the view draws its own words, the input box and the key
// hints under it, never in the scrollback: a conversation ABOUT this view (this
// one, for instance) quotes those words in its prose.
const FLEET_INPUT_RE = /describe a task for a new session/;
const FLEET_KEYS_RE = /\benter to (?:return|create|open)\b.*·.*(?:space to reply|esc to clear|ctrl\+x to delete)/;
const isFleetView = (screen) => {
  const found = composerBox(screen);
  if (!found) return false;
  if (FLEET_INPUT_RE.test(found.box[0])) return true;
  return found.lines.slice(found.bottom + 1).some((line) => FLEET_KEYS_RE.test(line));
};

// Chrome only a dialog draws.
const BLOCKED_CHROME_RE = /(Press Enter to continue|Enter to select|Enter to confirm|Tab to amend|ctrl\+e to explain|(?:Tab\/Arrow|↑\/↓|Arrow keys)[^\n]*navigate|Resuming the full session will consume|Resume from summary)/i;
// Dialogs render the key name as "Esc". Lowercase "esc to cancel" also appears
// in auto-continue and other status lines, which must not block sends.
const DIALOG_CANCEL_RE = /Esc to cancel/;
// Every built-in dialog names its way out with a capital "Esc to ...", and not
// always at the bottom: /mobile draws it above a tall QR code, /skills at the
// top of its list, /workflows and /feedback say "Esc to close", /config "Esc to
// clear" (measured on 2.1.303, 2026-10-24: each of those showed NO card, a dead
// end). Read over the whole screen, and only once the tail has shown there is
// no prompt and no working turn, so a hint in old scrollback cannot raise one.
const DIALOG_ESC_HINT_RE = /Esc to (?:cancel|close|clear|go back|back|exit)\b/;
// A confirmation question, which a dialog draws on its OWN line. Claude's prose
// says "do you want me to ..." mid-sentence constantly ("Ready to dig in, or do
// you want me to dive deeper on anything?"), and matching that inside a
// sentence is half of why Pat got an answer panel over an idle session.
//
// Compaction belongs in the SAME family and was left out of that fix, which
// locked Pat's composer on 2026-08-02: a running compaction draws "Compacting
// conversation history…" as its own status line, but Claude's ※ recap wrote
// "The handoff is written; next is compacting", and the composer footer of a
// nearly-full session reads "Context left until auto-compact: 16%" beside a
// perfectly usable prompt. Matching those two words anywhere on the screen made
// a session that is TALKING about compaction indistinguishable from one that is
// DOING it, and a session near its limit talks about nothing else. Anchored to
// the start of a line, after the spinner/bullet glyphs Claude draws status
// lines with.
const CONFIRM_LINE_RE = /^[\s│┃|>*-]*(?:Do you want|Do you trust)\b/im;
const COMPACTION_LINE_RE = /^[\s│┃|>*·⏺✻✳*⣾⣽⣻⢿⡿⣟⣯⣷-]*(?:Compacting|Auto-compact)/im;
// A SELECTED OPTION ROW IS MENU CHROME NOTHING ELSE DRAWS, so it identifies a
// blocker without needing to recognise that blocker's footer. Live-caught
// 2026-08-06 on the screen every brand-new install sees first: Claude's theme
// picker offers seven numbered options under a pointer, and its footer says
// "Syntax theme: Monokai Extended (ctrl+t to disable)", which matches nothing in
// BLOCKED_CHROME_RE. Worse, it renders a code sample BELOW the options, so the
// ten-line tail classifyBlocked reads did not even contain them. The result was
// the one state that must not exist: no composer, no card, no panel. A new user
// s very first session is a blank window.
//
// Anchored to the line start and requiring the NUMBER, deliberately: an
// unanchored pointer matches Claude's own prose bullets, and a bare number
// matches numbered paragraphs (the security notice numbers its two). Neither
// mistake is available to this shape.
const POINTER_ROW_RE = /^[\s│┃|]*❯\s*\d+[.)]\s+\S/m;

const isBlockedScreen = (text) => BLOCKED_CHROME_RE.test(text)
  || DIALOG_CANCEL_RE.test(text)
  || CONFIRM_LINE_RE.test(text)
  || COMPACTION_LINE_RE.test(text)
  || POINTER_ROW_RE.test(text);

// A live turn draws the composer box with an "esc to interrupt" footer. Claude
// QUEUES text typed into that (classifyBlocked reads the same footer as
// resolved, and deliver() accepts it), so a resumed session showing one has
// COME UP and is ready to take the message. Distinguishing this from "never
// came up" is what stops a resume into a long turn from being reported as a
// failed send. Compaction is checked BEFORE this by its caller, so a compaction
// banner that also carries "esc to interrupt" is not mistaken for a plain turn.
const WORKING_TURN_RE = /esc to interrupt/i;
const isWorkingTurn = (text) => {
  const bottom = String(text || '').split('\n').slice(-10).join('\n');
  return WORKING_TURN_RE.test(bottom) && /[❯╭╰]/.test(text);
};

function createSessionSend(deps) {
  const {
    snapshot, // async () => normalized { panes: [], workspaces: [] }
    readPane: rawReadPane, // async (paneId, lines, source) => text
    // async (paneId) => Claude's dim composer suggestion, or null. Read from the
    // keeper's modeled cells (src/daemon/screen.js); a stripped scrape cannot
    // tell it from a typed draft.
    readSuggestion = async () => null,
    // The Codex text rule is measured on Windows only (codexSafeText).
    platform = process.platform,
    terminalBridge,
    launchActions,
    getSessionMeta,
    resolveTranscriptPath,
    links,
    projectLabelForCwd,
    setXClipboardImage,
    // Off by default since 2026-11-19: Claude images go by path (see the
    // image routes in deliver). The clipboard route stays, switched off, as
    // the fallback should a CLI stop converting a pasted path again.
    pasteClaudeImagesFromClipboard = false,
    // async (path) => true when the picture is still a non-empty file
    // (round twenty-eight: Harbor prunes saved pictures after 14 days).
    imageFileReady = async (imagePath) => {
      try { const stat = await fs.stat(imagePath); return stat.isFile() && stat.size > 0; } catch { return false; }
    },
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    // The clock waitForProviderReady budgets against; a harness passes a fake
    // one that its sleep advances.
    clock = () => Date.now(),
    captureDir: suppliedCaptureDir,
  } = deps;
  // Same isolation-surface rule as artifact-thumbs and artifacts: the env
  // override outranks anything composed in. As a destructuring DEFAULT this
  // read `deps.captureDir ?? env`, so the moment the composition root passed a
  // captureDir from config the HARBOR_UNRECOGNIZED_DIR escape would go dead and
  // a harness would start writing into the real capture store. Nothing passes
  // it today, which is why this was latent; a unit test that supplies its own
  // directory still gets it, because env is unset there.
  const captureDir = process.env.HARBOR_UNRECOGNIZED_DIR
    || suppliedCaptureDir
    || (process.env.NODE_TEST_CONTEXT && deps.sendLogFile ? path.join(path.dirname(deps.sendLogFile), 'unrecognized-dialogs') : null)
    || path.join(os.homedir(), '.cache/harbor/unrecognized-dialogs');
  // ONE SCREEN READ PER ASK, NOT SIX, INSIDE A MENU POLL (2026-11-06). A window's
  // menu poll walks readMenu (recent, then visible), readFallback (recent again)
  // and readList (visible, recent): five or six daemon round trips for one
  // question, each a fresh pipe to the session's keeper, which renders 90 lines
  // of scrollback to JSON for every one of them. Measured live with six Claude
  // windows open: 7,434 screen reads a minute from Harbor main, 719 MB a minute
  // of allocations in the daemon, keepers behind open windows at 6x the CPU and
  // 2-3x the commit of the rest. Within one getMenu call the same read is asked
  // once and shared; any input this module sends to a pane drops what was read
  // (sendPaneInput), so a walk that types and re-reads still sees the new
  // screen. Outside a menu poll nothing is shared: the send and settle loops
  // poll every 40-160 ms and must see every change. And once a poll ACTS on a
  // pane (a first-run Enter, a batch walk's arrow keys) sharing stops for the
  // rest of that poll: its waits re-read every 60 ms for the redraw, and a
  // shared copy would hide it from them.
  //
  // Input from ANY caller ends the sharing too (Astra review 2026-11-06): two
  // polls of one pane can await the same discovery walk, and the walk's keys
  // are sent from the first poll's context, so the second poll's cached
  // pre-walk screen would survive the walk. Every input bumps the pane's
  // generation; a poll that sees a pane's generation move since it first read
  // that pane stops sharing for the rest of its run, exactly like a poll that
  // typed itself.
  const pollReads = new AsyncLocalStorage();
  const paneInputGen = new Map(); // paneId -> inputs sent through this module, any caller
  const readPane = (paneId, lines, source) => {
    const poll = pollReads.getStore();
    if (!poll?.sharing) return rawReadPane(paneId, lines, source);
    const gen = paneInputGen.get(paneId) || 0;
    if (poll.gens.has(paneId) && poll.gens.get(paneId) !== gen) {
      poll.sharing = false;
      poll.reads.clear();
      return rawReadPane(paneId, lines, source);
    }
    poll.gens.set(paneId, gen);
    const key = `${paneId}\u0000${lines}\u0000${source}`;
    if (!poll.reads.has(key)) poll.reads.set(key, rawReadPane(paneId, lines, source));
    return poll.reads.get(key);
  };
  const sendPaneInput = (paneId, payload) => {
    paneInputGen.set(paneId, (paneInputGen.get(paneId) || 0) + 1);
    const poll = pollReads.getStore();
    if (poll) { poll.sharing = false; poll.reads.clear(); }
    return terminalBridge.sendInput(paneId, payload);
  };
  const sendPaneInputAcked = async (paneId, payload) => {
    if (typeof terminalBridge.sendInputAcked !== 'function') return sendPaneInput(paneId, payload);
    paneInputGen.set(paneId, (paneInputGen.get(paneId) || 0) + 1);
    const poll = pollReads.getStore();
    if (poll) { poll.sharing = false; poll.reads.clear(); }
    return terminalBridge.sendInputAcked(paneId, payload);
  };
  const emitter = new EventEmitter();
  const inFlight = new Set(); // session ids currently draining one item
  const queues = new Map(); // sessionId -> FIFO send items
  let nextSendId = 1;

  const textPreview = (text, images = []) => {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (normalized) return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
    const count = Array.isArray(images) ? images.filter(Boolean).length : 0;
    return count === 1 ? '[1 image]' : `[${count} images]`;
  };

  const getQueueState = (sessionId) => {
    const items = (queues.get(sessionId) || []).map((item) => ({
      id: item.id,
      status: item.status,
      textPreview: item.textPreview,
    }));
    return { count: items.length, items };
  };

  // Every send leaves a trace on disk. Live-caught 2026-07-28: Pat sent the same
  // message to a session twice and it landed nowhere, not in that session's
  // transcript, not in another's, not even as text in the pane's composer, and
  // there was no way to tell afterwards WHICH decision dropped it. Forensics on
  // a send that leaves no evidence is guesswork, and guessing is what he has
  // been on the receiving end of. Phases and reasons only, never message text
  // (the same rule the freeze log follows), bounded, and it can never break a
  // send: a logging failure is swallowed.
  const sendLogFile = deps.sendLogFile
    ?? path.join(os.homedir(), '.cache/harbor/send-log.jsonl');
  const logSend = (record) => {
    if (process.env.HARBOR_NO_SEND_LOG === '1' || (process.env.NODE_TEST_CONTEXT && !deps.sendLogFile)) return;
    (async () => {
      try {
        await fs.mkdir(path.dirname(sendLogFile), { recursive: true });
        try {
          const stat = await fs.stat(sendLogFile);
          if (stat.size > 1024 * 1024) await fs.rename(sendLogFile, `${sendLogFile}.1`);
        } catch { /* no file yet */ }
        await fs.appendFile(sendLogFile, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
      } catch { /* logging must never break a send */ }
    })();
  };

  // Every status a session emits bumps its sequence, so a late correction can
  // tell whether anything newer has been said about that session since.
  const statusSeq = new Map();
  const status = (sessionId, phase, detail = null) => {
    statusSeq.set(sessionId, (statusSeq.get(sessionId) || 0) + 1);
    logSend({ sessionId, phase, detail });
    emitter.emit('status', { sessionId, phase, detail, queue: getQueueState(sessionId) });
  };

  const paneIdSet = async () => {
    try {
      const snap = await snapshot();
      return new Set((snap.panes || []).map((p) => p.pane_id));
    } catch {
      return null;
    }
  };

  // Snapshot-diff pane discovery (the mechanism the +T proof live-verified):
  // the fresh pane exists in the daemon within seconds of a launch, long
  // before agent detection names it.
  const findFreshPane = async ({ preIds, cwd, timeoutMs, sessionId = null }) => {
    timeoutMs = timeoutMs ?? Number(process.env.HARBOR_FRESH_PANE_TIMEOUT_MS || 45_000);
    if (!preIds) return null;
    const label = projectLabelForCwd ? projectLabelForCwd(cwd) : null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1000);
      try {
        const snap = await snapshot();
        const wsIds = new Set((snap.workspaces || [])
          .filter((w) => !label || w.label === label)
          .map((w) => w.workspace_id));
        // A resume names its session to the daemon at spawn (bin/harbor-bin.cjs
        // passes agentSession: the resume id, for Claude and for bin/ai), so
        // the resumed pane carries it from its first moment, and only that
        // pane is ours (rounds four and five of the review: a pane naming
        // nobody yet could be a New Session someone opened meanwhile).
        const fresh = (snap.panes || []).find((p) => {
          if (preIds.has(p.pane_id) || !wsIds.has(p.workspace_id)) return false;
          if (!sessionId) return true;
          const owner = p.agent_session?.value ?? (typeof p.agent_session === 'string' ? p.agent_session : null);
          return Boolean(owner) && String(owner).toLowerCase() === String(sessionId).toLowerCase();
        });
        if (fresh) return { paneId: fresh.pane_id, workspaceId: fresh.workspace_id };
      } catch { /* daemon hiccup; keep polling */ }
    }
    return null;
  };

  // A brand-new session's id is unknowable until Claude writes its transcript
  //; which happens on the FIRST MESSAGE, not at boot (live-caught). Poll
  // fast at first (the common case: Pat types right away), then back off.
  const findFreshTranscript = async ({ cwd, provider = 'claude', sinceMs, knownIds = new Set(), timeoutMs = 45_000, home = os.homedir() }) => {
    const start = Date.now();
    const deadline = start + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const candidates = await transcriptFiles(provider, cwd, home);
        for (const { id, file } of candidates) {
          if (knownIds.has(id)) continue;
          try {
            const stat = await fs.stat(file);
            if (stat.mtimeMs < sinceMs - 2000) continue;
            // Codex keeps every rollout in one dated tree, so the folder says
            // nothing about which session it is. A codex-worker fleet writing
            // in the same project would otherwise hand this pane a delegate's
            // id; the rollout's own session_meta.cwd is the honest test.
            if (provider === 'codex' && cwd && await codexRolloutCwd(file) !== cwd) continue;
            // Antigravity keeps every conversation of the profile in ONE brain
            // folder and its transcript holds no folder, so a new conversation
            // is this pane's only when the tee, the prompt history or the
            // folder map says it started here. No evidence yet is not a match:
            // keep polling, never guess.
            if (provider === 'gemini' && !(await geminiFolders(home, id)).some((folder) => sameFolder(folder, cwd, platform))) continue;
            return id;
          } catch { /* raced a delete */ }
        }
      } catch { /* project dir not created yet */ }
      await sleep(Date.now() - start < 45_000 ? 700 : 3000);
    }
    return null;
  };

  const listTranscriptIds = async (cwd, provider = 'claude', home = os.homedir()) => {
    try {
      return new Set((await transcriptFiles(provider, cwd, home)).map(({ id }) => id));
    } catch {
      return new Set();
    }
  };

  // Claude is "ready" when the pane has settled on a frame that shows the
  // composer chrome. Two consecutive identical reads containing the composer
  // prompt beat any fixed sleep; the cap keeps a wedged boot from hanging us.
  // Current Claude Code draws a flat-rule composer with a "❯" prompt (read
  // from a REAL pane 2026-07-18); older builds boxed it with ╭╰ and ">".
  const waitForClaudeReady = async (paneId, { timeoutMs = 30_000 } = {}) => {
    const deadline = Date.now() + timeoutMs;
    let prev = null;
    while (Date.now() < deadline) {
      await sleep(800);
      let text = null;
      try { text = await readPane(paneId); } catch { continue; }
      if (!text) continue;
      if (isBlockedScreen(text)) {
        prev = text;
        continue;
      }
      const hasComposer = /[❯╭╰]/.test(text) || /^\s*>\s*$/m.test(text);
      if (hasComposer && prev === text) return true;
      prev = text;
    }
    return false;
  };

  // Codex/cursor readiness after a resume: their TUIs draw different composer
  // chrome than claude, so readiness is SETTLEMENT, not glyphs: two identical
  // consecutive non-empty reads whose tail is not a bare shell prompt (a
  // failed resume drops back to the shell, and typing there would execute).
  // deliver() re-runs the dead-shell guard right before the bytes go anyway.
  // Panes this process has already typed into successfully. A pane Harbor just
  // LAUNCHED is still booting its TUI, and the first bytes sent into it are
  // swallowed; a pane that has taken a message before is by definition past
  // that. See deliver().
  const deliveredPanes = new Set();

  // That set is per PROCESS, so it starts empty whenever this Harbor does, and
  // harbor-server restarts on its own schedule. On 2026-10-14 the phone server
  // treated a cdt-app pane that had run for 12 hours as "still starting up":
  // the status line said so, and a refused send took the three-minute startup
  // wait instead of seconds. The daemon records when it spawned each pane;
  // one older than this is past startup whoever typed into it before. A pane
  // with no recorded start keeps the long wait.
  const PANE_STARTUP_MS = 5 * 60_000;
  const paneIsPastStartup = async (paneId) => {
    try {
      const snap = await snapshot();
      const pane = (snap?.panes || []).find((candidate) => candidate.pane_id === paneId);
      const started = Date.parse(pane?.created_at || '');
      return Number.isFinite(started) && clock() - started > PANE_STARTUP_MS;
    } catch {
      return false;
    }
  };

  // `blankTimeoutMs` (2026-09-26): a pane that has drawn NOTHING yet is still
  // starting, not busy, so it may wait longer than a drawn pane that never
  // settles. Cursor starts every MCP server before its first frame (measured
  // 25-32 s on the Legion, the pane blank throughout), so the 15 s first-send
  // budget ran out on a blank cursor pane and typed into a TUI not yet
  // listening. Only a READ that comes back blank earns the longer budget (a read
  // that throws is no evidence of anything and keeps `timeoutMs`); once anything
  // is drawn, the ordinary `timeoutMs` budget runs from that first frame, capped
  // by the blank budget, so a busy drawn pane gives up exactly as before.
  // 2026-11-09: the same pane took 42 to 64 s on 2026-10-05, 35 to 45 s in three
  // saved runs of the new build, and over 60 s on the old build under load
  // (cursor-pane-proof), at or past the 45 s this budget had, so a first message
  // could be typed into a pane that was not listening.
  // A pane with nothing drawn cannot be typed into safely, so a pane still blank
  // when the budget ends is refused, never typed into: `outcome.neverDrew` tells
  // the caller which of the two failures this was. `onBlankWait` fires once, when
  // a blank pane outlasts the ordinary budget, so a wait of a minute or more says
  // why it is taking so long.
  // The boot budget is the DEFAULT (2026-11-09 review): the Resume buttons on the
  // desktop and the phone call this with no options, and kept the old 45 s.
  const waitForProviderReady = async (paneId, { timeoutMs = 45_000, blankTimeoutMs = Math.max(timeoutMs, 90_000), outcome = null, onBlankWait = null } = {}) => {
    const started = clock();
    const bootLimit = started + Math.max(timeoutMs, blankTimeoutMs);
    let deadline = started + timeoutMs;
    let drawn = false;
    let sawBlank = false;
    let noticed = false;
    let prev = null;
    while (clock() < deadline) {
      await sleep(800);
      let text = null;
      try { text = await readPane(paneId); } catch { continue; }
      if (!text || !text.trim()) {
        sawBlank = true;
        if (!drawn) {
          deadline = bootLimit;
          if (onBlankWait && !noticed && clock() - started >= timeoutMs) {
            noticed = true;
            try { onBlankWait(); } catch { /* a status line must never break a send */ }
          }
        }
        prev = text;
        continue;
      }
      if (!drawn) {
        drawn = true;
        deadline = Math.min(bootLimit, clock() + timeoutMs);
      }
      if (SHELL_PROMPT_TAIL_RE.test(lastNonBlankLine(text))) { prev = text; continue; }
      if (prev === text) return true;
      prev = text;
    }
    if (outcome) outcome.neverDrew = sawBlank && !drawn;
    return false;
  };

  // A blocking prompt (permission/trust dialog, compaction) OR an interactive
  // numbered SELECT MENU replaces the composer; typing into it eats the message
  // and a blind Enter picks whatever the menu/dialog offers (live-caught: Pat's
  // message became /compact at the auto-compact boundary; and messages sent to a
  // session parked on a "1. …/2. …" choice menu silently vanished and reported
  // "could not confirm the message reached the session"). Claude draws those
  // menus with an "Enter to select … to navigate" footer the composer never
  // shows. That MUST be tested BEFORE the bare composer glyph, because a
  // highlighted menu row also carries a "❯" and would otherwise read as safe.
  // Order: refuse on a dialog/menu; else a visible composer proceeds; else a
  // plain shell (no Claude chrome) passes through.
  const COMPOSER_RE = /[❯╭]/;

  // A crashed CLI leaves its pane at a bare shell prompt, where typed text is
  // EXECUTED by the shell (live-caught 2026-07-22: a Bun segfault dropped
  // claude back to bash, and the next send ran as a bash command). The
  // signature is tail-anchored: no agent UI ever leaves the last non-blank
  // line ending in a naked $, % or #, while a prompt with a command typed
  // after it does not match.
  const SHELL_PROMPT_TAIL_RE = /[$%#]\s*$/;
  const lastNonBlankLine = (text) => {
    const lines = String(text || '').split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (lines[i].trim()) return lines[i];
    }
    return '';
  };
  // Provider-agnostic (codex and cursor crash back to bash the same way): a
  // shell-prompt tail with no working-turn footer means the CLI is gone.
  const assertNotDeadShell = async (paneId, knownScreen = null) => {
    let screen = knownScreen;
    if (screen == null) {
      try { screen = await readPane(paneId); } catch { return; /* unreadable: no evidence to refuse on */ }
    }
    if (!screen) return;
    const bottom = screen.split('\n').slice(-10).join('\n');
    if (/esc to interrupt/i.test(bottom)) return; // a working turn, never a dead shell
    if (SHELL_PROMPT_TAIL_RE.test(lastNonBlankLine(bottom))) {
      const error = new Error('the CLI exited in this pane and left a shell prompt; the send was refused so your text would not run in the shell. Your text is kept');
      error.code = 'DEAD_SHELL';
      throw error;
    }
  };

  const assertComposerSafe = async (paneId) => {
    // The refusal is the SAME decision as the card (classifyBlocked), not a
    // second one that happens to agree most of the time. It used to be its own
    // code on its own read: 16 lines instead of 90, sliced without trimming the
    // trailing blank line, and with no resolution-tail test at all. On
    // 2026-08-02 that cost Pat his composer for good: the blocker text matched
    // one line above the fold in the send's window and one line outside the
    // card's, so the send refused and told him to "use the answer panel in its
    // window" while the window, correctly, drew no panel. A refusal the card
    // does not panel is precisely the dead end the panel exists to prevent
    // (Pat mandate 2026-07-21), and the only way to keep the two honest is for
    // there to be one of them.
    //
    // ONE read answers every question below. Reading twice is not just slower:
    // a pane repaints between reads, so the guard would be judging one frame
    // and the composer test another.
    // Returns the frame it judged, so a later check before the first write
    // (the slash command's busy test) reads the same frame, not a second one.
    const screen = await readScreen(paneId, MENU_READ_LINES);
    if (!screen) return ''; // unreadable: no evidence to refuse on
    if (isFleetView(screen)) throw fleetViewError();
    if (classifyBlocked(screen)) {
      // When the blocker parses as an answerable question, the window shows
      // the labeled card; otherwise the window shows the fallback answer
      // panel (raw screen + direct keys). Either way the answer lives in the
      // window: a blocked pane is never a dead end (Pat mandate 2026-07-21).
      let menu = null;
      try { menu = await readMenu(paneId); } catch { /* refuse with the generic guidance */ }
      if (menu) {
        throw new Error('the session is asking a question in its window; answer it there first. Your text is kept');
      }
      throw new Error('the session is showing a prompt Harbor cannot fully read; use the answer panel in its window. Your text is kept');
    }
    const bottom = screen.split('\n').slice(-10).join('\n');
    if (COMPOSER_RE.test(bottom)) return screen;
    // A bare shell prompt at the tail means the CLI exited and anything typed
    // would RUN IN THE SHELL; refuse, never pass through. runSend catches the
    // DEAD_SHELL code and falls through to resume-then-send for resumable
    // sessions. (Other unrecognized screens still pass: an unreadable or
    // exotic frame is not evidence of a shell.)
    await assertNotDeadShell(paneId, screen);
    return screen;
  };

  // A leading-slash send is a slash COMMAND, not a message, and the current
  // CLI (2.1.214, live-verified) does NOT append a confirmable transcript event
  // for a bare /model or /effort: the switch only manifests on the NEXT
  // assistant message (its model id / effort stamp). So a slash command cannot
  // be hard-confirmed against the transcript, and hard-confirming one is the
  // exact bug that made a LANDED /model read as "send failed" (live-caught).
  // Slash commands are therefore confirmed BEST-EFFORT and treated as
  // "requested": if a build ever does write the command-name form we catch it,
  // but an absent confirmation is success, not failure. The real protection
  // against a silently-eaten slash command is assertComposerSafe (run before
  // any byte is sent); the real proof it took effect is the header model chip
  // flipping / the next effort stamp, both observed by the renderer.
  const isSlashCommand = (text) => String(text ?? '').trimStart().startsWith('/');
  // A line of the message's own that is nothing but image paths becomes a
  // picture when Claude reads the message from a paste (round twenty-nine;
  // Sol, round thirty: the transcript then holds the other lines and the
  // pictures, not the path text, and a delivered send read unconfirmed). The
  // converted form: the other lines, and how many pictures the lines name.
  const ownPathLineForm = (text) => {
    const segmentsOf = (line) => line.split(/ (?=\/|[A-Za-z]:\\)/).filter((segment) => segment.trim());
    const isPathLine = (line) => { const segments = segmentsOf(line); return segments.length > 0 && segments.every(isImagePathSegment); };
    const lines = String(text ?? '').split('\n');
    const pathLines = lines.filter(isPathLine);
    if (!pathLines.length) return null;
    return { rest: lines.filter((line) => !isPathLine(line)).join('\n').trim(), count: pathLines.reduce((n, line) => n + segmentsOf(line).length, 0) };
  };
  // asCommand: the send was typed as a command (round thirty-one: a picture's
  // caption that starts with "/" is a message, and was searched for as a
  // command tag).
  const confirmNeedle = (text, asCommand = isSlashCommand(text)) => {
    const trimmed = String(text ?? '').trimStart();
    if (asCommand && trimmed.startsWith('/')) {
      const base = trimmed.split(/\s+/, 1)[0]; // '/model'
      return `<command-name>${base}</command-name>`;
    }
    return JSON.stringify(text).slice(1, -1).slice(0, 60);
  };

  // Busy Claude sessions persist accepted input as a queue event rather than
  // a normal user turn. Match it the same way the transcript renderer pairs
  // enqueue/queued_command records: whitespace-normalized human text.
  //
  // A send that carried IMAGES is queued as "[Image #8] <text>": Claude writes
  // each pasted image's chip into the message. Exact equality therefore missed
  // every mid-turn image send, which read "could not confirm the message
  // reached the session" until Claude absorbed it minutes later (2026-11-02,
  // Pat's screenshot to this session). Leading chips are set aside only when
  // the send attached exactly that many images; the rest must still be equal.
  const LEADING_IMAGE_CHIPS_RE = /^((?:\[Image #\d+\]\s*)+)/;
  // THE WORDS A RECORD HOLDS, EXACTLY (Sol's review, rounds thirty-six and
  // thirty-seven). Line endings are unified and trailing spaces and the two
  // ends trimmed; nothing inside a line changes: dropping whitespace made
  // "releasenotes.txt" match "release notes.txt", and collapsing it made two
  // snippets that differ only in indentation one message.
  // One picture by its path: slashes either way, and a Windows path in any case.
  const samePicturePath = (recorded, sent) => {
    if (typeof recorded !== 'string' || typeof sent !== 'string') return false;
    const norm = (p) => p.trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+/g, '/');
    const [x, y] = [norm(recorded), norm(sent)];
    return /^[A-Za-z]:\//.test(y) ? x.toLowerCase() === y.toLowerCase() : x === y;
  };
  // Invisible characters are dropped from both sides first (2026-11-21): Claude
  // 2.1.321 records a prompt with them stripped (shared/invisible-chars.cjs),
  // so a message copied out of Teams never matched its own record.
  const exactWords = (value) => dropAllInvisible(value).replace(/[ \t]+$/gm, '').trim();
  // The readings of a record that may be the typed message: its literal
  // words first (a message may itself hold any tag), then, only from what
  // the CLI adds, a reminder or notification that is a part of its own left
  // out and Claude's own paste pair (2.1.27x: the id on BOTH tags) unwrapped,
  // as the window's own reader shows them (providers/transcript.js).
  const CLI_PART_RE = /^\s*<(system-reminder|task-notification)>[\s\S]*<\/\1>\s*$/;
  const PASTED_PAIR_RE = /<pasted_content id="([^"]+)">\n?([\s\S]*?)\n?<\/pasted_content id="\1">\n?/g;
  const typedReadings = (content) => {
    const parts = Array.isArray(content)
      ? content.filter((b) => b && (b.type === 'text' || b.type === 'input_text')).map((b) => String(b.text || ''))
      : [String(content ?? '')];
    const literal = exactWords(parts.join('\n'));
    const read = exactWords(parts.filter((part) => !CLI_PART_RE.test(part)).join('\n').replace(PASTED_PAIR_RE, '$2'));
    return read === literal ? [literal] : [literal, read];
  };
  // A reading equals the message, or (a send with pictures) is exactly that
  // many leading chips and then the message.
  const readingIs = (reading, want, images = 0) => {
    if (reading === want) return true;
    const lead = images > 0 ? reading.match(LEADING_IMAGE_CHIPS_RE) : null;
    return Boolean(lead) && (lead[1].match(/\[Image #\d+\]/g) || []).length === images && reading.slice(lead[1].length).trim() === want;
  };
  // A native-inbox peer message is Claude's WHOLE <cross-session-message>
  // envelope; prose that only names the tag is somebody's typed words.
  const isPeerEnvelope = (said) => /^<cross-session-message\b[^>]*>[\s\S]*<\/cross-session-message>$/.test(String(said ?? '').trim());
  const queuedTextMatches = (content, expected, images = 0) => {
    if (isPeerEnvelope(content)) return false;
    return typedReadings(content).some((reading) => readingIs(reading, expected, images));
  };
  const ONLY_IMAGE_CHIPS_RE = /^(?:\[Image #\d+\]\s*)+$/;
  const confirmsQueuedDelivery = (chunk, text, images = 0) => {
    const expected = exactWords(text);
    // Nothing but pictures (every line was a path Claude converted): the
    // queued prompt is exactly that many chips.
    const chipsOnly = (content) => {
      const got = String(content ?? '').replace(/\s+/g, ' ').trim();
      return ONLY_IMAGE_CHIPS_RE.test(got) && (got.match(/\[Image #\d+\]/g) || []).length === images;
    };
    if (!expected && !(images > 0)) return false;
    for (const line of String(chunk || '').split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'queue-operation'
          && obj.operation === 'enqueue'
          && (expected ? queuedTextMatches(obj.content, expected, images) : chipsOnly(obj.content))) return true;
      } catch { /* an incomplete/non-JSON line cannot confirm delivery */ }
    }
    return false;
  };

  // "Bytes written" is not "message received": confirm the sent text actually
  // landed in the session's transcript after the optimistic sent state. For a
  // real message an unconfirmed send becomes an honest background ERROR; for a
  // slash command (optional) an absent transcript event remains best-effort.
  // Returns true when confirmed, false when optional-and-unconfirmed.
  const prepareDeliveryConfirmation = async (sessionId) => {
    if (process.env.HARBOR_SKIP_DELIVERY_CONFIRM === '1') return { skip: true };
    if (String(sessionId).startsWith('pane:')) return { skip: true };
    const meta = await getSessionMeta(sessionId).catch(() => null);
    if (!meta?.path) return { skip: true };
    // An Antigravity row may name the cut copy; only the whole one can hold a long message.
    const wholePath = geminiWholeTranscriptPath(meta.path);
    let preSize = 0;
    try { preSize = (await fs.stat(wholePath)).size; } catch { preSize = 0; }
    // A Gemini message is also confirmed by agy's prompt history, which records
    // it when agy takes it, queued or not (geminiQueuedShown). Its boundary is
    // taken here, before typing, like the transcript's.
    const geminiHistory = geminiHistoryPathFor(wholePath);
    if (!geminiHistory) return { path: wholePath, preSize };
    let historyPreSize = 0;
    try { historyPreSize = (await fs.stat(geminiHistory)).size; } catch { historyPreSize = 0; }
    return { path: wholePath, preSize, history: { path: geminiHistory, preSize: historyPreSize, conversationId: String(sessionId), since: Date.now() } };
  };

  const confirmDelivery = async (
    sessionId,
    text,
    { timeoutMs, optional = false, prepared = null, images = 0, chips = null, paths = null } = {},
  ) => {
    if (prepared?.skip) return true;
    if (process.env.HARBOR_SKIP_DELIVERY_CONFIRM === '1') return true;
    if (String(sessionId).startsWith('pane:')) return true; // no transcript yet by definition
    let transcriptPath = prepared?.path || null;
    if (!transcriptPath) {
      const meta = await getSessionMeta(sessionId).catch(() => null);
      transcriptPath = meta?.path ? geminiWholeTranscriptPath(meta.path) : null;
    }
    if (!transcriptPath) return true; // nothing to confirm against
    const envTimeout = process.env.HARBOR_CONFIRM_TIMEOUT_MS
      ? Number(process.env.HARBOR_CONFIRM_TIMEOUT_MS) : null;
    // 20s, not 9 (2026-08-09): under the machine-wide stall the 9s budget
    // called a send failed that actually landed six minutes later. Containment
    // now bounds a stall to one session, but a session throttling inside its
    // own MemoryHigh band still writes its transcript late, and this confirm
    // is an async status, so the extra patience costs nothing interactive.
    const budget = timeoutMs ?? envTimeout ?? (optional ? 3000 : 20000);
    let preSize = prepared?.preSize;
    if (preSize == null) {
      try { preSize = (await fs.stat(transcriptPath)).size; } catch { preSize = 0; }
    }
    // Only a command confirms by its command tag; anything else is a message.
    const fromTranscript = transcriptScanner(transcriptPath, preSize, text, images, { asCommand: optional && isSlashCommand(text), chips, paths });
    // Gemini: the transcript, or agy's prompt history (a queued message reaches
    // the transcript only when the running turn ends, merged with the others).
    const fromHistory = prepared?.history && !optional && !images ? geminiHistoryScanner(prepared.history, text) : null;
    const scan = fromHistory ? async () => {
      let found = false;
      try { found = await fromTranscript(); } catch { /* the history may still say */ }
      return found || fromHistory();
    } : fromTranscript;
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await sleep(500);
      try {
        if (await scan()) return true;
      } catch { /* keep polling */ }
    }
    if (optional) return false; // slash command: delivered into a safe composer, requested
    const error = new Error('could not confirm the message reached the session. Check the window before resending');
    error.code = 'UNCONFIRMED';
    error.lateWatch = { transcriptPath, scan };
    throw error;
  };

  // Reads EVERYTHING the transcript grew by since the send, in bounded slices.
  // The confirm used to read only the first 1MB past the boundary, so a busy
  // session that wrote a screenshot-sized tool result before the queued
  // message hid the message past the cutoff. The trailing partial line is
  // carried into the next read so a record split across reads is still whole,
  // and the decoder keeps a multi-byte character split across reads intact.
  const SCAN_SLICE_BYTES = 1024 * 1024;
  // The longest line kept whole (round thirty-four). Picture bytes are dropped
  // as they stream (createDataStripper), so only words make a line this long;
  // up to here a line is parsed and judged whole, and past it the line never
  // confirms (judged by its head, a matching 60-character start confirmed a
  // different message, and a tool result's tail its caption).
  const SCAN_CARRY_MAX = 8 * 1024 * 1024;
  // WHICH RECORD MAY CONFIRM A SEND (Astra's round 4, 2026-11-01): a match
  // inside the assistant's reply or a tool's output is not the user's message
  // arriving (Codex answering "hello" confirmed a "hello" that never left the
  // box). A whole line is parsed and judged by its kind: assistant and tool
  // records never confirm; a Codex user record (user_message, or a user
  // message item) must hold the WHOLE sent text, not its first 60 characters;
  // a Claude user record confirms as before (the needle, or the whole text);
  // a queued enqueue as confirmsQueuedDelivery says. A line too large to have
  // been kept whole (an image) falls back to the old needle test.
  const recordText = (content) => (typeof content === 'string' ? content
    : Array.isArray(content) ? content.map((b) => (b && (b.type === 'text' || b.type === 'input_text') ? b.text || '' : '')).join('\n') : '');
  const recordConfirms = (rec, line, needle, text, images = 0, { strict = false, chips = null, paths = null } = {}) => {
    const want = exactWords(text);
    // ONLY A RECOGNIZED DELIVERY RECORD, AND IT MUST BE THE MESSAGE (Sol's
    // review, rounds thirty-five and thirty-six). A peer's "Please continue
    // with the next part" confirmed a typed "continue", a session summary
    // holding the words confirmed an unsent one, and a body with its spaces
    // dropped matched another file's name. So: a record that did not parse,
    // an isMeta note, a native-inbox peer envelope, or a shape not named
    // below never confirms, and a Claude or Cursor record must BE the
    // message, compared as typedWords (a picture send's own leading chips set
    // aside), not merely hold it.
    if (!rec || typeof rec !== 'object' || rec.isMeta) return false;
    const sameBody = (content) => typedReadings(content).some((reading) => readingIs(reading, want, images));
    // STRICT: a picture send, or the converted form (ownPathLineForm), confirms
    // only on one record that STARTS with exactly the attachment chips its
    // verified draft showed, in order, then its words (or nothing, when every
    // line was a path), and carries that many pictures (rounds thirty-one to
    // thirty-four). Attachments lead; a label in the words is only words.
    if (strict) {
      if (!Array.isArray(chips)) return false;
      // Blank lines aside: Claude joins a converted paste's remaining lines
      // without them.
      const lined = (value) => exactWords(value).split('\n').filter((l) => l.trim()).join('\n');
      const wanted = lined(want);
      const chipsThenWords = (content) => {
        if (isPeerEnvelope(Array.isArray(content) ? recordText(content) : content)) return false;
        return typedReadings(content).some((reading) => {
          let rest = reading;
          for (const chip of chips) {
            const label = rest.match(/^\[Image\s*#(\d+)\]\s*/);
            if (!label || `[Image#${label[1]}]` !== chip) return false;
            rest = rest.slice(label[0].length);
          }
          return lined(rest) === wanted;
        });
      };
      if (rec.type === 'queue-operation') return rec.operation === 'enqueue' && chipsThenWords(rec.content);
      const parts = rec.type === 'user' ? rec.message?.content : rec.type === 'attachment' && rec.attachment?.type === 'queued_command' ? rec.attachment.prompt : null;
      if (!Array.isArray(parts) || parts.some((b) => b?.type === 'tool_result')) return false;
      if (parts.filter((b) => b?.type === 'image').length !== images) return false;
      return chipsThenWords(parts);
    }
    if (!want) return false;
    if (rec.type === 'queue-operation') return confirmsQueuedDelivery(line, text, images);
    if (rec.type === 'assistant' || rec.message?.role === 'assistant' || rec.role === 'assistant') return false;
    // Codex: the whole user_message, or ONE input item that is the message
    // (round thirty-seven: its instruction items, AGENTS.md included, sit
    // beside the typed text, and the words inside them confirmed a send).
    // The same record must carry exactly the send's pictures (round
    // thirty-eight: a text-only turn with the caption confirmed a screenshot
    // Codex never took). Codex 0.17x keeps each as an input_image item beside
    // the typed text item.
    // And they must be THE send's pictures (round thirty-nine: an older
    // screenshot turn with the same caption and count confirmed a new one):
    // Codex 0.167 heads each with <image name=[Image #N] path="...">, the
    // path as Harbor pasted it, so the paths must be the sent ones, in order.
    const samePictures = (recorded) => (images === 0 ? recorded.length === 0
      : Array.isArray(paths) && paths.length === images && recorded.length === images
        && recorded.every((one, n) => samePicturePath(one, paths[n])));
    if (rec.type === 'event_msg') {
      if (rec.payload?.type !== 'user_message') return false;
      // Encoded images carry no path: never this send's pictures.
      if (Array.isArray(rec.payload.images) && rec.payload.images.length) return false;
      if (!samePictures(Array.isArray(rec.payload.local_images) ? rec.payload.local_images.map((one) => (typeof one === 'string' ? one : one?.path)) : [])) return false;
      return readingIs(exactWords(rec.payload.message), want, images);
    }
    if (rec.type === 'response_item') {
      if (rec.payload?.type !== 'message' || rec.payload.role !== 'user' || !Array.isArray(rec.payload.content)) return false;
      const items = rec.payload.content;
      const recorded = [];
      for (let n = 0; n < items.length; n += 1) {
        if (items[n]?.type !== 'input_image') continue;
        const head = items[n - 1]?.type === 'input_text' ? /^<image name=\[Image #\d+\] path="([^"]*)">$/.exec(String(items[n - 1].text).trim()) : null;
        recorded.push(head ? head[1] : null);
      }
      if (!samePictures(recorded)) return false;
      return rec.payload.content.some((item) => item && (item.type === 'input_text' || item.type === 'text') && readingIs(exactWords(item.text), want, images));
    }
    if (rec.type === 'user') {
      const content = rec.message?.content;
      if (Array.isArray(content) && content.some((b) => b?.type === 'tool_result')) return false;
      const said = recordText(content);
      if (isPeerEnvelope(said)) return false;
      // A real slash command is logged as its <command-name> form (confirmNeedle).
      if (String(needle || '').startsWith('<command-name>')) return said.includes(needle);
      return sameBody(content);
    }
    // The prompt is a LIST of parts (text, then each image) on 2.1.316; reading
    // it as one string never matched an image send.
    if (rec.type === 'attachment') {
      if (rec.attachment?.type !== 'queued_command') return false;
      return !isPeerEnvelope(recordText(rec.attachment.prompt)) && sameBody(rec.attachment.prompt);
    }
    // Cursor's agent transcript: {"role":"user","message":{...}} with no type,
    // the typed words framed in <user_query> after a <timestamp>.
    if (!rec.type && rec.role === 'user') {
      const said = recordText(rec.message?.content);
      const framed = said.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
      return exactWords(framed ? framed[1] : said) === want;
    }
    // Antigravity's transcript_full.jsonl: a USER_EXPLICIT USER_INPUT step whose
    // <USER_REQUEST> IS the typed words (its metadata sections follow it). A
    // model, tool or system step never confirms, and a send that carried
    // pictures reaches Gemini as a path line inside its words, never as items.
    if (rec.type === 'USER_INPUT') {
      if (rec.source !== 'USER_EXPLICIT' || images) return false;
      const said = geminiUserRequest(rec.content);
      return said !== null && exactWords(said) === want;
    }
    return false;
  };
  // PICTURE BYTES ARE DROPPED AS THE TRANSCRIPT STREAMS IN (Sol's review,
  // round thirty-one): a record carrying a screenshot can run to megabytes and
  // straddle reads, and the carry below kept only its tail, losing the words.
  // Every "data":"..." string value is emptied in place, escapes respected,
  // so each record stays whole, small and parseable, its image blocks still
  // there to count. Base64 holds no quote or backslash, and a quoted "data"
  // inside someone's words is escaped (\"data\"), so it never matches.
  // Encoded pictures are emptied as they stream: Claude's "data" values and
  // Codex's "image_url" data URLs (round thirty-nine: a 10 MB Codex receipt
  // passed SCAN_CARRY_MAX and a delivered screenshot stayed unconfirmed). The
  // item itself stays, so the picture still counts.
  const createDataStripper = () => {
    const KEYS = [{ find: '"data":"', keep: '"data":"' }, { find: '"image_url":"data:', keep: '"image_url":"' }];
    const longest = Math.max(...KEYS.map((key) => key.find.length));
    let inData = false;
    let escaped = false;
    let held = '';
    return (text) => {
      const input = held + text;
      held = '';
      let out = '';
      let i = 0;
      while (i < input.length) {
        if (inData) {
          for (; i < input.length; i += 1) {
            const c = input[i];
            if (escaped) { escaped = false; continue; }
            if (c === '\\') { escaped = true; continue; }
            if (c === '"') { inData = false; out += '"'; i += 1; break; }
          }
          continue;
        }
        let next = null;
        for (const key of KEYS) {
          const at = input.indexOf(key.find, i);
          if (at >= 0 && (!next || at < next.at)) next = { at, key };
        }
        if (!next) {
          // A key cut by the read boundary waits for the next piece.
          let hold = 0;
          for (let k = Math.min(longest - 1, input.length - i); k > 0 && !hold; k -= 1) {
            const tail = input.slice(input.length - k);
            if (KEYS.some((key) => key.find.startsWith(tail))) hold = k;
          }
          out += input.slice(i, input.length - hold);
          held = input.slice(input.length - hold);
          break;
        }
        out += input.slice(i, next.at) + next.key.keep;
        i = next.at + next.key.find.length;
        inData = true;
      }
      return out;
    };
  };
  const transcriptScanner = (transcriptPath, from, text, images = 0, { asCommand = isSlashCommand(text), chips = null, paths = null } = {}) => {
    const needle = confirmNeedle(text, asCommand);
    // The converted form only when the verified draft SHOWED the conversion
    // (more chips than pictures sent), and then only with those very chips
    // (round thirty-two: an earlier send's picture with the same words, taken
    // in late, confirmed one Claude never took).
    // The first `attached` chips of the draft are its attachments (pictures are
    // pasted first, and Claude puts converted chips at the front of a paste);
    // any later label is the message's own words.
    const pathForm = ownPathLineForm(text);
    const attached = images + (pathForm?.count || 0);
    const form = pathForm && Array.isArray(chips) && chips.length > images && chips.length >= attached ? pathForm : null;
    // A send that carried pictures, with its draft's chips known, is held to
    // them as the converted form is (round thirty-four: an older queued
    // screenshot with the same caption, taken in late, or the caption alone,
    // confirmed a new screenshot send).
    const ownChips = images > 0 && Array.isArray(chips) && chips.length >= images ? chips.slice(0, images).map(squashSpace) : null;
    const forms = [{ text, images, needle, paths, ...(ownChips ? { strict: true, chips: ownChips } : {}) }];
    if (form) forms.push({ text: form.rest, images: attached, needle: form.rest ? confirmNeedle(form.rest, false) : null, strict: true, chips: chips.slice(0, attached).map(squashSpace) });
    const strip = createDataStripper();
    // Set once a line past SCAN_CARRY_MAX has been let go: the rest of it, up
    // to its newline, is skipped, never judged as a line of its own.
    let skipTail = false;
    const nearby = (line) => forms.some((one) => one.needle && line.includes(one.needle));
    const decoder = new StringDecoder('utf8');
    let offset = from;
    let carry = '';
    return async () => {
      const { size } = await fs.stat(transcriptPath);
      while (offset < size) {
        const length = Math.min(size - offset, SCAN_SLICE_BYTES);
        const buffer = Buffer.alloc(length);
        const handle = await fs.open(transcriptPath, 'r');
        try {
          await handle.read(buffer, 0, length, offset);
        } finally {
          await handle.close();
        }
        offset += length;
        const chunk = carry + strip(decoder.write(buffer));
        const cut = chunk.lastIndexOf('\n');
        const complete = cut >= 0 ? chunk.slice(0, cut) : '';
        carry = cut >= 0 ? chunk.slice(cut + 1) : chunk;
        let lines = cut >= 0 ? complete.split('\n') : [];
        if (skipTail && cut >= 0) { lines = lines.slice(1); skipTail = false; }
        for (const line of lines) {
          if (!line.trim() || (!nearby(line) && !line.includes('queue-operation') && !line.includes('user_message') && !line.includes('"user"') && !line.includes('queued_command') && !line.includes('USER_INPUT'))) continue;
          let rec = null;
          try { rec = JSON.parse(line); } catch { rec = null; } // never confirms (recordConfirms)
          if (forms.some((one) => recordConfirms(rec, line, one.needle, one.text, one.images, { strict: Boolean(one.strict), chips: one.chips, paths: one.paths }))) return true;
        }
        if (carry.length > SCAN_CARRY_MAX) {
          // Too long to judge whole: it never confirms.
          carry = '';
          skipTail = true;
        }
      }
      return false;
    };
  };

  // agy's prompt history (<home>\.gemini\antigravity-cli\history.jsonl): one
  // JSON line per prompt it took, {display, timestamp, workspace,
  // conversationId}, written the moment it takes the prompt, queued behind a
  // running turn or not (measured on agy 1.5.14, 2026-11-25). A PASTED prompt's
  // display carries NUL marks between some characters; without them it is the
  // text exactly (four pastes of 469 to 1,289 characters, 20 lines among them).
  // A line confirms only when it was written after the send (bytes past the
  // boundary AND a timestamp from the send on, in case agy trims the file), is
  // this conversation's, and holds exactly the typed words.
  const geminiHistoryScanner = ({ path: historyPath, preSize, conversationId, since = 0 }, text) => {
    const want = exactWords(text);
    let offset = preSize;
    let decoder = new StringDecoder('utf8');
    let carry = '';
    return async () => {
      if (!want || !conversationId) return false;
      const { size } = await fs.stat(historyPath);
      if (size < offset) { offset = 0; carry = ''; decoder = new StringDecoder('utf8'); } // rewritten shorter: the timestamp decides
      while (offset < size) {
        const length = Math.min(size - offset, SCAN_SLICE_BYTES);
        const buffer = Buffer.alloc(length);
        const handle = await fs.open(historyPath, 'r');
        try {
          await handle.read(buffer, 0, length, offset);
        } finally {
          await handle.close();
        }
        offset += length;
        const chunk = carry + decoder.write(buffer);
        const cut = chunk.lastIndexOf('\n');
        carry = cut >= 0 ? chunk.slice(cut + 1) : chunk;
        if (carry.length > SCAN_CARRY_MAX) carry = '';
        for (const line of cut >= 0 ? chunk.slice(0, cut).split('\n') : []) {
          if (!line.includes(conversationId)) continue;
          let rec = null;
          try { rec = JSON.parse(line); } catch { continue; }
          if (rec?.conversationId !== conversationId || typeof rec.display !== 'string') continue;
          if (!(Number(rec.timestamp) >= since)) continue;
          if (exactWords(rec.display.replace(/\u0000/g, '')) === want) return true;
        }
      }
      return false;
    };
  };

  // A message that misses the confirm window is not necessarily lost. Live-caught
  // 2026-10-09 (send log 19:18:08Z): Pat's "continue" reached a 28MB-transcript
  // session two minutes late, right after the machine woke from a 19-minute
  // sleep, and the "could not confirm" error stayed in the status bar for the
  // next hour, which read as a session that would not take messages. After the
  // error, keep watching the same transcript; if the text lands, say so, unless
  // something newer has been said about the session since.
  const LATE_WATCH_MS = Number(process.env.HARBOR_LATE_CONFIRM_MS) || 10 * 60 * 1000;
  const LATE_POLL_MS = 2000;
  const lateSleep = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.(); // a watcher must never keep Harbor (or a test run) alive
  });
  const watchLateDelivery = async (sessionId, scan, errorSeq) => {
    const deadline = Date.now() + LATE_WATCH_MS;
    while (Date.now() < deadline) {
      await lateSleep(LATE_POLL_MS);
      if (statusSeq.get(sessionId) !== errorSeq) return false; // superseded
      let landed = false;
      try { landed = await scan(); } catch { /* keep watching */ }
      if (!landed) continue;
      if (statusSeq.get(sessionId) !== errorSeq) return false;
      status(sessionId, 'sent', 'Your message reached the session after all');
      return true;
    }
    return false;
  };

  // Control is acquired on tile focus and released on blur, and both travel
  // async through the bridge; a send must OWN its precondition instead of
  // assuming ambient focus state (a menu click can blur the tile between the
  // check and the write, which surfaced as a flaky 'pane is not focused for
  // control' refusal). Acquire, wait for it to land, retry once on refusal.
  const controlSettled = (paneId) => terminalBridge.getState().controlledPaneId === paneId
    && (terminalBridge.controlReady ? terminalBridge.controlReady(paneId) : true);

  const acquireControl = async (paneId, workspaceId) => {
    if (controlSettled(paneId)) return;
    if (terminalBridge.getState().controlledPaneId !== paneId) {
      await terminalBridge.requestFocusPane({ paneId, workspaceId }).catch(() => {});
    }
    // Wait for the attach to COMPLETE (first frame from the control child),
    // not just for the optimistic acquire: input written pre-grant is dropped
    // silently by the daemon.
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      if (controlSettled(paneId)) return;
      await sleep(50);
    }
  };

  // Typing waits for the keeper to say it wrote the keys (sendInputAcked), so
  // keys that never reached the pane fail here instead of being waited on as
  // if Claude had them queued (Sol's review, 2026-11-18).
  // Only a DEFINITE refusal (not the controlling client, the session exited)
  // is retried: the keys were never written. A timeout or a dropped daemon
  // connection can come after the keeper wrote them, so typing them again
  // could paste twice or press a second Enter into whatever came next (Sol's
  // review, round two); that send stops, and its pending record (written
  // before the keys went out) makes the next send wait for the text instead.
  const typeInto = async (paneId, workspaceId, payload) => {
    let result = await sendPaneInputAcked(paneId, payload);
    if (result?.ok === false && !result.ambiguous) {
      await acquireControl(paneId, workspaceId);
      result = await sendPaneInputAcked(paneId, payload);
    }
    if (result?.ok === false) throw result.ambiguous ? inputUnconfirmedError(result.reason) : new Error(result.reason || 'input refused');
  };
  const inputUnconfirmedError = (reason) => {
    const error = new Error(`Harbor could not confirm the session took the keys (${reason}), so nothing more was typed. Your text is kept; if it shows up in the prompt, the next send presses Enter for it instead of typing it again`);
    error.code = 'INPUT_UNCONFIRMED';
    error.submission = 'unknown';
    return error;
  };

  // Claude numbers pasted images cumulatively per session (#1, #2, #3…), and a
  // SENT image turn leaves TWO markers in the recent viewport (the prompt-echo
  // line and the "⎿ [Image #N]" attachment line). A raw COUNT delta is
  // therefore fragile: pasting the next image grows the composer and scrolls
  // those old markers off the top of readPane's 16-line window, so the count
  // can DROP even though the new image attached, live-caught as a real paste
  // falsely reported "never confirmed the image attachment." Track the highest
  // number instead: the freshly pasted image is always the highest #N in the
  // session, so a strictly-greater max is the robust "a new image landed"
  // signal, immune to older markers scrolling out of view.
  // How long a send waits on a Claude that has drawn NOTHING since Harbor typed
  // (see waitForPromptToHold): its input is queued, not lost.
  // Three minutes of REAL time (the clock, not a poll count a slow screen read
  // stretches), so a send ends before the phone's four-minute call deadline.
  const STALLED_WAIT_MS = 3 * 60_000;
  // A MARKER CAN WRAP (2026-11-18, Pat's screenshot into Vox: "Claude never
  // confirmed the image attachment ... no marker beyond #0"). Behind a long
  // message the chip lands at the end of the prompt and Claude wraps it at its
  // own space, "...when done.[Image" over "#430]", so a per-line match never
  // saw an attachment that was sitting right there. Whitespace is dropped
  // first, the same way the prompt checks read the box.
  const maxImageMarker = (screen) => (String(screen || '').replace(/\s+/g, '').match(/\[Image#(\d+)\]/g) || [])
    .reduce((max, marker) => Math.max(max, Number(marker.match(/\d+/)[0])), 0);

  // The base wait counts only while Claude is drawing: a screen unchanged
  // since the chord means Claude has not read the key yet (stalled or starved
  // of CPU, see STALLED_POLLS), so the wait goes on until it does.
  // A first redraw that comes late (after the base window) gets a full window
  // of its own from then: the redraw may be Claude just waking, about to read
  // the chord (Sol's review, 2026-11-18).
  // The newest image chip IN THE COMPOSER BOX, or null when no box is drawn.
  // A chip in the conversation above (an earlier message's, or one the model
  // printed) says nothing about this chord (Sol's review, round seven).
  const composerImageMax = (screen) => {
    const box = composerBox(screen);
    return box ? maxImageMarker(box.raw) : null;
  };
  const waitForImageMarker = async (paneId, beforeMax, { timeoutMs = 12000, baseline = null, onStalled = null, literal = null } = {}) => {
    // A pasted path Claude could not read stays in the box as text (round
    // twenty-eight). Seen there with no new chip on 15 reads in a row (at
    // least 1.5 s), it is not converting: the paste was read, so nothing is
    // owed, and it is refused. Counted in reads, like every wait here.
    let literalReads = 0;
    const basePolls = Math.ceil(timeoutMs / 100);
    const stallPolls = Math.ceil(STALLED_WAIT_MS / 100);
    const startedAt = clock();
    let changed = baseline == null;
    let changedAt = changed ? 0 : null;
    let changedAtTime = startedAt;
    let noticed = false;
    const more = (poll) => (poll < basePolls && clock() - startedAt < timeoutMs)
      || (!changed && poll < stallPolls && clock() - startedAt < STALLED_WAIT_MS)
      || (changed && changedAt !== null && poll < changedAt + basePolls && clock() - changedAtTime < timeoutMs);
    for (let poll = 0; more(poll); poll += 1) {
      await sleep(100);
      let screen = '';
      // The wide read (round nine: the desktop's default 16 lines lost the
      // composer's top edge once the chip made the box one line taller).
      try { screen = await readPane(paneId, MENU_READ_LINES); } catch { continue; }
      if (!changed && screen && screenContent(screen) !== screenContent(baseline)) { changed = true; changedAt = poll; changedAtTime = clock(); }
      const max = composerImageMax(screen);
      if (max !== null && max > beforeMax) return max;
      if (literal && (composerBox(screen)?.inside || '').includes(literal)) {
        literalReads += 1;
        if (literalReads >= 15) throw imageLeftAsTextError();
      } else literalReads = 0;
      if (!changed && !noticed && poll + 1 >= basePolls && onStalled) { noticed = true; try { onStalled(); } catch { /* status only */ } }
    }
    throw new Error(changed
      ? `Claude never confirmed the image attachment; image and text were NOT sent (no marker beyond #${beforeMax} within ${timeoutMs}ms)`
      : `Claude drew nothing for ${Math.round(STALLED_WAIT_MS / 60000)} minutes after Harbor pasted the image, so nothing more was typed or sent. Your text is kept. Check the >_ terminal`);
  };

  // CODEX ATTACHES A PASTED PATH ITSELF (Codex 0.165.0, 2026-10-29): a paste
  // that is nothing but an image file's path, bare or quoted, becomes an image
  // in the box (chat_composer.rs handle_paste_image_path) with "[Image #N]"
  // drawn in its place, no clipboard needed, so the desktop and the phone take
  // the same route. The label the phone used ("Image: <path>") defeated it and
  // left Codex a path to read. Codex numbers images per message, so an older
  // "[Image #1]" in the transcript says nothing; only the box is counted.
  const codexBoxImages = (screen) => {
    const box = codexPromptBox(screen);
    return box ? countImageChips(box.inside) : 0;
  };
  const pasteCodexImage = async (paneId, workspaceId, imagePath, { timeoutMs = 12000 } = {}) => {
    const before = codexBoxImages(await readScreen(paneId, CODEX_READ_LINES));
    await typeInto(paneId, workspaceId, `\x1b[200~"${imagePath}"\x1b[201~`);
    for (let poll = 0; poll * CODEX_POLL_MS < timeoutMs; poll += 1) {
      await sleep(CODEX_POLL_MS);
      const box = codexPromptBox(await readScreen(paneId, CODEX_READ_LINES));
      const count = box ? countImageChips(box.inside) : 0;
      if (count > before) return (box.inside.match(IMAGE_CHIPS_RE) || []).at(-1).replace('#', ' #');
    }
    throw new Error(`Codex never attached the image (no new [Image #N] in its box within ${timeoutMs / 1000} s); the image and text were NOT sent. Check the >_ terminal: the path may be sitting in the box as text`);
  };

  // Cached Claude conversations may ask for a second confirmation after a
  // /model or /effort command has already been submitted. This is deliberately
  // separate from assertComposerSafe: that guard protects text before send;
  // this narrowly-scoped handler resolves only Claude's known switch prompt.
  //
  // The pane WRAPS that sentence wherever its width falls (2026-10-21, Claude
  // Code 2.1.303 at 120 columns: "...gets re-read" / "on your next message." in
  // one session, "...re-read on" / "your next message." in another), and the
  // match used to require it on one line, so both of Pat's effort changes that
  // morning stopped on the raw-screen panel. The screen is matched with its
  // whitespace collapsed, and the dialog's own title and answer pair are
  // accepted as well, so a reworded explanation does not break it either.
  //
  // 2.1.312 (2026-10-28) did reword it: the sentence ends "gets re-read." with
  // no "on your next message", and the /model dialog's title is "Switch
  // model?" (2.1.310 and 2.1.312), not the "Change model?" this match guessed, so a
  // model change stopped on the open dialog. Both endings and the real title
  // are accepted now (fixtures claude-2.1.312-model-sonnet-*.txt).
  const SWITCH_COMMAND_RE = /^\/(model|effort)(?:\s|$)/i;
  // Only an OPEN switch dialog, read as ONE dialog (Sol's review, rounds forty
  // to forty-two). Every real capture (2.1.303, 2.1.312, and 2.1.321 live) is
  // drawn the same way: an edge (a run of ─ or ▔) directly above the title,
  // then the warning, then "1. Yes, switch to …" and "2. No, go back" as the
  // last thing on screen (the dialog takes the prompt's place). So the block
  // under the last edge must be exactly that dialog, with one answer pair:
  // prose quoting it has a prompt under it, and an older warning above a
  // DIFFERENT open dialog (an edit confirmation ending "2. No") once got "1"
  // and Enter. With no edge in view the whole screen must be the dialog.
  const SWITCH_EDGE_RE = /^\s*(?:─{10,}|▔{10,})/;
  const SWITCH_TITLE_FORM_RE = /^(?:Change effort level|Switch model|Change model)\? .{0,600}?(?:❯ )?1\. Yes, switch to .{1,120}? (?:❯ )?2\. No, go back$/i;
  const SWITCH_SENTENCE_FORM_RE = /^(?:Your next response will be slower and use more tokens )?(?:This conversation is cached for the current (?:model|effort level)\. )?Switching to .{1,120}? means the full history gets re-read(?: on your next message)?\. (?:❯ )?1\. Yes(?:, switch to .{1,120}?)? (?:❯ )?2\. No(?:, go back)?$/i;
  const showsSwitchConfirm = (screen) => {
    const lines = String(screen || '').split('\n');
    let end = lines.length - 1;
    while (end >= 0 && !lines[end].trim()) end -= 1;
    if (end < 0 || !/^\s*(?:❯\s*)?2\.\s*No\b/.test(lines[end])) return false;
    let top = end - 1;
    while (top >= 0 && !SWITCH_EDGE_RE.test(lines[top])) top -= 1;
    const block = lines.slice(top + 1, end + 1);
    if (block.filter((line) => /^\s*(?:❯\s*)?1\.\s/.test(line)).length !== 1) return false;
    if (block.filter((line) => /^\s*(?:❯\s*)?2\.\s/.test(line)).length !== 1) return false;
    const read = block.join(' ').replace(/\s+/g, ' ').trim();
    return SWITCH_TITLE_FORM_RE.test(read) || SWITCH_SENTENCE_FORM_RE.test(read);
  };

  // THE DIALOG CAN COME LATE (2026-11-19, CLI 2.1.321, four of seven live
  // drives): after Enter the CLI drew only the echoed "❯ /model …", no box
  // and no result, for longer than the old 4.5-second watch, then opened
  // "Switch model?", which stayed open and refused the next send ("a prompt
  // appeared in the session"). The watch now lasts until the command has an
  // answer: the dialog, or its own result drawn under its echo ("⎿ Set model
  // to …", the no-dialog case), up to 20 seconds.
  const SWITCH_WATCH_READS = 40; // 500 ms apart
  // And ONE wall-clock deadline that bounds every read too (round forty-one:
  // reads that each took six seconds to fail held the pane's lock 259 s).
  const SWITCH_WATCH_MS = Number(process.env.HARBOR_SWITCH_WATCH_MS) > 0 ? Number(process.env.HARBOR_SWITCH_WATCH_MS) : 20_000;
  const readPaneWithin = (paneId, ms) => new Promise((resolve, reject) => {
    if (!(ms > 0)) { reject(new Error('switch watch deadline passed')); return; }
    const timer = setTimeout(() => reject(new Error('switch watch read timed out')), ms);
    timer.unref?.();
    Promise.resolve().then(() => readPane(paneId)).then(
      (screen) => { clearTimeout(timer); resolve(screen); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
  // The command's own echo lines; a result counts only under a NEW one (round
  // forty: the same command's earlier echo and result, still on screen, ended
  // the watch before this one's echo was drawn, and its late dialog stayed).
  // Above the prompt box only: the command typed into the box, before its
  // Enter, is drawn exactly like its echo.
  const switchEchoes = (screen, text) => {
    const echo = `❯ ${String(text || '').trim()}`;
    const lines = String(screen || '').split('\n');
    const box = composerBox(screen);
    const at = [];
    for (let n = 0; n < (box ? box.top : lines.length); n += 1) if (lines[n].trim() === echo) at.push(n);
    return at;
  };
  // The count before the Enter, only from a screen that shows the prompt box
  // (the command sits in it then); a blank or partial read leaves it unknown
  // (round forty-one: a blank read counted zero, and the older result then
  // read as new).
  const switchBaseline = (screen, text) => (composerBox(screen) ? switchEchoes(screen, text).length : Infinity);
  const switchSettled = (screen, text, echoesBefore) => {
    const at = switchEchoes(screen, text);
    if (at.length <= echoesBefore) return false;
    return String(screen || '').split('\n').slice(at.at(-1) + 1).some((line) => /^\s*⎿/.test(line));
  };
  // `echoesBefore`: how many echoes of this command the screen showed before
  // its Enter (Infinity when unknown, so only the dialog or the 20 s ends it).
  const resolveClaudeSwitchConfirm = async (paneId, workspaceId, text, provider, echoesBefore = Infinity) => {
    if (provider !== 'claude' || !SWITCH_COMMAND_RE.test(String(text || '').trim())) return false;

    const deadline = clock() + SWITCH_WATCH_MS;
    let dialogSeen = false;
    for (let attempt = 0; attempt < SWITCH_WATCH_READS && clock() < deadline; attempt += 1) {
      if (attempt > 0) await sleep(500);
      let screen = '';
      try { screen = await readPaneWithin(paneId, deadline - clock()); } catch { continue; }
      if (!showsSwitchConfirm(screen)) {
        if (switchSettled(screen, text, echoesBefore)) break;
        continue;
      }
      dialogSeen = true;
      await typeInto(paneId, workspaceId, '1');
      await typeInto(paneId, workspaceId, '\r');
      break;
    }
    if (!dialogSeen) return false;

    const closedBy = clock() + 5000;
    for (let attempt = 0; attempt < 8 && clock() < closedBy; attempt += 1) {
      if (attempt > 0) await sleep(250);
      try {
        // Closed only on a readable frame (round forty-two: one blank frame
        // reported a dialog that was still open as answered).
        const screen = await readPaneWithin(paneId, closedBy - clock());
        if (String(screen || '').trim() && !showsSwitchConfirm(screen)) return true;
      } catch { /* keep verifying until the bounded retry is exhausted */ }
    }
    throw new Error('could not confirm the Claude model/effort switch; answer the open dialog via the >_ terminal');
  };

  // Enter can be swallowed (see composerSendState), and Harbor used to learn
  // that only when confirmDelivery gave up 20 seconds later, with the message
  // still sitting in the composer for the next send to be glued onto. Spare
  // Enters are measured harmless on 2.1.280 (three in a row sent one message;
  // one on an idle empty composer, or with a message queued, sent nothing), but
  // a spare is still pressed only on evidence: the box has held this send on
  // two reads in a row and nothing on screen is a dialog an Enter would answer.
  // Two spares at most. The watch runs inside the send's own control hold and
  // queue slot, so the next message cannot be typed onto a stranded one while
  // it is undecided. It ends at `taken`, at a dialog, or after
  // ENTER_WATCH_POLLS reads (about 8s), and whatever it could not decide is
  // left to confirmDelivery, as before. Counted in reads, not wall time.
  //
  // A screen with NO composer box is not a verdict (2026-10-09). It used to end
  // the watch as if the message had gone, which is how two of Pat's messages
  // were reported "sent" half a second after an Enter that never submitted
  // anything; an unreadable or boxless frame now just means "read again".
  const ENTER_POLL_MS = 350;
  const ENTER_WATCH_POLLS = 24;
  const ENTER_SPARES = 2;
  // A spare Enter is pressed only while the prompt still SHOWS the message.
  // If the first Enter is still queued in a frozen CLI, the spare is queued
  // right behind it and both are read in one batch: the first submits, the
  // second meets an empty prompt, where Enter does nothing. Nothing the first
  // one causes (a permission dialog, a picker) can be drawn before the second
  // is read, since it needs a model round trip first. A live CLI that
  // silently ignored an Enter draws nothing either, and needs the spare
  // (2026-09-23), so "drew since" cannot gate it.
  // `stillOurs(screen)` is the first Enter's own draft test (round fourteen):
  // a spare goes only on a frame that passes it, and a frame that ends with
  // the message but no longer is that draft (a chip or text drawn in front)
  // gets no Enter; what it was is left to confirmDelivery.
  const watchEnterTaken = async (paneId, workspaceId, sent, checkTarget = async () => {}, stillOurs = () => true) => {
    let spares = 0;
    let held = 0;
    for (let poll = 0; poll < ENTER_WATCH_POLLS; poll += 1) {
      await sleep(ENTER_POLL_MS);
      const screen = await readScreen(paneId, MENU_READ_LINES);
      if (screen && classifyBlocked(screen)) return 'unconfirmed';
      const state = screen ? composerSendState(screen, sent) : 'nobox';
      if (state === 'taken') return state;
      held = state === 'holds' ? held + 1 : 0;
      if (held < 2) continue;
      // 'not-taken': the prompt still holds the message on two reads after
      // every spare, or a spare was withheld over a changed draft; either way
      // it is still in the prompt (round twenty-six: a captionless screenshot
      // in that state was reported delivered).
      if (spares >= ENTER_SPARES) return 'not-taken';
      if (!stillOurs(screen)) {
        logSend({ paneId, phase: 'draft-changed-before-retry' });
        await captureSendScreen(paneId, 'draft-changed-before-retry', screen);
        return 'not-taken';
      }
      spares += 1;
      held = 0;
      logSend({ paneId, phase: 'enter-retry', attempt: spares });
      await checkTarget();
      await typeInto(paneId, workspaceId, '\r');
    }
    return 'unconfirmed';
  };

  // THE PROMPT MUST SHOW THE TEXT BEFORE ENTER IS PRESSED (2026-10-09, Pat:
  // messages "silently not reaching" session aac2564b). For 45 minutes that
  // session's Claude was alive and idle, finishing its own turns, while its
  // prompt took none of Harbor's keystrokes: two image pastes drew no marker,
  // two messages and a "continue" never appeared in the prompt, and Claude's
  // own prompt history (~/.claude/history.jsonl, written on every submit)
  // recorded none of them. Harbor typed, waited a fixed 160ms, pressed Enter
  // blind, and reported "sent" twice. The trigger inside the CLI was not
  // identified; resizes, terminal focus, the agent list and Alt+V were each
  // measured innocent against the real CLI, and the keeper answered every read
  // (see docs/claude/conversation.md). A second state
  // with the same look was reproduced on CLI 2.1.295: after the ← sessions
  // view and Esc, the prompt drew normally and dropped typed text, and Harbor
  // said "sent" after 8.6 seconds, the exact timing of Pat's "continue".
  //
  // So the Enter waits for evidence: the box ends with this send (composerSendState
  // `holds`). Without it Harbor presses NOTHING, says so at once, and keeps the
  // screen for diagnosis. Waiting for the draw also removes the 2026-09-23
  // coalescing race at its source: the text has been read before Enter exists.
  // Counted in reads, like the Enter watch; a CLI that draws late is the normal
  // case it waits through, not a failure.
  //
  // A STARTING CLAUDE SHOWS TYPING LATE, NOT NEVER (2026-10-10, Pat: a 6,299
  // character message into a brand-new cdt-app session, refused twice with
  // "nothing was sent", then found sitting in its prompt minutes later). Until
  // its prompt takes the keyboard, the CLI collects keystrokes in a startup
  // buffer (startCapturingEarlyInput in 2.1.296: escape sequences stripped,
  // so a paste arrives as plain lines and never collapses to "[Pasted text]",
  // and Enter becomes a newline) and drops the whole buffer into the prompt
  // when it takes over. Its prompt is DRAWN before that, so an empty box is not
  // proof the typing was lost. That session drew an empty prompt at 7 s and was
  // still holding both attempts in the buffer at 37 s, on a machine at 100% CPU.
  // The 7.5 s wait gave up, the second attempt typed the message again, and
  // both copies landed in one prompt. So the first message into a pane waits
  // minutes, saying why, and a pane whose prompt never showed what Harbor
  // typed is waited on, never typed into again (see unshownTyped).
  const PROMPT_HOLD_POLL_MS = 150;
  const PROMPT_HOLD_POLLS = 50;
  const PROMPT_HOLD_STARTUP_POLLS = 1200;
  const PROMPT_HOLD_NOTICE_POLLS = 20;
  // TYPED TEXT IS QUEUED, NOT LOST, WHILE CLAUDE DRAWS NOTHING (2026-11-18,
  // Pat: "this has been a constant problem ... solving symptoms and not
  // causes"). A pty's input is a queue: bytes written to a live CLI wait until
  // it reads them. Every pane had been starved of CPU (daemon/interactive-
  // priority.js), Claude drew nothing for minutes, and this wait gave up after
  // 7.5 s of wall time on text that was only waiting in line. The next send saw
  // an empty prompt, called the first try lost and pasted again, and when
  // Claude woke the copies stacked and every later send was refused. A live
  // Claude draws typed text within a frame, so a screen that has not changed
  // since the typing means Claude has not read it yet. The wait is therefore
  // counted only from the first redraw after the typing (and needs a few
  // redraws before it calls the text missing); while nothing redraws it goes
  // on, up to STALLED_WAIT_MS, and the Enter goes in the moment the text shows.
  // `baseline` is the screen read just before the typing; without one (a slash
  // command, an image send) the old wall-time count applies.
  const STALLED_REDRAWS = 3;
  const STALLED_NOTICE = 'Claude has not drawn anything since Harbor typed your message (it is busy or short of CPU). Your message is typed and goes in the moment Claude shows it';
  const waitForPromptToHold = async (paneId, sent, { polls = PROMPT_HOLD_POLLS, onWait = null, baseline = null, onStalled = null } = {}) => {
    let state = 'nobox';
    let screen = '';
    let previous = baseline;
    let redraws = 0;
    let livePolls = 0;
    let noticed = false;
    const stallPolls = Math.ceil(STALLED_WAIT_MS / PROMPT_HOLD_POLL_MS);
    const startedAt = clock();
    for (let poll = 0; ; poll += 1) {
      const waitedOut = baseline == null
        ? poll >= polls
        : (livePolls >= polls && redraws >= STALLED_REDRAWS) || poll >= Math.max(polls, stallPolls)
          || (poll >= polls && clock() - startedAt >= STALLED_WAIT_MS);
      if (waitedOut) break;
      if (baseline != null && !noticed && redraws === 0 && poll >= polls && onStalled) {
        noticed = true;
        try { onStalled(); } catch { /* a status line must never break a send */ }
      }
      if (poll === PROMPT_HOLD_NOTICE_POLLS && onWait) {
        try { onWait(); } catch { /* a status line must never break a send */ }
      }
      await sleep(PROMPT_HOLD_POLL_MS);
      screen = await readScreen(paneId, MENU_READ_LINES);
      if (screen && previous != null && screenContent(screen) !== screenContent(previous)) redraws += 1;
      if (screen) previous = screen;
      if (redraws > 0) livePolls += 1;
      if (!screen) { state = 'nobox'; continue; }
      if (isFleetView(screen)) return { state: 'fleet', screen };
      if (classifyBlocked(screen)) return { state: 'blocked', screen };
      state = composerSendState(screen, sent);
      // Claude's dim suggested prompt fills an EMPTY box; a suggestion that
      // happens to read like the message ("continue") is not the message.
      if (state === 'holds' && await dimSuggestion(paneId)) state = 'pending';
      if (state === 'holds') return { state, screen };
    }
    // Stalled unless the CLI drew enough distinct frames to count as alive
    // (round five: one frame and then the clock used to count as "drew", and
    // the record of a queued paste was dropped on it).
    return { state, screen, stalled: baseline != null && redraws < STALLED_REDRAWS };
  };
  const dimSuggestion = async (paneId) => {
    try { return await readSuggestion(paneId); } catch { return null; }
  };

  // The screen a refused send saw, kept beside the send log so the next time
  // a prompt stops taking text the state is on disk, not reconstructed from
  // scrollback hours later. Bounded; a write failure never breaks the send.
  const SEND_CAPTURES_KEPT = 40;
  const captureSendScreen = async (paneId, reason, screen) => {
    if (process.env.NODE_TEST_CONTEXT && !deps.sendLogFile) return;
    try {
      const dir = path.join(path.dirname(sendLogFile), 'send-captures');
      await fs.mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fs.writeFile(path.join(dir, `${stamp}-${String(paneId).replace(/[^\w-]/g, '_')}-${reason}.txt`), String(screen || ''));
      const names = (await fs.readdir(dir)).sort();
      for (const name of names.slice(0, Math.max(0, names.length - SEND_CAPTURES_KEPT))) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    } catch { /* diagnostics must never break a send */ }
  };

  const fleetViewError = () => {
    const error = new Error('Claude is showing its sessions list (the ← key opens it), not this conversation, so nothing was sent. Your text is kept. Press Esc in the >_ terminal to go back to the conversation');
    error.code = 'FLEET_VIEW';
    return error;
  };
  const promptNeverHeldError = (state, { awaitedEarlier = false } = {}) => {
    if (state === 'fleet') return fleetViewError();
    const error = new Error(state === 'blocked'
      ? 'a prompt appeared in the session while Harbor was typing, so it did not press Enter and nothing was sent. Your text is kept; answer the prompt in its window first'
      : awaitedEarlier
        ? 'Claude still has not shown the text Harbor typed earlier, so nothing was typed or sent this time. Your text is kept. Check the >_ terminal; sending again types it fresh'
        : 'Claude\'s prompt never showed your text, so Harbor did not press Enter and nothing was sent. Your text is kept. If Claude was still starting up, the text can still appear in its prompt, so sending again waits for it instead of typing it twice. Check the >_ terminal');
    error.code = 'PROMPT_NEVER_HELD';
    return error;
  };
  const promptHoldsMoreError = () => {
    const error = new Error('Claude\'s prompt already has text in it that ends like this message (probably an earlier try that showed up late), so Harbor typed and sent nothing. Your text is kept. Open the >_ terminal, fix the prompt there and press Enter');
    error.code = 'PROMPT_HOLDS_MORE';
    return error;
  };
  const earlierLandedError = () => {
    const error = new Error('Claude\'s prompt now shows the earlier message Harbor typed, not this one, so nothing was typed or sent. Your text is kept. Send or clear the earlier message in the >_ terminal first');
    error.code = 'PROMPT_HOLDS_EARLIER';
    return error;
  };
  const promptHoldsUnmatchedError = () => {
    const error = new Error('Claude\'s prompt already has text in it that Harbor cannot match to your message (probably Harbor\'s earlier try, drawn differently), so nothing was typed or sent. Your text is kept. Open the >_ terminal and send or clear what is in the prompt, then send again');
    error.code = 'PROMPT_HOLDS_UNMATCHED';
    return error;
  };
  // A DRAFT HARBOR DID NOT TYPE IS NEVER TYPED BEHIND (round fourteen, the
  // Claude twin of CODEX_BOX_BUSY): with no record of Harbor's own typing, a
  // prompt holding text or an attachment is someone else's draft, and Enter
  // would submit it with this message.
  const imageMissingError = () => {
    const error = new Error('A picture in this message is no longer on disk (Harbor clears saved pictures after 14 days), so nothing was typed or sent. Your text is kept. Remove the picture and attach it again');
    error.code = 'IMAGE_MISSING';
    return error;
  };
  const imagePromptUnreadableError = () => {
    const error = new Error('Harbor could not read Claude\'s prompt to attach the picture, so nothing was typed or sent. Your text is kept. Check the >_ terminal, then send again');
    error.code = 'IMAGE_PROMPT_UNREADABLE';
    return error;
  };
  const imageLeftAsTextError = () => {
    const error = new Error('Claude did not attach the picture: its file path stayed in the prompt as text, so Harbor did not press Enter and nothing was sent. Clear the prompt in the >_ terminal, then attach the picture again');
    error.code = 'IMAGE_NOT_ATTACHED';
    return error;
  };
  const clipboardChangedError = () => {
    const error = new Error('Something else was copied while Claude was taking the screenshot, so Harbor cannot be sure which picture is in Claude\'s prompt. Nothing was sent and your text is kept. Check the picture in the >_ terminal, then send or clear it');
    error.code = 'CLIPBOARD_CHANGED';
    return error;
  };
  const promptBusyError = () => {
    const error = new Error('Claude\'s prompt already has text or an attachment in it that is not this message, so Harbor typed and sent nothing (Enter would have sent both). Your text is kept. Open the >_ terminal and send or clear what is in the prompt, then send again');
    error.code = 'PROMPT_BUSY';
    return error;
  };
  // What a Claude prompt holds that someone TYPED: nothing when the box shows
  // only what Claude draws there itself (a dim prediction, the queue hint, the
  // welcome hint).
  const promptDraft = async (paneId, screen) => {
    const found = composerBox(screen);
    if (!found || !found.inside) return '';
    const shown = found.box.join(' ').replace(PROMPT_GLYPH_RE, '').replace(/\s+/g, ' ').trim();
    if (CLAUDE_BOX_HINT_RE.test(shown) || await dimSuggestion(paneId)) return '';
    return shown;
  };

  // CODEX TAKES ENTER ONLY ONCE ITS BOX SHOWS THE MESSAGE (2026-10-29, Pat:
  // "have to send like every message in terminal view"). Codex on Windows reads
  // raw key events, so a paste reaches it as a stream of keystrokes, and its
  // paste-burst rule (tui/src/bottom_pane/paste_burst.rs) holds that stream
  // undrawn until it goes quiet and turns any Enter arriving within 120 ms of it
  // into a newline. Harbor pressed Enter 160 ms after writing and never looked
  // again, so under load every message longer than a line sat in Codex's box
  // until it was submitted by hand from the >_ terminal, while Harbor said "sent"
  // (scripts/drive-codex-send-win.js reproduced 4 of 5). Now: refuse before
  // typing when no box is drawn (a dialog types its hotkeys: the lock dialog's
  // r/f/q, the update screen's 1/2/3), wait until the box shows the message
  // (the burst has then flushed), let the Enter window pass, press Enter, and
  // confirm the box let go of it, pressing once more if Codex swallowed it.
  const CODEX_READ_LINES = 60;
  const CODEX_POLL_MS = 250;
  const CODEX_PROMPT_POLLS = 20;
  const CODEX_HOLD_POLLS = 60;
  const CODEX_ENTER_SETTLE_MS = 250;
  const CODEX_ENTER_POLLS = 8;
  const CODEX_SLASH_SHOW_POLLS = 20;
  // A LONG PASTE TAKES CODEX SECONDS PER THOUSAND CHARACTERS TO SHOW (2026-11-05,
  // Pat: a 21,300-character handoff refused "Codex's box never showed your
  // text" while it was still arriving; it sat in the box as "[Pasted Content
  // 21300 chars]" afterwards). On Windows the paste reaches Codex one key event
  // per character and the paste-burst buffer draws nothing until the last one,
  // so there is no progress to see. Measured on the Legion in an isolated
  // Codex 0.166.0 (gpt-6-astra ultra): 5,000 characters showed in 3.5 s, 10,000
  // in 7.1 s, 21,300 in 14.7 s at 4 load workers and 18.0 s at 10, 40,000 in
  // 29.9 s at 10: 0.7 to 0.85 ms per character, rising with load. The fixed
  // 60 polls (about 18 s) failed anything past ~20,000 characters on a busy
  // machine. The wait now grows by CODEX_ABSORB_MS_PER_CHAR, about four times
  // the slowest rate measured; it still ends the moment the box shows the text,
  // so the extra allowance costs nothing when Codex is quick.
  // The allowance itself is module-level (codexAbsorbAllowanceMs) so the
  // cross-session typer waits by the same rule.
  const CODEX_HOLD_NOTICE_POLLS = 20;
  const codexHoldPolls = (text) => CODEX_HOLD_POLLS + Math.ceil(codexAbsorbAllowanceMs(text) / CODEX_POLL_MS);
  const codexHoldNotice = (text) => `Codex is still taking in your message (${[...String(text || '')].length.toLocaleString('en-US')} characters reach it one key at a time). Harbor presses Enter as soon as its box shows it`;
  // Codex Desktop holds a thread it has open (thread-writer-locks), and a
  // resume of that thread lands on "This conversation is open in another app",
  // whose keys are r (retry), f (fork) and q (quit): the one recorded Codex
  // image failure (2026-10-28) was a send into it.
  const CODEX_LOCKED_RE = /This conversation is open in another app/i;
  const codexNoPromptError = (screen = '') => {
    const error = new Error(codexReadOnlyNotice(screen) === 'provider'
      ? 'Codex cannot resume this chat with its current model provider, so Harbor typed and sent nothing. Your text is kept. Use the answer panel in its window to choose how to continue'
      : CODEX_LOCKED_RE.test(screen)
      ? 'This Codex conversation is open in the Codex app, which keeps it locked, so Harbor typed and sent nothing. Your text is kept. Close it in the Codex app, then send again'
      : 'Codex is not showing its prompt box (a dialog or a list may be open, or it is still starting), so Harbor typed and sent nothing. Your text is kept. Check the >_ terminal');
    error.code = 'CODEX_NO_PROMPT';
    return error;
  };
  // A BOX THAT ALREADY HOLDS TEXT IS NEVER TYPED INTO (2026-10-31). Another
  // session's typer left a 1,489-character paste unsent in Astra's box; Harbor
  // typed Pat's message after it, refused the Enter (correctly: it would have
  // sent both), and each retry typed the message again, until the box held the
  // stranger's paste and four copies. A retry whose own earlier attempt is the
  // whole box still presses Enter for it (see 'exact' below).
  const codexBoxBusyError = (draft) => {
    const error = new Error(`Codex's box already holds ${describeCodexDraft(draft)} that is not this message, so Harbor typed and sent nothing. Your text is kept. Send or clear what is in the box from the >_ terminal first`);
    error.code = 'CODEX_BOX_BUSY';
    return error;
  };
  // AN ENTER CODEX DID NOT VISIBLY TAKE IS NOT "SENT" (Astra's round 3): the
  // box held other text after Enter, or a dialog replaced it. With a
  // transcript to read, the send waits for it; without one (a pane: window, no
  // transcript yet) it says so instead of reporting sent.
  const pictureNotTakenError = () => {
    const error = new Error('Harbor pressed Enter three times, but Claude\'s prompt still shows the picture, so it has not gone. It is still in the prompt: press Enter in the >_ terminal, or clear it and send again');
    error.code = 'NOT_TAKEN';
    error.submission = 'unknown';
    return error;
  };
  const PICTURE_UNCONFIRMED_NOTE = 'Harbor could not see Claude take the picture; check its window';
  // agy holds a message sent mid-turn and sends it when the turn ends, together
  // with any others queued behind it (geminiQueuedShown).
  const GEMINI_QUEUED_NOTE = 'Gemini queued it: it goes in when the current turn ends, together with anything else queued (the window shows it then)';
  const codexUnconfirmedError = () => {
    const error = new Error('Harbor pressed Enter, but Codex\'s box did not come back empty, so Harbor cannot tell whether your message went. Your text is kept. Check the >_ terminal before sending again');
    error.code = 'CODEX_UNCONFIRMED';
    error.submission = 'unknown';
    return error;
  };
  const codexBoxChangedError = () => {
    const error = new Error('Codex\'s box does not show exactly your message (other text in front of it, or part of it missing), so Harbor did not press Enter and nothing was sent. Your text is kept. Check the >_ terminal before sending again');
    error.code = 'CODEX_BOX_CHANGED';
    return error;
  };
  const codexNeverHeldError = () => {
    const error = new Error('Codex\'s box never showed your text, so Harbor did not press Enter and nothing was sent. Your text is kept. The text may still appear in the box, so check the >_ terminal before sending again');
    error.code = 'PROMPT_NEVER_HELD';
    return error;
  };
  const codexNotSubmittedError = () => {
    const error = new Error('Your message is in Codex\'s box, but Codex did not take the Enter (twice). Open the >_ terminal and press Enter there; sending again presses Enter for it without typing it twice');
    error.code = 'CODEX_NOT_SUBMITTED';
    return error;
  };
  const waitForCodexBox = async (paneId, sent, done, polls, { onWait = null } = {}) => {
    let screen = '';
    let state = 'noprompt';
    for (let poll = 0; poll < polls; poll += 1) {
      if (poll === CODEX_HOLD_NOTICE_POLLS && onWait) {
        try { onWait(); } catch { /* a status line must never break a send */ }
      }
      screen = await readScreen(paneId, CODEX_READ_LINES);
      state = codexBoxState(screen, sent);
      if (done(state)) break;
      await sleep(CODEX_POLL_MS);
    }
    return { state, screen };
  };
  // ONLY AN EMPTY BOX MEANS CODEX TOOK THE MESSAGE (Astra's round-2 review,
  // 2026-11-01). "Not this message" is not "sent": each Enter Codex swallows
  // into a paste adds one to its count, so after two the box read
  // "F[Pasted Content 1184 chars]" for 1,182 characters, matched nothing, and
  // was reported sent while it sat there. A box holding anything else after
  // Enter gets no further Enter (it may not be ours) and is not confirmed.
  const watchCodexEnter = async (paneId, workspaceId, sent, checkTarget = async () => {}, stillOurs = () => true) => {
    for (let attempt = 0; ; attempt += 1) {
      let state = 'holds';
      let screen = '';
      for (let poll = 0; poll < CODEX_ENTER_POLLS; poll += 1) {
        await sleep(CODEX_POLL_MS);
        screen = await readScreen(paneId, CODEX_READ_LINES);
        state = codexBoxState(screen, sent);
        if (state === 'other' && codexBoxDraft(screen) === '') return attempt ? 'taken-after-retry' : 'taken';
        if (state === 'noprompt' && codexStartupEcho(screen, sent)) return attempt ? 'taken-after-retry' : 'taken';
      }
      // Something other than the box took the screen: never Enter into it.
      if (state === 'noprompt') return 'unconfirmed';
      if (state === 'other' && attempt === 0) {
        logSend({ paneId, phase: 'codex-box-changed-after-enter' });
        await captureSendScreen(paneId, 'codex-box-changed', screen);
        return 'unconfirmed';
      }
      if (attempt > 0) {
        logSend({ paneId, phase: 'codex-not-submitted' });
        await captureSendScreen(paneId, 'codex-not-submitted', screen);
        throw codexNotSubmittedError();
      }
      // The first Enter's draft test, on this frame (round fourteen).
      if (!stillOurs(screen)) {
        logSend({ paneId, phase: 'draft-changed-before-retry' });
        await captureSendScreen(paneId, 'draft-changed-before-retry', screen);
        return 'unconfirmed';
      }
      logSend({ paneId, phase: 'enter-retry', attempt: 1 });
      await checkTarget();
      await typeInto(paneId, workspaceId, '\r');
      noteCodexEnter(paneId, sent);
    }
  };
  // After a slash command's Enter, only a box still showing EXACTLY the command
  // gets one more Enter (the first was swallowed); an emptied box, a changed
  // one, or a dialog the command opened (a bare /model picker) gets none, since
  // an Enter there would choose its first row.
  const codexSlashNotSubmittedError = () => {
    const error = new Error('The command is in Codex\'s box, but Codex did not take the Enter (twice), so it has not run. Open the >_ terminal and press Enter there, or clear it and send again');
    error.code = 'CODEX_NOT_SUBMITTED';
    return error;
  };
  const watchCodexSlashEnter = async (paneId, workspaceId, text, checkTarget = async () => {}) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let screen = '';
      for (let poll = 0; poll < CODEX_ENTER_POLLS; poll += 1) {
        await sleep(CODEX_POLL_MS);
        screen = await readScreen(paneId, CODEX_READ_LINES);
        if (codexBoxState(screen, { text }) !== 'exact') return attempt ? 'taken-after-retry' : 'taken';
      }
      if (attempt > 0) {
        logSend({ paneId, phase: 'codex-not-submitted' });
        await captureSendScreen(paneId, 'codex-slash-not-submitted', screen);
        throw codexSlashNotSubmittedError();
      }
      // A BARE command can open a picker locally on its first Enter (bare
      // /model does, with no model round trip), so a spare written before
      // Harbor sees the picker would choose its highlighted row (round five).
      // Only a command with arguments, which runs without a picker, gets one.
      if (!/\s/.test(String(text).trim())) {
        logSend({ paneId, phase: 'codex-slash-no-spare' });
        return 'unconfirmed';
      }
      logSend({ paneId, phase: 'enter-retry', attempt: 1 });
      await checkTarget();
      await typeInto(paneId, workspaceId, '\r');
    }
    return 'unconfirmed';
  };

  // What Harbor typed into a pane whose prompt never showed it. It may still be
  // in Claude's startup buffer (see waitForPromptToHold), so the next send into
  // that pane types NOTHING and waits for it instead: typing again is how one
  // message became two. One full wait settles it either way: shown, it is
  // submitted (or, if the new send differs, refused with the prompt left to the
  // user); still missing, the record is dropped and the send after that types
  // fresh, so a prompt that truly lost the keys is never a dead end.
  // paneId -> { sent, at, stalled, screen }: typing Harbor did that the prompt
  // has not shown yet. SHARED by every Harbor process (a file beside the pane
  // locks), because the desktop and the phone server both type into the same
  // panes: kept per process, the other one could not know a paste was still
  // waiting inside a stalled Claude and typed a second message behind it
  // (Sol's review, 2026-11-18). A harness with no send log keeps it in memory.
  const unshownTyped = sharedPendingTyping();
  // Same Map-shaped API (get/set/delete) as the per-process Map it replaced.
  // Reads the lock directory at call time: it is defined further down.
  function sharedPendingTyping() {
    const memory = new Map();
    const fileFor = (paneId) => path.join(paneLockDir, `${String(paneId).replace(/[^\w-]/g, '_')}.pending.json`);
    return {
      get(paneId) {
        if (!paneLockDir) return memory.get(paneId);
        try { return JSON.parse(fsSync.readFileSync(fileFor(paneId), 'utf8')); } catch { return undefined; }
      },
      // True when recorded. With a store, only the shared file counts: a
      // record only this process could see is the bug this store exists for.
      set(paneId, value) {
        if (!paneLockDir) { memory.set(paneId, value); return true; }
        try {
          fsSync.mkdirSync(paneLockDir, { recursive: true });
          const tmp = `${fileFor(paneId)}.${process.pid}.tmp`;
          fsSync.writeFileSync(tmp, JSON.stringify(value));
          fsSync.renameSync(tmp, fileFor(paneId));
          return true;
        } catch { return false; }
      },
      delete(paneId) {
        memory.delete(paneId);
        if (paneLockDir) { try { fsSync.rmSync(fileFor(paneId), { force: true }); } catch { /* gone */ } }
        return true;
      },
    };
  }
  // Codex messages this Harbor typed and has not seen submitted: paneId ->
  // { key, at }. A box whose match rests on a pasted block (codexBoxMatch
  // `opaque`) proves only the message's SHAPE, so pressing Enter on it without
  // typing (an earlier try still sitting there) needs this record too; without
  // it, a stranger's paste of the same length would be sent as ours (Astra's
  // adversarial review, 2026-11-01).
  // The record holds the EXACT text (whitespace matters inside code) and how
  // many Enters Harbor has pressed into it, so a box whose count grew by one
  // per swallowed Enter is still recognised as this send's, and nothing else.
  // A box that only spells a placeholder is opaque too (codexBoxMatch).
  const codexTyped = new Map(); // paneId -> { key, at, enters }
  const ownsCodexBox = (paneId, screen, sent) => {
    const record = codexTyped.get(paneId);
    const mine = Boolean(record && record.key === sent.text && clock() - record.at <= UNSHOWN_TYPED_MS);
    const match = codexBoxMatch(screen, { ...sent, extra: mine ? record.enters : 0 });
    if (match.state !== 'exact') return false;
    // Harbor's own record of typing exactly this text, or the box drawn with
    // this send's spaces (round thirty-eight).
    // A record of typing DIFFERENT text vetoes the screen (round thirty-nine),
    // and the screen alone settles only a draft with no wrapped row.
    if (!match.opaque) {
      if (mine) return true;
      const shared = unshownTyped.get(paneId);
      const different = Boolean(record && record.key !== sent.text && clock() - record.at <= UNSHOWN_TYPED_MS)
        || Boolean(shared && shared.provider === 'codex' && shared.sent?.text !== sent.text);
      const raw = codexPromptBox(screen)?.raw || '';
      return !different && drawnWithoutWraps(raw) && drawnSpacingAgrees(raw, sent.text);
    }
    if (mine) sent.extra = record.enters;
    return mine;
  };
  // Each Enter pressed into a recorded Codex paste may come back as one more
  // character in its count.
  const noteCodexEnter = (paneId, sent) => {
    sent.extra = (sent.extra || 0) + 1;
    const record = codexTyped.get(paneId);
    if (record && record.key === sent.text) record.enters = sent.extra;
    // The shared record carries the count too, for another Harbor process.
    const shared = unshownTyped.get(paneId);
    if (shared && shared.provider === 'codex' && shared.sent?.text === sent.text) unshownTyped.set(paneId, { ...shared, enters: sent.extra });
  };
  const UNSHOWN_TYPED_MS = 10 * 60_000;
  // A record of unshown typing has NO age limit (Sol's review, rounds two and
  // three: any expiry can drop it while a frozen pane still holds the keys).
  // It is retired only on evidence: the prompt shows it, the pane's CLI was
  // replaced, or the CLI visibly drew something since (screenContent below)
  // and its prompt is still empty.
  // The pane's current run (when the daemon spawned it): a record from an
  // earlier run of the pane says nothing about this one.
  const paneGeneration = async (paneId) => {
    try {
      const snap = await snapshot();
      return (snap?.panes || []).find((candidate) => candidate.pane_id === paneId)?.created_at || null;
    } catch { return null; }
  };
  // A CODEX PASTE IS QUEUED TOO (Sol's review, round three). A Codex the CPU
  // starved reads nothing, its box stays empty, and a second send would paste
  // behind the first. Its record is the same shared one as Claude's (written
  // before the paste, provider 'codex'), and a send finding it waits while
  // the screen has not changed since the paste; once Codex has drawn, a box
  // holding the earlier text is judged by the box rules (Enter-only when it
  // is this send's own text, refused otherwise), and an empty box ends the
  // record (consumed or lost, never still queued in a CLI that is drawing).
  const settleEarlierCodexPaste = async (paneId, screen, { onWait = null } = {}) => {
    const earlier = unshownTyped.get(paneId);
    if (!earlier || earlier.provider !== 'codex') return screen;
    const generation = await paneGeneration(paneId);
    if (earlier.generation && generation && earlier.generation !== generation) { unshownTyped.delete(paneId); return screen; }
    if (earlier.phase === 'enter') {
      const local = codexTyped.get(paneId);
      if (await resolveEnterPhase(paneId, earlier, screen) && earlier.sent?.text && local?.key !== earlier.sent.text) {
        codexTyped.set(paneId, { key: earlier.sent.text, at: clock(), enters: earlier.enters || 0 });
      }
      return screen;
    }
    const startedAt = clock();
    let noticed = false;
    // Three minutes, by the clock or by one-second polls, whichever ends first.
    for (let poll = 0; earlier.screen && screenContent(screen) === screenContent(earlier.screen); poll += 1) {
      if (clock() - startedAt >= STALLED_WAIT_MS || poll >= STALLED_WAIT_MS / 1000) {
        logSend({ paneId, phase: 'codex-earlier-paste-stalled' });
        throw codexEarlierStalledError();
      }
      if (!noticed && onWait) { noticed = true; onWait('waiting for Codex to show the text Harbor pasted earlier, so it is not pasted twice'); }
      await sleep(1000);
      screen = (await readScreen(paneId, CODEX_READ_LINES)) || screen;
    }
    // Three outcomes, never a stale frame (round six): no box drawn (a dialog,
    // a blank or unreadable frame) refuses with the record kept; an empty box
    // ends the record only if a second look still shows it drawn and empty;
    // a box holding text goes to the box rules.
    const draft = codexBoxDraft(screen);
    if (draft === null) {
      logSend({ paneId, phase: 'codex-earlier-paste-unresolved' });
      throw codexEarlierUnresolvedError();
    }
    if (draft === '') {
      if (!(await stillEmptyAfterAMoment(paneId, true))) {
        logSend({ paneId, phase: 'codex-earlier-paste-unresolved' });
        throw codexEarlierUnresolvedError();
      }
      logSend({ paneId, phase: 'codex-earlier-paste-gone' });
      unshownTyped.delete(paneId);
    } else if (earlier.sent?.text) {
      codexTyped.set(paneId, { key: earlier.sent.text, at: clock(), enters: earlier.enters || 0 });
    }
    return screen;
  };
  // An "Enter pressed" record: kept (true) while the prompt still shows its
  // text, so the same text gets Enter only and other text is refused; ended
  // (false) once the text is gone (taken, or cleared). Never a wait.
  const enterUnresolvedError = () => {
    const error = new Error('Harbor already pressed Enter for this exact message and cannot read the window to see whether it went, so it was not typed again. Check the >_ terminal');
    error.code = 'ENTER_UNRESOLVED';
    error.submission = 'unknown';
    return error;
  };
  const resolveEnterPhase = async (paneId, earlier, screen = null) => {
    let now = screen;
    if (now == null) { try { now = await readScreen(paneId, earlier.provider === 'codex' ? CODEX_READ_LINES : MENU_READ_LINES); } catch { now = null; } }
    if (!now) return true; // unreadable: nothing proves the text is gone
    const shows = earlier.provider === 'codex'
      ? Boolean(codexBoxDraft(now))
      : Boolean(composerBox(now) && composerSendState(now, earlier.sent) === 'holds');
    if (shows) return true;
    logSend({ paneId, phase: 'enter-phase-ended' });
    unshownTyped.delete(paneId);
    return false;
  };
  // Before ending a record on "the CLI drew and its prompt is empty", look
  // once more a moment later (round four: a frame drawn in the instant before
  // the CLI read the queued keys). True when the prompt is still empty.
  // Only a fresh, readable frame with the composer drawn and EMPTY counts
  // (round five: an unreadable frame or a dialog over the box had counted
  // as empty).
  const stillEmptyAfterAMoment = async (paneId, codex) => {
    await sleep(1000);
    let again = null;
    try { again = await readScreen(paneId, codex ? CODEX_READ_LINES : MENU_READ_LINES); } catch { return false; }
    if (!again) return false;
    if (codex) return codexBoxDraft(again) === '';
    if (!composerBox(again) || classifyBlocked(again)) return false;
    return !(await promptDraft(paneId, again));
  };
  const earlierStalledError = (cli) => {
    const error = new Error(`${cli} has drawn nothing for 3 minutes since text was typed into it earlier, so nothing new was typed (it would land behind that text). Your text is kept; check the >_ terminal`);
    error.code = 'EARLIER_TYPING_STALLED';
    return error;
  };
  // THE SAME GUARD FOR WRITES THAT SKIP THE TEXT PATH (round four): a
  // clipboard image chord or a slash command typed into a Claude still
  // holding earlier unshown typing would land behind it. Wait while nothing
  // has been drawn since; then a prompt holding text refuses, and an empty
  // prompt in an established Claude ends the record.
  const settleEarlierClaudeTyping = async (paneId, { onWait = null } = {}) => {
    const earlier = unshownTyped.get(paneId);
    if (!earlier || earlier.provider === 'codex') return;
    const generation = await paneGeneration(paneId);
    if (earlier.generation && generation && earlier.generation !== generation) { unshownTyped.delete(paneId); return; }
    let screen = await readScreen(paneId, MENU_READ_LINES);
    if (earlier.phase === 'enter') {
      if (await resolveEnterPhase(paneId, earlier, screen)) throw earlierLandedError();
      return;
    }
    const startedAt = clock();
    let noticed = false;
    for (let poll = 0; earlier.screen && screenContent(screen) === screenContent(earlier.screen); poll += 1) {
      if (clock() - startedAt >= STALLED_WAIT_MS || poll >= STALLED_WAIT_MS / 1000) {
        logSend({ paneId, phase: 'earlier-typing-stalled' });
        throw earlierStalledError('Claude');
      }
      if (!noticed && onWait) { noticed = true; onWait(EARLIER_WAIT_NOTICE); }
      await sleep(1000);
      screen = (await readScreen(paneId, MENU_READ_LINES)) || screen;
    }
    if (composerBox(screen) && await promptDraft(paneId, screen)) {
      await captureSendScreen(paneId, 'holds-unmatched', screen);
      throw composerSendState(screen, earlier.sent) === 'holds' ? earlierLandedError() : promptHoldsUnmatchedError();
    }
    if ((deliveredPanes.has(paneId) || await paneIsPastStartup(paneId)) && await stillEmptyAfterAMoment(paneId, false)) {
      logSend({ paneId, phase: 'earlier-typing-lost' });
      unshownTyped.delete(paneId);
      return;
    }
    throw earlierStalledError('Claude');
  };
  const codexEarlierUnresolvedError = () => {
    const error = new Error('Harbor cannot see whether the text it pasted into Codex earlier is still waiting there (no readable box), so nothing new was typed. Your text is kept; check the >_ terminal');
    error.code = 'EARLIER_TYPING_UNRESOLVED';
    return error;
  };
  const codexEarlierStalledError = () => {
    const error = new Error('Codex has drawn nothing for 3 minutes since text was pasted into it earlier, so nothing new was typed (it would land behind that text). Your text is kept; check the >_ terminal');
    error.code = 'EARLIER_TYPING_STALLED';
    return error;
  };
  // strict (an agent's send, harbor-msg and harbor-send.mjs): a Claude pane
  // keeps its launch id after /clear (the keeper rebinds only Codex and
  // Cursor), so the pane check alone would type an agent's message for the old
  // conversation into the new one. The inbox registry records the /clear
  // (clearedInto); a strict send refuses it (round six). Pat's own sends
  // address the window he is looking at, so they are not strict.
  const verifyPaneServes = async (sessionId, target, { strict = false } = {}) => {
    const current = ((await snapshot())?.panes || []).find((candidate) => candidate.pane_id === target.paneId);
    if (!current || !await paneServes(sessionId, target, current)) throw targetChangedError();
    if (strict) assertNotCleared(sessionId);
  };
  const assertNotCleared = (sessionId) => {
    let cleared = null;
    // The marker itself, even beside a live record (round twenty-two: a resume
    // in another process does not make THIS pane, cleared away from the
    // session but still advertising its id, hold it again).
    try { cleared = peerInbox.clearedMarker(sessionId)?.clearedInto || null; } catch { /* no registry: nothing recorded */ }
    if (!cleared) return;
    const error = new Error(`That session ran /clear and is now ${cleared}; a message for the old conversation was not typed into the new one`);
    error.code = 'SESSION_CLEARED';
    error.clearedInto = cleared;
    throw error;
  };
  const withResumeLaunch = (fn) => withLock(`harbor-resume-launch:${paneLockDir || process.pid}`, fn, { waitMs: 120_000 });
  const draftChangedError = () => {
    const error = new Error('The prompt no longer showed exactly this message when Harbor was about to press Enter, so it pressed nothing. Your text is kept; check the >_ terminal');
    error.code = 'DRAFT_CHANGED';
    return error;
  };
  const targetChangedError = () => {
    const error = new Error('That session\'s window closed or started a different conversation just before this message was typed, so nothing was typed. Your text is kept; send again');
    error.code = 'TARGET_CHANGED';
    return error;
  };
  const pendingRecordError = () => {
    const error = new Error('Harbor could not record this send in its state folder, so nothing was typed (an unrecorded send could be typed twice). Your text is kept');
    error.code = 'PENDING_RECORD_FAILED';
    return error;
  };
  const STARTUP_WAIT_NOTICE = 'Claude is still starting up. Your message is typed and goes in as soon as its prompt shows it';
  const EARLIER_WAIT_NOTICE = 'waiting for Claude to show the message Harbor typed earlier, so it is not typed twice';

  // The box already holds exactly this message: an earlier attempt typed it,
  // the prompt drew it after that attempt gave up, and typing it again would
  // send it twice. Only an exact match counts. A box that merely ENDS like the
  // message (two copies, or a paste placeholder) is refused in deliver():
  // pressing Enter there sends the extra, and typing again adds another copy.
  // `recorded`: Harbor's own record says it typed exactly this text here, so
  // the box only has to read like it (whitespace dropped, chips for paths).
  // Without one the screen must settle it alone: no wrapped row, this send's spaces.
  const promptHoldsExactly = (screen, text, { recorded = false } = {}) => {
    const found = composerBox(screen);
    if (!found || !text || isFleetView(screen)) return false;
    const shown = found.shell ? squashSpace(text).replace(/^!/, '') : squashSpace(text);
    const typed = found.shell ? String(text).trim().replace(/^!/, '') : text;
    // Exactly this send, or this send with Claude's drawn completion of its
    // last slash word after it (slashGhostFollows), drawn with this send's own
    // spaces (round thirty-eight).
    const drafts = [found.raw, ...slashGhostDrafts(found.raw, text)];
    if (drafts.some((draft) => squashSpace(draft) === shown
      && (recorded || (drawnWithoutWraps(draft) && drawnSpacingAgrees(draft, typed))))) return true;
    // Or exactly this send with its image paths drawn as chips, one per path:
    // only on the record's word, since a chip never says which picture it is.
    const chipped = found.shell || !recorded ? null : textAfterImageChips(text);
    if (!chipped || countImageChips(found.inside) !== chipped.imageCount) return false;
    return drafts.some((draft) => squashSpace(draft).replace(IMAGE_CHIPS_RE, '') === chipped.rest);
  };

  // ---- GEMINI (ANTIGRAVITY CLI) SENDS: THE CODEX-LEVEL GATE ----------------
  // Not Cursor's blind Enter. A Gemini send types into a DRAWN box only (a
  // dialog takes keys: digits answer a permission menu, probe p16), refuses a
  // box that already holds other text, presses Enter only once the box shows
  // exactly this message (agy drops keys typed within about a second of startup
  // or of a dialog closing, so "typed" is not "shown"), watches the box let go
  // of it, and leaves delivery to the conversation's own transcript: a
  // USER_EXPLICIT USER_INPUT step whose <USER_REQUEST> holds the typed words
  // (recordConfirms). Consent and permission screens are the person's:
  // Harbor never answers them (design decision D12), it says where to.
  // Measured on agy 1.5.14, docs/orchestration/2026-11-23-gemini-provider/
  // AGY-FACTS.md section 2; screens in test/fixtures/gemini-box/.
  const GEMINI_POLL_MS = 150;
  const GEMINI_PROMPT_POLLS = 40;
  const GEMINI_HOLD_POLLS = 80;
  const GEMINI_ENTER_SETTLE_MS = 160;
  const GEMINI_ENTER_POLLS = 16;
  const GEMINI_ENTER_POLL_MS = 250;
  const GEMINI_ENTER_QUIET_READS = 3;
  const GEMINI_ENTER_SPARES = 2;
  // agy drops keys typed within about a second of a dialog closing (AGY-FACTS
  // section 2), so typing waits this long after the survey lets go of the box.
  const GEMINI_AFTER_DIALOG_MS = 1200;
  // The status tee is rewritten about every 300 ms while agy's state changes,
  // so a pending-permission reading this fresh is current.
  const GEMINI_TEE_FRESH_MS = 3000;
  // A paste placeholder hides its text, so a box holding one is this send's only
  // on Harbor's own word: what it typed into that pane, and when. In memory, per
  // process, like Codex's: a restart forgets it and the placeholder is "busy".
  const GEMINI_OWN_PASTE_MS = 10 * 60_000;
  const geminiTyped = new Map(); // paneId -> { text, at }
  const geminiHolds = (match) => match.state === 'exact' || match.state === 'placeholder';
  const geminiHoldPolls = (text) => GEMINI_HOLD_POLLS + Math.ceil([...String(text || '')].length * 2 / GEMINI_POLL_MS);
  const geminiNeedsAnswerError = (kind, { late = false } = {}) => {
    const first = kind === 'first-run';
    const error = new Error(first
      ? 'Gemini is on its first-run screens (colour scheme, Terms of Service & Data Use). Those choices are yours to make, so Harbor typed and sent nothing. Your text is kept. Answer them in the Gemini setup card in this window, then send again'
      : kind === 'trust'
        ? 'Gemini is asking whether to trust this folder, so Harbor typed and sent nothing. Your text is kept. Answer it in the panel in this window, then send again'
        : late
          ? 'A question appeared in Gemini while Harbor was typing, so it did not press Enter and nothing was sent. Your text is kept. Answer the question in the panel in this window first'
          : 'Gemini is waiting on a question (a permission or a choice), so Harbor typed and sent nothing; keys typed there would answer it. Your text is kept. Answer it in the panel in this window, then send again');
    error.code = first ? 'GEMINI_FIRST_RUN' : 'GEMINI_NEEDS_ANSWER';
    return error;
  };
  const geminiNoPromptError = () => {
    const error = new Error('Gemini is not showing its prompt box (a dialog or a list may be open, or it is still starting), so Harbor typed and sent nothing. Your text is kept. Check the >_ terminal');
    error.code = 'GEMINI_NO_PROMPT';
    return error;
  };
  const geminiSurveyError = ({ late = false } = {}) => {
    const error = new Error(late
      ? 'Gemini\'s feedback survey opened while Harbor was typing, so it did not press Enter and nothing was sent. Your text is kept. Check the >_ terminal, then send again (Harbor skips the survey first)'
      : 'Gemini\'s feedback survey ("How\'s the CLI experience so far?") did not close when Harbor pressed 0 (Skip), so Harbor typed and sent nothing. Your text is kept. Answer it in the >_ terminal, then send again');
    error.code = 'GEMINI_SURVEY';
    return error;
  };
  const geminiBoxBusyError = (draft) => {
    const error = new Error(`Gemini's box already holds ${describeGeminiDraft(draft)} that is not this message, so Harbor typed and sent nothing (Enter would have sent both). Your text is kept. Send or clear what is in the box from the >_ terminal first`);
    error.code = 'GEMINI_BOX_BUSY';
    return error;
  };
  const geminiNeverHeldError = () => {
    const error = new Error('Gemini\'s box never showed your text (it ignores keys typed in its first second or just after a dialog closes), so Harbor did not press Enter and nothing was sent. Your text is kept. If it appears in the box later, sending again presses Enter for it without typing it twice. Check the >_ terminal');
    error.code = 'PROMPT_NEVER_HELD';
    return error;
  };
  const geminiBoxChangedError = () => {
    const error = new Error('Gemini\'s box does not show exactly your message (other text in it, or part of it missing), so Harbor did not press Enter and nothing was sent. Your text is kept. Check the >_ terminal before sending again');
    error.code = 'GEMINI_BOX_CHANGED';
    return error;
  };
  const geminiNotSubmittedError = () => {
    const error = new Error('Your message is in Gemini\'s box, but Gemini did not take the Enter (three tries). Open the >_ terminal and press Enter there; sending again presses Enter for it without typing it twice');
    error.code = 'GEMINI_NOT_SUBMITTED';
    return error;
  };
  const geminiUnconfirmedError = () => {
    const error = new Error('Harbor pressed Enter, but Gemini\'s box did not come back empty, so Harbor cannot tell whether your message went. Your text is kept. Check the >_ terminal before sending again');
    error.code = 'GEMINI_UNCONFIRMED';
    error.submission = 'unknown';
    return error;
  };
  const geminiCommandRefusedError = (command) => {
    const error = new Error(`Harbor does not run ${command} in a Gemini window: agy writes it into the profile's settings (${command === '/logout' ? 'and it signs every Gemini session on this machine out' : 'so it would change every later Gemini session too'}). Start a new Gemini session with the model or effort you want, or run it yourself in the >_ terminal`);
    error.code = 'GEMINI_COMMAND_REFUSED';
    return error;
  };
  // The statusLine tee Harbor's launcher wires for every Gemini session:
  // gemini-<conversation id>.json in the context folder (the payload agy pipes
  // in, plus ownerPid and writtenAt). Absent before the first prompt, and when
  // the session is a provisional pane: that is no evidence, never a refusal.
  const geminiContextDir = deps.contextDir || resolveContextDir();
  const readGeminiTee = async (conversationId) => {
    if (!GEMINI_ID_RE.test(String(conversationId || ''))) return null;
    const file = path.join(geminiContextDir, `gemini-${conversationId}.json`);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      const tee = JSON.parse(raw.replace(/^﻿/, ''));
      const written = typeof tee.writtenAt === 'number' ? tee.writtenAt : Date.parse(tee.writtenAt);
      return {
        state: String(tee.agent_state || ''),
        pending: tee.tool_confirmation_pending === true,
        cwd: typeof tee.cwd === 'string' ? tee.cwd : null,
        ageMs: Math.max(0, Date.now() - (Number.isFinite(written) ? written : stat.mtimeMs)),
      };
    } catch {
      return null;
    }
  };
  // Folders a conversation is known to have started in, from the three places
  // agy leaves one (the transcript itself holds none): Harbor's own status tee,
  // the prompt history (its first line has no conversation id, later ones do),
  // and the folder-to-latest-conversation map.
  const geminiFolders = async (home, id) => {
    const folders = new Set();
    const tee = await readGeminiTee(id);
    if (tee?.cwd) folders.add(tee.cwd);
    try {
      const handle = await fs.open(path.join(geminiStoreDir(home), 'history.jsonl'), 'r');
      try {
        const { size } = await handle.stat();
        const length = Math.min(size, 256 * 1024);
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, size - length);
        for (const line of buffer.toString('utf8').split('\n')) {
          if (!line.includes(id)) continue;
          try {
            const entry = JSON.parse(line);
            if (entry?.conversationId === id && typeof entry.workspace === 'string') folders.add(entry.workspace);
          } catch { /* a cut first line or a partial one */ }
        }
      } finally {
        await handle.close();
      }
    } catch { /* no history yet */ }
    try {
      const last = JSON.parse(await fs.readFile(path.join(geminiStoreDir(home), 'cache', 'last_conversations.json'), 'utf8'));
      for (const [folder, value] of Object.entries(last || {})) if (value === id) folders.add(folder);
    } catch { /* no map yet */ }
    return [...folders];
  };
  const waitForGeminiBox = async (paneId, sent, done, polls, { onWait = null, noticeAt = 20 } = {}) => {
    let screen = '';
    let match = geminiBoxMatch('', sent);
    let noBox = 0;
    for (let poll = 0; poll < polls; poll += 1) {
      if (poll === noticeAt && onWait) {
        try { onWait(); } catch { /* a status line must never break a send */ }
      }
      screen = await readScreen(paneId, MENU_READ_LINES);
      match = geminiBoxMatch(screen, sent);
      noBox = match.state === 'noprompt' ? noBox + 1 : 0;
      if (done(match)) break;
      // A dialog that stays up is not coming back in this send's time.
      if (noBox >= 8 && geminiBlockedKind(screen) !== 'unknown') break;
      await sleep(GEMINI_POLL_MS);
    }
    return { ...match, screen };
  };
  // After Enter: an EMPTY box means agy took it; the same text still there on
  // three quiet reads means the Enter was swallowed (a spare goes only on a
  // frame that still shows exactly this message, at most twice); anything else
  // in the box, or no box, is left to the transcript and gets no more keys.
  // A slash command never gets a spare: its menu would take it as a choice.
  const watchGeminiEnter = async (paneId, workspaceId, sent, checkTarget = async () => {}, { spares: allowed = GEMINI_ENTER_SPARES } = {}) => {
    let held = 0;
    let spares = 0;
    for (let poll = 0; poll < GEMINI_ENTER_POLLS * (1 + allowed); poll += 1) {
      await sleep(GEMINI_ENTER_POLL_MS);
      const screen = await readScreen(paneId, MENU_READ_LINES);
      const match = geminiBoxMatch(screen, sent);
      if (match.state === 'empty') {
        geminiTyped.delete(paneId);
        // The queue row can land a frame after the box empties: one more look
        // while a turn is still running. It only changes the words shown.
        let queued = geminiQueuedShown(screen, sent.text);
        if (!queued && match.status !== 'idle') {
          await sleep(GEMINI_ENTER_POLL_MS);
          queued = geminiQueuedShown(await readScreen(paneId, MENU_READ_LINES), sent.text);
        }
        if (queued) return 'queued';
        return spares ? 'taken-after-retry' : 'taken';
      }
      if (match.state === 'noprompt') return 'unconfirmed';
      if (match.state === 'other') {
        logSend({ paneId, phase: 'gemini-box-changed-after-enter' });
        await captureSendScreen(paneId, 'gemini-box-changed', screen);
        return 'unconfirmed';
      }
      held += 1;
      if (!allowed || held < GEMINI_ENTER_QUIET_READS) continue;
      if (spares >= allowed) {
        logSend({ paneId, phase: 'gemini-not-submitted' });
        await captureSendScreen(paneId, 'gemini-not-submitted', screen);
        throw geminiNotSubmittedError();
      }
      spares += 1;
      held = 0;
      logSend({ paneId, phase: 'enter-retry', attempt: spares });
      await checkTarget();
      await typeInto(paneId, workspaceId, '\r');
    }
    return 'unconfirmed';
  };
  // Single-line text is typed; multi-line (and anything long enough to be at
  // risk when typed) goes as ONE bracketed paste, which agy draws as a
  // multi-line prompt without submitting. A first character the prompt treats
  // as a key ("?" opens the help panel on an empty box) also goes as a paste.
  const geminiPayload = (text, slash) => (slash ? text
    : /^[?!@#]/.test(text) && !mayCollapseToPlaceholder(text) ? asPaste(text) : typedPayload(text));
  const deliverGemini = async (paneId, workspaceId, text, images, { onWait = null, checkTarget = async () => {}, sessionId = null, markEnter = () => {} } = {}) => {
    if (images.length) throw new Error('pictures reach a Gemini window as a path line in the message; none can be pasted');
    const slash = isSlashCommand(text);
    const sent = { text };
    // 1. A drawn box, or a plain reason there is none.
    const waitForBox = () => waitForGeminiBox(paneId, { text: '' }, (match) => match.state !== 'noprompt', GEMINI_PROMPT_POLLS, {
      onWait: onWait ? () => onWait('Gemini has not drawn its prompt box yet. Harbor waits for it before typing') : null,
    });
    let drawn = await waitForBox();
    // The feedback survey sits where the box goes until a key answers it: one 0
    // (Skip), then the box again, then agy's one-second deafness after a dialog.
    // A survey that stays is refused below; it never gets a second key.
    if (drawn.state === 'noprompt' && geminiBlockedKind(drawn.screen) === 'survey') {
      await checkTarget();
      logSend({ paneId, phase: 'gemini-survey-skip' });
      await typeInto(paneId, workspaceId, '0');
      drawn = await waitForBox();
      if (drawn.state !== 'noprompt') {
        await sleep(GEMINI_AFTER_DIALOG_MS);
        const screen = await readScreen(paneId, MENU_READ_LINES);
        drawn = { ...geminiBoxMatch(screen, { text: '' }), screen };
      }
    }
    if (drawn.state === 'noprompt') {
      const kind = geminiBlockedKind(drawn.screen);
      logSend({ paneId, phase: 'gemini-no-prompt', kind });
      await captureSendScreen(paneId, `gemini-${kind}`, drawn.screen);
      throw kind === 'first-run' || kind === 'trust' || kind === 'permission' || kind === 'menu'
        ? geminiNeedsAnswerError(kind === 'menu' ? 'permission' : kind)
        : kind === 'survey' ? geminiSurveyError() : geminiNoPromptError();
    }
    // 2. The tee's word: a permission question the screen does not show yet.
    const tee = await readGeminiTee(sessionId);
    if (tee?.pending && tee.ageMs < GEMINI_TEE_FRESH_MS) {
      logSend({ paneId, phase: 'gemini-tee-pending' });
      throw geminiNeedsAnswerError('permission');
    }
    // 3. What the box holds. This very message (an earlier try that showed up
    // late) gets Enter only; anything else is never typed behind.
    const here = geminiBoxMatch(drawn.screen, sent);
    const own = geminiTyped.get(paneId);
    const ownPaste = here.state === 'placeholder' && Boolean(own) && own.text === text && clock() - own.at < GEMINI_OWN_PASTE_MS;
    if (here.state === 'other' || (here.state === 'placeholder' && !ownPaste)) {
      logSend({ paneId, phase: 'gemini-box-busy' });
      await captureSendScreen(paneId, 'gemini-box-busy', drawn.screen);
      throw geminiBoxBusyError(here.raw);
    }
    const alreadyInBox = here.state === 'exact' || ownPaste;
    if (alreadyInBox) logSend({ paneId, phase: 'already-in-prompt' });
    if (!alreadyInBox) {
      await checkTarget();
      geminiTyped.set(paneId, { text, at: clock() });
      await typeInto(paneId, workspaceId, geminiPayload(text, slash));
      debug('deliver: gemini text written');
      // 4. Enter only once the box shows the message (or, for a big paste, its
      // placeholder: the box was verified empty a moment ago under the pane lock,
      // so a placeholder of this size is this send's own).
      const held = await waitForGeminiBox(paneId, sent, geminiHolds, geminiHoldPolls(text), {
        onWait: onWait ? () => onWait('Gemini is still taking in your message. Harbor presses Enter as soon as its box shows it') : null,
        noticeAt: 40,
      });
      if (!geminiHolds(held)) {
        logSend({ paneId, phase: 'prompt-never-held', state: held.state });
        await captureSendScreen(paneId, `gemini-${held.state}`, held.screen);
        if (held.state === 'noprompt') {
          const kind = geminiBlockedKind(held.screen);
          throw kind === 'survey' ? geminiSurveyError({ late: true }) : geminiNeedsAnswerError(kind === 'first-run' ? 'first-run' : 'permission', { late: true });
        }
        throw held.state === 'other' ? geminiBoxChangedError() : geminiNeverHeldError();
      }
    }
    await sleep(GEMINI_ENTER_SETTLE_MS);
    // 5. The last look before the Enter, and the target after it.
    const last = await readScreen(paneId, MENU_READ_LINES);
    if (!geminiHolds(geminiBoxMatch(last, sent))) {
      logSend({ paneId, phase: 'draft-changed-before-enter' });
      await captureSendScreen(paneId, 'draft-changed-before-enter', last);
      throw geminiBoxChangedError();
    }
    await checkTarget();
    markEnter();
    await typeInto(paneId, workspaceId, '\r');
    deliveredPanes.add(paneId);
    debug('deliver: gemini enter written');
    const enterState = await watchGeminiEnter(paneId, workspaceId, sent, checkTarget, { spares: slash ? 0 : GEMINI_ENTER_SPARES });
    logSend({ paneId, phase: 'enter-state', state: enterState });
    return enterState;
  };

  // No default. A silent `= 'claude'` here is what let a codex pane be driven
  // down the claude path: wrong readiness test, wrong composer guard, and a
  // Claude chip on a gpt-5.6-sol session. Callers resolve it explicitly.
  // `onWait(detail)` lets a caller say why a send is taking minutes.
  const deliverUnlocked = async (paneId, workspaceId, text, images = [], provider = 'claude', { onWait = null, exactDraftOnly = false, verifyTarget = null, onVerified = null, sessionId = null } = {}) => {
    // The target is checked again at the input boundary (Sol's review, round
    // eleven): the composer reads between the in-lock check and the first
    // keystroke take long enough for a /clear typed in the raw terminal.
    const checkTarget = typeof verifyTarget === 'function' ? verifyTarget : async () => {};
    let enterWritten = false;
    const assertExactDraft = screen => {
      if (exactDraftOnly && !ownsCodexBox(paneId, screen, { text })) {
        const error = new Error('Codex\'s prepared draft changed before it could be sent. Harbor typed nothing. Your text is kept. Check the draft in the >_ terminal and send again.');
        error.code = 'CODEX_DRAFT_CHANGED';
        throw error;
      }
    };
    // Lease the pane's control for the whole keystroke sequence: a renderer
    // blur mid-send defers until the lease drops instead of yanking control.
    terminalBridge.holdControl?.(paneId);
    try {
      const t0 = Date.now();
      await acquireControl(paneId, workspaceId);
      debug('deliver: control after', Date.now() - t0, 'ms; controlled =', terminalBridge.getState().controlledPaneId);
      const safeScreen = provider === 'claude' ? await assertComposerSafe(paneId) : '';
      if (provider !== 'claude') await assertNotDeadShell(paneId);

      // A FRESH non-claude pane is still starting its TUI, and codex swallows
      // whatever arrives before it is listening. Live-caught 2026-08-08: a new
      // codex session took `/home/…/Census Tool - overview … - 2026-08-05.pdf,
      // 2 pages, current` and the rollout recorded it as
      // `026-08-05.pdf, 2 pages, curren…`. The leading characters were eaten and
      // codex answered the mangled remainder, so it read as a dropped message
      // while the send log honestly said `sent`: the bytes DID leave.
      //
      // waitForProviderReady existed already and was wired only to the RESUME
      // path, which is why resuming a codex session was safe and starting one
      // was not. assertNotDeadShell above is a refusal check, not a wait: it
      // returns immediately unless the pane is sitting at a shell prompt.
      //
      // Bounded, first-delivery-only, and NON-FATAL on purpose. Settling needs
      // two identical reads, which a pane mid-turn never produces, so making
      // this a hard gate would refuse sends into a busy codex. Not settling
      // leaves exactly the old behaviour.
      // EVERY provider, not just the non-claude ones. The first version of this
      // gate keyed on `provider !== 'claude'`, which made it useless in exactly
      // the case it was written for: `provider` arrives with a silent default of
      // 'claude' (see resolveProvider), so a codex pane whose provider had not
      // resolved yet was treated as claude and skipped the wait. A guard that a
      // wrong default can switch off is not a guard.
      //
      // It is also correct on its own terms: assertComposerSafe is a single READ,
      // a refusal check rather than a wait, so a freshly launched claude pane has
      // the same exposure. Claude's TUI merely comes up faster, which is why
      // codex is where it became visible.
      // Scoped to non-claude, and the reason matters. The gate cannot be allowed
      // to depend on `provider` being right, because a silent default is exactly
      // what broke this: see resolveProvider below, which is why an unresolved
      // provider is no longer able to masquerade as claude.
      //
      // Claude has the same shape of exposure (assertComposerSafe is a single
      // READ, a refusal check rather than a wait) and is covered differently:
      // since 2026-10-09 its Enter waits until the prompt SHOWS the text
      // (waitForPromptToHold), which a TUI still starting cannot fake.
      if (provider !== 'claude' && !deliveredPanes.has(paneId)) {
        const label = provider === 'codex' ? 'Codex' : provider === 'cursor' ? 'Cursor' : provider === 'gemini' ? 'Gemini' : provider;
        const outcome = {};
        const settled = await waitForProviderReady(paneId, {
          timeoutMs: 15_000,
          blankTimeoutMs: 90_000,
          outcome,
          onBlankWait: onWait ? () => onWait(`${label} has not drawn its screen yet. Harbor waits up to 90 seconds for it before typing`) : null,
        });
        if (!settled && outcome.neverDrew) {
          logSend({ paneId, phase: 'provider-never-drew', provider });
          await captureSendScreen(paneId, 'provider-never-drew', '');
          const error = new Error(`${label} has not drawn anything after 90 seconds, so Harbor typed and sent nothing. Your text is kept. Check the >_ terminal, then send again`);
          error.code = 'PROVIDER_NEVER_DREW';
          throw error;
        }
        if (!settled) debug('deliver: fresh', provider, 'pane never settled; sending anyway');
      }
      // A Gemini send has its own gate (deliverGemini) and shares nothing below.
      if (provider === 'gemini') {
        return await deliverGemini(paneId, workspaceId, text, images, { onWait, checkTarget, sessionId, markEnter: () => { enterWritten = true; } });
      }
      // Every Codex send starts at a drawn composer. Slash commands can open
      // their own popup after typing, but must not type into a pre-existing
      // chooser: its Enter could select a safety rewrite and start a new chat.
      const codexGated = provider === 'codex' && !isSlashCommand(text);
      if (provider === 'codex') {
        const ready = await waitForCodexBox(paneId, { text: '' }, (state) => state !== 'noprompt', CODEX_PROMPT_POLLS);
        if (ready.state === 'noprompt') {
          logSend({ paneId, phase: 'codex-no-prompt' });
          await captureSendScreen(paneId, 'codex-no-prompt', ready.screen);
          throw codexNoPromptError(ready.screen);
        }
        // An earlier paste into a frozen Codex is still queued, and its box
        // looks empty: wait for Codex to draw before judging the box.
        // Every Codex write: text, image paths and slash commands alike.
        const readyScreen = await settleEarlierCodexPaste(paneId, ready.screen, { onWait });
        const draft = codexBoxDraft(readyScreen);
        assertExactDraft(readyScreen);
        // Enter-only for an earlier try needs proof it is ours: exact visible text,
        // or a pasted block of its shape that this Harbor itself typed (ownsCodexBox).
        const ownEarlierTry = Boolean(text) && !images.length && ownsCodexBox(paneId, readyScreen, { text });
        if (draft && !ownEarlierTry) {
          logSend({ paneId, phase: 'codex-box-busy' });
          await captureSendScreen(paneId, 'codex-box-busy', readyScreen);
          throw codexBoxBusyError(draft);
        }
      }
      debug('deliver: composer safe after', Date.now() - t0, 'ms');
      // Images have TWO delivery routes, and which one is available depends on
      // whether there is a clipboard to put them on.
      //
      // The desktop pastes: setXClipboardImage + Ctrl+V, which attaches the
      // image INLINE, and inline is the better result (it is what the transcript
      // records, and it is why f71f39b moved off pasting a path in the first
      // place).
      //
      // harbor-server has no clipboard. It is headless by definition, so there
      // is no X selection to own, and it never passed setXClipboardImage at all.
      // Sending an image from the PHONE therefore died on
      // "setXClipboardImage is not a function" for as long as the phone client
      // has existed: the upload succeeded, the file landed on disk, and the send
      // threw. Nothing in the mobile gate caught it, because that gate stubs the
      // pty boundary and so never reaches this line.
      //
      // DESKTOP SCREENSHOTS GO BY PATH TOO (2026-11-19, after Sol's review,
      // rounds twenty-four and twenty-five). The clipboard is the whole
      // machine's: any copy in Harbor or another app, or a Win+Shift+S, made
      // before a slow Claude read the chord swapped the picture, and no lock or
      // fingerprint can see a copy that is put back. Claude 2.1.299 and later
      // turn a pasted image path into the same inline attachment, so the reason
      // f71f39b left paths (a path reached Claude as a Read) no longer holds,
      // and Pat's clipboard is never overwritten. Pat: "your call"; proven by
      // scripts/drive-prompt-gate-win.js against the real CLI. The clipboard
      // route below runs only with pasteClaudeImagesFromClipboard.
      //
      // With no clipboard, the honest delivery is the path: Claude reads the
      // file, which is the same route `+ add files` already uses for every
      // non-image attachment. It is a Read rather than an inline attachment, so
      // it is deliberately NOT the desktop's behaviour, only the one that works
      // where a clipboard cannot exist.
      const canPaste = pasteClaudeImagesFromClipboard === true && typeof setXClipboardImage === 'function';
      // The paste CHORD is per-OS: the Claude CLI attaches a clipboard image on
      // Ctrl+V (0x16) on Linux, but on Windows it binds image paste to Alt+V
      // (ESC v) — proven against a live ConPTY session 2026-08-13: 0x16 did
      // nothing (no marker, 12s timeout, "Claude never confirmed the image
      // attachment" on every image send), \x1bv attached [Image #1] at once.
      const imagePasteChord = process.platform === 'win32' ? '\x1bv' : '\x16';
      if (provider === 'claude' && (images.length || isSlashCommand(text))) await settleEarlierClaudeTyping(paneId, { onWait });
      // A screenshot paste this pane has not read yet blocks every new write to
      // it (round eleven): typed behind the queued chord, the next message
      // would carry that screenshot.
      if (provider === 'claude') await settleOwedChord(paneId, { onWait });
      if (images.length) await checkTarget();
      for (const imagePath of images) {
        if (!(await imageFileReady(imagePath))) {
          logSend({ paneId, phase: 'image-missing' });
          throw imageMissingError();
        }
      }
      const pathOnlyImages = [];
      let lastImageMarker = null;
      // Image chips the composer may show at Enter: the ones it held before
      // this send, plus this send's own (round thirteen).
      let chipsBefore = null;
      let chipsPasted = 0;
      // The markers this send's own pastes drew, in order (round sixteen: a
      // count let a REPLACED chip through; identity is checked, not number).
      const pastedMarkers = [];
      for (const imagePath of images) {
        if (codexGated) { lastImageMarker = await pasteCodexImage(paneId, workspaceId, imagePath); if (lastImageMarker) pastedMarkers.push(lastImageMarker); continue; }
        // EACH PICTURE BY ITSELF, ITS CHIP SEEN BEFORE ANYTHING ELSE IS TYPED
        // (Sol's review, round twenty-eight). A Claude picture is its quoted
        // path, pasted alone, and waited for like the clipboard chord: pasted
        // together with the caption, a caption that was itself an image path
        // became a second attachment. The caption then goes the text route.
        // No Claude picture is ever prepended to the text any more (round
        // twenty-nine: an unreadable screen fell back to that form, and its
        // check accepted a path left as text). Cursor reads a labelled line.
        if (provider !== 'claude') { pathOnlyImages.push(imagePath); continue; }
        let beforeMax = 0;
        let beforeScreen = null;
        // ONE CLIPBOARD, MANY PANES (Sol's review, 2026-11-18): Claude reads the
        // clipboard when it gets to the chord, not when Harbor sends it, so a
        // stalled pane could attach the image another pane's send put there
        // later. The clipboard is held from the write until the marker shows,
        // and a paste Claude never read leaves it EMPTY, so a late read
        // attaches nothing rather than someone else's screenshot.
        // A pane that never read its chord still owes a clipboard read (round
        // two of the review: clearing the clipboard could not stop it reading
        // the NEXT image, and wiped whatever Pat had copied). Until that pane
        // draws its own image chip or its CLI is gone, other images go by path
        // (Claude attaches a pasted image path itself, the phone's route) and
        // the clipboard keeps that pane's image. Checked INSIDE the clipboard
        // lock (round three: checked before it, a send already waiting for the
        // lock missed the debt the holder was about to record).
        const pasteOne = async (viaClipboard) => {
          if (viaClipboard && await clipboardOwed()) return null;
          // The chip count to beat is read HERE, inside the lock, and must be
          // readable (round six: a failed read left 0, and an old chip in the
          // scrollback then "confirmed" a chord still queued, ending its debt).
          // The SAME scope as the confirmation: the composer box (round eight:
          // a chip quoted in the conversation above set the bar so high that a
          // real attachment never cleared it). Read up to three times; still
          // unreadable, or no box drawn, the send is refused before anything
          // is written (round twenty-nine).
          let composerChips = null;
          for (let attempt = 0; attempt < 3 && composerChips === null; attempt += 1) {
            if (attempt) await sleep(200);
            try { beforeScreen = await readPane(paneId, MENU_READ_LINES); } catch { beforeScreen = null; }
            composerChips = beforeScreen && String(beforeScreen).trim() ? composerImageMax(beforeScreen) : null;
          }
          if (composerChips === null) {
            logSend({ paneId, phase: 'image-prompt-unreadable' });
            throw imagePromptUnreadableError();
          }
          beforeMax = composerChips;
          if (chipsBefore === null) {
            // The first write of this send: the prompt must hold no draft
            // (round fourteen; the chord would attach to someone else's).
            if (await promptDraft(paneId, beforeScreen)) {
              logSend({ paneId, phase: 'prompt-busy', before: 'image' });
              await captureSendScreen(paneId, 'prompt-busy', beforeScreen);
              throw promptBusyError();
            }
            chipsBefore = countImageChips(composerBox(beforeScreen)?.inside || '');
          }
          const written = viaClipboard ? await setXClipboardImage(imagePath) : null;
          if (!owedChords.set(paneId, { beforeMax, generation: await paneGeneration(paneId) })) throw pendingRecordError();
          let chordSent = false;
          try {
            await typeInto(paneId, workspaceId, viaClipboard ? imagePasteChord : asPaste(`"${imagePath}"`));
            chordSent = true;
            // The screen right after the chord, on the record at once (round
            // thirteen): a Harbor that exits during the wait must leave the
            // next one a "since" to judge from. Read AFTER the write, never
            // before it (round four's rule: a frame drawn between a pre-write
            // read and the write is no evidence the CLI read anything).
            try {
              const afterChord = await readPane(paneId, MENU_READ_LINES);
              const owed = owedChords.get(paneId);
              if (afterChord && String(afterChord).trim() && owed && !owed.unreadable) owedChords.set(paneId, { ...owed, screen: afterChord });
            } catch { /* the next send takes its own first read as the baseline */ }
            const marker = `[Image #${await waitForImageMarker(paneId, beforeMax, {
              baseline: beforeScreen,
              onStalled: onWait ? () => onWait(STALLED_NOTICE) : null,
              literal: viaClipboard ? null : squashSpace(`"${imagePath}"`),
            })}]`;
            // The chip proves Claude read A clipboard image, not that it read
            // THIS one: anything copied between the write and Claude's read
            // replaced it (round twenty-four: Harbor's own Board "Copy as PNG"
            // did, and the other picture was submitted). The clipboard must
            // still hold exactly what was written; otherwise the chip in the
            // prompt may be someone else's picture, so nothing is pressed and
            // the pane stays blocked until that prompt is sent or cleared.
            if (typeof written?.stillOnClipboard === 'function' && !(await written.stillOnClipboard())) {
              const owed = owedChords.get(paneId);
              if (owed && !owed.unreadable) owedChords.set(paneId, { ...owed, inPrompt: true });
              logSend({ paneId, phase: 'clipboard-changed' });
              throw clipboardChangedError();
            }
            owedChords.delete(paneId);
            return marker;
          } catch (error) {
            // A chord the keeper definitely refused was never written: nothing
            // is owed. A written or unconfirmed one may still be read, so its
            // debt (recorded before the chord) stands.
            if ((!chordSent && error?.code !== 'INPUT_UNCONFIRMED') || error?.code === 'IMAGE_NOT_ATTACHED') owedChords.delete(paneId);
            else {
              // The last screen this paste saw: only the CLI drawing after it
              // can show the chord was read (see settleOwedChord).
              let last = null;
              try { last = await readPane(paneId, MENU_READ_LINES); } catch { /* none */ }
              const debt = owedChords.get(paneId);
              if (debt && !debt.unreadable) owedChords.set(paneId, { ...debt, screen: last || null });
            }
            throw error;
          }
        };
        // With the clipboard route on, a pane owing another pane's clipboard
        // read sends this picture by path instead.
        let pasted = canPaste
          ? await withLock(`harbor-clipboard:${paneLockDir || process.pid}`, () => pasteOne(true), { waitMs: 60_000, onWait: onWait ? () => onWait(CLIPBOARD_WAIT_NOTICE) : null })
          : null;
        if (pasted === null) pasted = await pasteOne(false);
        lastImageMarker = pasted;
        pastedMarkers.push(pasted);
        chipsPasted += 1;
      }
      if (pathOnlyImages.length) {
        // Cursor reads a labelled line. Claude pastes each picture by itself
        // (above); Codex attaches its own (pasteCodexImage).
        const prefix = pathOnlyImages.length === 1 ? 'Image:' : 'Images:';
        const line = `${prefix} ${pathOnlyImages.join(' ')}`;
        text = text ? `${line}\n${text}` : line;
      }
      // A Claude message (not a slash command: its picker draws over the box and
      // its delivery is best-effort) presses Enter only once the prompt SHOWS
      // the text; see waitForPromptToHold.
      // A Claude prompt holding a picture starts with its chip, so a caption
      // that starts with "/" is a message, never a command (Sol's review,
      // round thirty: it was typed and checked as one, and a caption Claude
      // dropped went unseen, the picture submitted alone).
      const typedAsSlash = isSlashCommand(text) && !(provider === 'claude' && images.length);
      const gated = provider === 'claude' && !typedAsSlash;
      const codexSlash = provider === 'codex' && Boolean(text) && isSlashCommand(text);
      let codexSlashShown = false;
      const sent = { text, pasted: mayCollapseToPlaceholder(text), imageMarker: lastImageMarker };
      let alreadyInPrompt = false;
      let baseline = null; // the screen just before typing (waitForPromptToHold)
      let verifiedScreen = null; // the frame that showed this send, before Enter
      // A message that quotes a chip ("[Image #3]" in its own words) draws it
      // as text in the box: those are this send's too.
      const quotedChips = countImageChips(squashSpace(text));
      // A line of the message's own that is nothing but an image path becomes a
      // chip when Claude reads it from a paste, as it does for anyone pasting
      // that text: those chips are the message's own words, allowed for text
      // sends and captions alike (round twenty-nine, argued: refusing them
      // would refuse every message that lists a picture's path on its own line).
      const chipsAllowed = () => (chipsBefore || 0) + chipsPasted + (textAfterImageChips(text)?.imageCount || 0) + quotedChips;
      // Every marker this send pasted must be shown, each by an occurrence of
      // its own beyond any the message quotes (round seventeen: a caption
      // quoting "[Image #1]" stood in for the chip it had lost). Hidden
      // chips are allowed only on POSITIVE evidence that the box's front is
      // out of view, which only Codex draws (its clipped mark); Claude draws
      // none, so its chips must show (round seventeen: a short leftover of a
      // caption read as a clipped long one). A caption long enough to push a
      // chip out of Claude's box is far past the size Claude collapses a paste
      // into a one-line placeholder, so the refusal costs nothing real.
      const occurrences = (hay, needle) => hay.split(needle).length - 1;
      // The message's own words as the box shows them: none when the box holds
      // nothing but chips and ONE paste placeholder (Claude's or Codex's), since
      // the caption then sits collapsed inside it and its quotes are hidden
      // (round nineteen: a hidden quote was subtracted from the one visible
      // chip, and a whole, correct screenshot send was refused).
      const ONE_PASTE_RE = new RegExp(`^(?:${PASTE_PLACEHOLDER_RE.source}|${CODEX_PASTE_SEG_RE.source})$`);
      const shownWords = (inside) => (ONE_PASTE_RE.test(inside.replace(IMAGE_CHIPS_RE, '')) ? '' : squashSpace(text));
      const markersShown = (inside, clipped = false) => {
        if (!pastedMarkers.length) return true;
        const quoted = shownWords(inside);
        const own = (marker) => occurrences(inside, squashSpace(marker)) > occurrences(quoted, squashSpace(marker));
        if (pastedMarkers.every(own)) return true;
        return clipped && countImageChips(inside) === 0;
      };
      const chipsWithin = (screen) => {
        const inside = composerBox(screen)?.inside || '';
        return countImageChips(inside) <= chipsAllowed() && markersShown(inside);
      };
      let earlier = unshownTyped.get(paneId) || null;
      if (earlier && earlier.provider === 'codex') earlier = null; // a Codex record is handled at the Codex box
      const generation = (gated || codexGated) && text && !lastImageMarker ? await paneGeneration(paneId) : null;
      if (earlier && earlier.generation && generation && earlier.generation !== generation) {
        unshownTyped.delete(paneId);
        earlier = null;
      }
      if (earlier?.phase === 'enter' && !(await resolveEnterPhase(paneId, earlier))) earlier = null;
      if (gated && text && !lastImageMarker) {
        const screen = await readScreen(paneId, MENU_READ_LINES);
        baseline = screen || null;
        if (chipsBefore === null) chipsBefore = countImageChips(composerBox(screen)?.inside || '');
        const suggestion = composerBox(screen) ? await dimSuggestion(paneId) : null;
        // The prompt draws only the last ~25 lines of a long message, so no
        // long message can match exactly; it ending like this one is the
        // evidence. That cannot be chance for a paste or anything longer than
        // the compared tail, but a short message can end a draft by chance
        // ("blue blocks" ending "keep the blue blocks"); such a draft is not
        // this send, and the busy check below refuses it (round fourteen).
        const endsLikeIt = !suggestion && composerSendState(screen, sent) === 'holds'
          && (sent.pasted || squashSpace(text).length > SEND_TAIL_CHARS);
        // The same message exactly (round thirty-eight: a draft differing only
        // in its spaces is another message, and its Enter-only retry sent it).
        const sameAsEarlier = Boolean(earlier && exactWords(earlier.sent.text) === exactWords(text));
        // A record of a DIFFERENT draft vetoes the screen's word (round
        // thirty-nine: an earlier "releasenotes.txt" wrapped between "release"
        // and "notes.txt", and an earlier older.png drawn as the same chip, were
        // both submitted for the new request).
        const differentEarlier = Boolean(earlier) && !sameAsEarlier;
        // Enter-only for an earlier try needs evidence of the WHOLE draft
        // (round fifteen: "ends like it" took unrelated text drawn in front of
        // a swallowed message as the earlier try, and submitted both): the
        // frame its own Enter verified, which an "Enter pressed" record keeps;
        // without one, everything the prompt shows must be this send: the
        // message exactly, or a part of it that ends it (Claude draws only a
        // long prompt's last lines, so text in front of a message that fits is
        // visible and refused, the rule Codex's clipped box follows). A paste
        // placeholder alone is not that evidence (round sixteen: any paste of
        // the same shape draws one); without the record it is refused.
        const earlierVerified = earlier?.phase === 'enter' && earlier.screen ? earlier.screen : null;
        const visibleIsThisSend = () => {
          const found = composerBox(screen);
          if (!found?.inside) return false;
          // Claude's drawn completion of a last slash word is not a draft.
          return [found.inside, ...slashGhostRests(found.raw, text)].some((rest) => rest && squashSpace(text).endsWith(rest));
        };
        alreadyInPrompt = !suggestion && ((!differentEarlier && promptHoldsExactly(screen, text))
          || (sameAsEarlier && promptHoldsExactly(screen, text, { recorded: true }))
          || (sameAsEarlier && endsLikeIt && (earlierVerified
            ? sameComposerDraft(earlierVerified, screen, text)
            : visibleIsThisSend())));
        if (alreadyInPrompt) {
          logSend({ paneId, phase: 'already-in-prompt' });
          // The draft here is this text-only send's earlier try, so the only
          // chips it may carry are its own path images: a chip in front of it
          // was drawn by someone else, and counting it as "held before" let
          // the Enter-only retry submit it (round fourteen's follow-on: a
          // spare refused over a foreign chip, then the same text resent).
          if (!earlier?.sent?.imageMarker) chipsBefore = 0;
        } else if (endsLikeIt) {
          logSend({ paneId, phase: 'prompt-holds-more' });
          await captureSendScreen(paneId, 'holds-more', screen);
          throw promptHoldsMoreError();
        }
        // AN EARLIER TRY THAT "NEVER SHOWED" IS NEVER TYPED OVER (2026-11-04,
        // the death loop). Harbor misread Pat's message in the prompt (Claude's
        // drawn completion of "/dm", see slashGhostFollows), so every wait for
        // the earlier typing ran its full three minutes and gave up, and the
        // send after each give-up typed the message fresh behind the copy
        // already there: the prompt reached three copies. While a record of
        // unshown typing stands, a prompt holding anything that is not this
        // message is refused at once, nothing typed and the record kept, so
        // repeated sends cannot stack. An EMPTY prompt in a Claude that has
        // been running a while has no startup buffer to deliver it later: the
        // typing is gone, so this send types fresh now instead of waiting.
        if (earlier && !alreadyInPrompt && composerBox(screen)) {
          if (await promptDraft(paneId, screen)) {
            const showsEarlier = composerSendState(screen, earlier.sent) === 'holds';
            logSend({ paneId, phase: 'prompt-holds-unmatched', earlier: showsEarlier });
            await captureSendScreen(paneId, 'holds-unmatched', screen);
            if (!showsEarlier) throw promptHoldsUnmatchedError();
            throw exactWords(earlier.sent.text) === exactWords(text) ? promptHoldsMoreError() : earlierLandedError();
          }
          // A Claude that has drawn nothing since that typing has not read it
          // yet: the record stands and this send waits for it (STALLED_WAIT_MS).
          const stillStalled = Boolean(earlier.stalled && earlier.screen && screenContent(screen) === screenContent(earlier.screen));
          if (stillStalled) logSend({ paneId, phase: 'earlier-typing-stalled' });
          else if ((deliveredPanes.has(paneId) || await paneIsPastStartup(paneId)) && await stillEmptyAfterAMoment(paneId, false)) {
            logSend({ paneId, phase: 'earlier-typing-lost' });
            unshownTyped.delete(paneId);
            earlier = null;
          }
        }
        // No record of Harbor's own typing explains a draft: it is someone
        // else's, and this message would be sent with it (round fourteen: an
        // earlier draft holding text and a screenshot was submitted with an
        // unrelated message). Refused before the first keystroke.
        if (!alreadyInPrompt && composerBox(screen) && await promptDraft(paneId, screen)) {
          logSend({ paneId, phase: 'prompt-busy', before: 'text' });
          await captureSendScreen(paneId, 'prompt-busy', screen);
          throw promptBusyError();
        }
      }
      // A Claude slash command is typed raw at the end of whatever the prompt
      // holds, so a draft there would be submitted as a message with the
      // command glued on (round fourteen's sibling). No box (a picker or a
      // dialog the command flow expects) is left as before.
      if (provider === 'claude' && typedAsSlash) {
        const screen = safeScreen;
        if (composerBox(screen) && await promptDraft(paneId, screen)) {
          logSend({ paneId, phase: 'prompt-busy', before: 'slash' });
          await captureSendScreen(paneId, 'prompt-busy', screen);
          throw promptBusyError();
        }
      }
      // A send whose earlier try is still sitting in Codex's box (the error
      // below says so) presses Enter for it instead of typing it twice.
      if (codexGated && text && !lastImageMarker
        && ownsCodexBox(paneId, await readScreen(paneId, CODEX_READ_LINES), sent)) {
        alreadyInPrompt = true;
        logSend({ paneId, phase: 'already-in-prompt' });
      }
      // Typed earlier and never shown: wait for THAT, type nothing new.
      // An "Enter pressed" record never makes a send wait (it was resolved
      // above; kept only while the text shows or the screen cannot be read).
      // The SAME text is refused while it stands: its first Enter may land.
      if (gated && text && earlier?.phase === 'enter' && !alreadyInPrompt && squashSpace(earlier.sent.text) === squashSpace(text)) {
        logSend({ paneId, phase: 'enter-phase-unresolved' });
        throw enterUnresolvedError();
      }
      const awaitEarlier = Boolean(gated && text && !lastImageMarker && earlier && earlier.phase !== 'enter' && !alreadyInPrompt);
      if (awaitEarlier) logSend({ paneId, phase: 'awaiting-earlier-typing' });
      if (exactDraftOnly) {
        assertExactDraft(await readScreen(paneId, CODEX_READ_LINES));
        alreadyInPrompt = true; // this delivery is Enter-only, never keyboard text
      }
      // Slash command tokens must be typed raw so the CLI parses them. The
      // trailing space closes its popup; any remainder keeps the normal
      // single-line/raw or multi-line/bracketed-paste behavior.
      // THE RECORD GOES DOWN BEFORE THE KEYS (Sol's review, round two): written
      // after the wait, a sender that died mid-wait (or whose keys could not be
      // confirmed) left nothing, and the next sender typed the message again
      // behind keys still queued in a frozen Claude. Marked stalled against the
      // screen read just before typing: until that screen changes, the keys
      // count as queued. Unwritable means nothing is typed.
      // The target first (round twelve: checked after the record, a refusal
      // left a record of text that was never typed).
      if (text && !alreadyInPrompt && !awaitEarlier) await checkTarget();
      const provisional = Boolean((gated || codexGated) && text && !lastImageMarker && !alreadyInPrompt && !awaitEarlier && !typedAsSlash);
      const before = provisional && codexGated ? await readScreen(paneId, CODEX_READ_LINES) : baseline;
      if (provisional && !unshownTyped.set(paneId, { sent: { text: sent.text, pasted: sent.pasted, imageMarker: sent.imageMarker }, at: clock(), stalled: Boolean(before), screen: before || null, generation, provisional: true, provider: codexGated ? 'codex' : 'claude' })) {
        throw pendingRecordError();
      }
      if (text && !alreadyInPrompt && !awaitEarlier) try {
        if (typedAsSlash) {
          const trimmed = String(text).trim();
          const token = trimmed.split(/\s+/, 1)[0];
          const remainder = trimmed.slice(token.length).trimStart();
          await typeInto(paneId, workspaceId, `${token} `);
          if (remainder) await typeInto(paneId, workspaceId, typedPayload(remainder));
        } else {
          // Codex always gets a paste: 0.159.3's security banner takes a bare
          // `1` keypress over an empty composer, and a paste is never a key.
          // A long Claude message does too (typedPayload: a long typed line
          // loses everything but its last 1,024 characters).
          const payload = provider === 'codex' ? asPaste(text) : typedPayload(text);
          await typeInto(paneId, workspaceId, payload);
          if (codexGated) codexTyped.set(paneId, { key: text, at: clock(), enters: 0 });
        }
        debug('deliver: text written');
        // Judge "the CLI drew since" against a screen read AFTER the keys were
        // written (round four: a frame drawn between the pre-typing read and
        // the write was taken as the CLI having read them).
        if (provisional) {
          const afterWrite = await readScreen(paneId, codexGated ? CODEX_READ_LINES : MENU_READ_LINES).catch(() => null);
          const current = unshownTyped.get(paneId);
          if (afterWrite && current) unshownTyped.set(paneId, { ...current, screen: afterWrite, stalled: true });
          // The prompt wait counts redraws from this screen too, not from the
          // one read before typing (round five).
          if (afterWrite && gated) baseline = afterWrite;
        }
      } catch (error) {
        // Keys that were definitely never written leave no record; keys that may
        // have been (INPUT_UNCONFIRMED) keep it.
        if (provisional && error?.code !== 'INPUT_UNCONFIRMED') unshownTyped.delete(paneId);
        throw error;
      }
      if (gated) {
        // A pane that has never taken a message from this Harbor may still be
        // starting, unless the daemon says it has run for a while, and so may
        // one still owing an earlier attempt's typing.
        const startup = awaitEarlier || (!deliveredPanes.has(paneId) && !(await paneIsPastStartup(paneId)));
        const held = await waitForPromptToHold(paneId, awaitEarlier ? earlier.sent : sent, {
          polls: startup ? PROMPT_HOLD_STARTUP_POLLS : PROMPT_HOLD_POLLS,
          onWait: startup && onWait ? () => onWait(awaitEarlier ? EARLIER_WAIT_NOTICE : STARTUP_WAIT_NOTICE) : null,
          baseline: awaitEarlier ? (earlier.screen || null) : (alreadyInPrompt ? null : baseline),
          onStalled: onWait ? () => onWait(STALLED_NOTICE) : null,
        });
        if (held.state !== 'holds') {
          logSend({ paneId, phase: 'prompt-never-held', state: held.state, awaitedEarlier: awaitEarlier, stalled: Boolean(held.stalled) });
          await captureSendScreen(paneId, held.state, held.screen);
          if (awaitEarlier) {
            // Text in the prompt after the full wait is not "never shown": it
            // is something Harbor cannot read as the earlier try. Dropping the
            // record would let the next send type a copy behind it.
            if (held.state === 'pending' && await promptDraft(paneId, held.screen)) throw promptHoldsUnmatchedError();
            // Drew nothing during the whole wait: still queued, and the record
            // stays against the LAST screen this wait saw (round four), so only
            // the CLI drawing after this moment can end it. Drew repeatedly
            // (the wait's own rule: three distinct frames over the window)
            // without ever showing it: an event loop that ran that long has
            // read its input, so the typing is lost and the record ends.
            if (held.stalled) unshownTyped.set(paneId, { ...earlier, at: clock(), stalled: true, screen: held.screen || earlier.screen, generation: earlier.generation || generation });
            else unshownTyped.delete(paneId);
          } else if ((held.state === 'pending' || held.state === 'nobox') && text && !alreadyInPrompt && !lastImageMarker) {
            unshownTyped.set(paneId, { sent, at: clock(), stalled: Boolean(held.stalled), screen: held.screen || null, generation, provider: 'claude' });
          } else if (provisional) {
            unshownTyped.delete(paneId);
          }
          throw promptNeverHeldError(held.state, { awaitedEarlier: awaitEarlier });
        }
        // The prompt now shows the earlier message, not this one: refused, and
        // the record stays while it sits there, so a resend cannot type behind it.
        if (awaitEarlier && exactWords(earlier.sent.text) !== exactWords(text)) {
          logSend({ paneId, phase: 'earlier-typing-landed' });
          throw earlierLandedError();
        }
        verifiedScreen = held.screen;
        // Every chip the verified draft shows, by number (round thirty-two:
        // Claude numbers chips once per session, so they tie the delivery
        // check to THIS draft's pictures, not another send's with the same words).
        if (onVerified) { try { onVerified({ chips: (composerBox(held.screen)?.inside || '').match(IMAGE_CHIPS_RE) || [] }); } catch { /* evidence only */ } }
        // An image chip this send did not put there (round thirteen: a late
        // screenshot drawn in front of the message was submitted with it).
        if (!chipsWithin(held.screen)) {
          logSend({ paneId, phase: 'draft-has-foreign-chip' });
          await captureSendScreen(paneId, 'foreign-chip', held.screen);
          throw draftChangedError();
        }
      } else if (codexGated) {
        const held = await waitForCodexBox(paneId, sent, (state) => state === 'exact' || state === 'holds', codexHoldPolls(text), {
          onWait: onWait ? () => onWait(codexHoldNotice(text)) : null,
        });
        if (held.state !== 'exact' && held.state !== 'holds') {
          logSend({ paneId, phase: 'prompt-never-held', state: held.state });
          await captureSendScreen(paneId, `codex-${held.state}`, held.screen);
          throw codexNeverHeldError();
        }
        // 'holds' (the box ENDS with this message) is this message only when
        // Codex marked the box clipped AND all it shows is part of the
        // message. Unclipped, it means text in front arrived from someone else
        // or the start of the message never arrived, and Enter would send the
        // wrong thing either way (Astra's rounds 2 and 3).
        verifiedScreen = held.screen;
        const heldMatch = codexBoxMatch(held.screen, sent);
        if (held.state === 'holds' && squashSpace(text) && !(heldMatch.clipped && squashSpace(text).endsWith(codexBoxDraft(held.screen) || '\u0000'))) {
          logSend({ paneId, phase: 'codex-box-changed-while-typing' });
          await captureSendScreen(paneId, 'codex-box-changed', held.screen);
          throw codexBoxChangedError();
        }
        await sleep(CODEX_ENTER_SETTLE_MS);
      } else if (codexSlash) {
        // A CODEX SLASH COMMAND WAITS FOR ITS BOX TOO (2026-11-05). The effort
        // menus send "/model --reasoning=<level>", typed as keystrokes, and a
        // fixed 160 ms before Enter is the gap the paste-burst rule eats under
        // load: the live drive left "/model --reasoning=high" sitting in an
        // Ultra pane's box, effort unchanged, while Harbor said sent (1 of 4
        // runs at 4 load workers). Enter now waits until the box shows the
        // command, then the Enter window. A box that never shows it (a popup
        // drawn over it) keeps the old timing, so no command is held back.
        const shown = await waitForCodexBox(paneId, { text }, (state) => state === 'exact', CODEX_SLASH_SHOW_POLLS);
        codexSlashShown = shown.state === 'exact';
        if (!codexSlashShown) logSend({ paneId, phase: 'codex-slash-unshown', state: shown.state });
        await sleep(codexSlashShown ? CODEX_ENTER_SETTLE_MS : 160);
      } else {
        await sleep(160);
      }
      if (exactDraftOnly) assertExactDraft(await readScreen(paneId, CODEX_READ_LINES));
      // THE ENTER PHASE (Sol's review, round four). Before the Enter, the
      // pane's record says "Enter pressed for this text"; it is retired when
      // the CLI is seen taking the message. Until then a later send never
      // types a copy: while the prompt still shows the text it presses Enter
      // only for the same text and refuses other text; once the text is gone
      // the record ends. Every exit after this point reports submission "unknown".
      // An "Enter pressed" record never makes a send WAIT: it is resolved at
      // once by what the prompt shows (see resolveEnterPhase).
      const enterPhase = (gated || codexGated) && Boolean(text);
      // A screenshot with no caption gets the same last look before its Enter
      // (round fifteen: text drawn after its verified chip went in with it);
      // the Enter-pressed record stays a text send's.
      const finalCheck = enterPhase || ((gated || codexGated) && Boolean(lastImageMarker));
      // A real Claude /model or /effort: its echoes before Enter, read with the
      // same reader its watch uses, ahead of the last-moment checks.
      const switchCommand = provider === 'claude' && typedAsSlash && SWITCH_COMMAND_RE.test(String(text || '').trim());
      let switchEchoesBefore = Infinity;
      if (switchCommand) { try { switchEchoesBefore = switchBaseline(await readPaneWithin(paneId, 3000), text); } catch { /* unknown: Infinity */ } }
      const beforeEnter = finalCheck ? await readScreen(paneId, codexGated ? CODEX_READ_LINES : MENU_READ_LINES) : null;
      // The draft is verified on this last read, and the target after it, so
      // nothing awaited sits between the checks and the Enter (round twelve:
      // a /clear and a new draft landing during the read were submitted).
      // And it must be the SAME draft the hold verified, attachments included
      // (round thirteen: "holds" only asks that the box END with the message,
      // so a chip drawn in front of it between the two reads went in with it).
      // The same test runs before every spare Enter, against the frame this
      // one verified (round fourteen: a spare pressed on "ends with the
      // message" submitted a chip drawn in front of it after the first Enter).
      const draftStillOurs = (screen, verified) => {
        if (!screen) return false;
        // A screenshot with no caption (round fifteen): the box holds this
        // send's chips and nothing else (it was empty before the first write),
        // and they are the very markers its pastes drew, in order (round
        // sixteen: a chip replaced by another, or one missing, passed a count).
        if (!squashSpace(text)) {
          const inside = codexGated ? squashSpace(codexBoxDraft(screen)) : (composerBox(screen)?.inside || '');
          return pastedMarkers.length > 0 && inside === pastedMarkers.map(squashSpace).join('');
        }
        if (codexGated) {
          // Codex's match strips chips before comparing text, so the chips are
          // checked here: no more than this send's own, and its markers shown.
          const codexInside = squashSpace(codexBoxDraft(screen));
          if (countImageChips(codexInside) > pastedMarkers.length + quotedChips) return false;
          if (!markersShown(codexInside, codexBoxMatch(screen, sent).clipped)) return false;
          // Exact (or this Harbor's own paste of that shape) is the whole box,
          // so it needs no comparison; Codex's own swallowed Enter changes the
          // box (a pasted block's count goes up by one). A clipped box shows
          // only the message's tail, so it must also be the box verified.
          if (codexBoxState(screen, sent) === 'exact' || ownsCodexBox(paneId, screen, sent)) return true;
          const now = codexBoxMatch(screen, sent);
          return now.state === 'holds' && now.clipped && squashSpace(text).endsWith(codexBoxDraft(screen) || '\u0000')
            && (!verified || squashSpace(codexBoxDraft(verified)) === squashSpace(codexBoxDraft(screen)));
        }
        return composerSendState(screen, sent) === 'holds'
          && (!verified || sameComposerDraft(verified, screen, text))
          && chipsWithin(screen);
      };
      if (finalCheck) {
        const stillOurs = draftStillOurs(beforeEnter, verifiedScreen);
        if (!stillOurs) {
          logSend({ paneId, phase: 'draft-changed-before-enter' });
          throw draftChangedError();
        }
      }
      await checkTarget();
      if (enterPhase && !unshownTyped.set(paneId, { sent: { text: sent.text, pasted: sent.pasted, imageMarker: sent.imageMarker }, at: clock(), stalled: true, screen: beforeEnter || null, generation, provider: codexGated ? 'codex' : 'claude', phase: 'enter' })) {
        throw pendingRecordError();
      }
      enterWritten = true;
      await typeInto(paneId, workspaceId, '\r');
      if (codexGated) noteCodexEnter(paneId, sent);
      deliveredPanes.add(paneId);
      debug('deliver: enter written');
      // Not for a slash command: its picker or confirmation dialog would take a
      // spare Enter as an answer, and a slash send is best-effort anyway.
      let enterState = 'unconfirmed';
      if (gated) {
        enterState = await watchEnterTaken(paneId, workspaceId, sent, checkTarget, (screen) => draftStillOurs(screen, beforeEnter));
        logSend({ paneId, phase: 'enter-state', state: enterState });
      } else if (codexGated) {
        enterState = await watchCodexEnter(paneId, workspaceId, sent, checkTarget, (screen) => draftStillOurs(screen, beforeEnter));
        logSend({ paneId, phase: 'enter-state', state: enterState });
        if (enterState === 'taken' || enterState === 'taken-after-retry') codexTyped.delete(paneId);
      }
      if (enterPhase && (enterState === 'taken' || enterState === 'taken-after-retry')) unshownTyped.delete(paneId); else if (codexSlash && codexSlashShown) {
        enterState = await watchCodexSlashEnter(paneId, workspaceId, text, checkTarget);
        logSend({ paneId, phase: 'enter-state', state: enterState });
      }
      // Only for an actual slash command (round forty: a screenshot captioned
      // "/model sonnet" is words, and its watch typed "1" as a message).
      if (switchCommand) await resolveClaudeSwitchConfirm(paneId, workspaceId, text, provider, switchEchoesBefore);
      return enterState;
    } catch (error) {
      // After the first Enter was written, nothing proves the message was NOT
      // submitted: a caller must not send it another way (round four).
      if (enterWritten && error && typeof error === 'object' && !error.submission) error.submission = 'unknown';
      throw error;
    } finally {
      terminalBridge.releaseControlHold?.(paneId);
    }
  };

  // ---- interactive menu handling (command-bar answers, no >_ detour) --------
  // A session parked on a numbered SELECT MENU has no composer to write into, so
  // instead of refusing the send we let the command bar surface the menu and
  // answer it here. readMenu reads a taller scrape (menus are multi-line) and
  // parses it; answerMenu drives the highlight to the target and selects it.

  // Read the recent scrape first, then the visible grid. Both are needed, for
  // reasons that were each learned the hard way:
  //
  //   recent   a one-shot dialog whose top scrolled into scrollback still has
  //            its opening lines here (gate-caught 2026-07-21).
  //   visible  a pty resize can invalidate recent output, and a full-screen
  //            redraw ("\x1b[2J") writes over the screen without pushing a
  //            single line into scrollback, so a dialog that is plainly on the
  //            screen can have no recent bytes at all. Measured 2026-07-27
  //            against a real pane right after Harbor grew it: recent came back
  //            0 bytes while visible held the whole dialog. Reading only recent
  //            would make the card vanish exactly when the pane was fixed.
  const readScreen = async (paneId, lines) => {
    for (const source of ['recent', 'visible']) {
      let screen = '';
      try { screen = await readPane(paneId, lines, source); } catch { return ''; }
      if (screen.trim()) return screen;
    }
    return '';
  };

  const readMenu = async (paneId) => {
    for (const source of ['recent', 'visible']) {
      let screen = '';
      try { screen = await readPane(paneId, MENU_READ_LINES, source); } catch { return null; }
      // agy's drawn prompt box: every agy question REPLACES it, so with the box up nothing is asked, and
      // Claude's reader must not run. Its working status row "esc to cancel" reads as a dialog footer there,
      // which made a reply's numbered list a question card with "needs your answer" (Pat, 2026-11-25).
      if (geminiDialogOwnsScreen(screen) || geminiPromptBox(screen)) continue;
      const menu = parseMenu(screen);
      if (menu) return menu;
    }
    return null;
  };

  // A generic list dialog (generic-list.js) read off the GRID first: the walk
  // below steers by where the "❯" is NOW, and a full-screen redraw can leave
  // the recent buffer holding an older frame whose pointer never moves.
  const readList = async (paneId) => {
    for (const source of ['visible', 'recent']) {
      let screen = '';
      try { screen = await readPane(paneId, MENU_READ_LINES, source); } catch { return null; }
      const list = parseGenericList(screen);
      if (list) return list;
    }
    return null;
  };

  // ---- the no-dead-end guard (Pat mandate 2026-07-21) ---------------------
  // Six dialog shapes were each fixed only after Pat hit them live. The
  // structural inversion: a blocked pane whose screen the parser does NOT
  // recognize still yields an answerable in-window panel (the raw screen tail
  // plus direct keys), and the screen self-captures as a fixture so the next
  // labeled-card fix starts from real bytes instead of a live incident.
  // Trigger: known blocker text on screen (instant), or the engine-level
  // blocked signal (shape-independent, covers dialogs that do not exist yet)
  // as long as the screen is not a healthy composer/working turn, because
  // agent_status lags 60-150s and must never ghost keys over a recovered
  // session.
  const FALLBACK_SCREEN_LINES = 14;
  const capturedScreens = new Set();
  const captureUnrecognized = async (paneId, screen) => {
    if (process.env.NODE_TEST_CONTEXT && !deps.sendLogFile && !suppliedCaptureDir && !process.env.HARBOR_UNRECOGNIZED_DIR) return;
    try {
      const hash = crypto.createHash('sha1').update(screen).digest('hex').slice(0, 12);
      if (capturedScreens.has(hash)) return;
      capturedScreens.add(hash);
      await fs.mkdir(captureDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safePane = String(paneId).replace(/[^\w-]/g, '_');
      await fs.writeFile(path.join(captureDir, `${stamp}-${safePane}-${hash}.txt`), screen);
    } catch { /* the capture must never break the poll */ }
  };
  // "Is this pane blocked right now" has exactly ONE answer, and both the
  // in-window answer card and the send refusal read it from here. Returns the
  // screen when the pane is blocked, null when there is nothing to answer.
  //
  // Read the recent scrape, not the visible grid: linking a pane resizes
  // it, and a one-shot dialog does not redraw, so a LIVE dialog's opening
  // lines can exist only in scrollback (gate-caught 2026-07-21). Live vs
  // dead is decided by the TAIL instead: a resolution tail (shell prompt,
  // lone-pointer composer, working turn) means the dialog above is a
  // ghost, whatever blocker text sits in the scrollback.
  const classifyBlocked = (screen, blockedHint = false) => {
    if (!screen.trim()) return null;
    if (codexReadOnlyNotice(screen)) return { lines: screen.split('\n') };
    if (parseMenu(screen)?.kind === 'model-switch') return { lines: screen.split('\n') };
    let lines = screen.split('\n');
    while (lines.length && !lines.at(-1).trim()) lines = lines.slice(0, -1);
    const bottomLines = lines.slice(-10);
    const bottom = bottomLines.join('\n');
    const lastText = [...bottomLines].reverse().find((line) => line.trim()) || '';
    const resolved = bottomLines.some((_line, i) => isComposerLine(bottomLines, i))
      || endsAtPrompt(lines, bottomLines.length)
      || /esc to interrupt/i.test(bottom)
      || SHELL_PROMPT_TAIL_RE.test(lastText); // a bare shell prompt: claude exited, status lags
    if (resolved) return null;
    // Resolution is decided by the TAIL (a stale answered menu above a live
    // composer must not raise a ghost card), but the BLOCKER itself may sit
    // further up: the theme picker draws its options above a preview block. So
    // the tail answers "is this over?" and the whole screen answers "is there
    // something to answer?". A composer in the tail already short-circuits
    // above, which is what keeps the ghost-card rule intact.
    // A built-in list dialog is a blocker whatever its footer says ("Esc to go
    // back", /plugin): before 2026-10-24 that footer matched nothing here, and
    // the window showed no card at all while the dialog waited.
    if (!(isBlockedScreen(bottom) || POINTER_ROW_RE.test(screen) || blockedHint || parseGenericList(screen)
      || DIALOG_ESC_HINT_RE.test(screen))) return null;
    return { lines };
  };

  // CLAUDE'S FIRST-RUN GATE IS NOT A QUESTION, so Harbor stops making it one
  // (live-caught 2026-08-06). A brand new session on a config home that has not
  // completed onboarding does not open at a composer: it opens on a chain of
  // notices, each ending "Press Enter to continue…", and only after those does
  // it reach the real trust dialog. Nothing advanced them, so the window sat on
  // "No transcript yet", the command bar had nowhere to type, and two sends of
  // /acclimate went into a session that had never started. From the outside that
  // is indistinguishable from Harbor being broken, which is exactly what it was.
  //
  // Advancing is safe for these and ONLY these, so the test is deliberately
  // narrow and every clause is load-bearing:
  //   - the tail asks to continue, and
  //   - it carries one of Claude's own first-run markers, and
  //   - there is NO choice on screen: no numbered option, no pointer, no
  //     yes/no. The trust dialog and the pre-approved-permissions dialog both
  //     have options, so both keep going to the human, which is the point.
  // An informational notice has exactly one outcome; pressing it is not a
  // decision taken on the user's behalf.
  const FIRST_RUN_MARKER_RE = /(Welcome to Claude Code|Security notes:|Login successful)/i;
  const CONTINUE_RE = /Press Enter to continue/i;
  // NUMBERED PROSE IS NOT A CHOICE. The security notice numbers its two
  // paragraphs ("1. Claude can make mistakes."), and keying on a bare numbered
  // line therefore classified an informational screen as a decision and left the
  // dead end in place. A real choice draws a POINTER at its selected row or
  // says in its footer that Enter confirms a selection; the trust dialog does
  // both, plus names its own affirmative, so it stays excluded three ways over.
  const HAS_CHOICE_RE = /(^\s*❯|Enter to confirm|Enter to select|\(y\/n\)|Yes, I trust)/m;

  const isFirstRunNotice = (screen) => {
    if (!screen || !CONTINUE_RE.test(screen)) return false;
    if (!FIRST_RUN_MARKER_RE.test(screen)) return false;
    return !HAS_CHOICE_RE.test(screen);
  };

  const readFallback = async (pane, blockedHint, { observe = false } = {}) => {
    const paneId = pane.paneId;
    const screen = await readScreen(paneId, MENU_READ_LINES);
    // Gemini's first-run pages (colour scheme, Terms of Service & Data Use) are a card of their own
    // (gemini-first-run.js, 2026-11-24), read off the VISIBLE grid: agy redraws the whole page, so the recent
    // buffer can hold an older pointer. The extra read happens only while such a page is up.
    if (GEMINI_FIRST_RUN_RE.test(screen)) {
      let grid = '';
      try { grid = await readPane(paneId, MENU_READ_LINES, 'visible'); } catch { grid = ''; }
      const setup = parseGeminiFirstRun(grid) || parseGeminiFirstRun(screen);
      if (setup) return setup;
    }
    // agy's own drawn prompt box means nothing is being asked (its questions replace the box): dialog words in a
    // reply above it are prose, and its slash-command list under it is a draft being completed (2026-11-24/25).
    if (geminiPromptBox(screen)) return null;
    const blocked = classifyBlocked(screen, blockedHint);
    if (!blocked) return null;
    // Claude's own first-run notices are handled here rather than shown: one
    // Enter per poll, using the screen this function already read, so the poll
    // costs no extra pane read and a notice chain clears itself within a second
    // or two. Returning null means no panel flashes for something Harbor is
    // dealing with; the next poll sees whatever the notice revealed, which for
    // the last one is the trust dialog, and THAT gets a card. An observing poll
    // (see getMenu) presses nothing; the notice is not a question either way.
    if (isFirstRunNotice(screen)) {
      if (!observe) await answerMenu(paneId, pane.workspaceId, { type: 'key', key: 'enter' }).catch(() => {});
      return null;
    }
    let tail = blocked.lines;
    while (tail.length && !tail.at(-1).trim()) tail = tail.slice(0, -1);
    // A built-in LIST dialog (/mcp and its kin, 2026-10-24) is still the
    // fallback panel, with the whole list attached so the window shows every
    // row and a click picks one. Only a screen none of the five recognized
    // shapes took ever gets here, so this cannot claim one of theirs.
    const list = parseGenericList(screen) || (await readList(paneId));
    if (list) return { fallback: true, screen: tail.slice(-FALLBACK_SCREEN_LINES), list };
    await captureUnrecognized(paneId, screen);
    return { fallback: true, screen: tail.slice(-FALLBACK_SCREEN_LINES) };
  };

  // Click a row of a generic list: steer the "❯" there one arrow at a time,
  // re-reading after every key, and press Enter only once the highlight is
  // VERIFIED on that row (the same self-correcting walk as a numbered menu,
  // keyed on the row's label because these rows carry no number). A row the
  // CLI skips (a section header in an older layout) is never reached, so the
  // walk stops instead of confirming whatever it overshot onto.
  const pickListRow = async (paneId, workspaceId, action) => {
    const want = { label: String(action.label || ''), occurrence: Number(action.occurrence) || 0 };
    if (!want.label) return { ok: false, reason: 'no row to pick' };
    let list = await readList(paneId);
    if (!list) return { ok: false, reason: 'the list is no longer on screen' };
    let direction = 0;
    let turns = 0;
    const limit = list.rows.length * 2 + 6;
    for (let step = 0; step <= limit; step += 1) {
      const at = locateRow(list, want);
      if (at && at.current === at.target) {
        await typeInto(paneId, workspaceId, MENU_KEYS.enter);
        return { ok: true, action: 'list-pick', label: want.label };
      }
      // The search field has the highlight (/plugin while typing): one ↓
      // steps into the list, and the walk carries on from what that shows.
      if (at && at.current == null && list.searchable && !direction) {
        direction = 1;
        await typeInto(paneId, workspaceId, MENU_KEYS.down);
        await sleep(90);
        const into = await readList(paneId);
        if (!into || into.selectedIndex == null) return { ok: false, reason: 'could not move from the search field into the list' };
        list = into;
        continue;
      }
      if (at?.current == null || at.current < 0) return { ok: false, reason: 'cannot tell which row is highlighted; use the keys below' };
      // Off screen (a list that scrolls): keep going the way we were.
      const next = at ? Math.sign(at.target - at.current) : direction;
      if (!next) return { ok: false, reason: `"${want.label}" is not in this list any more` };
      if (direction && next !== direction) turns += 1;
      if (turns > 1) return { ok: false, reason: `"${want.label}" cannot be selected in this list` };
      direction = next;
      await typeInto(paneId, workspaceId, next > 0 ? MENU_KEYS.down : MENU_KEYS.up);
      await sleep(70);
      const after = await readList(paneId);
      if (!after) return { ok: false, reason: 'the list closed before that row was reached' };
      list = after;
    }
    return { ok: false, reason: `could not reach "${want.label}"` };
  };

  // Navigate to targetIndex and press Enter, or cancel with Esc. Selection is a
  // self-correcting loop: re-read the highlight, step one arrow toward the
  // target, repeat. A mis-parsed starting row therefore cannot select the wrong
  // option (we only press Enter once the "❯" is verified on the target).
  // Direct keys for the fallback panel: the human reads the raw screen in the
  // window and drives the dialog exactly as they would in the terminal, so no
  // parse is required and nothing is ever implied (Enter only when pressed).
  // "tab" is also the recognized card's question switcher: a batched
  // AskUserQuestion carries several questions behind one tab strip, and
  // without it the window can only ever answer the question that happens to
  // be showing. It is offered ONLY when the footer says Tab switches
  // questions, never on a permission prompt where Tab means amend.
  const FALLBACK_KEYS = Object.freeze({
    up: MENU_KEYS.up,
    down: MENU_KEYS.down,
    enter: MENU_KEYS.enter,
    esc: MENU_KEYS.cancel,
    space: ' ',
    tab: '\t',
    // Erases one character of a list's search (the generic list card).
    backspace: '\x7f',
    // Previous / next question in a batch. Both spellings are offered because
    // the dialog takes both and a future re-skin may drop one; the card sends
    // the arrows, which are what its own tab strip advertises.
    right: MENU_KEYS.right,
    left: MENU_KEYS.left,
    shifttab: '\x1b[Z',
  });

  // Drive the highlight onto a multi-select question's confirm row, the
  // unnumbered "Submit" (or "Next") drawn under the last option. It carries no
  // number, which is exactly what makes landing on it verifiable: while the
  // highlight is on an option some option parses as selected, and the step that
  // reaches the confirm row is the one after which none does.
  const walkToConfirmRow = async (paneId, workspaceId, menu) => {
    const selectedNow = (m) => (m?.options || []).some((o) => o.selected);
    // Already there: the pointer is ON the unnumbered row (menu-parse reads it
    // as confirmSelected), which is exactly where Enter has to be pressed.
    if (menu?.confirmSelected) return { ok: true };
    if (!selectedNow(menu)) {
      return { ok: false, reason: 'cannot tell what the dialog has highlighted; use its own keys' };
    }
    for (let step = 0; step < menu.options.length + 2; step += 1) {
      await typeInto(paneId, workspaceId, MENU_KEYS.down);
      await sleep(90);
      const current = await readMenu(paneId);
      if (!current) return { ok: false, reason: 'the menu closed before it was submitted' };
      if (!selectedNow(current)) return { ok: true };
    }
    return { ok: false, reason: 'could not reach this question\'s Submit row' };
  };

  // One recognized-dialog action against the pane, with control ALREADY held
  // by the caller. answerMenu wraps a single action; deliverSheet strings many
  // of these together under one hold, so the batch is never released to a blur
  // between two of its own keystrokes.
  const performMenuAction = async (paneId, workspaceId, action = {}) => {
    const decision = await readMenu(paneId);
    if (decision?.kind === 'model-switch') {
      if (action.type === 'cancel' && decision.canCancel) {
        await typeInto(paneId, workspaceId, MENU_KEYS.cancel);
        return { ok: await screenMovedOn(paneId, decision), action: 'cancel' };
      }
      if (action.type !== 'model-switch' || action.explicitClick !== true || !decision.options.length) {
        return { ok: false, reason: 'Choose a model with an explicit click on its button' };
      }
      const target = decision.options.find(o => o.index === action.index && o.label === action.label);
      if (!target) return { ok: false, reason: 'The model choices changed; review them again' };
      let landed = null;
      for (let step = 0; step < decision.options.length * 2 + 2; step += 1) {
        const current = await readMenu(paneId);
        if (current?.kind !== 'model-switch' || current.title !== decision.title
          || JSON.stringify(current.options.map(o => [o.index, o.label])) !== JSON.stringify(decision.options.map(o => [o.index, o.label]))) {
          return { ok: false, reason: 'The model choices changed; review them again' };
        }
        const selected = current.options.find(o => o.selected);
        if (selected && (target.numbered ? selected.index === target.index : selected.label === target.label)) { landed = current; break; }
        if (!selected) return { ok: false, reason: 'Cannot verify the selected model' };
        await typeInto(paneId, workspaceId, menuArrowToward(selected.index, target.index));
        await sleep(60);
      }
      if (!landed) return { ok: false, reason: 'Could not move to the chosen model' };
      await typeInto(paneId, workspaceId, MENU_KEYS.enter);
      return await screenMovedOn(paneId, landed)
        ? { ok: true, action: 'model-switch' }
        : { ok: false, reason: 'The model dialog did not change after Enter' };
    }
    if (action.type === 'model-switch') return { ok: false, reason: 'The model dialog is no longer on screen' };
    if (action.type === 'key') {
      const bytes = FALLBACK_KEYS[action.key];
      if (!bytes) return { ok: false, reason: `unknown key ${action.key}` };
      await typeInto(paneId, workspaceId, bytes);
      return { ok: true, action: 'key', key: action.key };
    }
    if (action.type === 'list-pick') return pickListRow(paneId, workspaceId, action);
    if (action.type === 'raw') {
      const text = String(action.text || '');
      if (!text) return { ok: false, reason: 'nothing to type' };
      // A dialog's own text field (a list's search box) drops text that
      // arrives in one chunk and takes it one key at a time (measured on
      // /plugin, 2.1.303), so the list card types key by key.
      if (action.perKey && !text.includes('\n')) {
        for (const ch of text) { await typeInto(paneId, workspaceId, ch); await sleep(40); }
        return { ok: true, action: 'raw' };
      }
      await typeInto(paneId, workspaceId, typedPayload(text));
      return { ok: true, action: 'raw' };
    }

    const menu = decision;
    if (!menu) return { ok: false, reason: 'the menu is no longer on screen' };

    if (action.type === 'cancel') {
      await typeInto(paneId, workspaceId, MENU_KEYS.cancel);
      return { ok: true, action: 'cancel' };
    }

    // A multi-select question confirms on its own unnumbered row, drawn under
    // the last option and labelled "Submit" (or "Next", when more questions
    // follow). Measured 2026-08-09, and it corrected the belief this code was
    // built on: a bare Enter does NOT confirm a multi-select question, it
    // TOGGLES whatever row the highlight is on, so the card's "Submit N
    // selected" button used to tick or untick an option and leave the
    // question exactly as open as before.
    //
    // The confirm row carries no number, which is precisely what makes
    // landing on it verifiable: while the highlight is on an option, some
    // option parses as selected, and the step that reaches the confirm row is
    // the one after which NONE does.
    if (action.type === 'submit') {
      const walked = await walkToConfirmRow(paneId, workspaceId, menu);
      if (!walked.ok) return walked;
      await typeInto(paneId, workspaceId, MENU_KEYS.enter);
      if (!(await screenMovedOn(paneId, menu))) {
        return { ok: false, reason: 'the dialog did not change after Enter on its Submit row, so nothing was confirmed' };
      }
      return { ok: true, action: 'submit' };
    }

    const target = Number(action.index);
    const option = menu.options.find((o) => o.index === target);
    const feedback = action.type === 'permission-feedback';
    if (feedback && (!menu.permission || option?.isText || !/^No\b/i.test(option?.label || ''))) {
      return { ok: false, reason: 'feedback must reject a native permission option' };
    }
    // An option the pane has scrolled off the top is still answerable: the
    // card knows it exists because the transcript listed it, and the walk
    // below only presses Enter once the "❯" has been SEEN on that number, so
    // a row we cannot currently read can never be selected by mistake. It
    // used to be refused outright, which is what left Pat arrowing through a
    // card that was showing him the option he wanted (2026-07-27).
    const firstVisible = menu.options[0]?.index ?? 1;
    const clippedAbove = !option && menu.clipped && target >= 1 && target < firstVisible;
    if (!option && !clippedAbove) return { ok: false, reason: `option ${action.index} is not on the menu` };

    // For a free-text option, land on it, open it, then deliver the prose.
    // Only a row we can read can be known to take text; a clipped one is a
    // transcript option, which is never the "Type something" row.
    if (action.type === 'text' && !option?.isText) {
      return { ok: false, reason: `option ${target} does not take typed text` };
    }

    // Drive the highlight onto the target (bounded; menus are short). Walk
    // by the option NUMBER under the "❯", re-read each step: an option's
    // position in the visible run shifts when the list scrolls or its top
    // is clipped by the viewport, so positions computed once would press
    // Enter on the wrong option. Options render in ascending order, so the
    // number ordering is the visual ordering.
    const selectedNumber = (m) => m.options.find((o) => o.selected)?.index ?? null;
    const maxSteps = menu.options.at(-1).index * 2 + 2;
    for (let step = 0; step < maxSteps; step += 1) {
      const current = await readMenu(paneId);
      if (!current) return { ok: false, reason: 'the menu closed before it was answered' };
      const currentNumber = selectedNumber(current);
      if (currentNumber === target) break;
      const arrow = menuArrowToward(currentNumber, target);
      // Pointer not visible (first open, or parked in a clipped top): step
      // toward where the target is known to be. Options end at the footer,
      // so below the visible run there is nothing, and ↓ is the move that
      // reveals a "❯" parked above; but when the TARGET itself sits above
      // the visible run, ↑ is the one going toward it.
      // From the confirm row (pointer on the unnumbered Submit/Next) every
      // numbered option sits ABOVE except the Chat row under the divider,
      // which is the last number; a blind ↓ from there bounced between the
      // confirm row and Chat forever (review-caught 2026-09-03).
      const lastNumber = current.options.at(-1)?.index ?? target;
      const blindArrow = current.confirmSelected
        ? (target >= lastNumber ? MENU_KEYS.down : MENU_KEYS.up)
        : (target < firstVisible ? MENU_KEYS.up : MENU_KEYS.down);
      await typeInto(paneId, workspaceId, arrow ?? blindArrow);
      await sleep(60);
    }
    const landed = await readMenu(paneId);
    if (!landed || selectedNumber(landed) !== target) {
      return { ok: false, reason: 'could not move the menu highlight to that option' };
    }
    if (feedback && (JSON.stringify(landed.permission) !== JSON.stringify(menu.permission)
      || landed.options.find(o => o.index === target)?.label !== option.label)) {
      return { ok: false, reason: 'the permission request changed; review it before sending feedback' };
    }

    // Tick a multi-select row. Space toggles, and the row draws its own state,
    // so the flip is CONFIRMED by re-reading the checkbox rather than assumed.
    // Nothing is submitted here; that is a separate, deliberate action.
    if (action.type === 'toggle') {
      const before = landed.options.find((o) => o.index === target)?.checked;
      // A row with NO checkbox cannot be ticked, and the change check below
      // skips itself when `before` is undefined, so this used to report
      // ok:true for a Space that did nothing to a plain row like "Chat about
      // this" (caught in review 2026-08-09). Refuse instead of claiming it.
      if (before == null) {
        return { ok: false, reason: `option ${target} is not a checkbox, so it cannot be ticked` };
      }
      await typeInto(paneId, workspaceId, FALLBACK_KEYS.space);
      await sleep(120);
      const after = await readMenu(paneId);
      const now = after?.options.find((o) => o.index === target)?.checked;
      if (after && before != null && now === before) {
        return { ok: false, reason: `option ${target} did not change state` };
      }
      return { ok: true, action: 'toggle', index: target, checked: now ?? null };
    }

    // Attach a note to this answer, using the key the FOOTER advertises rather
    // than an assumed one. Landing on the row first is what makes the note
    // attach to the intended option.
    if (action.type === 'notes') {
      const key = landed.notesKey || menu.notesKey;
      if (!key) return { ok: false, reason: 'this dialog does not offer notes' };
      await typeInto(paneId, workspaceId, key);
      await sleep(180);
      const text = String(action.text || '');
      if (text) {
        await typeInto(paneId, workspaceId, typedPayload(text));
        await sleep(120);
        await typeInto(paneId, workspaceId, MENU_KEYS.enter);
      }
      return { ok: true, action: 'notes', index: target };
    }

    // THE FREE-TEXT ROW IS AN INLINE FIELD, NOT A DOOR TO A COMPOSER
    // (2026-08-09, driven against a real dialog; captures in
    // test/fixtures/askuserquestion/real-text-row-typed-120x60.txt). Landing
    // on it and TYPING rewrites the row itself, and Enter then answers that
    // one question ("User answered Claude's questions: → my typed answer").
    //
    // This used to press Enter first, on the belief that the row "opens a
    // composer". It does open one, by DECLINING EVERY QUESTION IN THE SET
    // ("User declined to answer questions") and dropping the pane to its
    // ordinary prompt, where the answer was then typed and sent as a plain
    // chat message. So a typed answer destroyed the whole batch and never
    // answered anything, which is both halves of Pat's report: no way to
    // type, and one Enter submitting everything.
    if (action.type === 'text' && action.text) {
      const before = landed.options.find((o) => o.index === target)?.label ?? '';
      const text = String(action.text);
      await typeInto(paneId, workspaceId, typedPayload(text));
      await sleep(160);
      // CONFIRM the field took it before confirming, because the field's
      // contents ARE the row's label and therefore readable. This is the one
      // path where assuming a keystroke landed is unaffordable: an Enter on a
      // still-empty free-text row is the decline-everything case above.
      const typed = await readMenu(paneId);
      const after = typed?.options.find((o) => o.index === target)?.label ?? '';
      if (!typed || after === before) {
        return { ok: false, reason: 'the answer never reached the text field, so nothing was submitted' };
      }
      // ON A MULTI-SELECT QUESTION, ENTER IS NOT THE CONFIRM. Typing into its
      // free-text row TICKS that row ("[ ] Type something" -> "[✔] my answer"),
      // and Enter there UNTICKS it again, throwing the answer away and leaving
      // the question open. Measured 2026-08-09; a review flagged this exact
      // combination as unproven and it turned out to be wrong. So the typed row
      // is confirmed the way every other multi-select answer is: on the
      // question's own unnumbered Submit row, which also preserves whatever
      // else he had ticked.
      if (typed.multiSelect) {
        const walked = await walkToConfirmRow(paneId, workspaceId, typed);
        if (!walked.ok) return walked;
      }
      await typeInto(paneId, workspaceId, MENU_KEYS.enter);
      // The Enter has to have DONE something: a keystroke the bridge accepted
      // but the CLI never saw used to come back as delivered, and the card
      // then vanished over a dialog that was still up (review-caught
      // 2026-09-03, both for a lone question and the review's Submit).
      if (!(await screenMovedOn(paneId, typed))) {
        return { ok: false, reason: 'the dialog did not change after Enter, so the answer did not register' };
      }
      return { ok: true, action: 'text', index: target };
    }

    await typeInto(paneId, workspaceId, MENU_KEYS.enter);
    if (!(await screenMovedOn(paneId, landed))) {
      return { ok: false, reason: 'the dialog did not change after Enter, so the answer did not register' };
    }
    if (feedback && String(action.text || '').trim()) {
      // CLI 2.1.288, measured in an isolated live Edit: No rejects the tool
      // and returns to the composer. This stays inside answerMenu's pane
      // mutex and control hold, including deliver's guarded Enter watcher.
      for (let poll = 0; poll < 40; poll += 1) {
        const screen = await readScreen(paneId, MENU_READ_LINES);
        if (screen && !classifyBlocked(screen) && composerSendState(screen) !== 'nobox') {
          try {
            const state = await deliver(paneId, workspaceId, String(action.text), [], 'claude');
            return state === 'taken' ? { ok: true, action: 'permission-feedback', index: target }
              : { ok: false, reason: 'the tool was declined, but feedback submission could not be confirmed; check the composer before retrying' };
          } catch (error) {
            return { ok: false, reason: 'the tool was declined, but feedback could not be sent: ' + error.message };
          }
        }
        await sleep(150);
      }
      return { ok: false, reason: 'the tool was declined, but its composer did not return; feedback was not sent' };
    }
    return { ok: true, action: 'select', index: target };
  };

  // ---- the answer sheet's one delivery (2026-09-03) ------------------------
  // The card keeps every choice local and hands the pty ONE delivery: for each
  // question in order, make it the one on screen, answer it through the same
  // verified single-question actions as before, VERIFY the dialog moved on,
  // then reach the batch's review screen and submit. The first step that cannot
  // be verified stops, leaves the dialog exactly where it is, and names the
  // question it stopped on, so a partial delivery is visible and resumable
  // (re-submitting re-derives the current question and re-checks every tick).
  //
  // Measured against Claude Code v2.1.258 (fixtures real-batch-*-2.1.258.txt):
  // → / ← change question, Enter on a single-select option answers it and
  // auto-advances, the unnumbered Submit row confirms a multi-select, and the
  // last question leads to "Ready to submit your answers?" with "1. Submit
  // answers". `questions` is the set the card was built from: the transcript's
  // when it had one, else the batch discovered off the dialog (discoverBatch).
  // WHICH question is on screen is always derived from it, never trusted from
  // the renderer, and a batch with no known question set is refused rather
  // than answered as if it were a lone question (review-caught 2026-09-03).
  const SHEET_HOP_DELAY_MS = 140;
  const labelOf = (questions, i) => (questions?.[i]?.header ? `"${questions[i].header}"` : `question ${i + 1}`);

  // Make question `q` the one on screen. Returns the menu showing it, or a
  // refusal naming why it could not be reached.
  const goToQuestion = async (paneId, workspaceId, questions, q) => {
    const count = questions.length;
    for (let hop = 0; hop <= count + 1; hop += 1) {
      const menu = await readMenu(paneId);
      if (!menu) return { ok: false, reason: `the dialog closed before ${labelOf(questions, q)} was reached`, question: q };
      if (isReviewMenu(menu)) return { ok: false, reason: `the dialog reached its review screen before ${labelOf(questions, q)} was answered`, question: q };
      const current = currentQuestionIndex(questions, menu);
      if (current === q) return { ok: true, menu };
      if (current < 0) return { ok: false, reason: `cannot tell which question the dialog is showing, so ${labelOf(questions, q)} was not answered`, question: q };
      await typeInto(paneId, workspaceId, current < q ? MENU_KEYS.right : MENU_KEYS.left);
      await sleep(SHEET_HOP_DELAY_MS);
    }
    return { ok: false, reason: `could not reach ${labelOf(questions, q)} in the dialog`, question: q };
  };

  // Did the answer REGISTER. A dropped keystroke used to pass as delivered
  // (review-caught 2026-09-03: an Enter the CLI never saw still produced
  // ok:true and a partial batch was submitted). In a batch the CLI advances or
  // marks the tab; a lone question's dialog closes or changes.
  const answerRegistered = async (paneId, questions, q, before) => {
    const after = await readMenu(paneId);
    if (!after) return true;
    if (questions && questions.length > 1) {
      if (isReviewMenu(after)) return true;
      const current = currentQuestionIndex(questions, after);
      if (current >= 0 && current !== q) return true;
      return answeredFromStrip(after.tabs, questions[q]?.header, q) === true;
    }
    return !sameQuestion(after, before);
  };

  // ONE TYPIST PER PANE, ACROSS PROCESSES (2026-11-18). Two Harbor processes
  // type into the same panes: the desktop app (Pat's command bar) and the phone
  // server, which carries every agent's harbor-send. Each kept its own queue and
  // its own record of typing it had not yet seen drawn, so neither knew the
  // other's paste was still waiting inside a stalled Claude: Pat's screenshot
  // went into Vox behind an agent's unsent 2,034-character message, and both
  // sat in one prompt. Every write into a pane (a message, an answer sheet, a
  // mode key) now holds the pane's lock until it has seen its text shown and
  // pressed Enter, or given up.
  // The lock is OS-owned (shared/os-lock.cjs, a named pipe on Windows), never a
  // file: the first version was a lock file, and Sol's review showed two
  // waiters could both judge a dead holder stale and both take it, and a slow
  // live holder could be evicted. The OS frees a pipe the moment its process
  // dies, so neither can happen. A send that waits out the holder is REFUSED
  // (PANE_BUSY), never typed without the lock. The name carries the store
  // directory, so a harness on a relocated store never shares a real pane's lock.
  // A minute: past that the holder is almost certainly a frozen Claude, and
  // the refusal comes well inside the phone's four-minute call deadline.
  const PANE_LOCK_WAIT_MS = 60_000;
  // Panes whose image chord Claude never confirmed (see the image loop). A
  // debt ends only on evidence tied to that chord: the pane's COMPOSER drew an
  // image chip numbered past the ones it had (it read the clipboard), or its CLI is gone
  // or was replaced (a new created_at). A redraw, a resize or a failed read
  // proves nothing, so the debt stands (round three of the review). While any
  // debt stands, images go by path, which costs only the inline attachment.
  // Kept ON DISK in the pane-lock folder (round four: a desktop restart
  // forgot an in-memory debt while the pane still held the chord), written
  // BEFORE the chord goes out and removed when its chip shows.
  const owedChords = (() => {
    const memory = new Map();
    const dir = () => (paneLockDir ? path.join(paneLockDir, 'clipboard-debts') : null);
    const fileFor = (paneId) => path.join(dir(), `${String(paneId).replace(/[^A-Za-z0-9_.-]/g, '_')}.json`);
    return {
      set(paneId, debt) {
        if (!dir()) { memory.set(paneId, debt); return true; }
        try {
          fsSync.mkdirSync(dir(), { recursive: true });
          const tmp = `${fileFor(paneId)}.${process.pid}.tmp`;
          fsSync.writeFileSync(tmp, JSON.stringify({ paneId, ...debt }));
          fsSync.renameSync(tmp, fileFor(paneId));
          return true;
        } catch { return false; }
      },
      delete(paneId) {
        if (!dir()) { memory.delete(paneId); return; }
        try { fsSync.rmSync(fileFor(paneId), { force: true }); } catch { /* gone */ }
      },
      get(paneId) {
        if (!dir()) return memory.get(paneId) || null;
        try { return JSON.parse(fsSync.readFileSync(fileFor(paneId), 'utf8')); } catch (error) {
          return error?.code === 'ENOENT' ? null : { unreadable: true };
        }
      },
      // A missing folder is no debt; any other failure to read the folder or
      // a record counts as a debt that cannot be retired (round five: a
      // skipped unreadable record let another image overwrite the clipboard).
      entries() {
        if (!dir()) return [...memory];
        let names = [];
        try { names = fsSync.readdirSync(dir()).filter((name) => name.endsWith('.json')); } catch (error) {
          return error?.code === 'ENOENT' ? [] : [['(unreadable)', { unreadable: true }]];
        }
        const out = [];
        for (const name of names) {
          try {
            const debt = JSON.parse(fsSync.readFileSync(path.join(dir(), name), 'utf8'));
            out.push(debt?.paneId ? [debt.paneId, debt] : [name, { unreadable: true }]);
          } catch (error) {
            if (error?.code !== 'ENOENT') out.push([name, { unreadable: true }]); // gone meanwhile: retired
          }
        }
        return out;
      },
    };
  })();
  // A Claude pane that owes a screenshot read takes no new write (round
  // eleven). While nothing has been drawn since the paste gave up, wait (3
  // minutes, then refuse). Its chip in the composer: the screenshot is in the
  // prompt now, so refuse until it is sent or cleared. Drawn since with the
  // prompt drawn and empty on a second look: the chord was lost, the debt
  // ends, and the send goes on. No box or an unreadable frame: refuse.
  const settleOwedChord = async (paneId, { onWait = null } = {}) => {
    const debt = owedChords.get(paneId);
    if (!debt) return;
    if (debt.unreadable) throw owedChordError('unresolved');
    const generation = await paneGeneration(paneId);
    if (debt.generation && generation && debt.generation !== generation) { owedChords.delete(paneId); return; }
    let screen = '';
    try { screen = await readPane(paneId, MENU_READ_LINES); } catch { screen = ''; }
    // A debt with no screen after its chord (the Harbor that pasted exited
    // first; round thirteen) takes this read as its baseline, on the record,
    // and only a redraw after it counts: two identical frames from a frozen
    // Claude never end it.
    if (!debt.inPrompt && !debt.screen) {
      if (!screen || !String(screen).trim()) throw owedChordError('unresolved');
      debt.screen = screen;
      owedChords.set(paneId, { ...debt });
    }
    const startedAt = clock();
    let noticed = false;
    // The chip in the composer is evidence on its own, redraw or not (round
    // fourteen: a baseline that already showed it waited 3 minutes for a
    // redraw an idle Claude never makes), so it is looked for before the wait
    // and on every poll.
    const chipShown = (frame) => {
      const max = frame ? composerImageMax(frame) : null;
      return max !== null && max > debt.beforeMax;
    };
    for (let poll = 0; !debt.inPrompt && debt.screen && screen && !chipShown(screen) && screenContent(screen) === screenContent(debt.screen); poll += 1) {
      if (clock() - startedAt >= STALLED_WAIT_MS || poll >= STALLED_WAIT_MS / 1000) throw owedChordError('stalled');
      if (!noticed && onWait) { noticed = true; onWait('waiting for Claude to read the screenshot Harbor pasted earlier, so nothing is typed behind it'); }
      await sleep(1000);
      try { screen = (await readPane(paneId, MENU_READ_LINES)) || screen; } catch { /* keep the last frame */ }
    }
    const chips = screen ? composerImageMax(screen) : null;
    // Read: the clipboard is free (the debt is marked inPrompt, which the
    // clipboard check ignores), but the pane stays blocked while its prompt
    // holds that screenshot (round twelve: deleting the debt here let the
    // next send type behind the screenshot and submit both). It ends when the
    // prompt no longer shows the chip: sent or cleared.
    if (chips !== null && chips > debt.beforeMax) {
      if (!debt.inPrompt) owedChords.set(paneId, { ...debt, inPrompt: true });
      throw owedChordError('in-prompt');
    }
    if (debt.inPrompt) {
      if (chips === null) throw owedChordError('unresolved');
      logSend({ paneId, phase: 'owed-chord-draft-gone' });
      owedChords.delete(paneId);
      return;
    }
    if (chips !== null && await stillEmptyAfterAMoment(paneId, false)) {
      logSend({ paneId, phase: 'owed-chord-lost' });
      owedChords.delete(paneId);
      return;
    }
    throw owedChordError('unresolved');
  };
  const owedChordError = (why) => {
    const text = why === 'in-prompt'
      ? 'The screenshot from an earlier send is now in Claude\'s prompt, so nothing was typed behind it. Send or clear it in the >_ terminal first. Your text is kept'
      : why === 'stalled'
        ? 'Claude has drawn nothing for 3 minutes since Harbor pasted a screenshot into it, so nothing was typed behind that paste. Your text is kept; check the >_ terminal'
        : 'Harbor cannot tell whether Claude read the screenshot it pasted earlier, so nothing was typed behind it. Your text is kept; check the >_ terminal';
    const error = new Error(text);
    error.code = why === 'in-prompt' ? 'EARLIER_IMAGE_IN_PROMPT' : 'EARLIER_IMAGE_UNRESOLVED';
    return error;
  };
  const clipboardOwed = async () => {
    const debts = owedChords.entries();
    if (!debts.length) return false;
    let panes = null;
    try { panes = (await snapshot())?.panes || null; } catch { /* unknown: debts stand */ }
    for (const [owedPane, debt] of debts) {
      if (debt.unreadable) return true;
      if (panes) {
        const live = panes.find((candidate) => candidate.pane_id === owedPane);
        if (!live || (debt.generation && live.created_at && live.created_at !== debt.generation)) { owedChords.delete(owedPane); continue; }
      }
      let drawn = null;
      try { drawn = composerImageMax(await readPane(owedPane, MENU_READ_LINES)); } catch { /* unknown: the debt stands */ }
      if (debt.inPrompt) continue; // read already: the clipboard is free
      if (drawn !== null && drawn > debt.beforeMax) { owedChords.set(owedPane, { ...debt, inPrompt: true }); continue; }
      return true;
    }
    return false;
  };
  const PANE_LOCK_NOTICE = 'another Harbor window is typing into this session; this message goes in right after it';
  const CLIPBOARD_WAIT_NOTICE = 'another image is being pasted into a different session; this one goes in right after it';
  const paneLockDir = process.env.NODE_TEST_CONTEXT && !deps.sendLogFile ? null : path.join(path.dirname(sendLogFile), 'pane-locks');
  const paneBusyError = () => {
    const error = new Error('Another Harbor window has been typing into this session for several minutes (Claude is probably frozen), so nothing was typed or sent. Your text is kept. Check the >_ terminal');
    error.code = 'PANE_BUSY';
    return error;
  };
  const withPaneLock = async (paneId, fn, onWait) => {
    if (!paneLockDir) return fn();
    try {
      return await withLock(`harbor-pane:${paneLockDir}:${paneId}`, fn, {
        waitMs: PANE_LOCK_WAIT_MS,
        onWait: onWait ? () => onWait(PANE_LOCK_NOTICE) : null,
      });
    } catch (error) {
      if (error?.code === 'LOCK_TIMEOUT') throw paneBusyError();
      throw error;
    }
  };
  // Every session-addressed send re-checks, INSIDE the lock, that the pane
  // still serves its session (Sol's review, rounds two and three: between
  // resolving the pane and taking the lock, another Harbor process can take
  // and release the lock after starting a different conversation there, a
  // Codex /new for one, so "I did not wait" proves nothing).
  // options.verifyTarget throws if the pane changed.
  const deliver = (paneId, workspaceId, text, images = [], provider = 'claude', options = {}) => withPaneLock(
    paneId,
    async () => {
      if (typeof options?.verifyTarget === 'function') await options.verifyTarget();
      return deliverUnlocked(paneId, workspaceId, text, images, provider, options);
    },
    options?.onWait || null,
  );

  const deliverSheet = async (paneId, workspaceId, action, ask) => {
    const answers = Array.isArray(action.answers) ? [...action.answers] : [];
    answers.sort((a, b) => Number(a.question) - Number(b.question));
    const questions = normalizeAsk(Array.isArray(ask) ? { questions: ask } : ask);
    const batch = Boolean(questions) && questions.length > 1;
    const fail = (reason, question) => ({ ok: false, reason, question });
    const label = (i) => labelOf(questions, i);

    const opening = await readMenu(paneId);
    if (!opening) return fail('the dialog closed before it was answered', answers[0]?.question ?? 0);
    if (!batch && (answers.length > 1 || questionTabs(opening).length > 1)) {
      return fail('this batch\'s questions are not known yet, so nothing was answered; the card re-reads them in a moment', answers[0]?.question ?? 0);
    }
    if (!answers.length && !batch) return fail('nothing to deliver', 0);
    // An empty sheet on a batch means every answer already lives in the
    // dialog, and the strip has to say so before a single key is sent; a
    // sheet with nothing in it must never reach Submit.
    if (!answers.length && questionTabs(opening).some((tab) => !tab.done)) {
      return fail('nothing to deliver: the dialog still has unanswered questions', 0);
    }
    if (answers.some((answer) => batch && (Number(answer.question) < 0 || Number(answer.question) >= questions.length))) {
      return fail('an answer names a question this batch does not have', 0);
    }

    for (const answer of answers) {
      const q = batch ? Number(answer.question) || 0 : 0;
      let menu;
      if (batch) {
        const reached = await goToQuestion(paneId, workspaceId, questions, q);
        if (!reached.ok) return reached;
        menu = reached.menu;
      } else {
        menu = await readMenu(paneId);
        if (!menu) return fail('the dialog closed before it was answered', q);
      }

      let result;
      if (answer.kind === 'select') {
        result = await performMenuAction(paneId, workspaceId, { type: 'select', index: Number(answer.index) });
      } else if (answer.kind === 'text') {
        const textRow = menu.options.find((option) => option.isText);
        if (!textRow) return fail(`${label(q)} has no row that takes typed text`, q);
        result = await performMenuAction(paneId, workspaceId, { type: 'text', index: textRow.index, text: String(answer.text || '') });
      } else if (answer.kind === 'multi') {
        const want = new Set((answer.indexes || []).map(Number));
        const typed = String(answer.text || '').trim();
        // The free-text row is the one just above Chat; once something is
        // typed on it the CLI rewrites its label and it stops reading as a
        // text row, so it is found by POSITION and never toggled as an option
        // (review-caught 2026-09-03: a typed row was unticked and lost).
        const chatRow = menu.options.find((row) => !row.isText && CHAT_ROW_RE.test(row.label || ''));
        const textIndex = menu.options.find((row) => row.isText)?.index
          ?? (questions ? questions[q].options.length + 1 : (chatRow ? chatRow.index - 1 : null));
        const visible = menu.options.filter((row) => row.checked !== undefined && !row.isText && row.index !== textIndex);
        const unseen = [...want].filter((index) => !visible.some((row) => row.index === index));
        if (unseen.length) return fail(`${label(q)}: option ${unseen[0]} is not drawn in the terminal, so it cannot be ticked`, q);
        for (const row of visible) {
          const desired = want.has(row.index);
          if (row.checked === desired) continue;
          const toggled = await performMenuAction(paneId, workspaceId, { type: 'toggle', index: row.index });
          if (!toggled.ok) return fail(`${label(q)}: ${toggled.reason}`, q);
        }
        // Every wanted row must READ as ticked before the question is confirmed.
        const check = await readMenu(paneId);
        if (!check) return fail(`the dialog closed before ${label(q)} was confirmed`, q);
        const missing = [...want].filter((index) => check.options.find((option) => option.index === index)?.checked !== true);
        if (missing.length) return fail(`${label(q)}: option ${missing[0]} did not read as ticked, so nothing was confirmed`, q);
        const textRow = check.options.find((row) => row.index === textIndex) || check.options.find((row) => row.isText) || null;
        const typedRow = textRow && !textRow.isText ? textRow : null;
        if (typedRow && typed && typedRow.label !== typed) {
          return fail(`${label(q)}: the terminal already holds "${typedRow.label}" on the free-text row; clear it there before delivering "${typed}"`, q);
        }
        if (typedRow && Boolean(typedRow.checked) !== Boolean(typed)) {
          // Keep what the sheet says: tick the typed row back on, or untick
          // text the sheet no longer carries.
          const toggled = await performMenuAction(paneId, workspaceId, { type: 'toggle', index: typedRow.index });
          if (!toggled.ok) return fail(`${label(q)}: ${toggled.reason}`, q);
        }
        if (typed && !typedRow) {
          // Typing on the free-text row ticks it alongside the others, and the
          // text action confirms on the Submit row (measured 2026-08-09).
          if (!textRow) return fail(`${label(q)} has no row that takes typed text`, q);
          result = await performMenuAction(paneId, workspaceId, { type: 'text', index: textRow.index, text: typed });
        } else {
          result = await performMenuAction(paneId, workspaceId, { type: 'submit' });
        }
      } else {
        return fail(`${label(q)}: unknown answer kind "${answer.kind}"`, q);
      }
      if (!result?.ok) return fail(`${label(q)}: ${result?.reason || 'that answer did not land'}`, q);
      await sleep(SHEET_HOP_DELAY_MS);
      if (!(await answerRegistered(paneId, questions, q, menu))) {
        return fail(`${label(q)}: the answer did not register in the dialog, so nothing after it was sent`, q);
      }
    }

    if (batch) {
      let review = null;
      for (let hop = 0; hop <= questions.length + 1; hop += 1) {
        const menu = await readMenu(paneId);
        if (!menu) return { ok: false, reason: 'every question was answered, but the dialog closed before the answers were submitted' };
        if (isReviewMenu(menu)) { review = menu; break; }
        await typeInto(paneId, workspaceId, MENU_KEYS.right);
        await sleep(SHEET_HOP_DELAY_MS);
      }
      if (!review) return { ok: false, reason: 'every question was answered, but the review screen never appeared' };
      // The CLI's own review says whether anything is still open ("⚠ You have
      // not answered all questions", fixture real-batch-submit-review-120x60):
      // that line is the last word before Submit, whatever this driver believes.
      const reviewScreen = await readScreen(paneId, MENU_READ_LINES);
      if (/you have not answered all questions/i.test(reviewScreen)) {
        return { ok: false, reason: 'the dialog says not every question is answered, so nothing was submitted; the review is on screen' };
      }
      const submitRow = review.options.find((option) => /^submit answers$/i.test(option.label));
      const submitted = await performMenuAction(paneId, workspaceId, { type: 'select', index: submitRow.index });
      if (!submitted.ok) return { ok: false, reason: `the answers were filled in but not submitted: ${submitted.reason}` };
    }
    return { ok: true, action: 'sheet', delivered: answers.length };
  };

  // "Chat about this" for a given question: reach it first, then choose the
  // dialog's own Chat row by its label on THAT screen. The renderer used to send
  // a bare row number, which on a batch could land on another question's
  // option (review-caught 2026-09-03).
  const chatAbout = async (paneId, workspaceId, action, ask) => {
    const questions = normalizeAsk(Array.isArray(ask) ? { questions: ask } : ask);
    const q = Number(action.question) || 0;
    let menu;
    if (questions && questions.length > 1) {
      const reached = await goToQuestion(paneId, workspaceId, questions, q);
      if (!reached.ok) return reached;
      menu = reached.menu;
    } else {
      menu = await readMenu(paneId);
      if (!menu) return { ok: false, reason: 'the dialog is no longer on screen' };
    }
    const chatRow = menu.options.find((option) => !option.isText && CHAT_ROW_RE.test(option.label || ''));
    if (!chatRow) return { ok: false, reason: 'this dialog has no "Chat about this" row' };
    return performMenuAction(paneId, workspaceId, { type: 'select', index: chatRow.index });
  };

  // A note names its question now, like Chat: with the terminal on one question
  // and the sheet on another, a note used to land on the terminal's (review-
  // caught 2026-09-03).
  const noteOn = async (paneId, workspaceId, action, ask) => {
    const questions = normalizeAsk(Array.isArray(ask) ? { questions: ask } : ask);
    if (questions && questions.length > 1 && action.question != null) {
      const reached = await goToQuestion(paneId, workspaceId, questions, Number(action.question) || 0);
      if (!reached.ok) return reached;
    }
    return performMenuAction(paneId, workspaceId, action);
  };

  // Menu keystrokes take the pane's cross-process lock like a message does
  // (withPaneLock): an answer typed behind another process's unshown paste
  // lands in the wrong place (Sol's review, 2026-11-18).
  const answerMenu = (paneId, workspaceId, action = {}, ask = null) => serializeOnPane(paneId, () => withPaneLock(paneId, async () => {
    terminalBridge.holdControl?.(paneId);
    try {
      await acquireControl(paneId, workspaceId);
      // The Gemini setup card's clicks: each key only after a fresh read of the grid proves where the pointer is.
      if (isGeminiFirstRunAction(action)) {
        return await answerGeminiFirstRun(action, {
          read: () => readPane(paneId, MENU_READ_LINES, 'visible'),
          type: (bytes) => typeInto(paneId, workspaceId, bytes),
          sleep,
        });
      }
      if (action.type === 'sheet') return await deliverSheet(paneId, workspaceId, action, ask);
      if (action.type === 'chat') return await chatAbout(paneId, workspaceId, action, ask);
      if (action.type === 'notes') return await noteOn(paneId, workspaceId, action, ask);
      return await performMenuAction(paneId, workspaceId, action);
    } finally {
      terminalBridge.releaseControlHold?.(paneId);
    }
  }));

  const waitForResumedClaudeReady = async (paneId, workspaceId, { timeoutMs = 30_000, compactingTimeoutMs = 180_000 } = {}) => {
    // Size the pane BEFORE settling, not during. A resize changes the wrap
    // width and can invalidate recent output, so one landing mid-wait makes
    // every read differ from the last and the settle test can never pass. That
    // is what turned an adopt into "session adopted, but Claude never became
    // ready" on 2026-07-28: the session had been killed and resumed, so the
    // message was already unsendable by the time the wait gave up.
    await terminalBridge?.ensureDialogSize?.(paneId).catch?.(() => {});
    const start = Date.now();
    let deadline = start + timeoutMs;
    let prev = null;
    while (Date.now() < deadline) {
      await sleep(800);
      const screen = await readScreen(paneId, MENU_READ_LINES);
      if (!screen) continue;
      const menu = parseMenu(screen);
      const fullOption = menu?.options.find((option) => option.index === 2);
      if (menu?.kind !== 'model-switch' && fullOption?.label === 'Resume full session as-is') {
        const answered = await answerMenu(paneId, workspaceId, { type: 'select', index: 2 });
        if (!answered.ok) throw new Error(`could not answer the Claude resume dialog: ${answered.reason}`);
        prev = null;
        continue;
      }
      // A resume can come up STRAIGHT into a compaction: the tail was a typed
      // message resume redelivered (resume-nudge), and /compact or an auto
      // -compact runs for a minute or more before the composer returns. That is
      // proof the session came up, and it routinely outlasts the 30s settle
      // window, so extend the deadline and wait it out rather than declaring
      // "never came up" over a resume that in fact succeeded (live-caught
      // 2026-09-02: a cdt-app resume ran /compact ~95s and the send reported the
      // message unsent). Checked before the working-turn shortcut so we never
      // type into a running compaction, whose banner also carries "esc to
      // interrupt".
      if (COMPACTION_LINE_RE.test(screen)) {
        deadline = Math.max(deadline, start + compactingTimeoutMs);
        prev = screen;
        continue;
      }
      // In-session and working: the composer is drawn with an "esc to interrupt"
      // footer and the CLI queues text typed into it, so the resume HAS come up
      // and the message can be delivered. A long streaming turn never settles to
      // two equal frames, so without this it timed out as "never came up".
      if (isWorkingTurn(screen)) return true;
      if (isBlockedScreen(screen)) {
        prev = screen;
        continue;
      }
      const hasComposer = /[❯╭╰]/.test(screen) || /^\s*>\s*$/m.test(screen);
      const settled = settleKey(screen);
      if (hasComposer && prev === settled) return true;
      prev = settled;
    }
    return false;
  };

  // Permission mode is NOT carried on the statusline stdin in 2.1.214, so the
  // only honest read is scraping the composer footer the CLI draws it in. Best
  // effort: an unreadable pane yields a null mode rather than a guess.
  const PERMISSION_MODE_RES = [
    [/bypass(?:ing)? permissions? on/i, 'bypass'],
    [/plan mode on/i, 'plan'],
    [/accept edits on/i, 'accept-edits'],
    [/auto mode on/i, 'auto'],
  ];
  const readPermissionMode = async (paneId) => {
    let screen = '';
    try { screen = await readPane(paneId); } catch { return { mode: null }; }
    if (!screen) return { mode: null };
    const bottom = screen.split('\n').slice(-8).join('\n');
    for (const [re, mode] of PERMISSION_MODE_RES) if (re.test(bottom)) return { mode };
    return { mode: 'default' };
  };

  // Cycle the permission mode the only way the CLI exposes it: shift+tab
  // (ESC [ Z). We do not fake a "set bypass" button (bypass can be
  // org-disabled); we cycle and re-scrape so the UI reports the landed mode.
  const cyclePermissionMode = (paneId, workspaceId) => withPaneLock(paneId, async () => {
    const state = terminalBridge.getState();
    if (state.controlledPaneId !== paneId) {
      await terminalBridge.requestFocusPane({ paneId, workspaceId }).catch(() => {});
    }
    const result = sendPaneInput(paneId, '\x1b[Z');
    if (result?.ok === false) throw new Error(result.reason || 'input refused');
    await sleep(400);
    return readPermissionMode(paneId);
  });

  // Trust but VERIFY every candidate pane; including the renderer's, whose
  // model/link state can lag a pane's death by minutes. A dead pane must fall
  // through to the resume path, not eat the message (live-caught). Pane
  // EXISTENCE is not session liveness (live-caught 2026-07-22: a Bun segfault
  // dropped claude back to bash and the pane outlived the session by 90
  // minutes, so the send typed into the SHELL, which executed it). A pane the
  // snapshot says is OWNED BY ANOTHER SESSION is rejected here; a pane with
  // no detected agent still resolves (agent detection lags a fresh launch by
  // 60-150s), and deliver()'s shell-prompt refusal is what catches the
  // crashed-to-bash case. Provisional pane-keyed ids skip the ownership test:
  // the pane IS their identity.
  //
  // A SEND THAT NAMES ONLY A SESSION FINDS THAT SESSION'S LIVE PANE (2026-11-15,
  // Pat: "what caused a second vox session?"). Every caller used to bring the
  // pane (the window's, or a link this process recorded), and a send with
  // neither went straight to resume. That was right for the renderer and wrong
  // for everyone else: the phone server is its own process with its own links,
  // and a session messaging another by id carries no pane at all. Vox sat idle
  // in pane e08b9799, a peer sent it a note by session id through the phone
  // server, and the resume opened a SECOND claude on the same conversation in
  // pane 19c7be11 that ran for 45 minutes. The daemon's own list says which
  // live pane holds the session, so it is asked before any resume. A Codex
  // pane counts only while its title still shows this thread.
  const livePaneHolding = (sessionId, panes, excludePaneId) => {
    if (/^(pane|live):/.test(String(sessionId))) return null;
    const wanted = String(sessionId).toLowerCase();
    const holding = (panes || []).filter((p) => (
      p.pane_id !== excludePaneId && !p.exited
      && p.agent_session?.kind === 'id' && String(p.agent_session.value || '').toLowerCase() === wanted
      && (!p.codex_title?.prefix || wanted.startsWith(String(p.codex_title.prefix).toLowerCase()))
    ));
    holding.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    return holding[0] || null;
  };

  const resolvePane = async (sessionId, modelPane) => {
    // Queued payloads preserve the renderer's pane as it existed when Enter
    // was pressed. A resume completed by an earlier queue item updates this
    // registry, so that link is newer than the captured payload and must win.
    const offered = links.get(sessionId) || (modelPane?.paneId ? modelPane : null);
    let panes;
    try {
      panes = (await snapshot()).panes || [];
    } catch {
      return offered; // daemon hiccup; the send path will surface a real failure
    }
    if (offered) {
      const pane = panes.find((p) => p.pane_id === offered.paneId) || null;
      if (pane && await paneServes(sessionId, offered, pane)) return offered;
      links.dropPane(offered.paneId);
    }
    const holding = livePaneHolding(sessionId, panes, offered?.paneId);
    if (!holding) return null;
    const found = { paneId: holding.pane_id, workspaceId: holding.workspace_id || null };
    if (!await paneServes(sessionId, found, holding)) return null;
    links.set(sessionId, found);
    return found;
  };

  // True when this live pane may take this session's message; false when the
  // snapshot says another session owns it. Throws when a Codex pane shows a
  // different chat or a child view, because typing there would be wrong and
  // resuming would be wrong too.
  const paneServes = async (sessionId, candidate, pane) => {
    // A raw-terminal child view or ephemeral /side chat is not the bound
    // root. Do not submit that root's message into a different composer.
    // Keep the link: returning to the root makes it usable again.
    const displayed = pane.codex_title?.prefix;
    const different = displayed && /^[0-9a-f-]{36}$/i.test(String(sessionId))
      && !String(sessionId).toLowerCase().startsWith(displayed);
    if (pane.agent === 'codex' && displayed && (different || /^(pane|live):/.test(String(sessionId)))) {
      const screen = await readScreen(candidate.paneId, CODEX_READ_LINES);
      const view = codexThreadView(screen);
      if (different || view) {
        if (!view) {
          void Promise.resolve().then(() => deps.recheckProviderTitle?.(candidate.paneId)).catch(() => {});
        }
        const instruction = view === 'side' ? 'Open the >_ terminal and press Ctrl+C to close the side chat.'
          : view === 'child' ? 'Open the >_ terminal, use /subagents and select Main.'
            : 'This terminal is showing another chat. Harbor is checking its link; send again after the window updates.';
        const error = new Error(`${instruction} Your text is kept.`);
        error.code = 'CODEX_THREAD_VIEW_CHANGED';
        throw error;
      }
    }
    if (/^(pane|live):/.test(String(sessionId))) return true;
    const owner = pane.agent_session?.kind === 'id' ? (pane.agent_session.value || null) : null;
    return !owner || owner === sessionId;
  };

  const debug = (...args) => {
    if (process.env.HARBOR_SEND_DEBUG === '1') console.log('[send-debug]', ...args);
  };

  // A provider is RESOLVED, never defaulted into. `deliver(..., provider =
  // 'claude')` and the renderer's `session.provider || 'claude'` meant a codex
  // pane whose provider had not resolved yet was driven down the claude path:
  // the claude composer guard, the claude readiness test, a claude resume, and
  // a "Claude" chip on a gpt-5.6-sol session (live-caught 2026-08-08). The
  // session's own metadata knows what it is; ask it before assuming.
  const resolveProvider = async (sessionId, supplied) => {
    if (supplied && supplied !== 'claude') return supplied;
    try {
      const meta = await getSessionMeta?.(sessionId);
      if (meta?.provider) return meta.provider;
    } catch { /* fall through to what the caller said */ }
    return supplied || 'claude';
  };

  const resumeNudgePlan = async (sessionId) => {
    if (typeof resolveTranscriptPath !== 'function') return { kind: 'nudge' };
    try {
      const transcriptPath = await resolveTranscriptPath(sessionId);
      if (!transcriptPath) return { kind: 'nudge' };
      return planResumeNudge(await readTranscriptTailRecords(transcriptPath));
    } catch {
      // Transcript lookup is best effort. An unreadable tail keeps the exact
      // historical bare-resume behavior instead of making every resume fail.
      return { kind: 'nudge' };
    }
  };

  const runSend = async ({ sessionId, text, images = [], pane, detectedHome, provider, resumeOnly = false, strictTarget = false }) => {
    // Before any pane lookup or resume (round seven: with the pane gone, the
    // no-pane branch resumed the cleared id, and the resume's own hook would
    // then have replaced the tombstone).
    if (strictTarget) assertNotCleared(sessionId);
    provider = await resolveProvider(sessionId, provider);
    // Codex has no /effort (both effort menus send it for every provider); its
    // /model takes --reasoning=<level> and keeps the current model (Codex
    // 0.165.0 chatwidget/model_command.rs). Typed as-is, Codex only answered
    // "Unrecognized command '/effort'".
    const codexEffort = provider === 'codex' ? /^\/effort\s+([\w-]+)\s*$/i.exec(String(text ?? '').trim()) : null;
    let trimmed = codexEffort ? `/model --reasoning=${codexEffort[1].toLowerCase()}` : String(text ?? '').replace(/\r\n/g, '\n').trim();
    // CLAUDE STRIPS INVISIBLE CHARACTERS, SO HARBOR SENDS WHAT CLAUDE WILL KEEP
    // (2026-11-21). Claude 2.1.321 removes zero-width spaces, soft hyphens,
    // direction marks and their kin from a prompt before submitting it, and
    // when what it removed includes a direction mark, or the cleaned text starts
    // with "/" or "!", it does not submit at all ("review and press Enter to
    // send"). The cleaned text is THE message from here on, typed, matched and
    // confirmed as one, exactly as the Codex normalization below does it.
    if ((provider || 'claude') === 'claude' && trimmed) {
      const clean = stripInvisible(trimmed).trim();
      if (clean !== trimmed) {
        logSend({ sessionId, phase: 'claude-invisible-removed', removed: Array.from(trimmed).length - Array.from(clean).length });
        trimmed = clean;
      }
    }
    let imagePaths = Array.isArray(images) ? images.filter(Boolean) : [];
    if (!trimmed && imagePaths.length === 0 && !resumeOnly) throw new Error('nothing to send');
    // A GEMINI PICTURE IS A PATH LINE IN THE MESSAGE (agy attaches from the
    // clipboard only, and Harbor never writes Pat's clipboard): the words, with
    // the line, are THE message from here on, typed, matched in the box and
    // confirmed in the transcript as one text. Whether agy's own file tools
    // open the picture is not measured (REPORT-send.md).
    if (provider === 'gemini' && imagePaths.length) {
      for (const imagePath of imagePaths) {
        if (!(await imageFileReady(imagePath))) throw imageMissingError();
      }
      const named = imagePaths.map((imagePath) => (/\s/.test(imagePath) ? `"${imagePath}"` : imagePath));
      trimmed = `${named.length === 1 ? 'Image:' : 'Images:'} ${named.join(' ')}${trimmed ? `\n${trimmed}` : ''}`;
      imagePaths = [];
    }
    // A Claude send carrying a picture is a message (see deliver's typedAsSlash).
    const slash = isSlashCommand(trimmed) && !((provider || 'claude') === 'claude' && imagePaths.length);
    // CODEX ON WINDOWS DROPS SMART PUNCTUATION AND SYMBOLS (codexSafeText), so
    // a phone's "didn’t…" never matched the box and was never sent (Pat,
    // 2026-11-01). The ASCII version is THE message from here on: typed,
    // matched in the box, and confirmed in the transcript, all as one text
    // (confirming the original instead reported a delivered send as failed;
    // Astra's round-2 review). A removal that would turn the message into a
    // Codex command ("✓/exit" -> "/exit") or into nothing sends nothing.
    if (provider === 'gemini' && slash) {
      const persisting = GEMINI_PERSISTING_COMMAND_RE.exec(trimmed);
      if (persisting) throw geminiCommandRefusedError(`/${persisting[1].toLowerCase()}`);
    }
    const target = await resolvePane(sessionId, pane);
    let normalizedNote = null;
    let exactDraftOnly = false;
    if (provider === 'codex' && platform === 'win32' && trimmed && !slash) {
      const safe = codexSafeText(trimmed);
      // Native continuation drafts can contain punctuation which keyboard
      // input would lose. If that exact text is already drawn, Enter submits
      // it as-is; normalizing it would make our own exact-match guard refuse.
      if (safe.text !== trimmed) exactDraftOnly = Boolean(!imagePaths.length && target && ownsCodexBox(target.paneId, await readScreen(target.paneId, CODEX_READ_LINES), { text: trimmed }));
      if (safe.text !== trimmed && !exactDraftOnly) {
        const wire = safe.text.trim();
        const shown = safe.dropped.length ? [...new Set(safe.dropped)].join(' ') : '';
        if (!wire || isSlashCommand(wire)) {
          const error = new Error(`Codex cannot show ${shown || 'some of these characters'}, and without ${safe.dropped.length === 1 ? 'it' : 'them'} your message would ${wire ? `start with "/" and run as a Codex command` : 'be empty'}, so Harbor sent nothing. Your text is kept`);
          error.code = 'CODEX_TEXT_UNSENDABLE';
          throw error;
        }
        logSend({ sessionId, phase: 'codex-text-normalized', dropped: shown || null, mapped: safe.mapped.map(([from, to]) => `${from}>${to}`).join(' ') || null });
        // Every change is said, not only what was dropped: a twin can matter
        // in a path or a quoted value (Astra's round 3).
        normalizedNote = codexChangeNote(safe);
        trimmed = wire;
      }
    }
    const waitNotice = (detail) => status(sessionId, 'sending', detail);
    // A Claude send with pictures and no words has no transcript check (that
    // needs text), so the Enter watch is its only evidence (Sol's review,
    // round twenty-six: one Claude never took, its picture still in the
    // prompt, was reported delivered). Null for every other send.
    // The chips Claude's prompt showed when this send was verified (deliver).
    let verifiedChips = null;
    const onVerified = ({ chips }) => { verifiedChips = chips; };
    const claudePictureOutcome = (enterState) => {
      if (provider !== 'claude' || trimmed || !imagePaths.length || slash) return null;
      if (enterState === 'not-taken') throw pictureNotTakenError();
      return enterState === 'taken' ? 'delivered' : 'unconfirmed';
    };
    debug('resolved target', JSON.stringify(target), 'link was', JSON.stringify(links.get(sessionId)));
    logSend({
      sessionId,
      phase: 'resolve',
      paneId: target?.paneId || null,
      offered: pane?.paneId || null,
      linked: links.get(sessionId)?.paneId || null,
      chars: trimmed.length,
      images: imagePaths.length,
    });
    if (target) {
      if (resumeOnly) {
        // Resume must PROVE the pane still holds a live CLI before reporting
        // success. A pane whose claude exited survives at a shell prompt with
        // no agent_session, which resolvePane accepts (agent detection lags
        // 60-150s, so an unnamed pane cannot be rejected outright), and the
        // resume then returned ok having done nothing at all: the button
        // looked dead because it WAS dead (Pat, 2026-07-25: "the resume
        // functionality doesn't even work"). A dead shell falls through to a
        // real resume, exactly like the deliver path does.
        let paneAlive = true;
        try {
          await assertNotDeadShell(target.paneId);
        } catch (error) {
          if (error?.code !== 'DEAD_SHELL' || String(sessionId).startsWith('pane:')) throw error;
          paneAlive = false;
          links.dropPane(target.paneId);
        }
        if (paneAlive) {
          status(sessionId, 'sent', 'this session is already live in its pane');
          return { ok: true, paneId: target.paneId, alreadyLive: true };
        }
      } else {
        status(sessionId, 'sending');
        // Capture the transcript boundary before typing. Leaving this promise
        // unresolved lets a fast enqueue land before stat(), hiding the accepted
        // message inside preSize and guaranteeing a false timeout.
        const confirmation = trimmed ? await prepareDeliveryConfirmation(sessionId) : null;
        try {
          const verifyTarget = () => verifyPaneServes(sessionId, target, { strict: strictTarget });
          const enterState = await deliver(target.paneId, target.workspaceId, trimmed, imagePaths, provider, { onWait: waitNotice, exactDraftOnly, verifyTarget, onVerified, sessionId });
          const pictureOnly = claudePictureOutcome(enterState);
          if (pictureOnly) {
            status(sessionId, 'sent', pictureOnly === 'unconfirmed' ? PICTURE_UNCONFIRMED_NOTE : undefined);
            return { ok: true, paneId: target.paneId, delivery: pictureOnly };
          }
          if ((provider === 'codex' || provider === 'gemini') && !slash && (trimmed || imagePaths.length) && enterState === 'unconfirmed') {
            if (!trimmed || !confirmation || confirmation.skip) throw provider === 'gemini' ? geminiUnconfirmedError() : codexUnconfirmedError();
            status(sessionId, 'sending', `checking that ${provider === 'gemini' ? 'Gemini' : 'Codex'} took it`);
            // Only while this send still owns the status: a newer send's
            // outcome is never overwritten by this one's late answer.
            const checkingSeq = statusSeq.get(sessionId);
            reconcileDelivery(sessionId, trimmed, slash, confirmation, () => {
              if (statusSeq.get(sessionId) === checkingSeq) status(sessionId, 'sent', normalizedNote || undefined);
            }, checkingSeq, imagePaths.length, { paths: imagePaths });
            return { ok: true, paneId: target.paneId, delivery: 'confirming' };
          }
          status(sessionId, 'sent', (provider === 'gemini' && enterState === 'queued' ? GEMINI_QUEUED_NOTE : normalizedNote) || undefined);
          // Its own status only (Sol's review, round thirty-five: an older send's
          // late "could not confirm" overwrote a newer send's "sent").
          if (trimmed) reconcileDelivery(sessionId, trimmed, slash, confirmation, null, statusSeq.get(sessionId), imagePaths.length, { chips: verifiedChips, paths: imagePaths });
          return { ok: true, paneId: target.paneId, delivery: trimmed ? 'confirming' : 'delivered' };
        } catch (error) {
          // A pane at a dead shell prompt is a dead SESSION holding a leftover
          // pty (the CLI crashed or quit): the message must not be lost, so
          // fall through to resume-then-send. A provisional pane-keyed id has
          // no resumable identity; for it the honest refusal stands.
          if (error?.code !== 'DEAD_SHELL' || String(sessionId).startsWith('pane:')) throw error;
          links.dropPane(target.paneId);
        }
      }
    }

    // AN AGENT'S MESSAGE NEVER REOPENS A SESSION (Sol's review, round ten).
    // A strict send needs a live pane; with none, it is refused and nothing
    // is launched. Every resume path had a last instant (the launcher's own
    // ownership probe) in which a /clear could land and the resumed session's
    // hook could then replace the mark; with no resume there is no instant.
    // Pat's own sends still resume.
    if (strictTarget) {
      logSend({ sessionId, phase: 'strict-no-pane' });
      const error = new Error('That session has no open window, and a message from another session never reopens it, so nothing was sent');
      error.code = 'NO_LIVE_PANE';
      throw error;
    }
    // No pane: resume first, then deliver into the fresh pane. Codex/cursor
    // resume rides bin/ai (codex resume <id> / cursor-agent --resume <id>);
    // claude rides bin/claude-sessions. Never fire a claude resume at a
    // foreign id: a cursor session whose cwd could not be recovered (its
    // transcripts never record one) refuses honestly instead.
    if (provider && provider !== 'claude') {
      const providerMeta = await getSessionMeta(sessionId).catch(() => null);
      if (!providerMeta?.cwd || typeof launchActions.resumeProviderSession !== 'function') {
        throw new Error(`this ${providerLabel(provider)} session is not running in a pane and its working folder is unknown; cannot resume it`);
      }
      status(sessionId, 'resuming');
      // One resume launch at a time across Harbor processes (round four): the
      // new pane after this launch is then this launch's, never a pane another
      // resume in the same project opened meanwhile.
      const providerFresh = await withResumeLaunch(async () => {
        const providerPreIds = await paneIdSet();
        await launchActions.resumeProviderSession({
          provider,
          cwd: providerMeta.cwd,
          id: sessionId,
          ...(providerMeta.profileId ? { profileId: providerMeta.profileId } : {}),
          ...(providerMeta.configHome ? { configHome: providerMeta.configHome } : {}),
        });
        return findFreshPane({ preIds: providerPreIds, cwd: providerMeta.cwd, sessionId });
      });
      if (!providerFresh) throw new Error(`resumed the ${providerLabel(provider)} session, but the new pane never appeared`);
      links.set(sessionId, providerFresh);
      await terminalBridge.requestFocusPane({
        paneId: providerFresh.paneId,
        workspaceId: providerFresh.workspaceId,
      }).catch(() => {});
      status(sessionId, 'waiting');
      // The same boot budget as a first send: a resumed cursor pane is blank
      // while its MCP servers start. A drawn pane keeps its 45 s.
      const providerReady = await waitForProviderReady(providerFresh.paneId, { timeoutMs: 45_000, blankTimeoutMs: 90_000 });
      if (!providerReady) throw new Error(`${providerLabel(provider)} resumed, but its composer never settled; message NOT sent. Your text is kept`);
      if (resumeOnly) {
        if (provider === 'codex' && codexReadOnlyNotice(await readScreen(providerFresh.paneId, MENU_READ_LINES))) {
          status(sessionId, 'sent', 'codex session resumed and needs your answer in its window');
          return { ok: true, paneId: providerFresh.paneId, resumed: true };
        }
        status(sessionId, 'sent', `${providerLabel(provider)} session resumed and ready`);
        return { ok: true, paneId: providerFresh.paneId, resumed: true };
      }
      status(sessionId, 'sending');
      const freshEnter = await deliver(providerFresh.paneId, providerFresh.workspaceId, trimmed, imagePaths, provider, { onWait: waitNotice, exactDraftOnly, verifyTarget: () => verifyPaneServes(sessionId, providerFresh), sessionId });
      if ((provider === 'codex' || provider === 'gemini') && !slash && (trimmed || imagePaths.length) && freshEnter === 'unconfirmed') throw provider === 'gemini' ? geminiUnconfirmedError() : codexUnconfirmedError();
      status(sessionId, 'sent', normalizedNote || undefined);
      return { ok: true, paneId: providerFresh.paneId, resumed: true, delivery: 'delivered' };
    }
    const resumePlan = await resumeNudgePlan(sessionId);
    logSend({ sessionId, phase: 'resume-plan', detail: resumePlan.kind });
    if (resumePlan.kind === 'refuse') throw new Error(resumePlan.text);
    status(sessionId, 'resuming');
    const meta = await getSessionMeta(sessionId).catch(() => null);
    const fresh = await withResumeLaunch(async () => {
      const preIds = await paneIdSet();
      await launchActions.resumeSession({
        id: sessionId,
        detectedHome,
        resumePrompt: resumePlan.kind === 'redeliver' ? resumePlan.text : null,
      });
      return findFreshPane({ preIds, cwd: meta?.cwd || null, sessionId });
    });
    if (!fresh) throw new Error('resumed, but the new pane never appeared');
    links.set(sessionId, fresh);
    await terminalBridge.requestFocusPane({
      paneId: fresh.paneId,
      workspaceId: fresh.workspaceId,
    }).catch(() => {});
    status(sessionId, 'waiting');
    const ready = await waitForResumedClaudeReady(fresh.paneId, fresh.workspaceId);
    if (!ready) throw new Error('session resumed, but Claude never came up; message NOT sent');
    if (resumeOnly) {
      const redelivered = resumePlan.kind === 'redeliver';
      status(sessionId, 'sent', redelivered
        ? 'session resumed and unanswered message re-delivered'
        : 'session resumed and ready');
      return { ok: true, paneId: fresh.paneId, resumed: true, redelivered };
    }
    status(sessionId, 'sending');
    const confirmation = trimmed ? await prepareDeliveryConfirmation(sessionId) : null;
    const freshState = await deliver(fresh.paneId, fresh.workspaceId, trimmed, imagePaths, provider, { onWait: waitNotice, verifyTarget: () => verifyPaneServes(sessionId, fresh), onVerified });
    const freshPicture = claudePictureOutcome(freshState);
    if (freshPicture) {
      status(sessionId, 'sent', freshPicture === 'unconfirmed' ? PICTURE_UNCONFIRMED_NOTE : undefined);
      return { ok: true, paneId: fresh.paneId, resumed: true, delivery: freshPicture };
    }
    status(sessionId, 'sent');
    if (trimmed) reconcileDelivery(sessionId, trimmed, slash, confirmation, null, statusSeq.get(sessionId), imagePaths.length, { chips: verifiedChips, paths: imagePaths });
    return { ok: true, paneId: fresh.paneId, resumed: true, delivery: trimmed ? 'confirming' : 'delivered' };
  };

  // Confirmation is deliberately detached from the user-visible send. A pty
  // write makes the message appear sent immediately; transcript reconciliation
  // can still replace that optimism with an honest error if delivery failed.
  const reconcileDelivery = (sessionId, text, optional, confirmation, onConfirmed = null, guardSeq = null, images = 0, { chips = null, paths = null } = {}) => {
    Promise.resolve(confirmation).then((prepared) => (
      confirmDelivery(sessionId, text, { optional, prepared, images, chips, paths })
    )).then((confirmed) => {
      if (confirmed && onConfirmed) onConfirmed();
    }).catch((error) => {
      if (guardSeq != null && statusSeq.get(sessionId) !== guardSeq) return; // superseded
      status(sessionId, 'error', error.message);
      if (error?.code === 'UNCONFIRMED' && error.lateWatch?.scan) {
        watchLateDelivery(sessionId, error.lateWatch.scan, statusSeq.get(sessionId)).catch(() => {});
      }
    });
  };

  const drain = async (sessionId) => {
    if (inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    try {
      while ((queues.get(sessionId) || []).length) {
        const queue = queues.get(sessionId);
        const item = queue[0];
        item.status = 'sending';
        try {
          item.resolve(await runSend(item.payload));
        } catch (error) {
          status(sessionId, 'error', error.message);
          item.reject(error);
        } finally {
          queue.shift();
          if (queue.length === 0) queues.delete(sessionId);
        }
      }
    } finally {
      inFlight.delete(sessionId);
      if ((queues.get(sessionId) || []).length) drain(sessionId);
    }
  };

  // send(): enqueue every payload, then let one per-session drain preserve FIFO.
  const planMoves = new Set();
  const send = (payload) => {
    const { sessionId, text, images = [], pane, resumeOnly = false } = payload;
    if (planMoves.has(sessionId)) return Promise.reject(new Error('This session is changing plans. Your draft is kept; send it when the change finishes.'));
    debug('send()', JSON.stringify({ sessionId, pane, resumeOnly, inFlight: inFlight.has(sessionId) }));
    const queue = queues.get(sessionId) || [];
    const item = {
      id: `send-${nextSendId++}`,
      status: 'queued',
      textPreview: textPreview(text, images),
      payload,
    };
    const promise = new Promise((resolve, reject) => {
      item.resolve = resolve;
      item.reject = reject;
    });
    queue.push(item);
    queues.set(sessionId, queue);
    if (inFlight.has(sessionId)) status(sessionId, 'queued');
    drain(sessionId);
    return promise;
  };

  const cancelQueued = (sessionId, sendId) => {
    const queue = queues.get(sessionId) || [];
    const index = queue.findIndex((item) => item.id === sendId);
    if (index < 0) return { ok: false, reason: 'queued message not found' };
    const item = queue[index];
    if (item.status !== 'queued') return { ok: false, reason: 'message is already sending' };
    queue.splice(index, 1);
    if (queue.length === 0) queues.delete(sessionId);
    item.resolve({ ok: true, cancelled: true, sendId });
    status(sessionId, 'cancelled', 'Queued message cancelled');
    return { ok: true, cancelledId: sendId };
  };

  // Public menu surface: the command bar polls getMenu for the selected pane and
  // renders it; answerMenu drives the selection. Both are no-ops without a pane.
  // `ask` is the session's live AskUserQuestion payload from its transcript,
  // supplied by the caller (index.js has the transcript provider). It carries
  // the question and every option in full, so a dialog whose top the pty
  // viewport clipped is still readable in the window; see ask-question.js.
  // Absent or unmatched, the card is exactly what the pane alone yielded.

  // Bounded: a notice chain is a handful of screens, and a cap means a screen
  // that keeps matching can never become an infinite keypress loop.

  // ---- batch discovery: the pty is the ONLY live source (2026-09-03) --------
  // Measured against Claude Code v2.1.258 in an isolated pty: while an
  // AskUserQuestion dialog is up, the transcript holds NOTHING from the
  // assistant turn. The thinking, text, tool_use and tool_result records all
  // land together, 2.5s after the answer; thirty seconds of polling the file
  // with the dialog on screen saw zero assistant records. So the 2026-07-27
  // transcript read (providers/pending-ask.js) cannot see a pending question
  // in this CLI, and a batch's other questions exist nowhere Harbor can read
  // except the dialog itself. This walks the dialog ONCE per batch: ← to the
  // first question, → through every question reading each screen whole (the
  // pane is 120x60, so each renders with its descriptions), and back to the
  // question the user was on. Each screen is verified by its own question and
  // option labels, never by counting keystrokes. The result is cached per pane
  // by the strip's labels, so a 700ms poll costs one read after the first, and
  // the review screen that follows the last question is labelled from the same
  // cache. The transcript path stays in front of this as an additive enhancement
  // for any CLI that does persist early.
  const DISCOVERY_HOP_MS = 140;
  const DISCOVERY_RETRY_MS = 10_000;
  const discoveries = new Map(); // paneId -> { key, promise, questions, failedAt }
  const questionTabs = (menu) => (menu?.tabs || []).filter((tab) => !tab.submit);
  const stripKey = (menu) => questionTabs(menu).map((tab) => tab.label).join('|');
  // Two screens show the same question when text, option labels AND shape
  // agree: a single-select and a multi-select with the same words are two
  // questions (review-caught 2026-09-03: the walk read the second as "the
  // screen did not change" and left the dialog on it).
  const optionLabels = (menu) => (menu?.options || [])
    .filter((o) => !o.isText)
    .map((o) => `${o.label}${o.checked === undefined ? '' : '[]'}`)
    .join('|');
  const sameQuestion = (a, b) => Boolean(a && b)
    && a.question === b.question
    && Boolean(a.multiSelect) === Boolean(b.multiSelect)
    && optionLabels(a) === optionLabels(b);

  // ONE writer per pane. holdControl is a blur lease, not a mutex, so a card
  // action arriving while a discovery walk was mid-hop typed into whatever
  // question the walk had reached (review-caught 2026-09-03). Every key-sending
  // path on a pane queues behind the one before it.
  const paneQueues = new Map();
  const serializeOnPane = (paneId, fn) => {
    const previous = paneQueues.get(paneId) || Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    paneQueues.set(paneId, run);
    run.catch(() => {}).then(() => { if (paneQueues.get(paneId) === run) paneQueues.delete(paneId); });
    return run;
  };

  // Hold both the session send exclusion and the pane mutex across exit/resume.
  // /exit is only legal at a freshly verified empty, idle Claude composer.
  const moveIdleSession = async ({ sessionId, pane }, move) => {
    if (planMoves.has(sessionId) || inFlight.has(sessionId) || getQueueState(sessionId).count) {
      throw new Error('Wait for pending messages before changing this session\'s plan.');
    }
    planMoves.add(sessionId);
    try {
      return await serializeOnPane(pane.paneId, async () => {
        const exit = async () => {
          await acquireControl(pane.paneId, pane.workspaceId);
          const screen = await readScreen(pane.paneId, MENU_READ_LINES);
          if (isFleetView(screen)) throw fleetViewError();
          if (!screen || classifyBlocked(screen) || isWorkingTurn(screen) || composerSendState(screen) === 'nobox') {
            throw new Error('The session is not at an idle composer. Nothing was stopped.');
          }
          const lines = screen.split('\n');
          const edges = lines.map((line, i) => isPromptEdgeLine(line) ? i : -1).filter(i => i >= 0);
          const box = lines.slice(edges.at(-2) + 1, edges.at(-1)).join('\n').replace(/^\s*❯/, '').trim();
          if (box) throw new Error('Clear or send the terminal draft before changing plans. Nothing was stopped.');
          await deliver(pane.paneId, pane.workspaceId, '/exit', [], 'claude');
        };
        terminalBridge.holdControl?.(pane.paneId);
        try { return await move(exit); }
        finally { terminalBridge.releaseControlHold?.(pane.paneId); }
      });
    } finally { planMoves.delete(sessionId); }
  };

  // Did the pane's screen move on after a keystroke that should end or advance
  // a dialog. The CLI needs a moment to redraw, so an unchanged first read gets
  // one more look before it counts as "did not register".
  // Everything a keystroke can change on a dialog screen: which question, the
  // pointer, and every checkbox (Enter on a multi-select option toggles it).
  const screenSignature = (menu) => JSON.stringify([
    menu.question,
    menu.multiSelect,
    menu.selectedIndex,
    menu.confirmSelected,
    (menu.options || []).map((o) => [o.index, o.label, o.checked ?? null, o.selected]),
  ]);
  const screenMovedOn = async (paneId, before) => {
    const was = screenSignature(before);
    await sleep(160);
    let after = await readMenu(paneId);
    if (!after || screenSignature(after) !== was) return true;
    await sleep(300);
    after = await readMenu(paneId);
    return !after || screenSignature(after) !== was;
  };
  const questionFromScreen = (menu, header) => ({
    header: header || '',
    question: menu.question || '',
    multiSelect: Boolean(menu.multiSelect),
    options: menu.options
      .filter((option) => !option.isText && !CHAT_ROW_RE.test(option.label || ''))
      .map((option) => ({ label: option.label, description: option.description || '', recommended: Boolean(option.recommended) })),
  });
  const discoveredFor = (paneId) => discoveries.get(paneId)?.questions || null;

  const discoverBatch = async (paneId, workspaceId, menu) => {
    const tabs = questionTabs(menu);
    const count = tabs.length;
    const key = stripKey(menu);
    const hit = discoveries.get(paneId);
    if (hit && hit.key === key) {
      // A walk that failed is not retried on every poll: two keystrokes into a
      // live dialog every 700ms is the opposite of a quiet card. One retry per
      // DISCOVERY_RETRY_MS is enough to heal a transient read.
      if (hit.failedAt && Date.now() - hit.failedAt < DISCOVERY_RETRY_MS) return null;
      if (!hit.failedAt) return hit.promise;
    }
    const entry = { key, questions: null, promise: null, failedAt: 0 };
    // Lock order, everywhere: this process's pane queue FIRST, then the
    // cross-process pane lock inside it (answerMenu does the same). The other
    // order deadlocks: a walk holding the lock waits for the queue while an
    // answer holding the queue waits for the lock.
    entry.promise = serializeOnPane(paneId, () => withPaneLock(paneId, async () => {
      terminalBridge.holdControl?.(paneId);
      try {
        await acquireControl(paneId, workspaceId);
        // A hop's read gets one retry: a transient empty read after a
        // successful → left `current` stale, the restore walked the wrong way
        // and a stale menu was returned (review-caught 2026-09-03).
        const hop = async (bytes) => {
          await typeInto(paneId, workspaceId, bytes);
          await sleep(DISCOVERY_HOP_MS);
          const read = await readMenu(paneId);
          if (read) return read;
          await sleep(DISCOVERY_HOP_MS);
          return readMenu(paneId);
        };
        // 1. Back to the first question: ← until the screen stops changing.
        let current = menu;
        for (let i = 0; i < count; i += 1) {
          const next = await hop(MENU_KEYS.left);
          if (!next || isReviewMenu(next)) return null;
          if (sameQuestion(next, current)) break;
          current = next;
        }
        // 2. Forward through the batch, one screen per question.
        const found = [questionFromScreen(current, tabs[0]?.label)];
        for (let i = 1; i < count; i += 1) {
          const next = await hop(MENU_KEYS.right);
          if (!next || isReviewMenu(next) || sameQuestion(next, current)) break;
          found.push(questionFromScreen(next, tabs[i]?.label));
          current = next;
        }
        // 3. Back to where the user was, verified by the screen itself.
        for (let i = 0; i <= count && !sameQuestion(current, menu); i += 1) {
          const next = await hop(MENU_KEYS.left);
          if (!next) break;
          current = next;
        }
        if (found.length !== count) return null;
        entry.questions = found;
        return found;
      } finally {
        terminalBridge.releaseControlHold?.(paneId);
      }
    }));
    discoveries.set(paneId, entry);
    entry.promise.catch(() => null).then((found) => { if (!found) entry.failedAt = Date.now(); });
    return entry.promise;
  };

  // `observe` is the poll of a window showing the raw terminal (>_). It only
  // answers "is a dialog up?", so the taskbar, rail and window header can say
  // the session is waiting on you (2026-10-14: a guard permission prompt sat
  // 24 minutes under a blue badge). The human is looking at the real terminal
  // there and may be typing into it, so an observing poll never sends a key or
  // resizes: no batch walk, no first-run Enter, no dialog sizing.
  const getMenu = (args) => pollReads.run({ reads: new Map(), gens: new Map(), sharing: true }, () => getMenuOnce(args));
  const getMenuOnce = async ({ pane, blockedHint, ask, observe = false } = {}) => {
    if (!pane?.paneId) return null;
    // Size the pane for dialogs the first time a window polls it, which is
    // within a second of the window opening and long before Claude asks
    // anything. This is the actual fix for the clipped-question family: a
    // 23-row pane cannot draw a 35-row dialog, and no amount of parsing
    // recovers rows the pane never held.
    if (!observe) terminalBridge?.ensureDialogSize?.(pane.paneId).catch?.(() => {});
    const menu = await readMenu(pane.paneId);
    // A dialog still coming back clipped means the pane is still small (the daemon
    // re-laid it out, or the first attempt was refused). Try again, because
    // Ink redraws on SIGWINCH: this heals a dialog that is already on screen.
    if (menu?.clipped && !observe) terminalBridge?.ensureDialogSize?.(pane.paneId, { force: true }).catch?.(() => {});
    // No dialog, or a dialog with no strip: whatever batch this pane had is
    // over, and its questions must not label the next one (review-caught
    // 2026-09-03: a later batch with the same headers came back with the old
    // question text).
    if (!menu || !questionTabs(menu).length) discoveries.delete(pane.paneId);
    if (!menu) return readFallback(pane, Boolean(blockedHint), { observe });
    let merged = ask ? mergeAsk(menu, ask) : menu;
    if (merged.asked) return merged;
    // The transcript had nothing (see discoverBatch): a batch is discovered by
    // walking the dialog once, and the cache labels the review screen too. The
    // cache is only trusted while the screen still belongs to it.
    const known = discoveredFor(pane.paneId);
    if (known && stripKey(menu) === discoveries.get(pane.paneId)?.key) {
      if (isReviewMenu(menu) || currentQuestionIndex(known, menu) >= 0) return mergeAsk(menu, known);
      discoveries.delete(pane.paneId);
    }
    const batch = questionTabs(menu).length > 1 && menu.keys?.switchQuestions && !menu.keys?.amend && !isReviewMenu(menu);
    if (!batch || observe) return merged;
    const found = await discoverBatch(pane.paneId, pane.workspaceId, menu).catch(() => null);
    // Re-read after the walk either way: the pointer, the current question,
    // and (after a failed walk) where the dialog actually is, are all fresh.
    const after = await readMenu(pane.paneId);
    if (!found) return after ? (ask ? mergeAsk(after, ask) : after) : merged;
    return mergeAsk(after || menu, found);
  };
  const answerMenuFor = async ({ pane, action, ask = null } = {}) => {
    if (!pane?.paneId) return { ok: false, reason: 'no live pane to answer the menu on' };
    // A sheet navigates by the question set the card was built from: the
    // transcript when it had one, else the batch discovered off the dialog.
    return answerMenu(pane.paneId, pane.workspaceId, action, ask || discoveredFor(pane.paneId));
  };

  // The command bar offers this on Tab. Null whenever the pane is not sitting
  // on an idle composer that shows one; a read failure is simply no suggestion.
  // The live meter off Claude's working line ("26s · ↓ 2.4k tokens"); null
  // when the pane is not mid-turn. See work-meter.js.
  const getWorkMeter = async ({ pane } = {}) => {
    if (!pane?.paneId) return null;
    try { return parseWorkMeter(await readPane(pane.paneId)); } catch { return null; }
  };

  // Claude also draws its own HINTS dim in an empty box, and those are not
  // predictions: while a message waits in its queue the box reads "Press up
  // to edit queued messages" (CLI 2.1.316, measured 2026-11-01), which the bar
  // offered as "⇥ Tab", and Tab would have typed that sentence in to be sent.
  // The send path still reads the hint as an empty box (dimSuggestion), which
  // is right there; only the Tab offer drops it.
  const getSuggestion = async ({ pane } = {}) => {
    if (!pane?.paneId) return null;
    try {
      const suggestion = (await readSuggestion(pane.paneId)) || null;
      return suggestion && CLAUDE_BOX_HINT_RE.test(suggestion.trim()) ? null : suggestion;
    } catch { return null; }
  };

  return {
    emitter,
    // The ADOPT path lives in actions/takeover.js and emits its own statuses, so
    // none of them reached the send log: when an adopt failed on 2026-07-28 the
    // only record anywhere was a truncated line in Pat's status bar. Adoption
    // kills and resumes a session before it delivers, which makes it the most
    // expensive way for a message not to land, and it now writes the same trace.
    logStatus: (payload) => logSend(payload),
    send,
    moveIdleSession,
    getMenu,
    getSuggestion,
    getWorkMeter,
    answerMenu: answerMenuFor,
    findFreshPane,
    findFreshTranscript,
    listTranscriptIds,
    waitForClaudeReady,
    waitForResumedClaudeReady,
    waitForProviderReady,
    paneIdSet,
    readPermissionMode,
    cyclePermissionMode,
    confirmNeedle,
    confirmDelivery, // exposed for the transcript-record specs
    prepareDeliveryConfirmation, // and the Gemini prompt-history specs
    getQueueState,
    cancelQueued,
  };
}

module.exports = {
  createSessionSend,
  geminiPasteFits,
  describeGeminiDraft,
  createLinkRegistry,
  claudeProjectDir,
  providerTranscriptDirs,
  composerSendState,
  codexBoxState,
  codexReadOnlyNotice,
  codexThreadView,
  codexWritableComposer,
  codexBoxMatch,
  codexBoxDraft,
  codexStartupEcho,
  geminiPromptBox,
  geminiDialogOwnsScreen,
  geminiBoxMatch,
  geminiBoxState,
  geminiBlockedKind,
  geminiSurveyShown,
  geminiQueuedShown,
  geminiHistoryPathFor,
  geminiUserRequest,
  geminiBrainDir,
  geminiWholeTranscriptPath,
  sameFolder,
  codexSafeText,
  codexChangeNote,
  codexAbsorbAllowanceMs,
  composerBox,
  isFleetView,
  slashGhostRests,
  slashGhostFollows,
};
