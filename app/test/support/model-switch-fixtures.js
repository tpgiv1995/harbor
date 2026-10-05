'use strict';
// Invented prose and model labels, preserving only the measured dialog shapes.
function fixture(kind, width = 120, selected = 1) {
  const wrap = text => {
    const words = text.split(' '); const lines = [''];
    for (const word of words) {
      if (lines.at(-1).length + word.length + 1 > width - 4) lines.push('');
      lines[lines.length - 1] += (lines.at(-1) ? ' ' : '') + word;
    }
    return lines.join('\n  ');
  };
  const options = kind === 'paused'
    ? ['Switch to Opus Test', 'Edit prompt and retry with Fable Test']
    : ['Switch to Opus Test (1M context) and continue', 'Continue with Fable Test'];
  return [kind === 'paused' ? 'Session paused' : "You've reached your Fable limit",
    wrap(kind === 'paused' ? 'Safeguards flagged this synthetic message. Details: review the toy example.' : 'Included usage is exhausted. Continuing on Fable Test uses usage credits, purchased separately from your plan.'),
    '', ...(kind === 'checking' ? ['Checking usage credits...'] : options.map((label, i) => `${i + 1 === selected ? '\u276f' : ' '} ${kind === 'paused' ? `${i + 1}. ` : ''}${wrap(label).replaceAll('\n  ', '\n    ')}`)),
    '', kind === 'paused' ? '\u273b Waiting for API response' : 'Enter to confirm · Esc to cancel'].join('\n');
}
module.exports = { fixture };
