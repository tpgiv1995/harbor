# Setup

Open the folder for the machine you are on.

| Platform | Status | Start here |
| --- | --- | --- |
| **Linux** | The retired original platform (2026-08-10); was validated end to end | [linux/README.md](linux/README.md) |
| **Windows** | The platform Harbor runs and is developed on; validated end to end | [windows/README.md](windows/README.md) |
| **macOS** | Never run on real hardware | [macos/README.md](macos/README.md) |

Those short phrases mean exactly what they say, and the difference matters more
than the install steps do.

**Linux** is the platform Harbor was built on, and the one the original gate ran
against: the full unit suite over three consecutive runs plus a two-run
Playwright suite, all green, plus a cold-start drive that cloned the repo to an
empty home directory and walked the first-run wizard as a new user. That
install was retired 2026-08-10; the folder stands as the record of what was
validated there.

**Windows** is the platform Harbor runs and is developed on now. The full app
(Electron GUI included) runs there (since 2026-08-11), the core session
lifecycle (Harbor's own daemon starting, spawning a session, sending input,
reading the screen, closing a session) is proven directly on real Windows
hardware, the unit gate is green, and CI runs it on `windows-latest`. Still
open: the daemon/bin real-pty test families and the e2e suite are pending
their Windows ports, and the e2e suite currently runs on no machine. That
folder records how the port got here and what was actually observed.

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
