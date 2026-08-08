'use strict';

// Parse Claude Code's interactive SELECT MENU out of an ANSI-stripped pane
// scrape so the command bar can render and answer it without dropping to the
// raw terminal. The menu is a pty-only construct (it never reaches the
// transcript), identified by the footer Claude draws: "Enter to select …
// ↑/↓ to navigate … Esc to cancel". Ink renders the highlighted row with a
// "❯ " pointer, which survives ANSI stripping and tells us the current
// selection.
//
// The dialog is a LAYOUT, not a list of lines (live-caught 2026-07-26, the
// card Pat screenshotted): AskUserQuestion draws a tab strip for a batch of
// questions, wraps option labels, carries a per-option description, and in a
// wide pane parks that description in a SECOND COLUMN to the right of the
// options. Reading the raw lines therefore produced labels with the neighbour
// column's box-drawing glued on ("Custom segment +   ┌────────┐") and a
// question that was three lines of scrollback prose plus the tab strip. Every
// piece of that structure is parsed here so the card can render the same
// information the terminal shows.

const MENU_KEYS = Object.freeze({
  down: '\x1b[B',
  up: '\x1b[A',
  enter: '\r',
  cancel: '\x1b',
});

// The footer is the reliable question signature; the composer never shows it.
// Two families exist (both live-captured): the AskUserQuestion select menu
// ("Enter to select · Tab/Arrow keys to navigate · Esc to cancel") and the
// permission/hook confirmation ("Esc to cancel · Tab to amend · ctrl+e to
// explain"). Both draw numbered options with an Ink "❯" pointer.
const FOOTER_RE = /Enter to select|Enter to confirm|(?:Tab\/Arrow|↑\/↓|Arrow keys)[^\n]*navigat|Esc to cancel|Tab to amend|ctrl\+e to explain/i;
const RESUME_SENTINEL_RE = /Resuming the full session will consume|Resume from summary/i;
// An option row: optional indent, optional "❯" pointer (selected), then "N. label".
const OPTION_RE = /^\s*(❯)?\s*(\d+)\.\s+(.+?)\s*$/;
// A free-text option ("Type something…") opens an inline text field; a plain
// pick like "Chat about this" does not (selecting it just switches the pane to
// a composer the command bar can then drive).
const TEXT_OPTION_RE = /^(type something|type your|type a|write|enter )/i;

const DIVIDER_RE = /^[─—_-]{3,}$/;
// Box drawing belongs to the dialog frame and the side panel, never to text.
const BOX_CHARS = '─│┌┐└┘├┤┬┴┼╭╮╰╯━┃┏┓┗┛┣┫';
const BOX_RE = new RegExp(`[${BOX_CHARS}]`);
// Safety net for a two-column layout whose gutter we failed to find: a tail of
// pure frame glyphs after a wide gap is never part of a label.
const TRAILING_BOX_RE = new RegExp(`\\s{2,}[${BOX_CHARS}][\\s${BOX_CHARS}]*$`);
// The AskUserQuestion tab strip for a BATCH of questions:
// "←  ☐ Control  ☐ Chart win…  ☐ Period ti…  ✔ Submit  →". Which tab is
// active is carried in colour alone, so it does not survive ANSI stripping and
// is never guessed here.
const TAB_GLYPHS = '☐☑✔✓⬜⬚';
const TAB_SPLIT_RE = new RegExp(`(?=[${TAB_GLYPHS}])`);
const TAB_GLYPH_RE = new RegExp(`[${TAB_GLYPHS}]`);
const TAB_DONE_RE = /[☑✔✓]/;
// A standalone "(Recommended)" is Claude's own emphasis; the card renders it
// as a badge instead of leaving it in the middle of the label. "(Not
// recommended)" deliberately does not match and stays in the text.
const RECOMMENDED_RE = /\(\s*recommended\s*\)/i;
// A multi-select row's own state marker, drawn at the head of the label.
const CHECKBOX_RE = /^\[\s*([xX✓✔•*]?)\s*\]\s*/;
const CHECKED_RE = /[xX✓✔•*]/;

const isDivider = (line) => DIVIDER_RE.test(String(line).trim());

