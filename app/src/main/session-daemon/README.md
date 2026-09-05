# Session daemon backend

**Harbor's own daemon (`sessiond`) is the only session backend.** Harbor uses it
at the control-plane and byte-bridge seam.

`HARBOR_SESSION_BACKEND` may be unset or set to `sessiond`. A legacy request for
the retired backend is refused explicitly. `HARBOR_SESSIOND_DIR` and
`HARBOR_SESSIOND_SOCKET` select the daemon instance. An isolated Electron
profile is refused access to the default session store unless
`HARBOR_ALLOW_REAL_SESSION_STORE=1` explicitly permits that effect.

The session daemon client keeps bounded request timeouts and rejects outstanding
requests when the connection closes. Its adapter uses direct observe, input,
resize, screen, process, and terminate requests.
