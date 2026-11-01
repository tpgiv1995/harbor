Stages 1 and 2 are committed in `C:\dev\.orch\harbor\lane-pool-1101`. The worktree is clean.

- `282873f441dc`: core, CLI, design note and tests.
- `9bc42834293e3`: [handoff report](C:/dev/.orch/harbor/lane-pool-1101/docs/orchestration/2026-11-01-workspace-pool/reports/core.md).

`npm test -- lane`: **37 passed, 0 failed, 0 skipped, 0 cancelled, 0 todo**. The real Windows held-file test passed. No production pool or real lane state was touched.

Invoke `node C:\dev\.orch\harbor\lane-pool-1101\bin\harbor-lane`. Every command prints one JSON object. Below, **capability** means `--lane --token --generation`.

| Command | Contract |
|---|---|
| `init-repo` | `--repo --path --pool-root --size`; optional JSON `--allowlist`, `--max-writes`. Registers N ordinary slots plus integration slot 00. |
| `lease` | `--repo --lane --base --type`; branch required for write/integration. Optional `--owner-pid`, JSON `--runtimes`. |
| `resume` | Capability; optional owner/runtime options. Restores the recorded tip into the original slot and renews the capability. |
| `status` | Returns repositories, slots, lanes and sessions; quarantines lost owners. |
| `checkpoint` | Capability plus `--final`. Seals a clean commit without releasing. |
| `release` | Capability plus `--final`. Checks, preserves the durable ref, detaches and frees. |
| `recover` | `--repo --slot --token --generation`. Frees a quarantined slot only after ownership and release checks pass. |
| `quarantine` | Capability plus `--reason`. Preserves and holds the slot. |
| `env-begin` | Capability. Invalidates the installation receipt and returns the expected fingerprint. |
| `env-ready` | Capability plus `--fingerprint`. Records successful installation after a matching begin. |
| `bind-session` | Capability plus `--provider --config-home --session`. Saves the durable mapping. |
| `resolve-session` | `--provider --config-home --session`. Returns the mapping and current lane capability. |
| `recover-lock` | `--name global` or `--name repo-<id>`. Requires a provably dead lock owner. |

Exit codes: **0** success, **1** runtime/I/O error, **2** invalid arguments, **3** admission/contention refusal, **4** safety refusal.

Before wiring launchers, Claude needs to choose the shared state directory, pool sizes and write cap with verification headroom; the long-lived owner process; runtime/install fingerprint inputs; and coordinator checks for review, evidence and stopped descendants. Launcher adapters, guards, Dev Drive and retirement remain outside this change.