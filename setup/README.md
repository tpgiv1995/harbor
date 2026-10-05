# Setup

Use the guide for your platform. All source builds require Node 22.12.0 or newer.

| Platform | Current evidence | Guide |
| --- | --- | --- |
| Windows | Development platform; CI is configured here. Check the hosted run for status. | [Windows](windows/README.md) |
| Linux | Original platform; earlier validation is archived. | [Linux](linux/README.md) |
| macOS | No real hardware validation recorded. | [macOS checklist](macos/README.md) |

Harbor uses its own session daemon. Current configuration is documented in
[Configuration](../docs/CONFIGURATION.md), and phone setup in [mobile](mobile.md).

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
