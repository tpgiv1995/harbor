# Brief W1: crawl the competitors' full docs and changelogs (Firecrawl)

Read C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\briefs\_context.md first.

Use the Firecrawl connector tools (firecrawl_map to list every page of a site, then firecrawl_scrape or a batch scrape to read them; firecrawl_search for anything else). When Firecrawl fails on a page (403, 404, "not supported", empty body), open it in god Chrome (rules in _context.md) and read it there; say in the report which pages needed that. A page that fails both ways goes in a "could not read" list with the error.

Sites, crawl each docs site FULLY (every page from the map, not just the index), plus every changelog entry from 2026:
1. Orca: https://orca.dev/docs (all pages) and https://github.com/stablyai/orca releases. Last pass could not read several orca.dev pages (404/403).
2. Paseo: its docs site and https://github.com/getpaseo/paseo releases.
3. T3 Code: https://github.com/pingdotgg/t3code docs/ folder (every .md) and releases.
4. Paradev (formerly Superset): https://docs.paradev.com, https://paradev.com/changelog (every 2026 entry), https://paradev.com/blog.
5. Conductor: https://www.conductor.build/docs and https://www.conductor.build/changelog (every entry; last pass read five).
6. Emdash (generalaction/emdash) docs and releases; Nimbalyst docs; Vibeyard (elirantutia/vibeyard) README and docs.

For each product produce: a COMPLETE feature inventory grouped by area (sessions, review and git, recovery, plan/tasks, search/history, cost/limits, automation, phone/notifications, orchestration, settings/onboarding, performance), each feature with a one-line description and its source URL.

Then, for each of these ten items, write "how they built it" from their docs (data source, UI, settings, limits, failure handling), across all products that have it:
(1) changes/review pane with line comments sent to the agent; (2) search inside sessions; (3) plan/task/goal panels; (4) auto-resume after usage limit; (5) per-session cost; (6) rewind and fork; (7) needs-you inbox and jump-to-next; (8) scheduled runs; (9) phone approvals and push; (10) memory/perf with many terminals.

Finish with: features none of the earlier report's sections mention (new gaps for Harbor), each with source and why it matters.

Write the report to: C:\dev\harbor\docs\orchestration\2026-11-26-oss-survey\deep\W1-competitor-docs.md
