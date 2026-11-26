# Backlog

Deferred work from the September 2026 audit. These are open items, not release
promises. Earlier test counts and backend notes are [archived](BACKLOG-HISTORY.md).

| Area | Remaining work |
| --- | --- |
| Notes sync (DATA LOSS, fix first) | A device's stored unsaved note edit overwrites newer note text. `app/src/renderer/pending-patches.cjs` keeps each unsaved edit in that device's localStorage as whole field values (the whole note body) and restores it at load (lines 20-23); the phone editor then SHOWS the stored draft instead of the note's current body (`app/web/src/notes/NotesView.jsx:125`, `edits.draft.body ?? note.body`) and sends it whole when the editor closes (:48, `edits.flush()`); `note.update` in `app/src/shared/notes-model.cjs` (:264) replaces the body with no check that the note changed since the draft was typed. Seen 2026-11-25 (Pat, Carrier Bridge's live board note `n_mwrblo9g1w9hx9c`): opening the notes page on his phone wrote back a Nov 23 draft at 17:48:23Z; at 17:54Z his answers typed on the phone saved the whole body he had loaded, dropping an edit made at 17:52Z. Fix: each stored patch carries the note's `updatedAt` (or a body hash) it was based on; `note.update` refuses a patch whose base is older than the note (no silent overwrite: keep the draft as a conflict copy or merge only the user's own change); the phone editor drops or offers a draft whose base is stale instead of showing it as the note. Tests: a stale stored draft never overwrites a newer note, on desktop and phone; ordinary typing on a current note still saves. Reported by Vox (Carrier Bridge, session 9264f796) on Pat's word. Remove this row when it ships. |
| Electron | Move off Electron 37. The audit identified supported majors as 42 through 44. Revalidate ConPTY, Job Objects and packaging before changing the runtime. |
| Board persistence | Reconcile simultaneous edits from two board editors instead of overwriting the other editor's changes. |
| Provider metadata | Prevent lost updates across writers. |
| Retention | Add explicit retention for pasted images, preview thumbnails and config-load logs. |
| CLI questions | Improve recognition of Claude's terminal dialogs. In the audit corpus, 76 of 96 captured dialogs did not parse. This is a sample result, not a general failure rate. |
| Daemon latency | Instrument the observed 18-second stall; its cause is still unknown. |
| CLI updater | Handle installations outside the npm layout. |
| Cursor history | Reconcile project-name encoding with transcript lookup. |
| Crash evidence | Correlate crash dumps with renderer and session diagnostics. |
| Atomic writes | Sweep temporary-file cleanup and rename retries across the roughly twelve identified write sites. |
| Dependencies | Resolve React 19 and Radix peer warnings after compatibility validation. |
| Structure | Split large source files along tested boundaries. |
| Doctrine | Continue separating superseded historical instructions from current contributor guidance. |
| Drive harnesses | Keep the three newly identified drives that reach live state out of release validation until they use disposable homes and daemon endpoints. |
| Phone Notes | Desktop groups are not shown in the phone client. |
| Files | Index Codex and Cursor artifacts; the current discovery path indexes Claude sessions. |
| Assets | Resolve the Claude SVG's exact upstream source and redistribution terms; see [THIRD-PARTY.md](THIRD-PARTY.md) and [NOTICE](../NOTICE). |
| Platform proof | Validate the current Linux desktop, macOS hardware and installed phone-server path. Legacy desktop E2E is not a current Windows gate. |
| Content Security Policy | There is none, neither a meta tag nor a response header. Navigation refusal, denied window opens, the sandboxed artifact frame and the subframe request filter are the controls in place. A policy has to be proven against Excalidraw, the built-in PDF viewer and React's inline styles before it ships, which is why it has not been added blind. |
| Media permission | The permission request handler grants audio only. The paired permission check handler also passes an unknown media type. Tighten it to match, with a microphone on hand to prove dictation and live voice still work. |
| Store lock | The Notes and Tasks lock is a directory created with mkdir. Two processes that reach a stale lock within microseconds of each other can both remove it and both believe they hold it. The window is small and has always been there; closing it means a lock with a real owner token. |
| CI coverage | The test that renders a real board through the hardened export window needs the built export page, and CI runs the tests without building, so that test skips there with its reason stated. It passes locally. Add the build step once it has been shown not to flake on the hosted runner. |
| Harness isolation | Redirecting `HOME` and `USERPROFILE` does not redirect Electron's own `app.getPath('home')`, and `HOMEDRIVE` and `HOMEPATH` are inherited. The screenshot runtime now relocates all of them and sets `HARBOR_TAILNET_LOGINS`; the older `drive-*-win.js` harnesses have not been audited for the same gap. No product code calls the native getter. |
| Packaged builds | The release workflow builds installers for all three platforms, and none has been installed and run. A packaged app resolves `bin/` beside `app/` under `resources/`, which matches the source layout by design, but that is reasoning and not a test. Install one and start a session before publishing a release. |

The selected unit gate excludes the daemon and bin integration families.
Use [Contributing](../CONTRIBUTING.md) for commands and isolation requirements.
