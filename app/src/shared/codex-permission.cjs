'use strict';

// CODEX PERMISSION MODES. Every codex launch and resume used to hard-code
// --dangerously-bypass-approvals-and-sandbox. The bypass stays the default
// ('full'); the other three are choices the session popover and `bin/ai
// --permission` can make, and a resume reads back which one a session ran in.
//
// The flag sets were checked against codex 0.160.0's own parser, not its help
// text: --approve-for-me CONFLICTS with -s, -a and the bypass flag (clap refuses
// "the argument '--approve-for-me' cannot be used with '--sandbox'"), so auto is
// that flag alone. -a takes only on-request and never on 0.160.0. Ask and
// read-only mirror codex's own /approvals presets (on-request over a
// workspace-write or read-only sandbox) and pin approvals_reviewer=user, the
// config key codex validates (`bogus` is refused with the three allowed values),
// so a home whose config.toml routes approvals to auto_review cannot quietly
// turn "Ask" into auto, and the rollout records which one ran.
//
// One module for bin/ai (argv), the popover (labels) and resume (readback), so
// the flags, the names and the readback cannot drift apart.

const CODEX_PERMISSIONS = Object.freeze([
  Object.freeze({ id: 'auto', label: 'Auto', hint: 'automatic review of approvals, workspace-write sandbox' }),
  Object.freeze({ id: 'ask', label: 'Ask', hint: 'asks you before escalating, workspace-write sandbox' }),
  Object.freeze({ id: 'read-only', label: 'Read-only', hint: 'read-only sandbox, asks you before escalating' }),
  Object.freeze({ id: 'full', label: 'Full access', hint: 'no sandbox and no approvals' }),
]);

// Harbor's codex panes have always run with the bypass flag; that is still
// what a launch gets unless another mode is picked.
const DEFAULT_CODEX_PERMISSION = 'full';

const ARGS = Object.freeze({
  auto: Object.freeze(['--approve-for-me']),
  ask: Object.freeze(['-a', 'on-request', '-s', 'workspace-write', '-c', 'approvals_reviewer=user']),
  'read-only': Object.freeze(['-a', 'on-request', '-s', 'read-only', '-c', 'approvals_reviewer=user']),
  full: Object.freeze(['--dangerously-bypass-approvals-and-sandbox']),
});

function isCodexPermission(mode) {
  return Object.prototype.hasOwnProperty.call(ARGS, mode);
}

function codexPermissionArgs(mode) {
  if (!isCodexPermission(mode)) throw new Error(`unknown codex permission mode: ${mode} (auto, ask, read-only, full)`);
  return [...ARGS[mode]];
}

function codexPermissionLabel(mode) {
  return CODEX_PERMISSIONS.find((item) => item.id === mode)?.label || null;
}

function sandboxType(policy) {
  if (!policy) return null;
  if (typeof policy === 'string') return policy;
  return typeof policy.type === 'string' ? policy.type : null;
}

// Which mode a session ran in, read back from what codex RECORDED (the
// rollout's turn_context approval_policy / approvals_reviewer / sandbox_policy).
// Answers null whenever the record cannot name exactly one mode: a resume then
// falls back to the default instead of guessing. A workspace-write turn names
// its mode only through the reviewer, so a reader that does not have the
// reviewer gets null for it rather than a coin flip between auto and ask.
function codexPermissionFromPolicy({ approvalPolicy, sandboxPolicy, approvalsReviewer } = {}) {
  const sandbox = sandboxType(sandboxPolicy);
  if (sandbox === 'danger-full-access') return 'full';
  if (sandbox === 'read-only') return 'read-only';
  if (sandbox !== 'workspace-write') return null;
  if (approvalPolicy && approvalPolicy !== 'on-request') return null;
  if (approvalsReviewer === 'auto_review' || approvalsReviewer === 'guardian_subagent') return 'auto';
  if (approvalsReviewer === 'user') return 'ask';
  return null;
}

module.exports = {
  CODEX_PERMISSIONS,
  DEFAULT_CODEX_PERMISSION,
  isCodexPermission,
  codexPermissionArgs,
  codexPermissionLabel,
  codexPermissionFromPolicy,
};
