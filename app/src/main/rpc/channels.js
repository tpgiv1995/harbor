'use strict';

const LOCAL_ONLY = new Set([
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'window:is-maximized',
  'window:get-bounds',
  'window:set-bounds',
  'window:menu-action',
  'taskbar-badge:set',
  'pick-files',
  'pick-folder',
  'project-icons:reveal',
  'tasks:reveal',
  'artifacts:open-external',
  'artifacts:show-in-folder',
  'clipboard:read-image',
  'clipboard:save-image',
  // Reads a pasted image back off local disk for the composer's preview.
  // Local-only for the same reason its two siblings are: it touches this
  // machine's filesystem and clipboard, and the phone has no composer chip.
  'clipboard:image-data-uri',
  'clipboard:write-formatted',
  // Puts a rendered PNG on THIS machine's clipboard (the board's Copy as PNG and
  // Copy as image). Local-only for the same reason as its siblings: a remote
  // client has no clipboard here to write to.
  'clipboard:write-image',
  'context-menu:add-to-dictionary',
  'context-menu:edit-action',
  'context-menu:replace-misspelling',
  'context-menu:spell-status',
  'setup:login',
  'setup:pick-folder',
  'setup:symlink-apply',
  // Reclassified 2026-08-30 (same latent shape as the 2026-08-08 terminal:*
  // reclassification). The e2e:* family is only wired under HARBOR_E2E=1 in the
  // Electron app and has no headless handlers, so this was latent rather than
  // live — but remote-safe meant a future "drive the gate from my phone"
  // would have inherited no-auth access to quitting the app and rewriting
  // test fixtures. Local-only: a phone has no e2e surface.
  'e2e:get-launch-calls',
  'e2e:set-link',
  'e2e:set-ask-transcript',
  'e2e:emit-launched',
  'e2e:get-metrics',
  'e2e:mark-interactive',
  'e2e:quit',
  'e2e:session-owner-pid',
]);

const MUTATING = new Set([
  'resume-session',
  'session:takeover',
  'new-session',
  'workflow:run',
  'session:send',
  'session:menu-answer',
  'session:interrupt',
  'session:delete',
  'worker:close',
  'terminal:send-input',
  'orchestration:kickoff-research',
  'orchestration:kickoff-execute',
  'tasks:mutate',
  'notes:mutate',
  'whiteboard:write',
  'whiteboard:create',
  'whiteboard:rename',
  'whiteboard:delete',
  'setup:save',
  'voice:token',
  'whisper:transcribe',
  'upload:image',
  // Both were REMOTE_SAFE until 2026-08-07, and both are implemented in the
  // headless composition, so both were reachable over the network with no
  // token at all.
  //
  // 'capabilities:cycle-permission-mode' is the more serious of the two: it
  // ends in terminalBridge.sendInput(paneId, '\x1b[Z'), i.e. it types Shift+Tab
  // into a live session's pty. That is the SAME primitive as
  // 'terminal:send-input', which was correctly authenticated all along. Walking
  // the cycle far enough lands a running session in bypass-permissions mode,
  // which is exactly the confirmation gate a human was relying on. Any RPC path
  // that reaches sendInput, however indirectly, has to be authenticated.
  //
  // 'session:cancel-send' drops a message the user has already queued. Read-only
  // it is not.
  'capabilities:cycle-permission-mode',
  'session:cancel-send',

  // Reclassified 2026-08-08. docs/SECURITY-MOBILE.md described 'remote-safe' as
  // "read-only phone operations", and these were not read-only. The doc was the
  // thing a reader could disprove in one grep, but the classification was the
  // actual defect.
  //
  // Each of these reaches real state:
  //   session:menu-state  -> sessionSend.getMenu -> terminalBridge.ensureDialogSize,
  //                          which attaches a control child and resizes a live
  //                          pty to 120x60 so a dialog fits. Deliberate, and not
  //                          something an unauthenticated caller may trigger.
  //   pane:focus          -> focusWorkspace/focusPane, moving focus in the live
  //                          multiplexer and taking exclusive pane control.
  //   daemon:retry        -> app.relaunch(); app.exit(0). A remote restart.
  //   artifacts:thumb     -> spawns pdftoppm/ffmpeg/an offscreen capture.
  //
  // The phone is unaffected: it never calls three of them, it calls
  // session:menu-state only after connecting with a token, and it already
  // depends on nine other mutating methods, so an unauthenticated phone was
  // never a working configuration.
  'session:menu-state',
  'pane:focus',
  'daemon:retry',
  'artifacts:thumb',

  // Not implemented in the headless composition today, so this is latent rather
  // than live, but every one of them creates or tears down a live pane, tab or
  // workspace. Classified now so a future "close this tab from my phone" cannot
  // silently inherit no-auth access to closing the user's workspaces.
  'terminal:set-visible-panes',
  'terminal:focus-pane',
  'terminal:blur-pane',
  'terminal:resize-pane',
  'terminal:focus-workspace',
  'terminal:create-workspace',
  'terminal:close-workspace',
  'terminal:focus-tab',
  'terminal:create-tab',
  'terminal:close-tab',
  'terminal:rename-tab',
]);

