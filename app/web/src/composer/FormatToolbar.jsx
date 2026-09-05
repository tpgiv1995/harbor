import React from 'react';
import { applyFormat } from './format-markdown.cjs';

const BUTTONS = [
  { key: 'bold', label: 'B', title: 'Bold' },
  { key: 'italic', label: 'I', title: 'Italic' },
  { key: 'strike', label: 'S', title: 'Strikethrough' },
  { key: 'heading', label: 'H', title: 'Heading' },
  { key: 'bullets', label: '•', title: 'Bulleted list' },
  { key: 'numbers', label: '1.', title: 'Numbered list' },
  { key: 'quote', label: '❝', title: 'Quote' },
  { key: 'code', label: '<>', title: 'Inline code' },
  { key: 'codeblock', label: '{ }', title: 'Code block' },
];

export function FormatToolbar({ textareaRef, text, onChange, disabled }) {
  const run = (action) => {
    const el = textareaRef.current;
    if (!el || disabled) return;
    const start = el.selectionStart ?? text.length;
    const end = el.selectionEnd ?? text.length;
    const next = applyFormat(text, start, end, action);
    onChange(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.selectionStart, next.selectionEnd);
    });
  };

  return (
    <div className="composer-format-bar" role="toolbar" aria-label="Text formatting">
      {BUTTONS.map((item) => (
        <button
          key={item.key}
          type="button"
          className="composer-format-btn"
          title={item.title}
          aria-label={item.title}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
