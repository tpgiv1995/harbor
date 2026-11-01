# Phone shows Codex sessions as "Live session" rows (2026-10-31)

Fix: commit `1c0311a` on `phone-live-rows-2026-10-31`. Server-side only (`app/src/server/compose.js`); a running phone server keeps the old behaviour until it restarts.

## Root cause

The phone server builds its rail with the same `createSidebarBridge` as the desktop, but `server/compose.js` never passed `profiles`. Provider history and the provider session linker take every Codex home from `profiles`; without it they read only the default `~/.codex`. Codex sessions in the other two Codex homes had no history row on the phone, so a live pane fell back to the title "Live session" with nothing to open, and finished sessions in those homes were missing. Claude and Cursor rows were unaffected.

## Live evidence (read-only)

1. The daemon had 9 panes, 4 of them Codex, all with an `agent_session` (the pane-to-session link was fine). Two panes shared one session id, so the phone showed three rows.
2. The live phone server (`sidebar:get-state` over loopback) returned 3 Codex rows titled "Live session" with real ids, no history row and `home: null`; the 2 Claude rows were named. That reproduces the screenshot.
3. All three Codex rollouts sit in the same non-default Codex home.
4. `createProviderHistory().listSessions()` over the real stores:

| Options | Rows | Codex rows | The three live ids |
|---|---|---|---|
| Phone's (no `profiles`) | 667 | 435 | all missing |
| Desktop's (`profiles`) | 4,311 | 4,079 | all found with real titles |

5. The phone server awaits its first provider scan before it listens: 98 s cold across three homes, 455 ms from a copy of the desktop's facts cache. Passing `profiles` alone would have made every phone-server start sit about 100 s not listening, so the cache options went in with it.

## Change

`compose.js` now passes the four provider options `main/index.js` passes: `profiles`, `providerMetadataFile`, `providerFactsCacheFile`, `delegationScanCacheFile` (all under `config.paths.cacheDir`). The cache files are shared with the desktop on purpose: entries are validated against file size and mtime and each write is a whole-file rename, so a race costs a rescan. The phone's accounts provider and capability menus were checked and left alone.

## Proof

- `app/test/server/compose-provider-homes.test.js` (new, 5 tests): drives the real `composeServer`, bridge and provider history over real rollout files in two synthetic Codex homes, with a fake daemon (`app/test/support/fake-sessiond.js`, answers `list`, `dormant`, `health` on an isolated pipe). Against the unfixed `compose.js`, 4 fail for the right reason and the control passes; fixed, 5 of 5 pass.
- `app/scripts/drive-phone-codex-rows-win.js` (new): scratch build of the phone bundle (`--configLoader native`, no `app\dist-web` written), headless Chromium 430x932. Before: two "Live session" rows and no finished second-home Codex session. After: seven named rows; tapping a second-home Codex row opens its conversation with the Codex label and model chip. Screenshots in the worktree's `_astra\shots\` (scratch).

| Filter | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|
| new spec alone | 5 | 5 | 0 | 0 |
| `server` | 149 | 146 | 0 | 3 (existing Windows platform skips) |
| `sidebar-bridge` | 11 | 11 | 0 | 0 |
| `sidebar` | 90 | 90 | 0 | 0 |
| `provider-history` | 10 | 10 | 0 | 0 |
| `provider-session-link` | 13 | 13 | 0 | 0 |
| `startup-scan-caches` | 4 | 4 | 0 | 0 |

## Coordinator review (Claude, 2026-10-31)

Checked the four options against `main/index.js` (same names and paths; the desktop nulls the two scan caches only in E2E mode, and the phone server has no E2E mode of its own). `path` is already imported in `compose.js`. Accepted.

## Not verified / open

- Not yet seen on the real phone: needs the phone server restart.
- The 455 ms warm start came from a scratch copy of the desktop's cache. If that cache is cold (desktop never ran, cache deleted), a phone-server start waits about 100 s before listening.
- Pre-existing: `rememberKeeperIdentity` writes the whole metadata map from a copy loaded once per process, so the desktop and phone server can overwrite each other's newest entries. The phone's linker writes only for panes with no `agent_session` yet, so the window is small.
- The phone server now holds about 4,300 history rows in memory, like the desktop; wire size is unchanged (`projectRail` still sends live rows plus the 48 h window).
- The drive harness and fake daemon are Windows-only (named pipes).