// Fail CLOSED. Until 2026-07-31 `capability` was computed with 'remote-safe' as
// the implicit fallback for anything absent from the two sets above, which is
// the wrong polarity for an authentication boundary: a method added later with
// no thought given to it became network-reachable by default. Membership is now
// explicit on all three sides and buildCapability throws on anything that is not
// in exactly one, so the failure mode is a build error rather than a quiet hole.
const REMOTE_SAFE = new Set([
  'sidebar:get-state', 'daemon:get-banner',
  'session:preview', 'session:send-queue',
  'session:workflow-runs', 'new-session:options', 'new-session:folder',
  'transcript:open', 'transcript:close', 'links:get', 'usage:get-all',
  'accounts:read-emails', 'artifacts:list',
  'project-icons:list', 'tasks:read', 'notes:read', 'capabilities:get',
  'whiteboard:list', 'whiteboard:read',
  'capabilities:permission-mode',
  'terminal:get-state',
  'orchestration:get-data', 'orchestration:list-runs', 'orchestration:watch', 'orchestration:unwatch',
  'orchestration:watch-summaries', 'orchestration:unwatch-summaries',
  'orchestration:session-preview', 'perf:stall', 'diag:input',
  'setup:state', 'setup:detect', 'setup:read-home', 'setup:catalog',
  'setup:preview', 'setup:symlink-plan',
  // Lists the realtime voice names. Read-only, mints nothing, costs nothing.
  // voice:token and whisper:transcribe are deliberately NOT here: one mints an
  // OpenAI credential and the other spends money, so both are authenticated.
  'voice:voices',
]);

function buildCapability(method) {
  const hits = [
    MUTATING.has(method) && 'mutating',
    LOCAL_ONLY.has(method) && 'local-only',
    REMOTE_SAFE.has(method) && 'remote-safe',
  ].filter(Boolean);
  if (hits.length !== 1) {
    throw new Error(
      `rpc/channels: '${method}' is in ${hits.length} capability sets (${hits.join(', ') || 'none'}). `
      + 'Every method must be in exactly one. Unclassified is not remote-safe.',
    );
  }
  return hits[0];
}

const SEND_METHODS = new Set([
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'perf:stall',
  'window:set-bounds',
  'window:menu-action',
  'taskbar-badge:set',
  'diag:input',
]);

