# Transcript audit lessons

Audited and repaired in C:\dev\.orch\harbor\astra-audit-1104\app\src\main\providers\transcript.js. Regression evidence is synthetic in C:\dev\.orch\harbor\astra-audit-1104\app\test\providers\transcript-audit.test.js. Real inputs and comparisons remain in this run folder's ignored private directory.

- A byte window must begin at a complete JSONL record. Cutting a record made both the prefix and tail discard it. Initialization and truncation recovery now share backward line alignment. The opening scan stops at the actual prefix boundary.
- Prefix retention reserves forty recent human prompts independently of peer traffic. The opening and prompt images remain separate retention concerns. This is still bounded history, not full scrollback.
- Prefix bubbles must retain queue state across the boundary. Copying blocks alone stranded waiting badges and image attachments. Opening deduplication uses source record identity, not equal text and timestamp.
- CLI queued_command prompts can be strings. A text-only attachment is a recoverable message when its enqueue is absent. Idle dequeue followed by the matching normal user record updates one bubble; an independent repeated user record remains separate.
- Image payload eviction must preserve accompanying human text and publish the payload removal. Image attachments happen after push(), so the cap is enforced at record completion too. Eviction releases queue references to removed blocks.
- A push can immediately evict its own lower-priority peer block when human prompts fill the window. Queue lookup registration must check membership after push, not assume its return value survived.
- The shared reducer correctly applies removals, replacements and changes by key. It cannot recover a block that the provider omitted or deduplicate different keys assigned to the same send.

The desktop and current phone UI have no page-back caller. The provider has a paging implementation, but the existence of that function does not prove reachable scrollback. The 240-block limit, forty recent prefix prompts, image-only eviction, syntax-based user filtering and old sends already truncated in the raw transcript remain limits. No renderer or live application validation was authorized for this audit.
