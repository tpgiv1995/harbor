# Codex release notes, 0.165.0 to 0.166.0

Numbered from ~/.harbor/cli-updates.json (checked 2026-10-31T22:38:54.435Z), installed 0.165.0, target 0.166.0. Chip flags: models, resume, visibility, sandbox, daemon, rollout.

## 0.166.0

X1. Added keyboard-driven transcript selection with word, line, and page motions, integrated search, and configurable shortcuts. (#57221, #57222, #57223, #57224)
X2. Rendered Markdown consistently in async questions, choices, answers, and transcript replies. (#57259, #57292)
X3. Added GPT-6.1 Terra to the bundled, Vertex AI, and Amazon Bedrock model catalogs. (#57293)
X4. Added `codex queue --resume` to resume unloaded threads after queueing a message. (#57232)
X5. Added clearer safety-block explanations and selectable safer follow-up prompts in the TUI. (#57363, #57365)
X6. Added `codex doctor --network-only` for focused configuration, connectivity, and WebSocket diagnostics. (#57606)
X7. Preserved acknowledged approval and permission settings when resuming or forking threads. (#57227)
X8. Preserved local image attachments when restoring killed composer text. (#57502)
X9. Fixed standalone release cleanup on macOS when installations are in use or paths contain non-ASCII characters. (#57503)
X10. Restored spawned descendant threads when unarchiving their parent. (#57635)
X11. Fixed app-server thread startup and shutdown races and released completed runtimes promptly. (#57787, #57788)
X12. Improved TUI reconnection recovery, including offline `/quit` and `/exit` handling. (#57820)
X13. Preserved reasoning-token accounting across resume and fork to avoid premature compaction. (#57839)
X14. Switched Bazel to source-built V8 with target-matched Rust bindings and native Windows MSVC archive support. (#57164, #57269, #57644, #57832)
X15. Shipped the standalone executor in canonical CLI and app-server release packages. (#57837)
X16. Standardized development and release builds on Node.js 24.22.1 and Rust 1.95.0. (#57168, #57373)
