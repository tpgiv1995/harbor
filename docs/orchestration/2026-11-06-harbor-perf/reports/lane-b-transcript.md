# Lane B: transcript provider resource bugs (2026-11-06)

Status: done, uncommitted in the working tree. I did not run git add, commit, stash, reset or checkout, and I edited only the files listed below.

## Files
- `app/src/main/providers/transcript.js`
- `app/src/main/providers/image-store.js`
- `app/test/providers/transcript-perf.test.js` (new, 16 tests)
- `app/test/providers/transcript.test.js` (one assertion changed)

`session-owner.js` was not needed: the beacon cache lives in the entry.

## B1 image store
- `image-store.js:38` cap lowered from 384 MB to **128 MB**. I measured instead of taking the suggested 96 MB. I replayed the 14 most recently written transcripts over 8 MB, read-only. A window keeps its newest 64 prefix images plus the images in its 1 MB tail: 0 to 23 MB per window, 104 MB for all 14 together. 96 MB would already evict the least recently used window's pictures. Nothing re-resolves an evicted image (the renderer shows "Image no longer loaded. Reopen this window to see it."), so I kept 128 MB for headroom. The fallback is unchanged.
- `image-store.js:80` new `has(id)`, which counts as a use. The seed cache uses it.
- `transcript.js:957-1006`: `imageFromPart` can defer. Inside `applyLineDeferred` it returns `{mediaType, id: null, size}` with the base64 in a non-enumerable symbol. `commitImageRef` hashes and stores the image only for blocks that are kept.
  - The skipped-prefix scan stores only the newest 64 plus the opening (`settlePrefixImages`, line 1965).
  - The paging chunk (`readChunkEndingAt`, `commitBlockImages` at line 2318) stores only the returned blocks.
- Live parsing stays eager on purpose. Almost everything it parses survives, and a yield between parse and emit must never expose an id the store cannot serve.
- Real 343 MB session: the old code held 193 images / 55 MB after one open, the new code 70 images / 18.7 MB.

## B2 poll emits
- `emitUpdate` (line 2559) takes `{onlyIfChanged}`. Both non-replace emits in `readNew` use it (lines 2711, 2808). An empty payload with a header JSON identical to the last one sent is dropped (`entry.lastHeaderSig`).
- The header is still rebuilt on every read, including from the clock. A change that comes only from time passing (the 180 s shimmer limit, a beacon aging out) differs from the last header sent, so it goes out the moment it changes.
- Beacon read cached per entry for 30 s (`beaconCacheMs` option, line 2465; the entry's first read never uses the cache). Tee keyed by mtime and size (line 2647); the freshness verdicts still use the clock.
- `transcript.test.js`: the "Settled: a later refresh sends nothing" check used `updates.at(-1)`. It now asserts that no update was sent.

## B3 prefix re-stream
- `getPrefixSeed` (line 2130) replaces `readPrefixState`, which was not exported. The scan is a resumable state per (provider, path): the real parser, the line counter, the images list and the opening prompt.
  - Same file and same end offset: nothing is read.
  - The file only grew: only [oldEnd, newEnd) is streamed into the same parser. This is exact, not approximate, because the old end is a record boundary, so the queue state and line numbers carry over.
  - Anything else scans from byte 0: another file, a rewrite, a shorter offset, an end that is not after a newline, or a cached picture the store no longer holds.
- File identity is dev:ino plus SHA-1 of the first 4 KB and of the last 4 KB before the cached end.
- Bounds: 4 entries and 8 MB. Calls for one file are serialized. Each caller gets a `structuredClone`d copy, because the live parser mutates the blocks it receives. Queue references travel as copies and are mapped to the live blocks in `seedPrefixImages` (line 2489).
- Only desktop (unwindowed) opens use this. The phone's windowed opens never scanned the prefix.

## Proof
- New tests: `node --test test/providers/transcript-perf.test.js` passes 16/16.
- Two-sided: the same file run against HEAD's `transcript.js` and `image-store.js` in a temp copy fails 15/16. The paging, idle-poll, shimmer, beacon and tee tests fail on assertions. The cap test and the B3/prefix tests fail on the old numbers or missing APIs. The "owner died still emits" test passes on both sides, as a regression guard.
- Equivalence: merged seeds at five cut points, including cuts inside a pending queue entry, deep-equal a no-cache full scan, source marks included.
- `npm test -- transcript image-store`: 173 tests, 171 pass, 0 fail, 2 skipped (was 157 / 155 / 0 / 2).
- CI gate `npm test -- --exclude daemon --exclude bin`: 3063 tests, 3052 pass, 0 fail, 11 skipped.
- Real replay of the 352 MB `280ab966` transcript, read-only:

| Open | New | HEAD |
|---|---|---|
| 1st (cold) | 1497 ms | 1518 ms |
| 2nd (reload) | **11 ms** | 1380 ms |
| 3rd | **8 ms** | 1529 ms |

  - After the file grew, the seed streamed only the 59 MB between the old and new end, in 241 ms, versus 1132 ms for the cold scan to the first cut.
  - The `open` payload (blocks and header) is byte-identical to HEAD's: the same SHA-1 of the 144 blocks and of the header.

## Not done or caveats
- The live path still stores images eagerly.
- `docs/claude/conversation.md` still says "384 MB". I did not edit it because it is outside my file list. It needs "128 MB", the deferred-image rule, the seed cache and the emit-only-on-change rule.
- `readPrefixImageBlocks` was already dead code and is left alone.
- The phone server process was not exercised live. Its provider is the same module, so it gets B1 and B2 on restart.
