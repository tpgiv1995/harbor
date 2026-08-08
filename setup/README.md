# Setup

Open the folder for the machine you are on.

| Platform | Status | Start here |
| --- | --- | --- |
| **Linux** | Validated end to end | [linux/README.md](linux/README.md) |
| **Windows** | Session lifecycle proven directly; the app itself never launched | [windows/README.md](windows/README.md) |
| **macOS** | Never run on real hardware | [macos/README.md](macos/README.md) |

Those short phrases mean exactly what they say, and the difference matters more
than the install steps do.

**Linux** is the platform Harbor was built on and the one the gate runs against:
the full unit suite over three consecutive runs plus a two-run Playwright suite,
all green, plus a cold-start drive that clones the repo to an empty home
directory and walks the first-run wizard as a new user. If something is broken
there, it is a bug and it is worth reporting.

**Windows** is not upstream-blocked any more, and the core session lifecycle
(Harbor's own default daemon starting, spawning a session, sending input,
reading the screen, closing a session) is proven directly on real Windows
hardware. Nobody has launched the Electron GUI on Windows at all, and many unit
tests still fail on POSIX assumptions, so treat "the session backend works" and
"Harbor runs on Windows" as separate claims. That folder tells you exactly how
far it gets and what was actually observed.

**macOS** has never executed on a Mac. Not "lightly tested": zero runs on real
hardware. Every darwin code path was written and unit-tested against an injected
adapter on Linux. That folder is therefore not a support document, it is an
eleven-step validation checklist with the exact command, the expected result and
what to report for each check. Whoever runs it first is performing the
validation, and their results are the thing that turns macOS from a guess into a
supported platform or a documented no.

If your platform fights you and the steps above do not cover it, read
[`../docs/HANDBOOK.md`](../docs/HANDBOOK.md) before improvising. It explains what
each piece is *for*, so you can build the right equivalent on your OS instead of
copying a Linux mechanism that does not exist there.

## Giving your projects icons

Optional, and purely cosmetic. Harbor draws a coloured dot per project in the
rail, the window headers, the command bar, Artifacts and the Orch picker. Drop an
image into your own icon folder and it replaces the dot for that project:

| Platform | Folder |
| --- | --- |
| Linux | `~/.config/harbor/project-icons/` |
| Windows | `%APPDATA%\harbor\project-icons\` |
| macOS | `~/Library/Application Support/harbor/project-icons/` |

Name the file after the rail label, lowercased with spaces and separators turned
into hyphens: a project folder called `Team Tools` becomes
`team-tools.png`, `Notes/Wiki` becomes `notes-wiki.png`. `.png`, `.svg`,
`.webp`, `.jpg` and `.gif` all work. Files appear without a restart and without a
rebuild, and a project with no icon keeps its dot, which is a supported look
rather than a missing one.

The folder is deliberately outside the repository: an icon set is named for your
real projects, so it is yours and not repo content. `paths.projectIconsDir` in
`config.json` moves it somewhere else.

Shared reference, once you are installed:

- [`../README.md`](../README.md): what Harbor is and how the interface works.
- [`../docs/ARCHITECTURE-v2.md`](../docs/ARCHITECTURE-v2.md): daemon plumbing.
