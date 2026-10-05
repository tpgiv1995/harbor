'use strict';

const notesModel = require('../../shared/notes-model.cjs');
const markdownHtml = require('../../shared/markdown-html.cjs');

function displayTitle(note) {
  const explicit = String(note?.title || '').trim();
  if (explicit) return explicit;
  const first = String(note?.body || '').split(/\r?\n/).find((line) => line.trim());
  if (!first) return 'Untitled note';
  const clean = first.trim().replace(/^#{1,6}\s+/, '').replace(/^[-*+]\s+/, '').trim();
  return clean ? clean.slice(0, 60) : 'Untitled note';
}

function listRows(doc, options) {
  return notesModel.selectNotes(doc, options);
}

/** The groups a nav renders, each with how many notes it holds. */
function groupRows(doc) {
  const counts = notesModel.groupCounts(doc);
  return (doc?.groups || []).map((group) => ({ ...group, count: counts[group.id] || 0 }));
}

/** The topics in use, most used first (tag, key, count). */
function topicRows(doc) {
  return notesModel.tagIndex(doc);
}

function copyPayload(note) {
  const markdown = String(note?.body || '');
  return {
    html: markdownHtml.markdownToHtml(markdown),
    text: markdownHtml.markdownToPlainText(markdown),
  };
}

module.exports = { copyPayload, displayTitle, groupRows, listRows, topicRows };
