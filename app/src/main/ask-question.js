'use strict';

// The AskUserQuestion payload, taken from the TRANSCRIPT and merged onto the
// pty menu that menu-parse.js reads off the screen.
//
// Why both. Live-caught 2026-07-27, Pat: "not even showing the actual question,
// fix." His window rendered a card whose only honest line was "the question text
// and option 1 scrolled out of the terminal view", because the pane buffer holds
// nothing but the visible screen: when a dialog's options carry long
// descriptions they overflow a 24-row viewport and the question scrolls off the
// top, unrecoverable by reading more lines. menu-parse.js was right to blank the
// question rather than invent one. It was looking in the wrong place.
//
// The transcript has had the whole thing the entire time. Claude's own tool call
// records it verbatim:
//
//   AskUserQuestion { questions: [ { question, header, multiSelect,
//                                   options: [ { label, description, preview } ] } ] }
//
// That is strictly better than any scrape: no clipping, no terminal wrapping to
// undo, no box-drawing glyphs to strip, and the per-option descriptions intact.
//
// So the two sources split by authority, and neither substitutes for the other:
//
//   transcript  WHAT WAS ASKED. Question text, option labels, descriptions,
//               multiSelect, and the batch's shape.
//   pty         THE LIVE INTERACTION. Whether the dialog is still up at all,
//               which row the "❯" sits on, the option NUMBERING the arrow walk
//               keys off, and which keys the footer actually offers.
//
// The pty stays the liveness authority on purpose. A card built from the
// transcript alone would happily render a question that was answered ten minutes
// ago and type arrow keys into a composer.

// Claude writes "(Recommended)" inside the label text; menu-parse lifts it into
// a flag, so this does too or the two sides would never compare equal.
const RECOMMENDED_RE = /\(\s*recommended\s*\)/i;

