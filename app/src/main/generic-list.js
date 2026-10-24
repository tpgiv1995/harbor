'use strict';

const { isDividerLine } = require('../shared/divider.cjs');
const { parseMenu } = require('./menu-parse.js');

// THE GENERIC LIST (2026-10-24, Pat on `/mcp`: the window drew "NEEDS YOUR
// ANSWER · unrecognized prompt" with only the screen's tail, the highlighted
// row cut off above it and nothing to click). Claude Code draws many built-in
// dialogs as one shape: a title, rows with a "❯" on the highlighted one, and a
// footer like "↑/↓ to navigate · Enter to confirm · Esc to cancel". `/mcp` is
// one (measured on 2.1.303), and every other list dialog the CLI adds is too.
// This reads that shape whole so the window can show EVERY row, mark the
// highlighted one, and let a click move the highlight there and confirm.
//
// Where it sits matters more than how it parses. It runs ONLY on a screen the
// five recognized shapes in menu-parse.js already passed on (session-send's
// readFallback), so it can never take a question, a permission prompt, a resume
// dialog, a model switch or a clipped menu away from its own card, and it never
// sees a hook-lane question (those never reach the screen). A NUMBERED pointer
// row ("❯ 1. Yes") is menu-parse's by definition and is refused here as well,
// so the boundary holds even if the call site moves.
//
// The layout, from the real /mcp screen (test/fixtures/generic-list/):
//      ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔                        the dialog's top edge
//      Manage MCP servers                         title (left of the rows)
//      20 servers
//
//        User MCPs (<home>/.claude.json)          section header (row column,
//        ✔ graph                       9 tools    no status glyph)
//      ❯ ✔ browser                     24 tools   the highlighted row: "❯ "
//        ⚠ claude.ai Meetings          needs …    sits two columns left
//        claude.ai Hosting · ◯ hidden — …         a note (no glyph)
//          To use this connector instead, …       its continuation (deeper)
//      https://… for help                         hint (left of the rows)
//      ↑/↓ to navigate · Enter to confirm · Esc to cancel
// Rows and headers share a column, so the row column alone cannot tell them
// apart. When the highlighted row opens with a status glyph, rows are the
// lines that open with one and the rest are headers and notes; when it does
// not, every line in the row column is a row. A click on something the CLI
// does not treat as a row fails its verified walk; it never guesses.

