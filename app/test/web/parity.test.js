'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// This is the declared desktop-to-phone contract. Missing phone features stay
// visible here as named skips; adding a desktop capability requires deciding
// whether the phone ships it or why it is temporarily skipped.
//
// THE DECLARATION IS NOW CHECKED AGAINST THE CODE, and that is the whole point
// (2026-08-06). Five capabilities sat here marked `shipped: false` with
// confident reason strings ("mobile Composer has no dictation control yet")
// for three days AFTER the sprints that shipped them: the table was last
// edited at 05:21, and the two commits that built attach, permission mode,
// plan usage, voice and the slash palette landed at 05:39 and 05:49 the same
// morning. Nobody flipped the booleans. The old test only asserted that a
// `false` entry HAD a reason, never that the reason was still true, so the
// stale text survived every run and was then read by a later session as a
// considered product decision and written into a handoff as fact.
//
// A skip is a claim about the code, so it is tested like one, in BOTH
// directions: a capability marked shipped must have its implementation
// present, and one marked unshipped must NOT. The second half is what catches
// the stale skip, and it is the half a one-sided test would have omitted.
const WEB = path.resolve(__dirname, '../../web/src');

// Each probe names a file that must exist and a marker that must appear in it.
// A marker is deliberately something only a real implementation carries (an RPC
// method name, a control's class), not a word that could survive a deletion.
const CAPABILITIES = Object.freeze([
  {
    id: 'attach-image',
    label: 'attach image',
    shipped: true,
    probe: { file: 'attach/use-attachments.js', marker: "'upload:image'" },
  },
  {
    id: 'change-model',
    label: 'change model',
    shipped: true,
    probe: { file: 'capability/CapabilitySheet.jsx', marker: 'model' },
  },
  {
    id: 'change-effort',
    label: 'change effort',
    shipped: true,
    probe: { file: 'capability/CapabilitySheet.jsx', marker: 'effort' },
  },
  {
    id: 'change-permission-mode',
    label: 'change permission mode',
    shipped: true,
    probe: { file: 'capability/CapabilitySheet.jsx', marker: 'cyclePermission' },
  },
  {
    id: 'see-plan-usage',
    label: 'see plan usage',
    shipped: true,
    probe: { file: 'plan/PlanSheet.jsx', marker: 'plan-meter' },
  },
  {
    id: 'switch-plan',
    label: 'switch plan',
    shipped: true,
    probe: { file: 'plan/PlanSheet.jsx', marker: 'plan-card' },
  },
  {
    id: 'voice-to-draft',
    label: 'voice to draft',
    shipped: true,
    probe: { file: 'voice/use-voice-draft.js', marker: "'whisper:transcribe'" },
  },
  {
    id: 'slash-commands',
    label: 'slash commands',
    shipped: true,
    probe: { file: 'slash/SlashPalette.jsx', marker: 'SlashPalette' },
  },
  {
    id: 'collapse-project-group',
    label: 'collapse a project group',
    shipped: true,
    probe: { file: 'rail/SessionSheet.jsx', marker: 'toggleCollapse' },
  },
]);

function probeHit({ file, marker }) {
  const abs = path.join(WEB, file);
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return false; }
  return text.includes(marker);
}

test('MOBILE-PARITY-8: every declared phone capability is shipped or an explicit named skip', () => {
  assert.deepEqual(CAPABILITIES.map((capability) => capability.id), [
    'attach-image', 'change-model', 'change-effort', 'change-permission-mode',
    'see-plan-usage', 'switch-plan', 'voice-to-draft', 'slash-commands',
    'collapse-project-group',
  ]);
  for (const capability of CAPABILITIES) {
    if (!capability.shipped) {
      assert.ok(capability.reason, `${capability.label} needs a skip reason`);
      assert.doesNotMatch(capability.reason, /^(todo|not shipped)$/i);
    }
  }
});

test('MOBILE-PARITY-8: a capability declared SHIPPED has its implementation in app/web', () => {
  const missing = [];
  for (const capability of CAPABILITIES) {
    if (!capability.shipped) continue;
    if (!probeHit(capability.probe)) {
      missing.push(`${capability.id} claims shipped but ${capability.probe.file} has no ${capability.probe.marker}`);
    }
  }
  assert.deepEqual(missing, [], `the phone does not implement what this table promises:\n  ${missing.join('\n  ')}`);
});

test('MOBILE-PARITY-8: a capability declared UNSHIPPED really is absent, so a skip cannot go stale', () => {
  // The direction that would have caught the three-day-old lie. If a sprint
  // ships a feature and nobody edits the table, this fails and names it.
  const stale = [];
  for (const capability of CAPABILITIES) {
    if (capability.shipped) continue;
    if (probeHit(capability.probe)) {
      stale.push(`${capability.id} is marked unshipped ("${capability.reason}") but ${capability.probe.file} already implements it`);
    }
  }
  assert.deepEqual(stale, [], `stale skip declarations:\n  ${stale.join('\n  ')}`);
});

for (const capability of CAPABILITIES.filter((row) => !row.shipped)) {
  test(`MOBILE-PARITY-8 skip: ${capability.label}`, { skip: capability.reason }, () => {});
}
