'use strict';

// Gemini (Google's Antigravity CLI, `agy`) as Harbor's fourth session provider, UI side
// (2026-11-23, DESIGN D1/D6/D12/D13). Every list the renderer kept for "the other providers" is
// pinned here with Gemini in it, and the ones whose old answer was silently Claude's are written
// so the OLD code fails them.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SESSION_PROVIDER_KEYS } = require('../../src/renderer/provider-options.cjs');
const { sessionModelOptions, sessionEffortOptions } = require('../../src/renderer/session-model-options.cjs');
const { resolveNewSessionDefaults } = require('../../src/renderer/new-session-defaults.cjs');
const { terminalView, terminalFallbackNote, NON_CLAUDE_PROVIDERS } = require('../../src/renderer/stage/terminal-view.cjs');
const { planInChip, nonClaudeDead, PLAN_IN_CHIP } = require('../../src/renderer/stage/provider-rules.cjs');
const { showPlanChoice, providerPlans, selectedPlan } = require('../../src/shared/plan-options.cjs');
const { runModeText } = require('../../src/renderer/orchestration/team-text.cjs');
const { PROVIDER_LABEL, providerLabel } = require('../../web/src/provider-labels.cjs');

const RENDERER = path.join(__dirname, '../../src/renderer');
const WEB = path.join(__dirname, '../../web/src');

