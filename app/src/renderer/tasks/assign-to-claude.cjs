'use strict';

const YOLO_CWD = 'C:\\dev';

function composeTaskPrompt({ task, listName, extraInstructions = '', yolo = false }) {
  const lines = [
    'Harbor task explicitly assigned by Pat:',
    `Title: ${task.title}`,
    `Task ID: ${task.id}`,
    `List: ${listName || 'Unknown'}`,
    `Due date: ${task.dueDate || 'None'}`,
    `Tags: ${(task.tags || []).join(', ') || 'None'}`,
    'Note:',
    task.notes || '(none)',
  ];
  if (extraInstructions) lines.push('', 'Additional instructions from Pat (verbatim):', String(extraInstructions));
  if (yolo) lines.push('', 'First locate the correct project yourself before doing any work. Do not assume the launch folder is the project.');
  lines.push(
    '',
    'Implement this task fully and verify the result in production terms.',
    `Because Pat explicitly assigned this task by clicking Assign, when the work is verifiably done you SHOULD mark it complete with: harbor-tasks done ${task.id}`,
    'Address the task by the exact task ID above, never by its title.',
    'Do not add, complete, or modify any other Harbor task.',
  );
  return lines.join('\n');
}

module.exports = { YOLO_CWD, composeTaskPrompt };
