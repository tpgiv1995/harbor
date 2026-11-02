import React from 'react';

// Stroked glyphs for the team chart, one weight (1.6) and one 16px box, never
// unicode or emoji. Status always pairs one of these with a word.
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, focusable: 'false' };

export function StatusIcon({ kind }) {
  switch (kind) {
    case 'working':
      return <svg {...base}><path d="M1.5 8h3l2-5 3 10 2-5h3" /></svg>;
    case 'tool':
      return <svg {...base}><path d="M10.2 2.3a3.2 3.2 0 0 0-3.9 4.3L2.5 10.4a1.5 1.5 0 0 0 2.1 2.1l3.8-3.8a3.2 3.2 0 0 0 4.3-3.9l-2 2-1.9-.4-.4-1.9z" /></svg>;
    case 'quiet':
      return <svg {...base}><path d="M4 1.8h8M4 14.2h8M4.8 1.8c0 3 3.2 3.9 3.2 6.2S4.8 11.2 4.8 14.2M11.2 1.8c0 3-3.2 3.9-3.2 6.2s3.2 3.2 3.2 6.2" /></svg>;
    case 'starting':
      return <svg {...base}><circle cx="8" cy="8" r="6" /><path d="M6.5 5.4 9.6 8l-3.1 2.6" /></svg>;
    case 'ended':
      return <svg {...base}><rect x="3.5" y="3.5" width="9" height="9" rx="1.5" /></svg>;
    default:
      return <svg {...base}><path d="M5.8 4v8M10.2 4v8" /></svg>;
  }
}

export function WarnIcon() {
  return <svg {...base}><path d="M8 2.2 14.3 13H1.7z" /><path d="M8 6.5v3M8 11.3v.1" /></svg>;
}

export function CloseIcon() {
  return <svg {...base}><path d="m4 4 8 8M12 4l-8 8" /></svg>;
}

export function OpenIcon() {
  return <svg {...base}><path d="M9.5 2.5h4v4M13.5 2.5 7.8 8.2M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3" /></svg>;
}

export function PinIcon() {
  return <svg {...base}><path d="M9.8 1.8 14.2 6.2l-2 .6-2.6 2.6.2 3-1.4 1.4-2.3-2.3-3.4 3.4M6.1 11.5 4.5 9.9l1.4-1.4 3-.2 2.6-2.6z" /></svg>;
}

export function HelperIcon() {
  return <svg {...base}><circle cx="5.5" cy="5.5" r="2.3" /><circle cx="11" cy="10.5" r="2.3" /><path d="M7.2 7.2 9.3 8.8" /></svg>;
}

export function MinusIcon() {
  return <svg {...base}><path d="M3.5 8h9" /></svg>;
}

export function PlusIcon() {
  return <svg {...base}><path d="M3.5 8h9M8 3.5v9" /></svg>;
}

export function FitIcon() {
  return <svg {...base}><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>;
}
