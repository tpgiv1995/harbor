import React from 'react';

// Native line numbers describe the surrounding file; a hook replacement has
// no such coordinates. Both routes render the same signs and content instead.
export function PermissionDiff({ before = '', after = '', screen }) {
  let rows;
  if (screen !== undefined) {
    rows = screen.split('\n').map(line => {
      const numbered = line.match(/^\s*\d+ ([+\- ])(.*)$/);
      const bare = line.match(/^([+\-])(.*)$/);
      const match = numbered || bare;
      return match ? { sign: match[1], text: match[2].trimEnd() } : { sign: ' ', text: line.trimEnd() };
    });
  } else {
    const oldLines = String(before).split('\n');
    const newLines = String(after).split('\n');
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
      && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
    const group = (lines, sign) => lines.map(text => ({ sign, text }));
    rows = [...group(oldLines.slice(0, prefix), ' '),
      ...group(oldLines.slice(prefix, oldLines.length - suffix), '-'),
      ...group(newLines.slice(prefix, newLines.length - suffix), '+'),
      ...group(oldLines.slice(oldLines.length - suffix), ' ')];
  }
  return <pre className="prompt-diff">{rows.map(({ sign, text }, index) => {
    const Tag = sign === '-' ? 'del' : sign === '+' ? 'ins' : 'span';
    return <Tag className={sign === ' ' ? 'prompt-diff-context' : undefined} key={index}><span className="prompt-diff-sign">{sign} </span>{text}</Tag>;
  })}</pre>;
}
