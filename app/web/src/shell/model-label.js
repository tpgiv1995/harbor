// One rule for turning a raw model id into something a header can show.
//
// The phone chip used to render the raw id, so a 430px header showed
// "claude-op…" beside an already-truncated session title. The fix derived a
// friendly label from the id and its comment claimed it named models "the same
// way the desktop does, so the two surfaces cannot drift". It drifted
// immediately, and the drift shipped: it capitalized only the FIRST
// hyphen-separated segment, so `gpt-5.6-sol` read "Gpt 5.6 sol" on the phone
// and "Gpt 5.6 Sol" on the desktop, in two published screenshots of the same
// session. Every segment is capitalized now, which is what
// providers/transcript.js `modelDisplay` does with `\b\w`.
//
// It lives in its own module rather than inside the shell component so the
// claim is testable: test/web/model-label.test.js runs both formatters over the
// same ids and requires the same answer. A rule nobody checks is a rule that
// comes back.
export function prettyModelId(id) {
  return String(id || '')
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
    // `claude-opus-4-5` arrives as three segments and reads as a version, not
    // as two numbers: "Opus 4 5" becomes "Opus 4.5".
    .replace(/(\d) (\d)/, '$1.$2');
}
