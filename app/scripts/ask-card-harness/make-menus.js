'use strict';
// Builds the menu-state payloads the visual harness renders, from the real
// captures and the same parser and merge production uses. Run from app/:
//   node scripts/ask-card-harness/make-menus.js
const fs = require('node:fs');
const path = require('node:path');
const { parseMenu } = require('../../src/main/menu-parse.js');
const { mergeAsk } = require('../../src/main/ask-question.js');

const fixture = (name) => fs.readFileSync(path.join(__dirname, '../../test/fixtures/askuserquestion', name), 'utf8');
const ASK = [
  {
    header: 'Finish approach',
    question: 'How do you want me to produce the complete BIH file for the full roster?',
    multiSelect: false,
    options: [
      { label: 'Reassemble + one BIH map (Recommended)', description: 'Take the cleaned roster data from the processed census records and reassemble it into a single complete BIH file with one unified map. This bundles everything together without re-processing the source PDFs.' },
      { label: 'Show me the cleaned census first', description: 'Generate and display the cleaned census data as an intermediate step so you can review the results before I proceed to full BIH assembly.' },
      { label: 'Clean re-run of the 5 PDFs', description: 'Start fresh from the original 5 PDFs, re-process them end-to-end through the cleaning pipeline, and produce the complete BIH file.' },
    ],
  },
  {
    header: 'Delivery',
    question: 'How should I hand off the finished file? (pick any)',
    multiSelect: true,
    options: [
      { label: 'File + note to you', description: 'Deliver both the complete BIH file and a summary note documenting what was processed.' },
      { label: 'Just the file', description: 'Provide only the finished BIH file without additional documentation or notes.' },
      { label: 'Draft the note for someone', description: 'Create a draft message that explains the completed roster and its contents.' },
    ],
  },
];

const menus = {
  batch: mergeAsk(parseMenu(fixture('real-batch-q1-2.1.258.txt')), ASK),
  answered: mergeAsk(parseMenu(fixture('real-batch-one-answered-2.1.258.txt')), ASK),
  lone: parseMenu(fixture('real-claude-120x60.txt')),
  multi: mergeAsk(parseMenu(fixture('real-batch-two-answered-2.1.258.txt')), [ASK[1]]),
  review: mergeAsk(parseMenu(fixture('real-batch-review-2.1.258.txt')), ASK),
  permission: parseMenu([
    'Hook PreToolUse:Bash requires confirmation for this command:',
    '  git push origin main',
    'Do you want to proceed?',
    '❯ 1. Yes',
    '  2. No, and tell Claude what to do differently',
    'Esc to cancel · Tab to amend · ctrl+e to explain',
  ].join('\n')),
  fallback: { fallback: true, screen: ['  Select a theme:', '', '  ❯ Dark mode', '    Light mode', '    Dark mode (colorblind-friendly)', '', '  Preview', '  ┌──────────────────┐', '  │ function hi() {} │', '  └──────────────────┘', '  ↑/↓ to navigate · Enter to confirm · Esc to cancel'] },
};
fs.writeFileSync(path.join(__dirname, 'menus.json'), JSON.stringify(menus, null, 1));
console.log('wrote', Object.keys(menus).join(', '));
