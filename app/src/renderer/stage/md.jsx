import React, { memo, useMemo } from 'react';

// Markdown-lite for conversation prose. Deliberately tiny: fenced code, inline
// code, bold, italics, strikethrough, underline, headings, bullet and numbered
// lists, paragraph breaks. Everything renders as React elements (never injected
// HTML), so transcript content can never script the app. Unrecognized markdown
// degrades to plain text, which is the right failure mode for a conversation
// surface.
//
// Since the composer became WYSIWYG (2026-07-26) this also renders the user's
// OWN prompts, so what was composed as bold reads back as bold instead of as
// literal asterisks.

function renderInline(text, keyBase) {
  const nodes = [];
  // Split on `code`, **bold**, *em*, ~~strike~~, <u>underline</u> in one pass.
  // <u> is here because markdown has no underline at all: the composer emits
  // the inline HTML form, so this is the only way a composed underline reads
  // back the way it was written.
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|~~[^~]+~~|<u>[\s\S]*?<\/u>)/g;
  let last = 0;
  let match;
  let i = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      nodes.push(<code key={`${keyBase}-c${i}`}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      nodes.push(<strong key={`${keyBase}-b${i}`}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('~~')) {
      nodes.push(<s key={`${keyBase}-s${i}`}>{token.slice(2, -2)}</s>);
    } else if (token.startsWith('<u>')) {
      nodes.push(<u key={`${keyBase}-u${i}`}>{token.slice(3, -4)}</u>);
    } else {
      nodes.push(<em key={`${keyBase}-e${i}`}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
    i += 1;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// preserveBreaks keeps single newlines visible as line breaks. Assistant prose
// is real markdown, where a lone newline is a soft wrap and joining is correct.
// A typed prompt is not: breaking a line there was a deliberate act, and
// reflowing it would show Pat something other than what he actually sent.
export const Markdown = memo(function Markdown({ text, preserveBreaks = false }) {
  const out = useMemo(() => {
    const src = String(text || '');
    const nodes = [];
    const segments = src.split(/```/);
    segments.forEach((segment, si) => {
      if (si % 2 === 1) {
        // Fenced block: first line may be a language tag.
        const lines = segment.split('\n');
        const body = (lines[0].trim().length <= 12 && lines.length > 1 ? lines.slice(1) : lines).join('\n');
        nodes.push(<pre className="md-code" key={`f${si}`}>{body.replace(/\n$/, '')}</pre>);
        return;
      }
      // Prose: group into paragraphs / list runs.
      const lines = segment.split('\n');
      let para = [];
      let list = null;
      const flushPara = (key) => {
        if (!para.length) return;
        nodes.push(
          <p className="md-p" key={key}>
            {preserveBreaks
              ? para.map((line, li) => (
                <React.Fragment key={li}>
                  {li ? <br /> : null}
                  {renderInline(line, `${key}-${li}`)}
                </React.Fragment>
              ))
              : renderInline(para.join(' '), key)}
          </p>,
        );
        para = [];
      };
      const flushList = (key) => {
        if (!list?.items.length) return;
        const Tag = list.ordered ? 'ol' : 'ul';
        nodes.push(
          <Tag className="md-list" key={key}>
            {list.items.map((item, li) => <li key={li}>{renderInline(item, `${key}-${li}`)}</li>)}
          </Tag>,
        );
        list = null;
      };
      lines.forEach((line, li) => {
        const key = `s${si}l${li}`;
        const trimmed = line.trim();
        const bullet = trimmed.match(/^([-*•]|\d{1,2}\.)\s+(.*)$/);
        const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
        if (!trimmed) {
          flushPara(`${key}p`);
          flushList(`${key}u`);
        } else if (heading) {
          flushPara(`${key}p`);
          flushList(`${key}u`);
          nodes.push(<p className="md-h" key={key}>{renderInline(heading[1], key)}</p>);
        } else if (bullet) {
          flushPara(`${key}p`);
          const ordered = /\d/.test(bullet[1]);
          // A numbered run following a bulleted one is a different list, not a
          // continuation of it.
          if (list && list.ordered !== ordered) flushList(`${key}u`);
          (list ||= { ordered, items: [] }).items.push(bullet[2]);
        } else {
          flushList(`${key}u`);
          para.push(trimmed);
        }
      });
      flushPara(`s${si}pend`);
      flushList(`s${si}uend`);
    });
    return nodes;
  }, [text, preserveBreaks]);
  return <>{out}</>;
});
