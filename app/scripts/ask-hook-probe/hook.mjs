#!/usr/bin/env node
// PROBE HOOK: answer an AskUserQuestion from a PreToolUse hook.
//
// Reads the hook's stdin JSON (tool_name, tool_input), records it to
// <outdir>/hook-input.json, and returns a PreToolUse decision that ALLOWS the
// tool with updatedInput carrying `answers` and `annotations`, the two fields
// the CLI's own sdk-tools.d.ts documents on AskUserQuestionInput as "collected
// by the permission component". If the interactive CLI honours them, the TUI
// dialog never appears and the tool_result carries these answers verbatim.
//
// Answer policy for the probe: question 1 -> its second option's label,
// question 2 (multi) -> options 1 and 3 comma-joined, a note on question 1.
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  try { fs.mkdirSync(outDir, { recursive: true }); fs.writeFileSync(path.join(outDir, 'hook-input.json'), JSON.stringify(input, null, 2)); } catch { /* best effort */ }
  if (input.tool_name !== 'AskUserQuestion') process.exit(0);
  const questions = input.tool_input?.questions || [];
  const answers = {};
  const annotations = {};
  questions.forEach((q, i) => {
    const labels = (q.options || []).map((o) => o.label);
    if (q.multiSelect) answers[q.question] = [labels[0], labels[2]].filter(Boolean).join(', ');
    else answers[q.question] = labels[1] || labels[0] || '';
    if (i === 0) annotations[q.question] = { notes: 'probe note from the hook' };
  });
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'answered by the Harbor probe hook',
      updatedInput: { ...input.tool_input, answers, annotations },
    },
  };
  try { fs.writeFileSync(path.join(outDir, 'hook-output.json'), JSON.stringify(output, null, 2)); } catch { /* best effort */ }
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
});
