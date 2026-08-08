'use strict';

function appendTranscription(draft, transcription) {
  const current = String(draft || '');
  return `${current}${current && !/\s$/.test(current) ? ' ' : ''}${String(transcription || '')}`;
}

function attachmentsAfterSend(current, submitted, ok) {
  if (!ok) return current;
  const sent = new Set(submitted);
  return current.filter((attachment) => !sent.has(attachment));
}

function classifyPasteItems(items) {
  const list = Array.from(items || []);
  const imageItem = list.find((item) => item.type?.startsWith('image/')) || null;
  if (imageItem) return { imageItem, readClipboardImage: false };
  const hasText = list.some((item) => item.kind === 'string' || item.type?.startsWith('text/'));
  return { imageItem: null, readClipboardImage: list.length === 0 && !hasText };
}

module.exports = { appendTranscription, attachmentsAfterSend, classifyPasteItems };