// A SINGLE-question dialog still draws a tab strip, just a one-tab one:
// "☐ PDF Generation". It has no ←/→ pager and no Submit tab, so parseTabStrip
// rightly refuses to call it a strip, and it used to fall straight into the
// question instead: "☐ PDF Generation Where should the per-office PDFs get
// generated each quarter?" (real Claude capture, 2026-07-27,
// test/fixtures/askuserquestion/real-claude-120x60.txt).
//
// Deliberately narrow. It matches ONE EMPTY checkbox opening a short line, so
// a permission prompt's reason lines ("✔ lint clean  ✔ types clean") are
// untouched: those are check MARKS, they come in pairs, and losing a reason
// line silently is a worse failure than a stray label in the question.
const LONE_TAB_RE = /^[☐⬜⬚]\s*\S/;
const isLoneTab = (line) => LONE_TAB_RE.test(line)
  && line.length <= 60
  && (line.match(new RegExp(`[${TAB_GLYPHS}]`, 'g')) || []).length === 1;

// Strip the dialog's own frame, then collapse the runs of spaces a column
// layout leaves behind. Box drawing is chrome: an option's text never
// contains it, so any that reaches here belongs to a neighbouring panel and
// showing it would look exactly like the bug this replaced.
const BOX_RUN_RE = new RegExp(`[${BOX_CHARS}]+`, 'g');
const cleanText = (text) => String(text)
  .replace(TRAILING_BOX_RE, '')
  .replace(BOX_RUN_RE, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Split the strip into its tabs. Returns null unless the line carries at
// least two tabs AND the strip's own chrome (the ←/→ pager, or the Submit
// tab): prose that happens to contain check marks must never be eaten as a
// tab strip, because the question is what would silently go missing.
function parseTabStrip(line) {
  if (!TAB_GLYPH_RE.test(line)) return null;
  if (!/[←→]/.test(line) && !/submit/i.test(line)) return null;
  const tabs = [];
  for (const segment of String(line).split(TAB_SPLIT_RE)) {
    if (!TAB_GLYPH_RE.test(segment[0] || '')) continue;
    const label = cleanText(segment.slice(1).replace(/[←→]/g, ''));
    if (!label) continue;
    // The Submit tab's own icon is a check mark; that is its glyph, not an
    // answered question, and reading it as one would claim work Pat has not
    // done yet.
    const submit = /^submit$/i.test(label);
    tabs.push({ label, done: !submit && TAB_DONE_RE.test(segment[0]), submit });
  }
  return tabs.length >= 2 ? tabs : null;
}

// Find the column where a two-column dialog's right-hand description panel
// starts, or 0 when the dialog is a single column. A gutter is a column that
// EVERY row either stops short of (by at least two spaces, so cutting there
// cannot clip a label) or has real content past, and the content past it must
// include frame glyphs: the panel is drawn in a box, ordinary indented
// description lines are not, so a single-column menu can never match.
function findGutter(rows) {
  if (rows.length < 2) return 0;
  const candidates = new Set();
  for (const row of rows) {
    // Start past the widest "  ❯ 12. " prefix; a gutter never sits inside it.
    for (let i = 8; i < row.length; i += 1) {
      if (row[i] !== ' ' && row[i - 1] === ' ' && row[i - 2] === ' ') candidates.add(i);
    }
  }
  for (const gutter of [...candidates].sort((a, b) => a - b)) {
    let panelSeen = false;
    let framed = false;
    let ok = true;
    for (const row of rows) {
      const right = row.slice(gutter);
      // Nothing to the right: cutting at the gutter cannot lose anything.
      if (!right.trim()) continue;
      // Content on both sides, so the gap between them must be a real gutter
      // and not the middle of a word.
      if (!(row[gutter - 2] === ' ' && row[gutter - 1] === ' ')) { ok = false; break; }
      panelSeen = true;
      if (BOX_RE.test(right)) framed = true;
    }
    if (ok && panelSeen && framed) return gutter;
  }
  return 0;
}

// Rejoin the lines the terminal wrapped. A fragment that starts hard against
// column 0 while the line above filled the pane is a MID-WORD wrap (the
// terminal broke "(which" into "(w" + "hich"), so it joins with no space; a
// fragment the CLI indented itself, or one whose predecessor stopped short of
// the edge, lost a space at the break and joins with one.
function joinWrapped(parts, wrapWidth) {
  if (parts.length === 0) return '';
  let out = parts[0].text;
  for (let i = 1; i < parts.length; i += 1) {
    const midWord = parts[i].indent === 0 && parts[i - 1].lineLength >= wrapWidth;
    out += midWord ? parts[i].text : ` ${parts[i].text}`;
  }
  return out;
}

function takeRecommended(text) {
  if (!RECOMMENDED_RE.test(text)) return { text, recommended: false };
  return { text: cleanText(text.replace(RECOMMENDED_RE, '')), recommended: true };
}

// Returns null when the screen is not a select menu, else a structured menu.
function parseMenu(screen) {
  const lines = String(screen || '').split('\n');

  // The live dialog sits at the BOTTOM of the screen. Take the last footer
  // match, then decide whether what follows means the dialog is stale: an
  // answered menu's final frame lingering above a fresh COMPOSER must never
  // read as a live question (a ghost card would type arrows into a composer),
  // but content below the footer is not automatically staleness. The CLI
  // draws messages queued while blocked as an echo UNDER the dialog
  // (live-caught 2026-07-20), so only composer chrome counts as ghost: a lone
  // "❯" prompt line, a horizontal rule, or the esc-to-interrupt hint.
  let footerIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (FOOTER_RE.test(lines[i])) { footerIndex = i; break; }
  }
  const resumeSentinelLine = lines.findIndex((line) => RESUME_SENTINEL_RE.test(line));
  const resumeDialog = footerIndex < 0 && resumeSentinelLine >= 0;
  if (footerIndex < 0 && !resumeDialog) return null;
  if (resumeDialog) footerIndex = lines.length;
  const trailing = lines.slice(footerIndex + 1);
  const composerBelow = trailing.some((line) => /^\s*❯\s*$/.test(line)
    || /^\s*[─]{3,}\s*$/.test(line)
    || /esc to interrupt/i.test(line));
  if (composerBelow) return null;

  // A multi-select question ("Space to toggle") answers by TOGGLING rows and
  // then confirming, not by landing on one and pressing Enter. It used to get no
  // card at all, which dropped it to the raw-screen fallback panel: answerable,
  // but a shape reported as unusable (2026-07-27). It is parsed
  // now, and every part of the interaction is verifiable, because a multi-select
  // row draws its own state as a checkbox this reads back.
  const footerZone = lines.slice(Math.max(0, footerIndex - 1), footerIndex + 3).join('\n');
  const multiSelect = /space to (toggle|select)/i.test(footerZone);

  // A narrow pane wraps the footer across lines and every fragment matches
  // FOOTER_RE (gate-caught 2026-07-21), so the footer is a contiguous BLOCK,
  // not the last matching line: adjacency and the option region both anchor
  // at its top.
  let footerTop = footerIndex;
  while (footerTop > 0 && FOOTER_RE.test(lines[footerTop - 1])) footerTop -= 1;

  // Collect numbered rows above the footer, then keep only the trailing
  // consecutive run: numbered prose in the scrollback above the dialog
  // (plans, lists, echoed commands) must not masquerade as extra options.
  let run = [];
  for (let i = 0; i < footerIndex; i += 1) {
    const match = lines[i].match(OPTION_RE);
    if (!match) continue;
    const option = {
      index: Number(match[2]),
      label: match[3],
      selected: Boolean(match[1]),
      line: i,
    };
    if (run.length && option.index === run.at(-1).index + 1) run.push(option);
    else run = [option];
  }
  if (run.length === 0) return null;

  // A run that starts above 1 is either the tail of a menu whose question and
  // first option(s) are clipped off the top of the pty viewport (live-caught
  // 2026-07-21, pane wC:pC: long option descriptions overflow the small
  // hidden pane, and the clipped top is unrecoverable: the pane buffer holds
  // only the visible screen) or numbered prose. Only a real menu draws its
  // last option directly above the footer, so anything but blank lines or
  // dividers in between means prose, not a clipped menu.
  const clipped = run[0].index !== 1;
  if (clipped) {
    if (resumeDialog) return null;
    const between = lines.slice(run.at(-1).line + 1, footerTop);
    if (between.some((line) => line.trim() && !isDivider(line))) return null;
  }
  if (resumeDialog) {
    if (resumeSentinelLine >= run[0].line) return null;
    const lastOptionLine = run.at(-1).line;
    if (lines.slice(lastOptionLine + 1).some((line) => line.trim())) return null;
  }
  const firstOptionLine = run[0].line;

  // The option BLOCK is the options plus the lines that wrap or describe them:
  // it ends at the first blank line or divider after the last option, so the
  // side panel's own overflow ("Notes: press n to add notes") stays out of it.
  let regionEnd = run.at(-1).line;
  for (let i = regionEnd + 1; i < footerTop; i += 1) {
    if (!lines[i].trim() || isDivider(lines[i])) break;
    regionEnd = i;
  }
  const region = lines.slice(firstOptionLine, regionEnd + 1);
  const gutter = findGutter(region.filter((line) => line.trim() && !isDivider(line)));
  const paneWidth = lines.reduce((max, line) => Math.max(max, line.length), 0);

  // Group each option with the lines beneath it, in LEFT-COLUMN text only.
  const optionByLine = new Map(run.map((option) => [option.line, option]));
  const groups = [];
  let current = null;
  for (let i = firstOptionLine; i <= regionEnd; i += 1) {
    const raw = gutter ? lines[i].slice(0, gutter) : lines[i];
    if (!raw.trim() || isDivider(raw)) { current = null; continue; }
    const option = optionByLine.get(i);
    if (option) {
      const match = raw.match(OPTION_RE);
      const prefix = raw.match(/^\s*(?:❯)?\s*\d+\.\s+/);
      current = {
        index: option.index,
        selected: option.selected,
        // Where the label's own text starts. A continuation indented less than
        // this is the label still wrapping, not the description starting.
        textColumn: prefix ? prefix[0].length : 0,
        parts: [{ text: cleanText(match ? match[3] : option.label), indent: 0, lineLength: lines[i].length }],
      };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    const text = cleanText(raw);
    if (!text) continue; // a pure-frame row carries nothing to read
    current.parts.push({
      text,
      indent: raw.length - raw.trimStart().length,
      lineLength: lines[i].length,
    });
  }

  // In a two-column dialog the description lives in the side panel, so every
  // left-column line under an option is the LABEL wrapping. In a single-column
  // dialog the CLI puts the description on its own indented lines below.
  // Only a single column can be hard-wrapped at the pane edge; the left
  // column of a two-column dialog is wrapped by the CLI, well short of it.
  const wrapWidth = gutter ? Infinity : paneWidth;
  const options = groups.map((group) => {
    const head = group.parts[0].text;
    // A multi-select row carries its own state: "[ ]" unticked, "[x]" ticked.
    // Reading it back is what makes a toggle verifiable the same way the
    // single-select arrow walk verifies the "❯".
    const box = CHECKBOX_RE.exec(group.parts[0].text);
    if (box) {
      group.parts[0] = { ...group.parts[0], text: group.parts[0].text.slice(box[0].length).trim() };
    }
    // In a single column a long label runs off the pane edge and the terminal
    // hard-wraps it. That remainder is still the LABEL: it sits left of where
    // the description would be indented, and its predecessor filled the pane.
    // Reading it as the description cut labels mid-word ("Custom segment +
    // inlin" / "e pickers …").
    let labelEnd = 1;
    while (
      !gutter
      && labelEnd < group.parts.length
      && group.parts[labelEnd].indent < group.textColumn
      && group.parts[labelEnd - 1].lineLength >= paneWidth
    ) labelEnd += 1;
    const labelParts = gutter ? group.parts : group.parts.slice(0, labelEnd);
    const detailParts = gutter ? [] : group.parts.slice(labelEnd);
    const label = takeRecommended(cleanText(joinWrapped(labelParts, wrapWidth)));
    const detail = takeRecommended(cleanText(joinWrapped(detailParts, wrapWidth)));
    return {
      index: group.index,
      label: label.text,
      description: detail.text,
      recommended: label.recommended || detail.recommended,
      selected: group.selected,
      isText: TEXT_OPTION_RE.test(head),
      ...(box ? { checked: CHECKED_RE.test(box[0]) } : {}),
    };
  });

  // The question is the prose between the dialog's own top edge and the first
  // option. That edge is the last divider above the options: without it the
  // scan ran into the transcript and read three lines of the assistant's last
  // message, the tab strip, and the question as one run-on sentence
  // (live-caught 2026-07-26). Hook confirmations have no frame, so their scan
  // still starts at the top and keeps the reason lines that make the choice
  // decidable. An empty question is honest, a wrong one is not.
  let questionTop = 0;
  for (let i = firstOptionLine - 1; i >= 0; i -= 1) {
    if (isDivider(lines[i])) { questionTop = i + 1; break; }
  }
  // The tab strip WRAPS in a narrow pane, and a stray fragment of it landing
  // in the question ("riod ✔ Submit →  How should …") is a silent lie about
  // what Claude asked. Grow the contiguous block of glyph-bearing lines, join
  // it the way the terminal broke it, and keep the whole block out of the
  // question.
  let tabs = null;
  const stripLines = new Set();
  for (let i = 0; i < firstOptionLine; i += 1) {
    if (!TAB_GLYPH_RE.test(lines[i])) continue;
    let end = i;
    while (end + 1 < firstOptionLine && TAB_GLYPH_RE.test(lines[end + 1])) end += 1;
    const block = lines.slice(i, end + 1).map((line) => ({
      text: line.trim(),
      indent: line.length - line.trimStart().length,
      lineLength: line.length,
    }));
    const strip = parseTabStrip(joinWrapped(block, paneWidth));
    if (strip) {
      tabs = strip;
      for (let j = i; j <= end; j += 1) stripLines.add(j);
    }
    i = end;
  }
  const questionLines = [];
  for (let i = questionTop; i < firstOptionLine; i += 1) {
    const line = lines[i].trim();
    if (!line || isDivider(line) || stripLines.has(i)) continue;
    if (isLoneTab(line)) continue;
    questionLines.push({
      text: line,
      indent: lines[i].length - lines[i].trimStart().length,
      lineLength: lines[i].length,
    });
  }
  // Rejoin the question the way the pane broke it, for the same reason the
  // labels need it: a plain space put one back together as "a custo m range".
  const question = clipped ? '' : joinWrapped(questionLines.slice(-6), paneWidth).slice(0, 320);

  // What the footer itself advertises, so the card offers exactly the keys
  // this dialog has and invents none. Tab means "switch questions" on a
  // batched AskUserQuestion and "amend" on a permission prompt; they are not
  // interchangeable.
  // The footer wraps too, and only its FIRST fragment matches FOOTER_RE, so
  // reading to footerIndex alone hid "Tab to switch questions" behind a line
  // break and the card silently lost its question switcher. Take the whole
  // contiguous run and rejoin it the way the terminal broke it; a blank line
  // ends the footer, which keeps a queued-message echo below it out.
  let footerEnd = footerIndex;
  while (footerEnd + 1 < lines.length && lines[footerEnd + 1].trim()) footerEnd += 1;
  const footerBlock = joinWrapped(lines.slice(footerTop, footerEnd + 1).map((line) => ({
    text: line.trim(),
    indent: line.length - line.trimStart().length,
    lineLength: line.length,
  })), paneWidth);
  const keys = {
    switchQuestions: /tab to switch questions/i.test(footerBlock),
    notes: /to add notes/i.test(footerBlock),
    amend: /tab to amend/i.test(footerBlock),
    explain: /ctrl\+e to explain/i.test(footerBlock),
    toggle: multiSelect,
  };
  // The key that adds a note to an answer, as the footer spells it ("n to add
  // notes"). Taken from the footer rather than assumed, so the card offers the
  // key this dialog actually has.
  const notesKey = (footerBlock.match(/(\w)\s+to add notes/i) || [])[1] || null;

  return {
    question,
    options,
    tabs,
    keys,
    notesKey,
    multiSelect,
    clipped,
    footer: resumeDialog ? '' : lines[footerIndex].trim(),
    acceptsText: options.some((option) => option.isText),
    // Zero-based position, or null when no row is pointed at yet.
    selectedIndex: options.some((option) => option.selected)
      ? options.findIndex((option) => option.selected)
      : null,
  };
}

// One arrow keystroke that moves the highlight toward target, or null if the
// highlight is already there. The caller re-reads and repeats (self-correcting,
// so a mis-parsed starting position cannot land on the wrong option).
function menuArrowToward(currentIndex, targetIndex) {
  if (currentIndex == null || currentIndex === targetIndex) return null;
  return targetIndex > currentIndex ? MENU_KEYS.down : MENU_KEYS.up;
}

module.exports = { parseMenu, menuArrowToward, MENU_KEYS };
