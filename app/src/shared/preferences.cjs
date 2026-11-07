'use strict';

// OPT-IN PREFERENCES (config.preferences). Every one is OFF by default, so a
// config without this block, or with any value that is not exactly the opt-in,
// behaves the way Harbor always has: Claude launches and resumes with
// --dangerously-skip-permissions, Codex with
// --dangerously-bypass-approvals-and-sandbox, prompt suggestions follow the
// CLI's own server flag, the Slate palette, and no usage debug log.
//
// One module for bin/ (argv, child env), main (the usage log) and the renderer
// (the theme, the wizard's Preferences card and the copy-paste resume command),
// so the flag sets and the defaults cannot drift between them.

const THEMES = Object.freeze(['default', 'reading']);

const PREFERENCE_DEFAULTS = Object.freeze({
  claudeAutoMode: false,
  codexAutoMode: false,
  promptSuggestions: false,
  theme: 'default',
  usageDebugLog: false,
});

function normalizePreferences(raw) {
  const p = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    claudeAutoMode: p.claudeAutoMode === true,
    codexAutoMode: p.codexAutoMode === true,
    promptSuggestions: p.promptSuggestions === true,
    theme: THEMES.includes(p.theme) ? p.theme : PREFERENCE_DEFAULTS.theme,
    usageDebugLog: p.usageDebugLog === true,
  };
}

// Claude in auto mode keeps bypass in the Shift+Tab cycle (auto, manual,
// accept edits, plan, bypass) through --allow-dangerously-skip-permissions,
// which the command bar's Cycle mode drives. Auto needs a model that supports
// it: a session on a model without it (Haiku) starts in manual, the CLI's rule.
const CLAUDE_BYPASS_ARGS = Object.freeze(['--dangerously-skip-permissions']);
const CLAUDE_AUTO_ARGS = Object.freeze(['--permission-mode', 'auto', '--allow-dangerously-skip-permissions']);

function claudePermissionArgs(preferences) {
  return [...(normalizePreferences(preferences).claudeAutoMode ? CLAUDE_AUTO_ARGS : CLAUDE_BYPASS_ARGS)];
}

// Codex's auto mode is `--approve-for-me` ALONE: codex refuses it together
// with -s, -a or the bypass flag. The default mode ids match codex's own
// presets ('full' is the bypass Harbor has always launched with).
const CODEX_PERMISSION_ARGS = Object.freeze({
  full: Object.freeze(['--dangerously-bypass-approvals-and-sandbox']),
  auto: Object.freeze(['--approve-for-me']),
});

function codexDefaultPermission(preferences) {
  return normalizePreferences(preferences).codexAutoMode ? 'auto' : 'full';
}

function codexDefaultPermissionArgs(preferences) {
  return [...CODEX_PERMISSION_ARGS[codexDefaultPermission(preferences)]];
}

// Every flag either default can put on a codex command line, so code that
// anchors on "the permission flag" (pane controls go straight after it) finds
// whichever one a launch carries.
const CODEX_PERMISSION_FLAGS = Object.freeze([...new Set(Object.values(CODEX_PERMISSION_ARGS).flat())]);

module.exports = {
  THEMES,
  PREFERENCE_DEFAULTS,
  normalizePreferences,
  claudePermissionArgs,
  codexDefaultPermission,
  codexDefaultPermissionArgs,
  CODEX_PERMISSION_FLAGS,
};