// The registry entry the LAUNCH side sends for Gemini (gemini-model-catalog.js geminiModelOptions): a
// Default row first (no --model), then each model FAMILY with its own efforts, never a union.
function geminiRegistry(overrides = {}) {
  return {
    defaultModel: 'default',
    models: [
      { value: 'default', label: 'Gemini default' },
      { value: 'gemini-4-neon', label: 'Gemini 4 Neon' },
      { value: 'gemini-4-hydrogen', label: 'Gemini 4 Hydrogen' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh'],
    effortsByModel: {
      default: ['low', 'medium', 'high', 'xhigh'],
      'gemini-4-neon': ['low', 'medium', 'high', 'xhigh'],
      'gemini-4-hydrogen': ['low', 'medium'],
    },
    defaultEffort: 'high',
    bin: 'agy',
    profiles: [],
    defaultProfile: null,
    ...overrides,
  };
}

// -- New session popover --------------------------------------------------------------------------------

test('the New session popover offers a Gemini tab beside the other three, Claude first', () => {
  assert.deepEqual(SESSION_PROVIDER_KEYS, ['claude', 'codex', 'cursor', 'gemini']);
});

test('the popover draws its tabs from SESSION_PROVIDER_KEYS, not a literal that stops at three', () => {
  const source = fs.readFileSync(path.join(RENDERER, 'NewSessionConfig.jsx'), 'utf8');
  assert.match(source, /SESSION_PROVIDER_KEYS\.map\(/);
  assert.doesNotMatch(source, /\['claude', 'codex', 'cursor'\]/);
});

test('Gemini offers its families and each family keeps its own efforts', () => {
  const providerOptions = geminiRegistry();
  const rows = sessionModelOptions({ provider: 'gemini', providerOptions, model: 'default', showVersions: false });
  assert.deepEqual(rows.map((row) => row.value), ['default', 'gemini-4-neon', 'gemini-4-hydrogen']);
  // Hydrogen has two levels: a union with Neon's would offer xhigh to a model that has none.
  const hydrogen = sessionEffortOptions({ providerOptions, model: 'gemini-4-hydrogen', effort: 'xhigh' });
  assert.deepEqual(hydrogen.levels, ['low', 'medium']);
  assert.equal(hydrogen.effort, 'high' === hydrogen.effort ? 'low' : hydrogen.effort, 'xhigh is not submitted for a family without it');
  assert.ok(hydrogen.levels.includes(hydrogen.effort));
  const neon = sessionEffortOptions({ providerOptions, model: 'gemini-4-neon', effort: 'high' });
  assert.equal(neon.effort, 'high');
});

test('a Gemini launch opens on the registry default (agy: no --model, effort high) and never carries another provider’s model', () => {
  const options = { providers: { claude: { defaultModel: 'default', efforts: ['default', 'high'] }, gemini: geminiRegistry() } };
  const result = resolveNewSessionDefaults({
    request: { provider: 'gemini' },
    stored: { provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' },
    options,
  });
  assert.equal(result.provider, 'gemini');
  assert.equal(result.model, 'default');
  assert.equal(result.effort, 'high');
});

test('the action reads "Start Gemini session" from the Gemini identity', () => {
  const source = fs.readFileSync(path.join(RENDERER, 'providers.js'), 'utf8');
  assert.match(source, /gemini: \{\s*label: 'Gemini'/);
  assert.match(source, /logo-gemini\.svg/);
  assert.ok(fs.existsSync(path.join(__dirname, '../../assets/logo-gemini.svg')), 'the mark exists');
  // The comment that said Gemini had no panes is gone.
  assert.doesNotMatch(source, /has no Harbor panes/);
});

test('a Gemini plan is a choice only between two roots; Cursor never; Claude and Codex from one', () => {
  const one = [{ id: 'gemini', provider: 'gemini' }];
  const two = [...one, { id: 'gemini-2', provider: 'gemini' }];
  assert.equal(showPlanChoice('gemini', []), false);
  assert.equal(showPlanChoice('gemini', one), false, 'a lone Gemini root is no choice');
  assert.equal(showPlanChoice('gemini', two), true);
  assert.equal(showPlanChoice('cursor', two), false);
  for (const provider of ['claude', 'codex']) {
    assert.equal(showPlanChoice(provider, []), false);
    assert.equal(showPlanChoice(provider, [{ id: 'a' }]), true, provider);
  }
  // providerPlans keeps Gemini's plans apart from the others'.
  const options = { profiles: [...two, { id: 'p', provider: 'claude' }] };
  assert.deepEqual(providerPlans(options, 'gemini').map((p) => p.id), ['gemini', 'gemini-2']);
  assert.equal(selectedPlan(options, 'gemini', 'gemini-2').id, 'gemini-2');
});

// -- Window: terminal fallback, read-only rule, plan badge -------------------------------------------------

// 2026-11-24 (Pat, on a new Gemini window that opened on agy's colour page in a raw terminal: "you didn't even bother
// to build out a harbor screen for gemini"): a new Gemini window is the designed window, like codex and cursor, and
// Google's first-run pages come up as the Gemini setup card (GeminiSetupCard.jsx, main/gemini-first-run.js).
test('a new Gemini pane with no transcript yet shows the designed window, not its terminal', () => {
  const PANE = { paneId: 'p1' };
  for (const provider of ['gemini', 'codex', 'cursor', 'claude']) {
    const view = terminalView({ session: { id: 'pane:p1', provider }, data: null, pane: PANE, tty: false });
    assert.equal(view.showTerminal, false, provider);
    assert.equal(view.fallback, false, provider);
  }
  // A live pane no evidence named still falls back, as for codex and cursor (nothing else can show it).
  assert.equal(terminalView({ session: { id: 'live:p1', provider: 'gemini' }, data: { missing: true }, pane: PANE }).fallback, true);
  assert.deepEqual(NON_CLAUDE_PROVIDERS, ['codex', 'cursor', 'gemini']);
});

test('a Gemini window WITH a transcript, or without a pane, does not fall back', () => {
  const PANE = { paneId: 'p1' };
  const named = { id: '0a1b2c3d-0000-4000-8000-000000000001', provider: 'gemini' };
  assert.equal(terminalView({ session: named, data: { blocks: [{}] }, pane: PANE, tty: false }).showTerminal, false);
  assert.equal(terminalView({ session: { id: 'live:p1', provider: 'gemini' }, data: null, pane: null, tty: true }).showTerminal, false);
  // The >_ toggle still works for any Gemini window.
  assert.equal(terminalView({ session: named, data: { blocks: [{}] }, pane: PANE, tty: true }).showTerminal, true);
});

test('the fallback note is the same for every provider; first-run pages are a card, never "answer them here"', () => {
  assert.equal(terminalFallbackNote('Gemini'), 'this gemini pane has not named its session yet; showing its terminal');
  assert.equal(terminalFallbackNote('Codex'), 'this codex pane has not named its session yet; showing its terminal');
  assert.equal(terminalFallbackNote('Cursor'), 'this cursor pane has not named its session yet; showing its terminal');
});

test('a Gemini window mounts the answer card, so its setup card and questions show in the window', () => {
  const tile = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'stage', 'SessionTile.jsx'), 'utf8');
  assert.match(tile, /session\.provider === 'claude' \|\| session\.provider === 'gemini'\) \? \(/);
});

// 2026-11-25: a card over a Gemini window read "Claude is asking".
test("the answer card names the window's own provider, never Claude on a Gemini window", () => {
  const tile = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'stage', 'SessionTile.jsx'), 'utf8');
  const card = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'renderer', 'stage', 'AskCard.jsx'), 'utf8');
  assert.match(tile, /<AskCard\n[^>]*providerName=\{providerIdentity\(session\.provider \|\| 'claude'\)\.label\}/);
  assert.match(card, /const who = providerName;/);
  assert.match(card, /`\$\{who\} is asking`/);
  assert.doesNotMatch(card, /'Claude is asking'|Claude continues/);
});

