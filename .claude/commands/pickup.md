---
description: Load the most recent session handoff document (written by /handoff) and orient. Does not start executing work, waits for direction.
argument-hint: [optional filename or partial filename to load a specific handoff]
---

Load the most recent session handoff document and orient. Do not start
executing work, wait for direction.

## Steps

1. **Find the newest handoff.** Look in `.claude/handoffs/` for files
   matching `handoff-*.md`. Pick the newest by filename sort (filenames
   are timestamped `handoff-YYYY-MM-DD-HHMM.md`, so lexicographic sort =
   chronological).

   If the folder doesn't exist or is empty, say so plainly: "No handoff
   documents found in `.claude/handoffs/`. What would you like to work
   on?", then stop.

2. **Read the handoff in full.** Top to bottom. Do not skim.

3. **Confirm repo state matches.** Run in parallel:
   - `git status`
   - `git log --oneline -5`
   - `git branch --show-current`

4. **Detect drift** between the handoff and reality:
   - Commits added since the handoff was written (compare `git log` to
     whatever the handoff describes as the head state)
   - Uncommitted changes that don't match the handoff's description of the
     working tree
   - Branch changes
   - Files mentioned in the handoff's to-do list that have since been
     modified

5. **Respond with a brief orientation.** Format:

   ```
   **Loaded:** `.claude/handoffs/handoff-YYYY-MM-DD-HHMM.md`

   **Where things stand:** <3-5 line summary in plain prose>

   **Top next actions:**
   1. <first to-do item, condensed>
   2. <second>
   3. <third, if relevant>

   **Drift detected:** <only include this section if there is drift; otherwise omit>
   ```

6. **Stop.** Do not start executing any to-do items. Wait for the user to
   direct the next move.

## Notes

- Be terse. The user wrote (or received) the handoff; they don't need it
  re-summarized in detail, just enough to re-anchor.
- If drift is significant (e.g., the handoff says "nothing committed" but
  there are 5 new commits), flag it prominently so the user knows the
  handoff may be stale.
- `$ARGUMENTS`, if provided, is an optional filename or partial filename to
  load a specific handoff instead of the newest. Match against files in
  `.claude/handoffs/`. If no match, fall back to newest and note that the
  argument didn't match.
