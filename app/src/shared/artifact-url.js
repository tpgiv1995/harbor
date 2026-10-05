// ONE rule for carrying a native file path inside a harbor-artifact:// URL and
// reading it back, so the renderer that builds the URL, the offscreen window
// that captures a thumbnail, and the protocol handler that serves the bytes
// cannot disagree about what the URL means.
//
// The path lives in the URL PATH with real '/' separators (each SEGMENT
// percent-encoded, the separators never encoded) rather than as one opaque
// blob, because an HTML artifact's relative references ('./chart.png') have to
// resolve to its real siblings on disk; the sibling-directory allowlist in
// providers/artifacts.js exists to serve exactly those.
//
// A Windows path rides the way a file:// URL carries one: 'C:\dev\x.png'
// becomes '/C:/dev/x.png'. The rule is PLATFORM-PURE and keys off the
// drive-letter SHAPE rather than process.platform, so both directions are
// testable from either OS. That is the lesson project-label.cjs paid for on
// 2026-08-12: a posix-only path rule shipped on a Windows host stays invisible
// until a user hits it.
//
// Before this module existed the URL was built inline as
//   `//local${String(p).split('/').map(encodeURIComponent).join('/')}`
// which on Windows produced NO path segments at all: a path with no forward
// slashes stayed one piece, the whole drive-lettered string was percent-encoded
// into the URL's HOST, and url.pathname came back ''. Every image, every HTML
// iframe, every PDF frame and every thumbnail capture in the Files view was
// refused (the handler saw '.' and the allowlist said no). Never rebuild this
// by splitting a native path on '/'.

export const ARTIFACT_SCHEME = 'harbor-artifact';
const DRIVE_SEGMENT_RE = /^[A-Za-z]:$/;

// Native path -> the path component of an artifact URL (leading '/', encoded
// segments). Accepts either separator so a caller never has to normalize first.
export function artifactUrlPath(filePath) {
  const slashed = String(filePath == null ? '' : filePath).replace(/\\/g, '/');
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`;
  return rooted.split('/').map(encodeURIComponent).join('/');
}

export function artifactUrl(filePath, scheme = ARTIFACT_SCHEME) {
  return `${scheme}://local${artifactUrlPath(filePath)}`;
}

// The path component of an artifact URL -> a file path, in the shape the
// platform that built it uses. Returns '' for a URL that carries no path,
// which callers must treat as "not found" rather than resolving it (an empty
// string handed to path.resolve becomes the process cwd).
export function filePathFromUrlPath(pathname) {
  const decoded = String(pathname == null ? '' : pathname)
    .split('/')
    .map((segment) => {
      try { return decodeURIComponent(segment); } catch { return segment; }
    })
    .join('/');
  const withoutRoot = decoded.replace(/^\/+/, '');
  if (!withoutRoot) return '';
  // '/C:/dev/x.png' is a Windows path, not a directory named 'C:' at the root.
  if (DRIVE_SEGMENT_RE.test(withoutRoot.split('/')[0])) return withoutRoot;
  return decoded;
}
