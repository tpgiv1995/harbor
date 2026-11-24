# Published visuals

The hero and gallery keep the existing dark style and 1760-pixel presentation
width. Desktop captures use a 1600 by 1000 layout at double scale; the phone
composition contains two 430 by 932 screens. Every session and document comes
from the synthetic corpus in `app/scripts/lib/demo-corpus.cjs`.

PowerShell, replacing the checkout path:

```powershell
Set-Location 'C:\src\harbor\app'
npm run build
npm run build:web
node scripts/capture-screenshot.js
node scripts/capture-mobile-shot.js
node scripts/make-hero.js
```

Run one capture at a time. Electron and Playwright come from the app install;
FFmpeg scales the PNGs and creates the demo video, and Typst creates the demo
PDF. Missing FFmpeg or Typst can reduce the gallery or leave larger images;
review the log and the output dimensions before committing.

Windows skips Xvfb. Linux retains a separate Xvfb display. Every Electron
window is created hidden with offscreen rendering, including HTML composition
windows. The capture entry point blocks native show, focus, maximize and
restacking calls before importing the product. A headed capture is rejected.

Each run owns an `app/verify/harbor-*` fixture root. It relocates HOME,
USERPROFILE, HOMEDRIVE/HOMEPATH, the Electron home path, provider config homes,
app-data, temporary files, configuration, context, documents and
daemon storage. Windows uses a fixture-specific named pipe, not a filesystem
socket. Do not point these scripts at real histories or live daemon state.

The desktop run stages the entire set and publishes only after every expected
shot exists. Text checks reject identities and absolute paths, but cannot read
canvas pixels. Open every resulting PNG and compare it with the previous
version. Check titles, paths, clipping, feature states and captions. A successful
command alone is not visual approval.

The lesson from the Windows port: fixtures must encode Windows path separators,
and Node must execute extensionless CLI files explicitly. The old captures also
waited for session rows before expanding collapsed groups. Wait for the project
groups first, expand them, then assert the complete provider corpus is present.

The same hero command writes docs/social-preview.png at 1280 by 640 for
manual upload in GitHub repository settings. It combines the wordmark and
tagline with a crop of the current desktop capture. Run the desktop capture first.

Windows can clamp a BrowserWindow's initial dimensions. Set the content size
after creation and assert the actual CSS viewport as well as the pixel scale.
Otherwise a successful screenshot can crop both phone bezels and captions.

The September visual review found that the renderer itself seeds Opus 4.8 on
a fresh profile. Matching a local setting did not establish that the setting
was read. Capture logs now include resolved homes, provider config reads and
the renderer default alongside the fixture settings. Electron home and the
Windows home-variable pair are explicitly relocated; a capture-only filesystem
guard rejects account-home access through Node filesystem APIs. This is an
application guard, not an OS sandbox. Review its refusal log as well as the PNGs.

The phone capture opens the real composer tools tray to show its microphone and
voice buttons. It never records audio, starts voice or supplies an API key.
Orchestration fixtures populate notes and done_when, and the capture expands
a completed batch to show the result excerpt. The current panel has no separate
WORKERS strip. The composer caret sits in the bold heading so the formatting
state matches visible text.

The phone's open-session ID array must stay stable while the active session
does. Recreating it on every render repeatedly reopened the voice transcript
subscription, whose replacement pushes rendered the composer again. The visual
review reproduced 12,484 opens and 12,482 closes during one capture; memoizing
the array reduced that to two opens and zero closes. The phone capture now
checks that count and requires both conversation sides to remain visible.

Set HARBOR_TAILNET_LOGINS=none in captures. Leaving it unset makes the phone
server ask Tailscale for this workstation's real login, even with HOME relocated.
The shared capture environment disables that discovery and uses its fixture
token. Memory telemetry is also synthetic; the memory chip itself is existing
TitleBar UI, and plan-usage meters remain in the rail.

The November 2026 recapture (the first since September) failed four ways
before it ran, and each failure is now either fixed or checked:

- Run from a checkout outside `C:\dev\.orch`. The rail files any cwd with a
  `.orch` segment under Orchestration, so a capture from an orchestration
  worktree shows every demo session in one "Orchestration" group.
- Two readers ignore HOME on purpose and read the real profile
  (`os.userInfo`), because workers in shadow homes write there: the Team
  chart's launch records and the workspace-pool state. The capture sets
  HARBOR_TEAM_LAUNCHES_FILE and HARBOR_LANES_DIR inside its root; the home
  guard caught the first one as a blocked read of the real
  `~/.harbor/team-launches.jsonl`.
- The Team chart lists workers from the machine's process table, which no
  HOME isolates, so an isolated Harbor charted the real workers running beside
  it, with their real project names. HARBOR_TEAM_NO_PROCESS_SCAN=1 (set by the
  capture) leaves the table unread; `test/providers/team-process-scan.test.js`
  pins it. The Orch shot is the Team chart itself (what the Orch view opens on),
  drawn from invented workers: `seedTeam` in demo-corpus.cjs writes a lead, the
  workers it launched and their headless transcripts, and HARBOR_TEAM_PROCESS_FIXTURE
  hands them to the chart in place of the process table. An earlier attempt
  clicked through to the batch list, which is not the view anyone opens.
- Replies carry no "Claude" or "Codex" line since the 2026-11-09 layout, so
  the every-provider check reads each window's model chip (`data-provider`)
  instead of the stage text. A fresh profile stores no new-session default and
  shows the newest Opus the options offer.

When the app exits before its first window, the capture now prints Electron's
own output and the original error; teardown no longer replaces it with a
Playwright error about a closed connection.

The 2026-11-24 recapture (Gemini as the fourth provider) found three more:

- The phone capture's root lives in `~/harbor-capture`, not `app/verify`.
  The phone folds every folder under `<drive>:\dev\<name>` into that project
  (`shared/project-root.cjs`, rule 1), and `app/verify` always sits inside the
  checkout, so the six demo projects drew as one "demo" group with the
  capture's own path on every row. A Temp folder does not work either: the
  phone hides those as scratch and showed "No sessions match." The capture
  deletes the folder when it finishes; `test/capture-root.test.js` pins the
  rule.
- The phone keeps each chat's place and moves only on a person's own input
  (wheel, pointer, keys), so the capture scrolls to the top with a real mouse
  wheel; a programmatic `scrollTop` is put back.
- The Team chart's invented workers each run in their own sub-folder. Two in
  one folder is Harbor's real "two writers" warning, which put a warning badge
  on three cards; the capture now refuses a picture with any badge, or without
  a card for each provider.
