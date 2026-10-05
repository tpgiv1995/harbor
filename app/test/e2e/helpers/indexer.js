'use strict';

const { createHistoryIndex } = require('../../../src/main/providers/history-index.js');
const { parseEmitTsv } = require('../../../src/main/providers/history.js');
const { mergeSidebarModel, filterProjects, flattenSidebarRows } = require('../../../src/shared/sidebar-model.cjs');

function emitLines(args = []) {
  const stdout = createHistoryIndex().run(['emit', ...args]);
  return parseEmitTsv(stdout);
}

function indexerCounts() {
  const allSessions = emitLines(['--all']);
  const titledSessions = emitLines([]);
  return {
    emitAll: allSessions.length,
    emitTitled: titledSessions.length,
    allSessions,
    titledSessions,
  };
}

function expectedSidebarRows({ filter, query } = {}) {
  const sessions = emitLines(['--all']);
  const model = mergeSidebarModel({ historySessions: sessions, livePanes: [], workspaces: [], homes: {} });
  const filtered = filterProjects(model, { filter, query });
  const { sessionRowCount } = flattenSidebarRows(filtered, {
    collapsedProjects: new Set(),
    expandedOlder: new Set(),
    liveProjects: [],
  });
  return { sessionRowCount, projectCount: filtered.projects.length };
}

module.exports = {
  emitLines,
  indexerCounts,
  expectedSidebarRows,
};