// Normalize a label down to something a wrapped, truncated, frame-stripped pty
// row can still be matched against: case-folded, ellipsis dropped, punctuation
// that terminals like to eat removed, whitespace collapsed.
function matchKey(text) {
  return String(text || '')
    .replace(RECOMMENDED_RE, '')
    .toLowerCase()
    .replace(/[…]/g, '')
    .replace(/\.{3,}/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function takeRecommended(label) {
  const text = String(label || '');
  if (!RECOMMENDED_RE.test(text)) return { label: text.trim(), recommended: false };
  return { label: text.replace(RECOMMENDED_RE, '').replace(/\s+/g, ' ').trim(), recommended: true };
}

// Flatten one AskUserQuestion tool_use input into the shape the card needs.
// Returns null for anything that is not a usable question set, so a malformed
// payload degrades to "no transcript help" rather than throwing inside a poll.
function normalizeAsk(input) {
  const questions = Array.isArray(input?.questions) ? input.questions : null;
  if (!questions || questions.length === 0) return null;
  const out = [];
  for (const raw of questions) {
    if (!raw || typeof raw !== 'object') continue;
    const question = typeof raw.question === 'string' ? raw.question.trim() : '';
    const options = (Array.isArray(raw.options) ? raw.options : [])
      .map((option) => {
        if (!option || typeof option !== 'object') return null;
        const { label, recommended } = takeRecommended(option.label);
        if (!label) return null;
        return {
          label,
          // Also honour a flag that is already lifted, which is what makes this
          // IDEMPOTENT: mergeAsk normalizes whatever it is handed, and a second
          // pass over an already-normalized option would otherwise decide it was
          // not recommended, since its label no longer carries the marker.
          recommended: recommended || Boolean(option.recommended),
          description: typeof option.description === 'string' ? option.description.trim() : '',
          preview: typeof option.preview === 'string' ? option.preview : '',
        };
      })
      .filter(Boolean);
    if (!question && options.length === 0) continue;
    out.push({
      question,
      header: typeof raw.header === 'string' ? raw.header.trim() : '',
      multiSelect: Boolean(raw.multiSelect),
      options,
    });
  }
  return out.length ? out : null;
}

// Which question in the batch is the one currently on screen. The tab strip
// cannot answer this: which tab is current is carried in COLOUR alone and does
// not survive ANSI stripping, which is why menu-parse never guesses it. But the
// options on screen belong to exactly one question, so matching them against
// each question's own options DERIVES it from structure.
//
// Returns the index, or -1 when the evidence is not decisive. Ambiguity means no
// answer: a card labelled with the wrong question is worse than one labelled
// with none.
//
// A match REQUIRES at least one option label in common, even when the payload
// holds a single question. Short-circuiting the single-question case looked
// harmless and was not: the transcript's newest unanswered AskUserQuestion is
// not necessarily the dialog currently on screen (a question can go unanswered
// while a permission prompt opens over it), and matching unconditionally pasted
// the wrong question onto it. Gate-caught by spec 6e, where a pane showing one
// dialog was labelled with a different session's live question.
// A truncated label is only evidence when what survives is distinctive. Gate
// caught the alternative on 2026-07-27: a permission prompt's "Yes" prefixed a
// real unanswered question's "Yes, ..." in the same session's transcript, one
// two-way prefix hit was enough, and the card confidently retitled "Do you want
// to proceed?" with a question about a kernel fault. Exact equality always
// counts; a prefix has to be long enough to mean something.
const MIN_PREFIX_KEY = 8;
function keysAgree(key, seen) {
  if (!key || !seen) return false;
  if (key === seen) return true;
  const shorter = key.length < seen.length ? key : seen;
  if (shorter.length < MIN_PREFIX_KEY) return false;
  return key.startsWith(seen) || seen.startsWith(key);
}

function matchQuestionIndex(questions, ptyOptions) {
  if (!Array.isArray(questions) || questions.length === 0) return -1;
  const visible = (ptyOptions || []).filter((option) => !option.isText && option.label);
  if (visible.length === 0) return -1;

  // EVERY visible row in the payload's own numbering range has to be one of
  // that question's options, not merely one of them somewhere. A dialog
  // numbers a question's options 1..N and then adds its own rows ("Type
  // something.", "Chat about this") after them, so a row inside 1..N that the
  // payload has never heard of means this is a different dialog and the pane
  // should be left to speak for itself. (Which SLOT a label sits in is checked
  // separately, by numberingHolds in mergeAsk: an odd numbering is a reason to
  // withdraw the derived offscreen row numbers, not a reason to withhold the
  // question text.)
  const scores = questions.map((question) => {
    const keys = question.options.map((option) => matchKey(option.label));
    let hits = 0;
    for (const option of visible) {
      const position = option.index - 1;
      if (position < 0 || position >= keys.length) continue; // one of the dialog's own extra rows
      const seen = matchKey(option.label);
      if (keys.some((key) => keysAgree(key, seen))) hits += 1;
      else return -1; // a row the payload does not have: not this question
    }
    return hits;
  });
  const best = Math.max(...scores);
  if (best <= 0) return -1;
  if (scores.filter((score) => score === best).length > 1) return -1; // ambiguous
  return scores.indexOf(best);
}

// Merge the transcript's question set onto a parsed pty menu.
//
// Additive by contract: every field the card already relied on keeps its pty
// value unless the transcript can state it BETTER, and a failed match returns
// the menu untouched. That is what makes this safe to put in a 700ms poll, and
// it means the worst case is exactly today's behaviour.
function mergeAsk(menu, ask) {
  if (!menu || !Array.isArray(menu.options)) return menu;
  // Normalize whatever shape arrives, rather than trusting an array to have been
  // normalized already. Gate-caught by spec 6f: a raw payload reached here with
  // "(Recommended)" still inside its label, so the badge never rendered.
  // A permission/hook confirmation is NOT an AskUserQuestion, and a session can
  // easily hold an unanswered question in its transcript while one of these is
  // on screen. Its footer says so ("Tab to amend · ctrl+e to explain"), so this
  // never has to be guessed. Gate-caught 2026-07-27: without it, "Do you want
  // to proceed? / Yes / No" was retitled with an unrelated live question.
  if (menu.keys?.amend || menu.keys?.explain) return menu;

  const questions = normalizeAsk(Array.isArray(ask) ? { questions: ask } : ask);
  if (!questions) return menu;

  const index = matchQuestionIndex(questions, menu.options);
  if (index < 0) return menu;
  const current = questions[index];

  // Options the pty can SEE, enriched with the description the scrape never had
  // (in a two-column dialog the description lives in a side panel; clipped off
  // the top it is simply gone).
  const byKey = new Map();
  for (const option of current.options) {
    const key = matchKey(option.label);
    if (key && !byKey.has(key)) byKey.set(key, option);
  }
  const lookup = (label) => {
    const seen = matchKey(label);
    if (!seen) return null;
    if (byKey.has(seen)) return byKey.get(seen);
    for (const [key, option] of byKey) {
      if (key.startsWith(seen) || seen.startsWith(key)) return option;
    }
    return null;
  };

  // Where each option sits in the payload, so the pty's numbering can be checked
  // against it rather than trusted.
  const positionByKey = new Map();
  current.options.forEach((option, i) => {
    const key = matchKey(option.label);
    if (key && !positionByKey.has(key)) positionByKey.set(key, i);
  });

  const matchedLabels = new Set();
  // Does the CLI really number a question's options 1..N in payload order? Every
  // visible match is evidence, so it is CONFIRMED rather than assumed; a single
  // disagreement withdraws the offscreen rows, whose numbers depend on it.
  let numberingHolds = true;
  const options = menu.options.map((option) => {
    const source = option.isText ? null : lookup(option.label);
    if (!source) return option;
    matchedLabels.add(matchKey(source.label));
    const position = positionByKey.get(matchKey(source.label));
    if (position != null && option.index !== position + 1) numberingHolds = false;
    return {
      ...option,
      // The transcript label is the untruncated one.
      label: source.label,
      description: source.description || option.description,
      preview: source.preview || '',
      recommended: option.recommended || source.recommended,
    };
  });

  // Options that exist in the question but are NOT on screen: the ones clipped
  // off the top. They are shown so Pat can read the whole question, and marked
  // offscreen because selection is only verifiable for a row the "❯" can be
  // seen on. Their number comes from payload order, which the visible matches
  // above have to corroborate first.
  const offscreen = [];
  if (menu.clipped && numberingHolds) {
    current.options.forEach((option, i) => {
      const key = matchKey(option.label);
      if (!key || matchedLabels.has(key)) return;
      const number = i + 1;
      if (options.some((existing) => existing.index === number)) return;
      offscreen.push({
        index: number,
        label: option.label,
        description: option.description,
        preview: option.preview,
        recommended: option.recommended,
        selected: false,
        isText: false,
        offscreen: true,
      });
    });
  }

  const merged = [...offscreen, ...options].sort((a, b) => a.index - b.index);

  return {
    ...menu,
    question: current.question || menu.question,
    questionSource: current.question ? 'transcript' : (menu.question ? 'pty' : 'none'),
    header: current.header || '',
    multiSelect: current.multiSelect,
    options: merged,
    // The batch, so the card can show real headers rather than the tab strip's
    // truncated ones, and can say which question is current now that it is known.
    batch: questions.length > 1
      ? {
        count: questions.length,
        currentIndex: index,
        headers: questions.map((question, i) => ({
          header: question.header || `Question ${i + 1}`,
          current: i === index,
        })),
      }
      : null,
    // The honesty note ("the question and option 1 scrolled out of view") is
    // what `clipped` drives, so it must go quiet once the reader is no longer
    // missing anything, even though the pty VIEW is still clipped. It stays on
    // only if the transcript filled in neither the question nor the lost rows.
    clipped: Boolean(menu.clipped) && !current.question && offscreen.length === 0,
    ptyClipped: Boolean(menu.clipped),
  };
}

module.exports = { normalizeAsk, mergeAsk, matchQuestionIndex, matchKey };
