// Markdown-lite for the phone conversation surface. This is the SAME
// implementation the desktop renderer uses, not a second parser to drift from
// it: fenced code, inline code, bold, italics, strikethrough, underline,
// headings, lists, paragraphs, all rendered as React elements. Never
// dangerouslySetInnerHTML and never a markdown library that emits HTML
// strings, so transcript content can never script the app.
export { Markdown } from '../../../src/renderer/stage/md.jsx';
