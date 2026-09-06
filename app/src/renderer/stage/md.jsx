import React, { memo, useMemo, useState } from 'react';
import composeDoc from './compose-doc.cjs';
import { looksLikeRow, isSeparatorLine, parseTableLines } from './md-table.cjs';
import { continuesListRun } from './md-lists.cjs';

const { markdownToSpec } = composeDoc;

// Markdown-lite for conversation prose. Deliberately tiny: fenced code, inline
// code, bold, italics, strikethrough, underline, headings, bullet and numbered
// lists, GFM tables, paragraph breaks. Everything renders as React elements (never injected
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

function renderListChildren(children, keyBase) {
  return (children || []).map((child, index) => {
    const key = `${keyBase}-${index}`;
    if (typeof child === 'string') return <React.Fragment key={key}>{child}</React.Fragment>;
    if (child.tag === 'ul' || child.tag === 'ol') return renderListSpec(child, key);
    const Tag = child.tag;
    return <Tag key={key} href={child.tag === 'a' ? child.href : undefined}>{renderListChildren(child.children, key)}</Tag>;
  });
}

function renderListSpec(list, key) {
  const Tag = list.tag;
  return (
    <Tag
      className="md-list"
      key={key}
      type={list.type || undefined}
      start={list.start != null && list.start !== 1 ? list.start : undefined}
    >
      {list.children.map((item, index) => (
        <li key={`${key}-${index}`}>{renderListChildren(item.children, `${key}-${index}`)}</li>
      ))}
    </Tag>
  );
}

// Copying from an Electron renderer loaded over file:// is not a solved problem:
// navigator.clipboard.writeText is gated on secure-context + document focus and
// fails SILENTLY there, which is why the app's copy affordances can look like
// no-ops. execCommand('copy') on a transient textarea is deprecated but still
// works from a user gesture in Chromium/Electron, so it is the fallback that
// actually lands the text. Returns whether the copy succeeded, so the button
// never claims "Copied" it did not achieve.
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the execCommand path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// A fenced block with a hover/always-visible copy button. Copying a full block
// out of a scrolling <pre> by hand is miserable, so every code block carries its
// own button. Same clipboard idiom as the session rail: write, flip a transient
// "copied" label, and swallow failures rather than pop anything up. The button
// lives in the wrapper (not the <pre>), so it stays put while the code scrolls.
function CodeBlock({ code }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (!(await copyText(code))) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="md-code-wrap">
      <button
        type="button"
        className={`md-code-copy${copied ? ' is-copied' : ''}`}
        onClick={onCopy}
        aria-label={copied ? 'Copied' : 'Copy code'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="md-code">{code}</pre>
    </div>
  );
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
        nodes.push(<CodeBlock code={body.replace(/\n$/, '')} key={`f${si}`} />);
        return;
      }
      // Prose: group into paragraphs / list runs / table runs.
      const lines = segment.split('\n');
      let para = [];
      let listLines = [];
      let tableLines = [];
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
        if (!listLines.length) return;
        const specs = markdownToSpec(listLines.join('\n'));
        let prose = [];
        const flushProse = (pk) => {
          if (!prose.length) return;
          const run = prose;
          prose = [];
          // Consecutive lines that looked like ordered markers but did not open a
          // canonical list ("v. Smith\na. m.") join with a <br> into ONE
          // paragraph, exactly like any other multi-line user prompt, rather than
          // separate paragraphs with a gap (2026-09-03).
          nodes.push(
            <p className="md-p" key={pk}>
              {run.map((sp, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <React.Fragment key={i}>
                  {i ? <br /> : null}
                  {renderListChildren(sp.children, `${pk}-${i}`)}
                </React.Fragment>
              ))}
            </p>,
          );
        };
        specs.forEach((spec, index) => {
          const sk = `${key}-${index}`;
          if (spec.tag === 'ul' || spec.tag === 'ol') { flushProse(`${sk}-p`); nodes.push(renderListSpec(spec, sk)); return; }
          prose.push(spec);
        });
        flushProse(`${key}-pend`);
        listLines = [];
      };
      const flushTable = (key) => {
        if (!tableLines.length) return;
        const parsed = parseTableLines(tableLines);
        if (!parsed) {
          // Pipes without a separator row are prose; hand the lines back.
          tableLines.forEach((line) => para.push(line.trim()));
          tableLines = [];
          return;
        }
        tableLines = [];
        const alignStyle = (i) => (parsed.align[i] ? { textAlign: parsed.align[i] } : undefined);
        nodes.push(
          <div className="md-table-wrap" key={key}>
            <table className="md-table">
              <thead>
                <tr>
                  {parsed.header.map((cell, ci) => (
                    <th key={ci} style={alignStyle(ci)}>{renderInline(cell, `${key}h${ci}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {parsed.rows.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={alignStyle(ci)}>{renderInline(cell, `${key}r${ri}c${ci}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
      };
      lines.forEach((line, li) => {
        const key = `s${si}l${li}`;
        const trimmed = line.trim();
        // Roman and letter markers are recognized too (2026-09-03), so a list
        // the composer emits as "I. / II." renders as an ordered list in the
        // bubble instead of literal text. markdownToSpec still decides whether a
        // run is really a list; a lone marker line falls back to a paragraph.
        const nestedBullet = line.match(/^(\s*)([-*]|(?:\d{1,9}|[IVXLCDM]{1,9}|[ivxlcdm]{1,9}|[A-Za-z])[.)])\s+(.*)$/);
        const bullet = trimmed.match(/^([-*•]|\d{1,2}\.)\s+(.*)$/);
        const heading = trimmed.match(/^#{1,4}\s+(.*)$/);
        // A table opens only when the NEXT line is a separator row, so prose
        // that merely contains pipes never becomes a two-column accident.
        const rowLike = looksLikeRow(line);
        if ((tableLines.length && rowLike)
          || (!tableLines.length && rowLike && isSeparatorLine(lines[li + 1] || ''))) {
          flushPara(`${key}p`);
          flushList(`${key}u`);
          tableLines.push(line);
          return;
        }
        if (tableLines.length) flushTable(`${key}t`);
        if (!trimmed) {
          flushPara(`${key}p`);
          // A blank line BETWEEN items must not split the list; the rule (and
          // the incident) live in md-lists.cjs where a test can reach them.
          if (!(listLines.length && continuesListRun(lines, li))) flushList(`${key}u`);
        } else if (heading) {
          flushPara(`${key}p`);
          flushList(`${key}u`);
          nodes.push(<p className="md-h" key={key}>{renderInline(heading[1], key)}</p>);
        } else if (nestedBullet || bullet) {
          flushPara(`${key}p`);
          if (nestedBullet) listLines.push(line);
          else listLines.push(`- ${bullet[2]}`);
        } else {
          flushList(`${key}u`);
          para.push(trimmed);
        }
      });
      flushTable(`s${si}tend`);
      flushPara(`s${si}pend`);
      flushList(`s${si}uend`);
    });
    return nodes;
  }, [text, preserveBreaks]);
  return <>{out}</>;
});
