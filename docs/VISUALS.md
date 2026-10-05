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