test('the Gemini setup card counts as a dialog waiting on you, on the desktop and the phone', () => {
  const { liveDialog } = require('../../src/renderer/stage/dialog-state.cjs');
  const setup = { kind: 'gemini-setup', page: 'scheme', schemes: [{ label: 'terminal', selected: true }] };
  assert.equal(liveDialog(setup), setup);
  const phone = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'ask', 'AskCard.jsx'), 'utf8');
  assert.match(phone, /GeminiSetupCard/);
  assert.match(phone, /kind === 'gemini-setup'/);
});

test('a dead Gemini session with an unknown folder is read-only, like codex and cursor; Claude is not', () => {
  for (const provider of ['codex', 'cursor', 'gemini']) {
    assert.equal(nonClaudeDead({ dead: true, session: { provider } }), true, provider);
    assert.equal(nonClaudeDead({ dead: true, session: { provider, cwd: '/p' } }), false, `${provider} with a folder resumes`);
    assert.equal(nonClaudeDead({ dead: false, session: { provider } }), false, `${provider} alive`);
  }
  assert.equal(nonClaudeDead({ dead: true, session: { provider: 'claude' } }), false);
  assert.equal(nonClaudeDead({ dead: true, session: {} }), false);
});

test('the plan badge rides inside the chip for claude, codex and gemini; cursor keeps the trailing pill', () => {
  for (const provider of ['claude', 'codex', 'gemini', undefined]) assert.equal(planInChip(provider), true, String(provider));
  assert.equal(planInChip('cursor'), false);
  assert.deepEqual([...PLAN_IN_CHIP].sort(), ['claude', 'codex', 'gemini']);
});

