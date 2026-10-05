'use strict';

// Invented content in the measured CLI 2.1.288 layout. No private capture text.
const cwd = 'C:\\Synthetic';
const labels = {
  bash: ['Yes', 'Yes, and don’t ask again for: node *', 'No'],
  outside: ['Yes', `Yes, and always allow access to ${cwd}\\outside from this project`, 'No'],
  compound: ['Yes', `Yes, and don't ask again for "node red.js" and "node blue.js" commands in ${cwd}`, 'No'],
  guard: ['Yes', 'No'],
  edit: ['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session', 'No, and tell Claude what to do differently (esc)'],
  write: ['Yes', 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session', 'No, and tell Claude what to do differently (esc)'],
  mcp: ['Yes', `Yes, and don't ask again for toy \u2014 Paint commands in ${cwd}`, 'No'],
  fetch: ['Yes', "Yes, and don't ask again for example.com", 'No, and tell Claude what to do differently (esc)'],
  plan: ['Yes, auto-accept edits', 'Yes, manually approve edits', 'Tell Claude what to change'],
};
function fixture(kind, width = 120, selected = 1) {
  const edge = '─'.repeat(width);
  const inner = '╌'.repeat(width);
  const wrap = (text, indent = ' ') => {
    const out = [];
    let rest = text;
    let prefix = indent;
    while (prefix.length + rest.length > width) {
      const end = rest.lastIndexOf(' ', width - prefix.length);
      const cut = end > 0 ? end : width - prefix.length;
      out.push(prefix + rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
      prefix = '      ';
    }
    return [...out, prefix + rest];
  };
  const request = {
    bash: [' Bash command', ' Print the toy color', inner, ' node blue.js', inner, ' This command requires approval'],
    outside: [' Bash command', ' Create the outside toy folder', inner, ` mkdir "${cwd}\\outside\\toy"`, inner, ' This command accesses a directory outside the project'],
    compound: [' Bash command', ' Print both toy colors', inner, ' node red.js && node blue.js', inner],
    guard: [' Bash command', ' Print the toy color', inner, ' node blue.js', inner, ' Hook PreToolUse:Bash requires confirmation for this command:', ' Review the synthetic toy folder first.', ' Keep the saved blue sample.'],
    edit: [' Edit file', ` ${cwd}\\toy.txt`, inner, '  1 -Red toy', '  1 +Blue toy', '  2  Keep the wheels', inner],
    write: [' Create file', ` ${cwd}\\toy.txt`, inner, ...Array.from({ length: 15 }, (_, i) => ` Toy instruction ${i + 1}`), inner],
    mcp: [' Tool use', ' toy \u2014 Paint (MCP)', inner, ' color: "blue"', ' copies: 2', inner, ' About the toy \u2014 Paint:', ' │ Paint a synthetic toy'],
    fetch: [' Fetch', ' Claude wants to fetch content from example.com', inner, ' url: https://example.com/toys', ' prompt: Read the toy instructions', inner],
    plan: [' Ready to code?', '', " Here is Claude's plan:", inner, ' Toy plan', '', ' Context', ' Build a blue wooden toy.', '', ' Steps', ' 1. Cut the wooden pieces.', ' 2. Paint the pieces blue.', ' 3. Fit the wheels.', '', ' Verification', ' Check that each wheel turns.', inner, '', edge],
  }[kind];
  const question = kind === 'plan' ? 'Claude has written up a plan and is ready to execute. Would you like to proceed?'
    : kind === 'fetch' ? 'Do you want to allow Claude to fetch this content?' : 'Do you want to proceed?';
  const foot = kind === 'plan' ? ['      shift+tab to approve with this feedback', '', ` ctrl+g to edit in Notepad · ${cwd}\\toy-plan.md`]
    : ['edit', 'write', 'fetch'].includes(kind) ? [] : ['', ' Esc to cancel · Tab to amend · ctrl+e to explain'];
  return [edge, ...request, '', ...wrap(question), ...labels[kind].flatMap((label, i) => wrap(label, ` ${selected === i + 1 ? '❯' : ' '} ${i + 1}. `)), ...foot].join('\n');
}
module.exports = { fixture, labels, cwd };
