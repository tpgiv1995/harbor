'use strict';

const { isDividerLine } = require('../shared/divider.cjs');
const INNER = /^\s*[╌╍┄┅┈┉]{3,}\s*$/;
const TITLE = /^(Bash command|Edit file|Write file|Create file|Fetch|WebFetch|Tool use|MCP tool)$/i;
const MCP = /^.+\s+[-\u2014]\s+.+\(MCP\)$/i;
const QUESTION = /^(?:Do you want to (?:proceed|allow|make this edit|create)|Would you like to proceed|Claude has written up a plan)/i;
const FOOT = /^(?:Esc to cancel|Tab to amend|ctrl\+e to explain|ctrl\+g to edit|shift\+tab to approve|Enter to (?:select|confirm)|\w to add notes)/i;
const ROW = /^(\s*)(❯)?\s*(\d+)\.\s+(.+?)\s*$/;

// This is presentation data only. Selection still goes through the existing
// numbered, reread-before-Enter walk. Keep unknown detail as text, unbounded
// by the old question heading's six-line / 320-character display limit.
function parsePermissionMenu(screen) {
  const lines = String(screen || '').split('\n').map(line => line.replace(/\r$/, ''));
  const width = Math.max(...lines.map(line => line.length));
  let first = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*❯\s*\d+\.\s+/.test(lines[i])) { first = i; break; }
  }
  if (first < 0) return null;
  // Find the beginning of this pointed run, not a numbered list in the plan.
  let number = Number(lines[first].match(ROW)[3]);
  for (let i = first - 1; i >= 0 && number > 1; i -= 1) {
    const row = lines[i].match(ROW);
    if (row && Number(row[3]) === number - 1) { first = i; number -= 1; }
    else if (row || isDividerLine(lines[i], 3) || INNER.test(lines[i])) break;
  }
  let questionAt = -1;
  for (let i = first - 1; i >= 0; i -= 1) {
    if (QUESTION.test(lines[i].trim())) { questionAt = i; break; }
    if (isDividerLine(lines[i], 3)) break;
  }
  const after = lines.slice(first).join('\n');
  if (questionAt < 0 && !/Tab to amend|ctrl\+e to explain/i.test(after)) return null;
  let top = 0;
  for (let i = (questionAt < 0 ? first : questionAt) - 1; i >= 0; i -= 1) {
    if (isDividerLine(lines[i], 3)) { top = i + 1; break; }
  }
  // Plan approval has a second solid rule between the plan and its question.
  // Reach back only to its explicit title, never to arbitrary scrollback.
  const plan = questionAt >= 0 && /^Claude has written up a plan/i.test(lines[questionAt].trim());
  if (plan) {
    for (let i = top - 1; i >= 0; i -= 1) {
      if (/^\s*Ready to code\?\s*$/.test(lines[i])) { top = i; break; }
    }
  }
  const options = [];
  const foot = [];
  let inFooter = false;
  let echo = false;
  for (let i = first; i < lines.length; i += 1) {
    const text = lines[i].trim();
    if (isDividerLine(lines[i], 3) || /^❯\s*$/.test(text) || /esc to interrupt/i.test(text)) return null;
    if (echo) continue;
    const row = lines[i].match(ROW);
    if (!row && /^❯\s+\S/.test(text)) { echo = true; continue; }
    if (FOOT.test(text)) inFooter = true;
    if (inFooter) { if (text) foot.push(text); continue; }
    if (row) {
      const index = Number(row[3]);
      if (options.length && index !== options.at(-1).index + 1) return null;
      options.push({ index, label: row[4], description: '', recommended: false, selected: Boolean(row[2]), isText: false });
    } else if (text && options.length) {
      // The CLI indents wrapped labels to the same text column. Preserve the
      // entire label, including scope paths and persistence wording.
      const hardWrap = !/^\s+/.test(lines[i]) && lines[i - 1].length >= width;
      if (!/^\s+/.test(lines[i]) && !hardWrap) return null;
      options.at(-1).label += hardWrap ? text : ` ${text}`;
    }
  }
  if (!options.length) return null;
  const footer = foot.join('\n');
  if (plan && /shift\+tab to approve/i.test(footer)) options.at(-1).isText = true;
  const question = questionAt < 0 ? '' : lines.slice(questionAt, first).map(l => l.trim()).filter(Boolean).join(' ');
  const body = lines.slice(top, questionAt < 0 ? first : questionAt);
  let toolTitle;
  let toolName;
  const titleAt = body.findIndex(line => TITLE.test(line.trim()) || MCP.test(line.trim()));
  if (titleAt >= 0) {
    toolTitle = body[titleAt].trim();
    toolName = /^Bash command$/i.test(toolTitle) ? 'Bash' : /^Edit file$/i.test(toolTitle) ? 'Edit'
      : /^(?:Write|Create) file$/i.test(toolTitle) ? 'Write' : /^(?:Web)?Fetch$/i.test(toolTitle) ? 'WebFetch' : undefined;
    body.splice(titleAt, 1);
    const mcpAt = body.findIndex(line => MCP.test(line.trim()));
    if (mcpAt >= 0) { toolTitle = body[mcpAt].trim(); body.splice(mcpAt, 1); }
  }
  if (plan) toolTitle = 'Plan';
  const blocks = [];
  let buffer = [];
  let code = false;
  const flush = () => {
    const text = buffer.join('\n').trimEnd().replace(/^\n+/, '');
    if (text) blocks.push({ type: code ? (toolName === 'Edit' ? 'diff' : 'code') : 'text', text });
    buffer = [];
  };
  for (const line of body) {
    if (INNER.test(line)) { flush(); code = !code; continue; }
    if (isDividerLine(line, 3)) { flush(); continue; }
    // Strip only the dialog's one-column inset, keeping diff/code whitespace.
    buffer.push(line.startsWith(' ') ? line.slice(1) : line);
  }
  flush();
  if (['Edit', 'Write'].includes(toolName) && blocks[0]?.type === 'text'
    && /^[^\n]+[\\/][^\n]+$/.test(blocks[0].text)) blocks[0].type = 'path';
  // Extra native controls remain readable even when they have no card action.
  const extra = foot.filter(line => /ctrl\+g|shift\+tab/.test(line));
  if (extra.length) blocks.push({ type: 'text', text: extra.join('\n') });
  const notesKey = (footer.match(/(\w)\s+to add notes/i) || [])[1]
    || (/Tab to amend/i.test(footer) ? '\t' : null);
  return {
    question, options, tabs: null,
    keys: { switchQuestions: false, notes: Boolean(notesKey), amend: /Tab to amend/i.test(footer), explain: /ctrl\+e to explain/i.test(footer), toggle: false },
    notesKey, multiSelect: false, clipped: options[0].index !== 1, confirmSelected: false,
    submitReview: false, reviewAnswers: [], footer, acceptsText: options.some(option => option.isText),
    selectedIndex: options.findIndex(o => o.selected),
    permission: { ...(toolTitle ? { toolTitle } : {}), ...(toolName ? { toolName } : {}), blocks, question,
      canCancel: /Esc to cancel|\(esc\)/i.test(footer + '\n' + options.map(o => o.label).join('\n')) },
  };
}

module.exports = { parsePermissionMenu };
