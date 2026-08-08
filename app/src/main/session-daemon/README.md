# Session daemon backend

**Harbor's own daemon (`sessiond`) is the default.** Herdr is the fallback and
remains supported. Harbor selects the backend at the existing control-plane and
byte-bridge seam.

Set `HARBOR_SESSION_BACKEND=herdr` to roll back to Herdr. Unset it, or set it to
`sessiond`, for the default. `HARBOR_SESSIOND_DIR` and
`HARBOR_SESSIOND_SOCKET` select the daemon instance. An isolated Electron
profile is refused access to the default session store unless
`HARBOR_ALLOW_REAL_SESSION_STORE=1` explicitly permits that effect.

A backend cutover drops running ptys. No conversation work is lost because a
Claude session resumes from its transcript by session id, but the live pty and
any process state inside it do not move between daemons. Plan the switch as a
restart and resume operation. It is not seamless.

The session daemon client multiplexes requests and events over one long-lived
connection. This differs from Herdr, whose control client opens one connection
per request. Both clients keep bounded request timeouts and reject outstanding
requests when the connection closes.

Herdr-only compatibility behavior remains in the Herdr implementation. This
includes replay deduplication and settle timers, exclusive controller swaps,
refusal retry, self-release tracking, frame-count controller readiness, and
transient controller attachment for dialog sizing. The session daemon adapter
keeps the same method names but uses direct observe, input, resize, screen,
process, and terminate requests.