// The footer names how to move and how to act ("↑/↓ to navigate · Enter to
// confirm · Esc to cancel", "↑/↓ to select · Enter to open · Esc to close"),
// or at least an Enter that picks and an Esc that backs out ("Enter to select
// · Esc to cancel", /theme). "Enter to toggle" is NOT a pick: a click there
// would flip a setting, so a toggle list stays on the raw keys.
const FOOTER_NAV_RE = /(?:↑\s*\/\s*↓|arrow keys|↑↓)[^\n]*(?:navigat|select|move)/i;
const FOOTER_ACT_RE = /enter to (?:confirm|select|open|view|choose)|esc to (?:cancel|close|go back|exit|back)/i;
const FOOTER_ENTER_RE = /enter to (?:confirm|select|open|view|choose)\b/i;
const FOOTER_ESC_RE = /esc to (?:cancel|close|go back|exit|back)\b/i;
const isListFooter = (line) => (FOOTER_NAV_RE.test(line) && FOOTER_ACT_RE.test(line)) || (FOOTER_ENTER_RE.test(line) && FOOTER_ESC_RE.test(line));
// A boxed field's frame: "╭────╮", "│ ⌕ Search… │", "╰────╯".
const BOX_FRAME_RE = /^\s*[╭╮╰╯│┃]/u;
// A rule INSIDE the dialog (a preview block's ╌╌╌ frame), not its edge.
const INNER_RULE_RE = /^[╌╍┄┅┈┉─━\s\ufffd]{3,}$/u;
const FORM_FOOTER_RE = /backspace to unset|→ to expand|tab to (?:next|switch) field/i;
const ELICITATION_RE = /requests your input/i;
const POINTER_RE = /^(\s*)❯\s+(\S.*?)\s*$/;
const NUMBERED_RE = /^\d+[.)]\s/;
// A status glyph then a space: ✔ connected, ⚠ needs auth, ✗ failed, ◯ off.
const GLYPH_RE = /^([^\p{L}\p{N}\s()[\]"'`<>/\\~.,:;-])\s+(\S.*)$/u;
const BULLET_RE = /^[·•∙‣◦]$/u;
const TONE = { '✔': 'ok', '✓': 'ok', '●': 'ok', '⚠': 'warn', '!': 'warn', '✗': 'err', '✘': 'err', '×': 'err', '◯': 'off', '○': 'off', '⊘': 'off', '◌': 'off' };
const isEdge = (line) => {
  const t = String(line || '').trim();
  if (isDividerLine(t, 3)) return true;
  // The CLI's dialog edge is a run of "▔" (a few cells can read back as U+FFFD
  // after a resize), and the status line can land in its tail: "▔▔▔…◉ xhigh ·
  // /effort" (measured in Pat's /mcp captures). A long run OPENING the line is
  // the edge; no row text opens that way.
  const run = /^[▔▁\ufffd]+/u.exec(t)?.[0] || '';
  return (run.match(/[▔▁]/gu) || []).length >= 8;
};
// A list taller than the pane scrolls: the CLI draws a scrollbar down the right
// edge (↑ ┃ │ ↓, after a wide gap) and "↓ 1 more" / "↑ 3 more" where rows are
// hidden (measured on the 32-row capture of Pat's /mcp). Neither is a row.
const SCROLLBAR_RE = /\s{2,}[↑↓┃│║▐▌█░▒▓]\s*$/u;
const MORE_RE = /^([↑↓])\s+(\d+)\s+more\b/i;
const indentOf = (line) => line.length - line.trimStart().length;
// Columns the CLI lays out with runs of spaces ("graph      9 tools").
const columns = (text) => text.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);

function parseGenericList(screen) {
  // Whatever the five recognized shapes read (a question, a permission prompt,
  // a resume dialog, a model or usage-limit switch, a clipped menu) is theirs,
  // wherever this is called from. Pat's captures hold usage-limit screens this
  // layout would otherwise also read as a list.
  if (parseMenu(screen)) return null;
  const lines = String(screen || '').split('\n');
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  if (!lines.length) return null;

  // The footer is the dialog's last line, or within the last few (a hint can
  // trail it). It has to name both the navigation and an action key.
  let footerIndex = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 4); i -= 1) {
    if (isListFooter(lines[i])) { footerIndex = i; break; }
  }
  if (footerIndex < 0) return null;
  // Composer chrome under the footer means the list is an old frame and the
  // session has moved on (menu-parse's ghost rule): a divider, a lone "❯", or a
  // working turn.
  if (lines.slice(footerIndex + 1).some((line) => isDividerLine(line, 3) || /^\s*❯\s*$/.test(line) || /esc to interrupt/i.test(line))) return null;
  // An MCP server's input FORM (an elicitation) draws the same navigation
  // footer plus form keys; it belongs to the Elicitation hook lane and its own
  // card, never to a list (13 of Pat's captured screens were one).
  if (FORM_FOOTER_RE.test(lines[footerIndex])) return null;

  // The highlighted row: the last pointer line above the footer.
  let pointerLine = -1;
  for (let i = footerIndex - 1; i >= 0; i -= 1) {
    if (isEdge(lines[i])) break;
    if (POINTER_RE.test(lines[i])) { pointerLine = i; break; }
  }
  // A searchable list ("Type to search", /plugin) moves the highlight INTO
  // its search field while you type, so its rows show no "❯" at all
  // (measured on 2.1.303). It is still the same list: its glyph rows share one
  // column, and a click steps down into it first (session-send pickListRow).
  const searchable = /type to (?:search|filter)/i.test(lines[footerIndex]);
  let pointer = null;
  let column;
  if (pointerLine >= 0) {
    pointer = POINTER_RE.exec(lines[pointerLine]);
    if (NUMBERED_RE.test(pointer[2])) return null;
    column = lines[pointerLine].indexOf(pointer[2]);
  } else {
    if (!searchable) return null;
    const byIndent = new Map();
    for (let i = footerIndex - 1; i >= 0 && !isEdge(lines[i]); i -= 1) {
      if (GLYPH_RE.test(lines[i].trim())) byIndent.set(indentOf(lines[i]), (byIndent.get(indentOf(lines[i])) || 0) + 1);
    }
    const best = [...byIndent].sort((a, b) => b[1] - a[1])[0];
    if (!best || best[1] < 2) return null;
    column = best[0];
    const sample = lines.slice(0, footerIndex).reverse().find((line) => indentOf(line) === column && GLYPH_RE.test(line.trim()));
    pointer = [sample, '', sample.trim()];
  }

  // The dialog: from its top edge (or the screen top) to the footer.
  let top = 0;
  for (let i = (pointerLine >= 0 ? pointerLine : footerIndex) - 1; i >= 0; i -= 1) {
    if (isEdge(lines[i])) { top = i + 1; break; }
  }
  if (lines.slice(top, footerIndex).some((line) => ELICITATION_RE.test(line))) return null;
  // Rows line up on their LABEL, not their first character: a status glyph
  // ("✔ chrome", /mcp) or a current-value mark ("✔ Dark mode" among plain
  // "Light mode" rows, /theme) sits two columns left of the label it belongs
  // to. Section headers start where the glyphs do, so they never line up with
  // a row's label, and a header's own continuation line is told apart by
  // following that header.
  const labelColumn = (indent, text) => {
    const glyph = GLYPH_RE.exec(text);
    return indent + (glyph ? text.length - glyph[2].length : 0);
  };
  const rowColumn = labelColumn(column, pointer[2]);
  // Prose the dialog wraps at the pane edge (/plugin's "⚠ Make sure you trust
  // a plugin ..." over three lines) is not a run of rows: a line that fills
  // the pane, followed by a plain line opening in lower case, is one sentence.
  const paneWidth = lines.reduce((max, line) => Math.max(max, line.trimEnd().length), 0);
  const fillsPane = (line) => line.trimEnd().length >= paneWidth * 0.85;
  // Glyph rows: when several lines open with a glyph right where the
  // highlighted row's text starts (/mcp, /plugin), every row carries one, and
  // a plain line at the label column is the row above it continuing (/plugin
  // prints each plugin's description there). A lone "✔" is only a
  // current-value mark (/theme), and its plain neighbours are rows.
  const glyphRows = lines.slice(top, footerIndex).filter((line, n) => {
    const i = top + n;
    const text = i === pointerLine ? pointer[2] : line.trim();
    const indent = i === pointerLine ? column : indentOf(line);
    return indent === column && GLYPH_RE.test(text);
  }).length >= 2;

  const items = [];
  const title = [];
  let hints = [];
  let last = null;
  let blankRun = 0;
  const more = { above: 0, below: 0 };
  let search = '';
  for (let i = top; i < footerIndex; i += 1) {
    const raw = lines[i].replace(SCROLLBAR_RE, '');
    if (!raw.trim()) {
      last = null;
      blankRun += 1;
      // A dialog still being drawn has no top edge yet, and the screen above
      // it is the session banner: a gap of blank lines ends whatever came
      // before, so only the dialog's own title survives.
      if (blankRun >= 2 && !items.length) title.length = 0;
      continue;
    }
    blankRun = 0;
    if (isEdge(raw)) continue;
    // A preview block under the rows (/theme draws a code sample between two
    // ╌ rules): only what follows its last rule is a hint.
    if (INNER_RULE_RE.test(raw.trim())) { if (items.length) hints = []; last = null; continue; }
    // A boxed input inside the dialog (/plugin's search field): its frame is
    // chrome, never a title or a hint.
    if (BOX_FRAME_RE.test(raw)) {
      const typed = /⌕\s*(.*?)\s*[│┃]?\s*$/u.exec(raw)?.[1];
      if (typed != null && !/^Search…?$/.test(typed)) search = typed;
      last = null;
      continue;
    }
    const hidden = MORE_RE.exec(raw.trim());
    if (hidden) {
      more[hidden[1] === '↑' ? 'above' : 'below'] = Number(hidden[2]);
      last = null;
      continue;
    }
    const isPointer = i === pointerLine;
    if (!isPointer && POINTER_RE.test(raw)) return null; // two highlights is not one list
    const text = isPointer ? POINTER_RE.exec(raw)[2] : raw.trim();
    const indent = isPointer ? column : indentOf(raw);
    const at = labelColumn(indent, text);
    const glyph = GLYPH_RE.exec(text);
    // A wrapped sentence: the line above filled the pane and this one goes on
    // in lower case. The line above was prose, never a row.
    if (at === rowColumn && !glyph && !isPointer && last && !last.selected && last.fullLine && /^[a-z]/.test(text)) {
      if (last.type === 'row') last.type = 'label';
      last.more.push(text);
      last.fullLine = fillsPane(raw);
      continue;
    }
    const continues = !glyph && !isPointer && last && (last.type === 'label' || glyphRows);
    // A bullet ("· Component summary ...") is a note, not a choice.
    if (at === rowColumn && glyph && BULLET_RE.test(glyph[1]) && !isPointer) {
      const item = { type: 'label', text, label: text, detail: '', glyph: null, tone: null, selected: false, line: i, more: [], fullLine: fillsPane(raw) };
      items.push(item);
      last = item;
      continue;
    }
    if (at === rowColumn && !continues) {
      const body = glyph ? glyph[2] : text;
      const parts = columns(body);
      const item = {
        type: 'row',
        text,
        label: parts[0] || body,
        detail: parts.slice(1).join(' · '),
        glyph: glyph ? glyph[1] : null,
        tone: glyph ? (TONE[glyph[1]] || null) : null,
        selected: isPointer,
        line: i,
        more: [],
        fullLine: fillsPane(raw),
      };
      if (NUMBERED_RE.test(item.label)) return null;
      items.push(item);
      last = item;
      continue;
    }
    if (at === rowColumn || at > rowColumn) {
      if (last) { last.more.push(text); continue; }
      (items.length ? hints : title).push(text);
      continue;
    }
    if (indent < column) {
      (items.length ? hints : title).push(text);
      last = null;
      continue;
    }
    // In the row region but left of the labels: a section header or a note.
    const item = { type: 'label', text, label: text, detail: '', glyph: null, tone: null, selected: false, line: i, more: [] };
    items.push(item);
    last = item;
  }

  const rows = items.filter((item) => item.type === 'row');
  if (!rows.length || (pointerLine >= 0 && !rows.some((row) => row.selected))) return null;
  // A label followed by rows is a section header; one that is not is a note.
  items.forEach((item, n) => {
    if (item.type !== 'label') return;
    const next = items[n + 1];
    item.type = next && next.type === 'row' && next.line > item.line && !item.more.length ? 'header' : 'note';
  });
  rows.forEach((row, index) => { row.index = index; });
  // Rows with the same label are told apart by their order among that label.
  const seen = new Map();
  for (const row of rows) {
    const n = seen.get(row.label) || 0;
    row.occurrence = n;
    seen.set(row.label, n + 1);
  }

  return {
    kind: 'list',
    title: title.slice(0, 3),
    items: items.map(({ line, fullLine, ...item }) => item),
    rows: rows.map(({ line, fullLine, more, ...row }) => ({ ...row, more })),
    hints,
    more,
    footer: lines[footerIndex].trim(),
    // null: nothing in the list is highlighted (the search field has it).
    selectedIndex: pointerLine >= 0 ? rows.findIndex((row) => row.selected) : null,
    searchable,
    // What is typed in the list's search field now ('' when empty).
    search,
    signature: rows.map((row) => row.label).join('\n'),
  };
}

// Where the highlight is relative to a target row the human clicked: the
// target found by its label (and which of several same-labelled rows), so a
// list that scrolls under the walk still finds it. null when not on screen.
function locateRow(list, { label, occurrence = 0 } = {}) {
  if (!list) return null;
  const target = list.rows.find((row) => row.label === label && (row.occurrence || 0) === occurrence);
  return target ? { target: target.index, current: list.selectedIndex } : null;
}

module.exports = { parseGenericList, locateRow };
