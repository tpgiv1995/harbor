'use strict';

// The keyboard half of the one-click permission answers (QuickAnswer.jsx):
// Cmd/Ctrl+Shift+Y allows the SELECTED window's permission prompt once and
// Cmd/Ctrl+Shift+N denies it, by pressing that window header's own buttons.
// Pure, so the key rule is tested without a DOM.

const QUICK_ANSWER_EVENT = 'harbor-quick-answer';

function quickAnswerKeys(platform = '') {
  return /mac/i.test(String(platform))
    ? { allow: '⌘⇧Y', deny: '⌘⇧N' }
    : { allow: 'Ctrl+Shift+Y', deny: 'Ctrl+Shift+N' };
}

// A text box keeps every key it is typed: the command bar's composer, the
// rail search, a card's notes field and the raw terminal (xterm's hidden
// textarea) are all editable, and a shortcut that fired there would answer a
// prompt from a keystroke meant for the text.
function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  if (target.isContentEditable) return true;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String(target.type || 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes(type);
  }
  return false;
}

// 'allow' | 'deny' for the shortcut, else null.
function quickAnswerDecision(event) {
  if (!event || event.repeat || event.isComposing) return null;
  if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) return null;
  const key = String(event.key || '').toLowerCase();
  const decision = key === 'y' ? 'allow' : key === 'n' ? 'deny' : null;
  if (!decision || isEditableTarget(event.target)) return null;
  return decision;
}

module.exports = { QUICK_ANSWER_EVENT, quickAnswerKeys, isEditableTarget, quickAnswerDecision };
