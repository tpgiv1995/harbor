'use strict';

const {
  STICKY_COLORS,
  TEMPLATES,
} = require('../renderer/whiteboard/board-files.cjs');

const DEFAULT_SECTIONS = ['Ideas', 'Risks', 'Decisions', 'Actions'];
const DEFAULT_DIAGRAM = 'mindmap';

const DIAGRAM_X = 80;
const DIAGRAM_Y = 160;
const DISCUSSION_WIDTH = 708;
const DISCUSSION_HEIGHT = 360;
const REGION_GAP = 80;
const ZONE_WIDTH = 240;
const ZONE_HEIGHT = 280;
const ZONE_GAP = 40;
const ZONE_COLUMNS = 2;

function templateSpec(diagram) {
  const key = diagram === 'flowchart' ? 'flow' : diagram;
  return TEMPLATES.find((template) => template.key === key);
}

function composeBoard(spec = {}) {
  const topic = String(spec.topic || '').trim() || 'Untitled brainstorm';
  // Never-guess: an EXPLICIT unknown diagram refuses with the valid names (the
  // same posture as add-template); only an omitted one takes the default.
  if (spec.diagram !== undefined && !templateSpec(spec.diagram)) {
    throw new Error(`unknown diagram "${spec.diagram}"; valid: kanban, matrix, flowchart, mindmap`);
  }
  const diagram = spec.diagram === undefined ? DEFAULT_DIAGRAM : spec.diagram;
  const selectedTemplate = templateSpec(diagram);
  const sections = spec.sections === undefined
    ? DEFAULT_SECTIONS
    : Array.from(spec.sections, (section) => String(section));

  const discussionY = DIAGRAM_Y + selectedTemplate.height + REGION_GAP;
  const notesX = DIAGRAM_X + Math.max(selectedTemplate.width, DISCUSSION_WIDTH) + 120;
  const stickyColors = STICKY_COLORS.map((color) => color.key);

  const ops = [
    {
      type: 'board.addText',
      x: DIAGRAM_X,
      y: 40,
      text: topic,
      fontSize: 36,
      maxWidth: 1100,
    },
    {
      type: 'board.addTemplate',
      template: diagram,
      x: DIAGRAM_X,
      y: DIAGRAM_Y,
    },
  ];

  sections.forEach((section, index) => {
    const column = index % ZONE_COLUMNS;
    const row = Math.floor(index / ZONE_COLUMNS);
    const x = notesX + column * (ZONE_WIDTH + ZONE_GAP);
    const y = DIAGRAM_Y + row * (ZONE_HEIGHT + ZONE_GAP);

    ops.push(
      {
        type: 'board.addText',
        x,
        y,
        text: section,
        fontSize: 24,
        maxWidth: ZONE_WIDTH,
      },
      {
        type: 'board.addSticky',
        x: x + 20,
        y: y + 70,
        color: stickyColors[index % stickyColors.length],
        text: '',
      },
    );
  });

  ops.push({
    type: 'board.addShape',
    shape: 'rectangle',
    x: DIAGRAM_X,
    y: discussionY,
    width: DISCUSSION_WIDTH,
    height: DISCUSSION_HEIGHT,
    text: 'Discussion',
    fontSize: 28,
    backgroundColor: 'transparent',
    strokeColor: '#868e96',
    strokeStyle: 'dashed',
  });

  return ops;
}

module.exports = { composeBoard };
