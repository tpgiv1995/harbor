'use strict';

const ATTACHMENT_REFUSAL = 'This session stopped before answering your last message, but that message included an attachment Harbor cannot safely re-send from the transcript. Reattach it and send the message again.';

function messageContent(record) {
  return record?.message?.content;
}

function planResumeNudge(tailRecords) {
  const records = Array.isArray(tailRecords) ? tailRecords : [];
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    const role = record?.message?.role || record?.type;
    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'assistant') return { kind: 'nudge' };

    // 2026-08-14: a sessiond double-crash left a typed human message as the
    // transcript tail. A bare resume added an isMeta nudge, and Claude Code
    // answered it client-side with model:<synthetic>, swallowing the real
    // question. Meta user records stop the scan so a prior nudge can never
    // become a redelivery loop.
    if (record.isMeta) return { kind: 'nudge' };
    const human = record?.origin?.kind === 'human' || record?.promptSource === 'typed';
    if (!human) return { kind: 'nudge' };

    const content = messageContent(record);
    if (typeof content === 'string') {
      return content.trim() ? { kind: 'redeliver', text: content } : { kind: 'nudge' };
    }
    if (!Array.isArray(content)) return { kind: 'nudge' };
    if (content.some((part) => !part || part.type !== 'text')) {
      return { kind: 'refuse', text: ATTACHMENT_REFUSAL };
    }
    const text = content.map((part) => String(part.text ?? '')).join('');
    return text.trim() ? { kind: 'redeliver', text } : { kind: 'nudge' };
  }
  return { kind: 'nudge' };
}

module.exports = { ATTACHMENT_REFUSAL, planResumeNudge };
