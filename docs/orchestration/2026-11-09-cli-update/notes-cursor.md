# Cursor Agent 2026.10.22-27dcf5f to 2026.11.05-86047df

Cursor publishes no machine-readable release notes, so this is a bundle comparison. Reviewed package SHA-256: `c886cf57681e596163318814d1ec559b10ce81ca2d050aab7a6ad12592840184` (79,418,789 bytes).

| Contract | Result |
|---|---|
| Root launchers and `node.exe` | `cursor-agent.cmd`, `cursor-agent.ps1` and `node.exe` byte-identical to the installed ones. |
| Flags Harbor passes | `--force`, `--trust`, `--disable-auto-update`, `--resume`, `--api-key` all still registered; `--api-key` and `--version` moved to a shared option builder. New: `--grok-bot`, `--session-token-file` (private workers only). |
| Keyless run deletes an API-key sign-in | Same logic (`auth-status.ts`: login mode with a stored apiKey clears it). `cursorAuthEnv` still required. |
| `models` output | Same format, 277 lines on both builds through the real key path. |
| Pane launch | `cursor-pane-proof.cjs` passes on the scratch 2026.11.05 build: banner, no trust screen, correct folder. |
| Updater | Native waiters now pass `windowsHide`, plus a new `versions/pending-launchers` folder. Not run. Harbor's version picker filters by the version pattern, so that folder is ignored. Land by hand per doctrine. |

**Blank-pane wait, pre-existing.** Three saved runs of the new build drew the banner after 35, 38 and 45 s (the proof's figure includes about 4 s of its own settle and poll); the old build had not drawn by 60 s in one run under load. Both are at or past the 45 s budget a first send and a resume had. The boot budget is now 90 s, a judgment (about twice the saved new-build runs), and the default of `waitForProviderReady`, so the Resume buttons get it too. A pane still blank at 90 s is refused, never typed into (`PROVIDER_NEVER_DREW`).
