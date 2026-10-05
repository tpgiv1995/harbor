'use strict';

// Display-only cleanup. Never rewrite the transcript or interpret its contents.
function sessionTitleText(raw, { internal = false } = {}) {
  let text = String(raw || '').trim();
  if (internal) {
    const request = text.match(/(?:^|\n)user:\s*([^\n]+)/i);
    return request ? `Action review: ${request[1].trim()}` : 'Background action review';
  }
  const request = text.match(/(?:^|\n)## My request:\s*\n([\s\S]*)/);
  if (request && /^# Files mentioned by the user:/m.test(text)) text = request[1];
  text = text.replace(/\n<image\b[\s\S]*$/, '').trim();
  if (/^(?:# AGENTS\.md instructions|<environment_context>|<skills_instructions>)/.test(text)) return null;
  return text || null;
}
module.exports = { sessionTitleText };
