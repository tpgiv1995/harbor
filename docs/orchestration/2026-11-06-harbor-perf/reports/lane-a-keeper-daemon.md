# Lane A: keeper memory and daemon `list` polling (2026-11-06)

Nothing was committed, staged, stashed or reset. All changes are in the working tree. The live daemon, sessions, app and phone server were not touched (every test uses an isolated store).

## A1. Keeper scrollback and per-chunk encoding

- `app/src/daemon/screen.js:78` adds the exported constant `MODELED_SCROLLBACK_LINES = 2000`, now the `ScreenModel` default (was a literal 10000). The comment states why.
- Why 2,000: the largest read anywhere is 200 lines (`terminal-bridge.js` `BACKFILL_LINES`; `readPane`'s default in `client.js` is also 200; session-send reads 90 or fewer; sidebar-bridge 120). I checked every `scrollback:` and `lines:` request in `app/src`, `src/server` and the scripts. 2,000 is 10x the largest request.
- `app/src/daemon/keeper.js:173`: `event()` returns at once when no observer is attached. `keeper.js:238`: the pty data handler builds the base64 copy and the event object only when `observers.size > 0`. The wire format observers receive is unchanged (`{id, type:'frame', text, bytes}`).
- Applies only to keepers spawned after a deploy. A running keeper keeps its 10,000-line buffer and its old data handler until its session ends. `keeper.js` is read from disk at each spawn, so no daemon handover is needed. I did not measure the memory gain on a live keeper, because that would mean touching live sessions.

## A2. Shared snapshot poll

- `app/src/main/session-daemon/client.js:22-70` adds `SharedSnapshotPoller` and `sharedPollers`. A `SessionSubscription` created without `pollIntervalMs` joins the poller for its daemon (key: the client's socket path plus its home, because project labels depend on home; an owner with no socket path, such as a test double, is its own key).
- Each tick makes one `owner.snapshot()` request. A tick that arrives while the previous request is outstanding is skipped, so there is never more than one request in flight. The result goes to every member's `_apply()`. Each member diffs against its own previous panes and emits its own events, including `pane.resized`.
- A closed subscription leaves the set. The timer stops when the last member leaves, and a later subscriber starts a fresh poller. The cadence is still 1 s.
- A subscription with its own `pollIntervalMs` keeps its own timer, and `_poll()` still fetches for itself (the existing tests rely on both).
- A fetch error is emitted to every member. A member that throws, or has no `error` listener, cannot stop the others being served.
- One behaviour change: members receive the same `pane` object references from the shared snapshot, where each used to get its own. No consumer in `src` mutates them.
- Scope: this removes the duplicate fetches inside one process (three per Harbor process, two per phone server). Separate processes still poll separately, so expect about 2 per second instead of 5. It does not change the daemon's `list` cost itself.

## Tests added

- `app/test/daemon/screen-scrollback.test.js` (3): the bound holds at 5,000 lines written and a 200-line read still returns 200 lines; a 10,000-line control keeps more than 2x the bound; the constant is at least 5x the largest read (parsed from `terminal-bridge.js` and `client.js`).
- `app/test/daemon/keeper-frame-encoding.test.js` (1): the real isolated daemon and a real keeper, with a `--require` hook counting base64 encodings inside the keeper. Zero with no observer. After `observe`, frames keep `text` and `bytes` (decoded bytes equal text), and the count moves, which proves the hook is live. Zero further encodings after `unobserve`.
- `app/test/main/session-subscription-shared-poll.test.js` (7, mocked timers): 3 shared subscriptions cost 1 request per tick against 3 for private timers (the control); per-subscription events including `pane.resized` and `pane.closed`; close semantics; one request in flight; error fan-out; separate daemons poll separately; direct `_poll()` still works.
- Two-sided proof: I restored the HEAD versions of `keeper.js`, `screen.js` and `client.js` in turn (then put mine back). Old keeper: "the keeper encoded 4 chunks with no observer attached". Old screen: constant undefined, 4977 lines kept. Old client: 5 of 7 shared-poll specs fail (the other two are the event-semantics and direct-`_poll` specs, which are meant to pass on both).

## Results

- `npm test -- daemon/screen`: 25/25 pass. Scoped runs pass: `daemon/sessiond` 9/9, `main/session-daemon` (session-daemon-live) 7/7, `main/dialog-size` 18/18, `daemon/keeper-frame` 1/1, `main/session-subscription` 7/7, `daemon/provider-keeper` 7/7. The runner accepts only one filter per call, so I ran them one at a time.
- CI gate `npm test -- --exclude daemon --exclude bin`: 3041 tests, 3029 pass, 1 fail, 11 skipped. The failure is `test/renderer/session-tile-ask.test.js` "Ask card poll re-arms when sessionId changes after a provisional upgrade". It is a source-regex check on `app/src/renderer/stage/AskCard.jsx`, which has another session's uncommitted edits (10 lines changed, outside my allowed files). Nothing of mine is involved, and I did not touch it.

## Not done

- No live memory or request-rate measurement (the live daemon was off limits). The 266/min and 53-194 MB figures are from the brief. Verify after the next deploy by counting `list` requests and by keeper commit on keepers spawned afterwards.
- No docs/claude/sessiond.md doctrine bullet was added (outside the edit list). Suggested text: the 2,000-line bound and why, and the shared poll.
