# codex release notes 0.164.0 to 0.165.0 (12 lines)

## 0.165.0

### New Features
X1. [0.165.0] Added a built-in Google Cloud Vertex AI provider, configured with `model_provider = "gcp"`. (#56265)
X2. [0.165.0] Added GPT-6.1 Terra to the model catalogs. (#57337)
X3. [0.165.0] Added a repository filter to the session picker and directory grouping to the agent command center, making it easier to navigate sessions across linked worktrees. (#56308)
X4. [0.165.0] Added experimental attached thread forks to the app-server API. (#56351)
X5. [0.165.0] Enabled reasoning effort changes during a conversation by default for supported models. (#56163)
X6. [0.165.0] Enabled memory v2 by default for fresh profiles and added support for importing external-agent memories into it. (#56211, #56414)

### Bug Fixes
X7. [0.165.0] Fixed fresh TUI sessions to honor the server’s default approval reviewer when no explicit override is provided. (#56090)
X8. [0.165.0] Kept TUI preferences editable and immediately applicable when execution settings are invalid. (#56091)
X9. [0.165.0] Cancelled remote MCP tool requests when their local response futures are dropped. (#56132)
X10. [0.165.0] Prevented queued agent messages from restarting work after an interrupt or a switch to Plan mode. (#56330)
X11. [0.165.0] Stopped retrying when a provider reports that a model was not found, preserving its error message. (#56445)
X12. [0.165.0] Closed a marketplace URL validation gap that could allow Git to connect to a different host than the one checked against allowed patterns. (#56263)

## Appendix: merged pull requests in rust-v0.164.0...rust-v0.165.0 (68), scan for hidden contract changes

P1. #56081 Cache decrypted Codex auth and managed secrets
P2. #56090 Honor server approval reviewer defaults on fresh TUI startup
P3. #56091 Keep TUI preferences editable when execution settings are invalid
P4. #56097 Prepare TUI startup to accept multiple backend sessions
P5. #56124 Forward Guardian reviewer events to parent raw-event subscribers
P6. #56127 Avoid blocking EMA auth status checks on account refresh
P7. #56132 Cancel MCP tool requests when response futures are dropped
P8. #56133 Defer agent mail after empty final answers
P9. #56139 Fix the MCP auth status test's IdP OAuth configuration
P10. #56153 Preserve safe enterprise MCP authentication error details
P11. #56154 Add managed network review domains before allow rules
P12. #56163 Enable reasoning effort overrides by default
P13. #56182 Add AWS SigV4 signing to network proxy MITM hooks
P14. #56210 Stabilize the marketplace staging cleanup test
P15. #56211 Default fresh memory profiles to v2
P16. #56214 Remove the `u64` cast from WSL DrvFS detection
P17. #56220 Use cargo_bin in the Windows sandbox manifest test
P18. #56222 Consolidate Bazel CI setup into `prepare-bazel-ci`
P19. #56224 Reuse current model context across paginated resume config loading
P20. #56233 Make Opus encoder test timestamps follow sample time
P21. #56234 Emit prompt telemetry only after hooks accept input
P22. #56236 Make the code mode yield/resume test yield explicitly between phases
P23. #56246 Bump Bazelisk to 1.30.0 in the Bazel CI setup action
P24. #56247 Consolidate Rust unit tests under dedicated test modules
P25. #56248 Bump uv to 0.13.5 in CI and release workflows
P26. #56250 Avoid redundant settings checkpoints when resuming threads
P27. #56261 Isolate V8 source dependencies and their C++ runtime settings
P28. #56263 Reject backslashes in HTTP(S) marketplace URL userinfo
P29. #56265 Add a built-in Google Cloud Vertex AI provider
P30. #56266 Preserve MCP disable reasons across runtime overlays
P31. #56272 Upgrade Python SDK model generation to datamodel-code-generator 0.64.0
P32. #56274 Wait for cloud config refresh cancellation in loader lifetime tests
P33. #56277 Support bounded request bodies in AWS SigV4 signing
P34. #56278 Add negotiated network policy metadata support for MCP calls
P35. #56280 Group consecutive transcript prompts into one background block
P36. #56284 Scope model catalogs and caches by thread originator
P37. #56286 Bump `@modelcontextprotocol/sdk` to `1.32.0`
P38. #56288 Pin Linux artifact signing to Cosign v3.1.4
P39. #56290 Lock Python release build tools with uv
P40. #56292 Fix MCP cancellation tests to use the metadata callback
P41. #56293 Use fixed-token auth fixtures in Vertex tests
P42. #56295 Decouple managed configuration loading from ChatGPT authentication
P43. #56297 Mark built-in dummy credentials and strengthen collision checks
P44. #56301 Add TLS forwarding tests for MITM SigV4 requests
P45. #56302 Add hook configuration to environment attachments
P46. #56304 Add support for environment-scoped managed hooks
P47. #56308 Separate directory and repository scopes in the TUI
P48. #56309 Support model-specific writable-root permission wording
P49. #56312 Track accepted conversation history in rollout traces
P50. #56313 Apply model catalog overrides to history, notes, and context tools
P51. #56314 Add managed configuration loaders for custom config servers
P52. #56330 Make agent-message wakes respect interrupts and Plan mode
P53. #56342 Match rollout trace image content across request snapshots
P54. #56343 Run environment hooks on their owning executors
P55. #56351 Add experimental attached thread forks
P56. #56364 Allow callers to set the thread source for sampling
P57. #56371 Make the Guardian review timeout configurable
P58. #56414 Support memory v2 in external-agent memory imports
P59. #56439 Update `ctutils` from 0.4.2 to 0.4.5
P60. #56445 Treat model-not-found provider errors as terminal failures
P61. #56453 Make the Realtime V2 background-agent steering test deterministic
P62. #56454 Make sandbox mount cleanup tests tolerate file descriptor reuse
P63. #56459 Add Guardian V3 feature configuration
P64. #56460 Add Guardian v3 local board helpers
P65. #56461 Add silent append support to message boards
P66. #56462 Prevent memory imports from racing with consolidation
P67. #56465 Add experimental thread memory summary reads
P68. #57337 [0.165.0-alpha.1.2] Backport GPT-6.1 Terra to the model catalogs
