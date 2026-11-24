
function subSessionKind(row) {
  if (!row) return null;
  if (row.isChildTask || /^BATCH TITLE:/i.test(String(row.firstPrompt || '')) || /^BATCH TITLE:/i.test(String(row.title || ''))) return 'batch worker';
  if ((row.provider || 'claude') === 'claude' && row.entrypoint === 'sdk-cli') return 'headless Claude';
  // A print-mode `agy -p` run lands in the same store as a typed conversation with
  // the same records. Provider history marks it headless when none of the files only
  // the interactive TUI writes (annotations, history.jsonl, a summaries title) name it.
  if (row.provider === 'gemini' && row.headless === true && !row.delegatedBy) return 'headless Gemini';
  if (row.provider === 'codex') {
    const lineage = row.lineage || {};
    const source = row.source?.subagent;
    if (lineage.kind === 'guardian' || source?.other === 'guardian' || source === 'other') return 'approval review';
    if (String(lineage.kind || '').startsWith('subagent') || source) return 'sub-agent';
    if (lineage.originator === 'codex_exec' || row.originator === 'codex_exec' || lineage.kind === 'exec') return 'exec run';
  }
  return row.delegatedBy ? 'sub-agent' : null;
}
function isSubSession(row) { return Boolean(subSessionKind(row)); }
function railSessionVisible(row) { return !isSubSession(row) || Boolean(row.isLive); }
function subSessionReadOnly(row) {
  if (!row) return false;
  if (subSessionKind(row) === 'batch worker') return true;
  return Boolean((row.isSubSession || isSubSession(row)) && !(row.isLive && row.isLiveInteractive));
}
// A historical launch mode is not the mode of a resumed foreground process.
// Unknown argv is deliberately not evidence of an interactive TUI.
function interactiveAgentArgv(provider, argv) {
  if (!Array.isArray(argv) || !argv.length) return null;
  const binaryPattern = provider === 'claude' ? /(?:^|[/\\])claude(?:\.exe|\.cmd|\.js)?$|claude-code[/\\]cli\.js$/i
    : provider === 'codex' ? /(?:^|[/\\])codex(?:\.exe|\.cmd|\.js)?$/i
      : provider === 'gemini' ? /(?:^|[/\\])agy(?:\.exe|\.cmd)?$/i : null;
  const binary = binaryPattern ? argv.findIndex((arg) => binaryPattern.test(arg)) : -1;
  if (binary < 0) return null;
  const args = argv.slice(binary + 1);
  if (provider === 'claude') return !args.some((arg) => arg === '-p' || arg === '--print' || arg.startsWith('--print='));
  if (provider === 'codex') return !args.some((arg) => arg === 'exec' || arg === 'e');
  // agy: -p / --print is a headless run; acp, models and update are not a TUI either.
  if (provider === 'gemini') return !args.some((arg) => arg === '-p' || arg === '--print' || arg.startsWith('--print=')) && !['acp', 'models', 'update'].includes(args[0]);
  return null;
}

// A bounded, independently requested page. No prompt bodies or lineage trees
// cross the bridge here. Search deliberately belongs to Orch, not the rail.
function listSubSessions(rows, { query = '', older = false, offset = 0, limit = 100, now = Date.now() } = {}) {
  const needle = String(query).trim().toLowerCase();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const eligible = rows.filter((row) => isSubSession(row)
    && (older || row.isLive || (row.lastActiveMs || Date.parse(row.lastActive) || 0) >= now - 7 * 86400000)
    && (!needle || `${row.title}\n${row.project}\n${row.firstPrompt || ''}`.toLowerCase().includes(needle)))
    .sort((a, b) => (b.lastActiveMs || Date.parse(b.lastActive) || 0) - (a.lastActiveMs || Date.parse(a.lastActive) || 0) || a.id.localeCompare(b.id));
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const count = Math.max(1, Math.min(200, Math.floor(Number(limit) || 100)));
  const groups = new Map();
  for (const row of eligible.slice(start, start + count)) {
    const parentId = row.delegatedBy || row.lineage?.parentThreadId || null;
    const parent = parentId && byId.get(parentId);
    const key = parentId ? `parent:${parentId}` : `project:${row.project || 'Unknown project'}`;
    if (!groups.has(key)) groups.set(key, { key, parentId, label: parent?.title || (parentId ? 'Parent session' : row.project || 'Unknown project'), linked: Boolean(parentId), sessions: [] });
    groups.get(key).sessions.push({ id: row.id, provider: row.provider || 'claude', kind: subSessionKind(row), title: row.title,
      project: row.project, lastActiveMs: row.lastActiveMs || Date.parse(row.lastActive) || 0,
      status: row.isLive ? (row.agentStatus || 'live') : (row.dormant ? 'sleeping' : 'no live pane'), isSubSession: true });
  }
  return { groups: [...groups.values()], total: eligible.length, offset: start, nextOffset: start + count < eligible.length ? start + count : null };
}

export { subSessionKind, isSubSession, railSessionVisible, subSessionReadOnly, interactiveAgentArgv, listSubSessions };