test('the tile and the command bar take these rules from provider-rules.cjs, not their own literals', () => {
  const tile = fs.readFileSync(path.join(RENDERER, 'stage/SessionTile.jsx'), 'utf8');
  const bar = fs.readFileSync(path.join(RENDERER, 'stage/CommandBar.jsx'), 'utf8');
  assert.match(tile, /planInChip\(/);
  assert.doesNotMatch(tile, /PLAN_IN_CHIP/);
  assert.match(bar, /planInChip\(session\.provider\)/);
  assert.match(bar, /nonClaudeDeadRule\(/);
  assert.doesNotMatch(bar, /\['codex', 'cursor'\]\.includes/);
  // The model chip carries data-provider (the mark is the identity's own logo).
  assert.match(tile, /data-provider=\{provider\}/);
  assert.match(tile, /className="logomk" src=\{identity\.logo\}/);
});

// -- Team chart -----------------------------------------------------------------------------------------

test('a Gemini worker run says "Gemini worker", by launcher and by provider (the old fallback said Headless worker)', () => {
  assert.equal(runModeText({ runMode: 'worker', launcher: 'gemini-worker', provider: 'gemini' }), 'Gemini worker');
  assert.equal(runModeText({ runMode: 'worker', provider: 'gemini' }), 'Gemini worker');
  assert.equal(runModeText({ runMode: 'pane', provider: 'gemini' }), 'Harbor pane');
  // The others are unchanged.
  assert.equal(runModeText({ runMode: 'worker', provider: 'cursor' }), 'Cursor worker');
  assert.equal(runModeText({ runMode: 'worker', launcher: 'claude-worker', provider: 'claude' }), 'Headless worker');
});

test('a Gemini agent with nothing else to call it is named "Gemini worker"', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared/team-model.cjs'), 'utf8');
  assert.match(source, /member\.provider === 'gemini' \? 'Gemini worker'/);
});

test('the Team chart cards draw the provider identity mark, so a Gemini agent shows the Gemini mark', () => {
  const card = fs.readFileSync(path.join(RENDERER, 'orchestration/AgentCard.jsx'), 'utf8');
  assert.equal((card.match(/providerIdentity\(member\.provider\)/g) || []).length, 2, 'card and chip');
});

// -- Rail copy ------------------------------------------------------------------------------------------

test('the rail’s "other plan" menu names Gemini with Codex and Cursor', () => {
  const source = fs.readFileSync(path.join(RENDERER, 'sidebar/Sidebar.jsx'), 'utf8');
  assert.match(source, /Other: Codex, Cursor, Gemini…/);
  assert.match(source, /choose Codex, Cursor, Gemini or any plan/);
});

// -- Phone ---------------------------------------------------------------------------------------------

test('the phone names all four providers; a Gemini session is never labelled Claude (HARBOR-MAP G7)', () => {
  assert.deepEqual(PROVIDER_LABEL, { claude: 'Claude', codex: 'Codex', cursor: 'Cursor', gemini: 'Gemini' });
  assert.equal(providerLabel('gemini'), 'Gemini');
  assert.equal(providerLabel('gemini', 'Claude'), 'Gemini', 'the header fact: set provider wins over its fallback');
  // The header context fact's fallback is Claude only for a session with NO provider.
  assert.equal(providerLabel(undefined, 'Claude'), 'Claude');
  assert.equal(providerLabel('nonesuch', 'Claude'), 'Claude');
  // A tab for a provider the server offers but the phone has no name for shows its id, never nothing.
  assert.equal(providerLabel('nonesuch', 'nonesuch'), 'nonesuch');
});

test('every phone surface that named a provider reads the one table', () => {
  for (const [file, pattern] of [
    ['newsession/NewSessionSheet.jsx', /providerLabel\(key, key\)/],
    ['newsession/NewSessionSheet.jsx', /providerLabel\(provider, provider\)/],
    ['shell/AppShell.jsx', /providerLabel\(provider, provider\)/],
    ['shell/SessionMeta.jsx', /providerLabel\(session\.provider, 'Claude'\)/],
    ['capability/CapabilitySheet.jsx', /providerLabel\(provider, provider\)/],
  ]) {
    assert.match(fs.readFileSync(path.join(WEB, file), 'utf8'), pattern, file);
  }
  // The old literals are gone, so a fifth provider cannot fall through them again.
  assert.doesNotMatch(fs.readFileSync(path.join(WEB, 'shell/SessionMeta.jsx'), 'utf8'), /\{ codex: 'Codex', cursor: 'Cursor' \}/);
  assert.doesNotMatch(fs.readFileSync(path.join(WEB, 'shell/AppShell.jsx'), 'utf8'), /PROVIDER_NAME/);
  assert.doesNotMatch(fs.readFileSync(path.join(WEB, 'newsession/NewSessionSheet.jsx'), 'utf8'), /PROVIDER_LABEL\[/);
});

test('the phone’s provider tabs carry the same marks the desktop draws, Gemini’s included, as CSS backgrounds', () => {
  const css = fs.readFileSync(path.join(WEB, 'newsession/newsession.css'), 'utf8');
  for (const [provider, logo] of [['claude', 'claude'], ['codex', 'openai'], ['cursor', 'cursor'], ['gemini', 'gemini']]) {
    assert.match(css, new RegExp(`data-provider="${provider}"\\] \\{ background-image: url\\("../../../assets/logo-${logo}\\.svg"\\)`), provider);
    assert.ok(fs.existsSync(path.join(__dirname, `../../assets/logo-${logo}.svg`)), logo);
  }
  const sheet = fs.readFileSync(path.join(WEB, 'newsession/NewSessionSheet.jsx'), 'utf8');
  assert.match(sheet, /className="newsession-provider-mark" data-provider=\{key\}/);
  // No script import of an svg: the unit tests bundle this sheet with a bare esbuild that has no asset loader.
  assert.doesNotMatch(sheet, /\.svg/);
});
