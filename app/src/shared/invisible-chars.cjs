'use strict';

// INVISIBLE CHARACTERS, THE WAY CLAUDE CODE TREATS THEM (2026-11-21, Pat:
// "the only message i had tried to send to that agent recently went through
// fine. what is causing that error to show?").
//
// Claude Code 2.1.321 runs every prompt, and every pasted block in it, through
// an invisible-character stripper before it submits (the bundled CLI's `VG`,
// reached through `ege`; telemetry `tengu_prompt_invisible_strip`; the notice
// "Removed N invisible characters from the pasted text"). The transcript and
// `paste-cache` then hold the CLEANED text. Text copied out of Teams carries
// such characters, so Harbor's delivery check compared its own uncleaned copy
// against Claude's cleaned record, never matched, and reported "could not
// confirm the message reached the session" for messages that had arrived in a
// third of a second (three to Vox on 2026-11-21, one to Harbor's own session).
// Worse, when a removed character is a direction mark, or the cleaned text
// starts with "/" or "!", Claude does NOT submit: it leaves the cleaned text in
// the box under "review and press Enter to send".
//
// `isHidden` is Claude's own predicate, transcribed from the 2.1.321 binary (its
// `k`). Two uses follow from it:
//   stripInvisible     what Harbor removes BEFORE typing into Claude and when
//                      text is pasted into the message box: everything Claude
//                      always removes. Characters Claude keeps in some contexts
//                      (joiners and variation selectors inside emoji, tag
//                      characters in a subdivision flag, a zero-width space
//                      between Thai or Khmer words, direction marks in Arabic
//                      or Hebrew text) are kept, so no emoji or script breaks.
//   dropAllInvisible   the comparison form: every hidden character dropped and
//                      every line separator made "\n". Applied to BOTH sides
//                      of a match, it is indifferent to whatever Claude decided
//                      about a context-dependent character.

const RTL_RE = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFC]|[\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
// Scripts written without spaces, where a zero-width space is a word break.
const NO_SPACE_SCRIPT_RE = /[\u0E00-\u0EFF\u0F00-\u0FFF\u1000-\u109F\u1780-\u17FF\u1950-\u19DF\u1A20-\u1AAF]/u;

function isHidden(cp) {
  if (cp < 160) return (cp < 32 && cp !== 9 && cp !== 10) || cp >= 127;
  if (cp < 8192) {
    return cp === 173 || cp === 847 || cp === 1564 || cp === 4447 || cp === 4448
      || cp === 6068 || cp === 6069 || (cp >= 6155 && cp <= 6159);
  }
  if (cp < 65536) {
    return (cp >= 8203 && cp <= 8207) || (cp >= 8232 && cp <= 8238) || (cp >= 8288 && cp <= 8303)
      || cp === 12644 || (cp >= 65024 && cp <= 65039) || cp === 65279 || cp === 65440
      || (cp >= 65520 && cp <= 65531);
  }
  return cp === 69759 || (cp >= 78896 && cp <= 78911) || cp === 94180 || (cp >= 113824 && cp <= 113827)
    || (cp >= 119155 && cp <= 119162) || (cp >= 917504 && cp <= 921599);
}

// Kept by stripInvisible because Claude keeps them where they mean something.
function isContextual(cp) {
  return cp === 0x200C || cp === 0x200D // joiners: emoji sequences, Indic and Arabic shaping
    || cp === 0x034F || cp === 0x17B4 || cp === 0x17B5
    || (cp >= 0x180B && cp <= 0x180F) // Mongolian variation selectors
    || (cp >= 0xFE00 && cp <= 0xFE0F) // variation selectors (emoji presentation)
    || cp === 0x1107F || (cp >= 0x13430 && cp <= 0x1343F) || (cp >= 0x1BCA0 && cp <= 0x1BCA3)
    || (cp >= 0xE0000 && cp <= 0xE0FFF); // tags (subdivision flags) and supplementary selectors
}

// Every line separator Claude turns into a newline: CRLF and a lone CR, VT, FF,
// NEL, LINE SEPARATOR, PARAGRAPH SEPARATOR.
const LINE_BREAK_RE = /\r\n?|[\v\f\u0085\u2028\u2029]/g;

function wellFormed(text) {
  return typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
}

function stripInvisible(value) {
  const text = wellFormed(String(value ?? '')).replace(LINE_BREAK_RE, '\n');
  if (!/[^\t\n\x20-\x7e]/.test(text)) return text;
  const rtl = RTL_RE.test(text);
  const chars = Array.from(text);
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    const cp = ch.codePointAt(0);
    if (!isHidden(cp) || isContextual(cp)) { out += ch; continue; }
    if ((cp === 0x200E || cp === 0x200F || cp === 0x061C) && rtl) { out += ch; continue; }
    if (cp === 0x200B && (NO_SPACE_SCRIPT_RE.test(chars[i - 1] || '') || NO_SPACE_SCRIPT_RE.test(chars[i + 1] || ''))) {
      out += ch;
      continue;
    }
  }
  return out;
}

function dropAllInvisible(value) {
  const text = wellFormed(String(value ?? '')).replace(LINE_BREAK_RE, '\n');
  if (!/[^\t\n\x20-\x7e]/.test(text)) return text;
  let out = '';
  for (const ch of text) if (!isHidden(ch.codePointAt(0))) out += ch;
  return out;
}

module.exports = { isHidden, stripInvisible, dropAllInvisible };