const METHOD_NAMES = [
  'sidebar:get-state',
  'daemon:get-banner',
  'daemon:retry',
  'window:minimize',
  'window:toggle-maximize',
  'window:close',
  'perf:stall',
  'window:is-maximized',
  'window:get-bounds',
  'window:set-bounds',
  'window:menu-action',
  'taskbar-badge:set',
  'e2e:get-launch-calls',
  'e2e:get-metrics',
  'e2e:mark-interactive',
  'e2e:session-owner-pid',
  'e2e:set-link',
  'e2e:set-ask-transcript',
  'e2e:emit-launched',
  'e2e:quit',
  'pane:focus',
  'resume-session',
  'session:takeover',
  'session:preview',
  'new-session',
  'workflow:run',
  'new-session:options',
  'new-session:folder',
  'transcript:open',
  'transcript:close',
  'session:send',
  'session:menu-state',
  'session:menu-answer',
  'session:send-queue',
  'session:cancel-send',
  'session:interrupt',
  'session:delete',
  'capabilities:get',
  'capabilities:permission-mode',
  'capabilities:cycle-permission-mode',
  'links:get',
  'diag:input',
  'worker:close',
  'pick-files',
  'usage:get-all',
  'accounts:read-emails',
  'pick-folder',
  'terminal:get-state',
  'terminal:set-visible-panes',
  'terminal:focus-pane',
  'terminal:blur-pane',
  'terminal:send-input',
  'terminal:resize-pane',
  'terminal:focus-workspace',
  'terminal:create-workspace',
  'terminal:close-workspace',
  'terminal:focus-tab',
  'terminal:create-tab',
  'terminal:close-tab',
  'terminal:rename-tab',
  'orchestration:watch-summaries',
  'orchestration:unwatch-summaries',
  'orchestration:list-runs',
  'orchestration:get-data',
  'orchestration:watch',
  'orchestration:unwatch',
  'orchestration:kickoff-research',
  'orchestration:kickoff-execute',
  'orchestration:session-preview',
  'session:workflow-runs',
  'artifacts:thumb',
  'project-icons:list',
  'project-icons:reveal',
  'tasks:read',
  'tasks:mutate',
  'tasks:reveal',
  'notes:read',
  'notes:mutate',
  'whiteboard:list',
  'whiteboard:read',
  'whiteboard:write',
  'whiteboard:create',
  'whiteboard:rename',
  'whiteboard:delete',
  'artifacts:list',
  'artifacts:open-external',
  'artifacts:show-in-folder',
  'clipboard:read-image',
  'clipboard:save-image',
  'clipboard:image-data-uri',
  'clipboard:write-formatted',
  'clipboard:write-image',
  'context-menu:add-to-dictionary',
  'context-menu:edit-action',
  'context-menu:replace-misspelling',
  'context-menu:spell-status',
  'setup:catalog',
  'setup:detect',
  'setup:login',
  'setup:pick-folder',
  'setup:preview',
  'setup:read-home',
  'setup:save',
  'setup:state',
  'setup:symlink-apply',
  'setup:symlink-plan',
  'voice:token',
  'voice:voices',
  'whisper:transcribe',
  'upload:image',
];

const METHOD_CHANNELS = Object.freeze(METHOD_NAMES.map((method) => Object.freeze({
  method,
  capability: buildCapability(method),
  ipc: SEND_METHODS.has(method) ? 'send' : 'invoke',
})));

const PUSH_CHANNELS = Object.freeze([
  'app:update-available',
  'context-menu:show',
  'daemon:banner',
  'links:update',
  'orchestration:summaries',
  'orchestration:update',
  'project-icons:update',
  'send:status',
  'session:launched',
  'setup:open',
  'sidebar:update',
  'tasks:changed',
  'notes:changed',
  'terminal:backfill',
  'terminal:control-state',
  'terminal:frame',
  'terminal:reset',
  'terminal:update',
  'transcript:update',
  'usage:update',
  'whiteboard:changed',
  'window:maximize-changed',
]);

function methodChannel(method) {
  return METHOD_CHANNELS.find((entry) => entry.method === method);
}

module.exports = { METHOD_CHANNELS, PUSH_CHANNELS, buildCapability, methodChannel };
