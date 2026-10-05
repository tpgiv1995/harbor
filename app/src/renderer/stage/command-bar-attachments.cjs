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

function attachmentKind(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  if (attachment.kind === 'file') return 'file';
  if (attachment.kind === 'image') return 'image';
  // Attachments created before file chips had no kind. They are image paths.
  return typeof attachment.path === 'string' && attachment.path ? 'image' : null;
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function fileAttachment(filePath) {
  const path = typeof filePath === 'string' ? filePath.trim() : '';
  if (!path) return null;
  return { kind: 'file', path, basename: basename(path) };
}

function fileAttachmentsFromPaths(paths) {
  return Array.from(paths || []).map(fileAttachment).filter(Boolean);
}

function imageAttachment(filePath, thumbDataUri = null) {
  const path = typeof filePath === 'string' ? filePath : '';
  if (!path) return null;
  return { kind: 'image', path, thumbDataUri: typeof thumbDataUri === 'string' ? thumbDataUri : null };
}

function removeAttachmentAt(attachments, index) {
  if (!Array.isArray(attachments)) return [];
  return attachments.filter((_, itemIndex) => itemIndex !== index);
}

function composeOutgoingText(text, attachments) {
  const message = String(text || '').trim();
  const paths = Array.from(attachments || [])
    .filter((attachment) => attachmentKind(attachment) === 'file')
    .map((attachment) => String(attachment.path || '').trim())
    .filter(Boolean);
  return [message, ...paths].filter(Boolean).join('\n');
}

function imageAttachmentPaths(attachments) {
  return Array.from(attachments || [])
    .filter((attachment) => attachmentKind(attachment) === 'image')
    .map((attachment) => String(attachment.path || '').trim())
    .filter(Boolean);
}

function classifyPasteItems(items) {
  const list = Array.from(items || []);
  const imageItem = list.find((item) => item.type?.startsWith('image/')) || null;
  if (imageItem) return { imageItem, readClipboardImage: false };
  const hasText = list.some((item) => item.kind === 'string' || item.type?.startsWith('text/'));
  return { imageItem: null, readClipboardImage: list.length === 0 && !hasText };
}

// What a click on an attachment chip should show, decided here rather than
// inline in the JSX so the rule has a test (the same reason file-drop.cjs and
// session-config-mode.cjs exist).
//
// A pasted or dropped image already carries its full bytes as a data URI, so
// its preview costs nothing and cannot fail. An attachment WITHOUT one still
// has to open: that is the Electron-clipboard path (readImage saves a file and
// captures no data URI) and every draft restored from localStorage, which
// persists paths and not bytes (draft-store maps a stored path to
// `{ path, thumbDataUri: null }`). Those read back off disk through the
// allowlisted channel. File attachments return no preview plan, which keeps
// both the disk image reader and ImagePreview image-only.
function attachmentPreviewPlan(attachment) {
  if (attachmentKind(attachment) !== 'image') return null;
  const filePath = attachment && attachment.path ? String(attachment.path) : '';
  const name = basename(filePath) || 'Pending attachment';
  if (attachment && attachment.thumbDataUri) {
    return { path: filePath, name, src: attachment.thumbDataUri, needsFetch: false };
  }
  return { path: filePath, name, src: null, needsFetch: Boolean(filePath) };
}

module.exports = {
  appendTranscription,
  attachmentsAfterSend,
  attachmentKind,
  fileAttachment,
  fileAttachmentsFromPaths,
  imageAttachment,
  removeAttachmentAt,
  composeOutgoingText,
  imageAttachmentPaths,
  classifyPasteItems,
  attachmentPreviewPlan,
};
