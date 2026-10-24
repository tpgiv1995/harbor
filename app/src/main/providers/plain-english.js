'use strict';

// Claude writes a plain-English `description` on almost every shell command
// ("Install py-spy into C:\tools for stack dumps"), and the CLI's own screen
// shows it while the command runs ("Installing py-spy into ..."). Harbor shows
// the same sentence: in the -ing form while it runs, and in the past tense once
// it has finished, like every other action row ("Ran", "Edited", "Read").
//
// Descriptions are imperative and verb-first in practice: a survey of 225,643
// real descriptions (2026-10-24) found 2,219 distinct opening words, with the
// 485 used 12 times or more covering 98%. A sentence is only re-tensed when its
// opening word is in VERBS below; anything else ("Final pass over the logs",
// "Dry-run the publish") is shown exactly as Claude wrote it. Wrong grammar is
// worse than no grammar, so the list is an allowlist, never a guess.

const VERBS = new Set(`
abort accept adapt add adjust aggregate align allow amend analyze append apply approve archive arm ask assemble attach audit
balance bisect block boot branch break bring build bump cache call cancel cap capture carry categorize chain change
characterize check clarify classify clean clear click clone close collect combine commit compact compare compile complete
compose compute condense confirm contact continue convert copy correct count create crop cut debug decode delete deliver deploy
derive detect determine diagnose diff disable dispatch document download drain draw drill drive drop dump edit enable encode
end enlarge enumerate escape estimate excuse exclude exercise expand explore export expose extend extract fetch fill film filter
find finalize finish fit fix flag flip fold follow force format freeze gather generate get give grab grade grep group handle
harden hash have hide hold identify ignore import include initialize insert inspect install integrate investigate isolate join
keep kill land launch layer learn limit link level lint list load locate lock log look loosen lower make map mark match measure merge
mint mirror mount move mux narrow normalize note notify open orient outline pack package parse patch pause peek persist pick pin
place plan poll post prepare prepend preview print probe profile prove publish pull push put quantify query queue quiet quote
raise rank rasterize read rebalance rebase rebuild recalculate recall recapture recheck recompile recompute reconcile record
recount recover recreate recrop redeliver redeploy redo redraw refactor refine refit refresh regenerate register rehearse
relabel relaunch release reload remove rename renumber reopen reorder repackage repair repeat replace replay repoint report
reproduce require rerun rescan rescore reset reshoot resize resolve restamp restart restore restructure resume retake retest
retry return revert review rewire reword rework rewrite rotate route run sample save scan schedule score scrub seal search seed
send separate serve set share shorten show shrink sign simplify simulate size skim skip snapshot sort splice split stage stamp
start step stop store strip stub style submit sum summarize survey swap sweep switch sync tabulate tag tail take tally teach
tell test tidy tie tighten tile time trace track transcribe treat trigger trim try turn type undo unpack update upload upscale
use validate verify view wait wake walk warm watch widen wire wrap write zoom conform
activate anchor answer assert assess assign attempt avoid backfill backtest benchmark bind blur brighten bundle
calibrate capitalize choose cite claim clamp collapse comment compress concatenate connect correlate decompile decrypt
dedupe delegate demonstrate describe disambiguate disassemble discard discover dismiss distinguish downscale draft
embed ensure enter equalize establish evaluate examine execute exempt explain fade fingerprint fire flatten fork
forward generalize grant hit hunt implement improve index inject inline instrument intersect invite invoke inventory
judge label lay leave lengthen let lift lighten migrate mask mutate navigate neutralize nudge overwrite pad paginate
parallelize parametrize park ping play plot pluralize point polish prefer predict prep preserve price produce
prototype provision purge quarantine quit reapply reassign reattach reboot recompare reconnect reconstruct recopy
redact reframe refuse regroup reinstall rejoin relax relocate remeasure render replicate reply reprint republish
requeue rescrub resend reseed restack restage restrict restyle retarget retire retitle retrace retrieve retune reuse
revise rewalk rewrap reroute say scaffold scale screenshot scroll segment select settle sharpen shift shoot slice
smooth soften spawn spread stash strengthen summarise suppress surface tap triage tune tweak typecheck understand
uninstall unlink unmask unwrap unzip
`.trim().split(/\s+/));

// Hyphenated verbs re-tense their last part ("Re-run" -> "Re-ran"). Only the
// listed ones: "Dry-run the publish" must not become "Dry-ran".
const HYPHENATED = new Set(`
cherry-pick cross-check fact-check fast-forward parse-check re-apply re-arm re-capture re-check re-crop re-dispatch re-export
re-extract re-measure re-probe re-pull re-read re-record re-render re-run re-take re-test re-verify re-zoom sanity-check
seal-check self-test smoke-test spot-check syntax-check type-check
compile-check cross-link cross-register dash-check dry-check force-remove mutation-check re-add re-baseline re-copy
re-cut re-decode re-deliver re-detect re-download re-dump re-lay re-lint re-pin re-query re-queue re-register re-scan
re-score re-screenshot re-shoot re-snapshot re-stamp re-time re-transcribe re-validate re-walk self-compare
smoke-check unit-test
`.trim().split(/\s+/));

const IRREGULAR_PAST = {
  bring: 'brought', build: 'built', break: 'broke', cut: 'cut', draw: 'drew', drive: 'drove', find: 'found', fit: 'fit',
  freeze: 'froze', get: 'got', give: 'gave', have: 'had', hide: 'hid', hold: 'held', keep: 'kept', make: 'made', put: 'put',
  read: 'read', rebuild: 'rebuilt', redo: 'redid', redraw: 'redrew', refit: 'refit', rerun: 'reran', reset: 'reset',
  reshoot: 'reshot', retake: 'retook', rewrite: 'rewrote', run: 'ran', send: 'sent', set: 'set', shrink: 'shrank',
  split: 'split', sweep: 'swept', take: 'took', teach: 'taught', tell: 'told', undo: 'undid', wake: 'woke', write: 'wrote',
  bind: 'bound', choose: 'chose', hit: 'hit', lay: 'laid', leave: 'left', let: 'let', overwrite: 'overwrote', quit: 'quit',
  resend: 'resent', say: 'said', shoot: 'shot', spread: 'spread', understand: 'understood',
};

// One-syllable (or end-stressed) verbs that double their last consonant:
// "stop" -> "stopped", "commit" -> "committing". US spelling throughout, so
// "cancel" and "relabel" do not double.
const DOUBLES = new Set(`
cap commit crop cut debug drop fit flag flip format get grab grep log map pin plan put recrop refit rerun rescan run scan
scrub set ship skim skip split step stop strip stub submit sum swap tag trim wrap
blur embed hit let pad plot prefer prep quit rescrub rewrap screenshot tap unwrap unzip
`.trim().split(/\s+/));

const VOWEL = /[aeiou]/;

function pastOf(verb) {
  if (IRREGULAR_PAST[verb]) return IRREGULAR_PAST[verb];
  if (DOUBLES.has(verb)) return `${verb}${verb.at(-1)}ed`;
  if (verb.endsWith('e')) return `${verb}d`;
  if (verb.endsWith('y') && !VOWEL.test(verb.at(-2))) return `${verb.slice(0, -1)}ied`;
  return `${verb}ed`;
}

function progressiveOf(verb) {
  if (verb.endsWith('ie')) return `${verb.slice(0, -2)}ying`;
  if (/(ee|ye|oe)$/.test(verb)) return `${verb}ing`;
  if (DOUBLES.has(verb)) return `${verb}${verb.at(-1)}ing`;
  if (verb.endsWith('e')) return `${verb.slice(0, -1)}ing`;
  return `${verb}ing`;
}

// Inflect one word if it is a known verb, keeping its case and any trailing
// punctuation ("Commit," -> "Committed,"). Returns null for anything else.
function inflectWord(word, form) {
  const match = /^([A-Za-z][A-Za-z-]*)([,;:.]?)$/.exec(word);
  if (!match) return null;
  const [, raw, tail] = match;
  const lower = raw.toLowerCase();
  const cut = lower.lastIndexOf('-');
  if (cut >= 0 ? !HYPHENATED.has(lower) : !VERBS.has(lower)) return null;
  const base = lower.slice(cut + 1);
  let out = form === 'past' ? pastOf(base) : progressiveOf(base);
  if (raw[0] !== raw[0].toLowerCase()) out = out[0].toUpperCase() + out.slice(1);
  return `${raw.slice(0, cut + 1)}${cut >= 0 ? out.toLowerCase() : out}${tail}`;
}

// A second action joined on with "and", "then" or a comma is re-tensed too
// ("Commit the port and list the changes" -> "Committed ... and listed ..."),
// but only when the word is unmistakably a verb there. JOINED verbs are re-tensed
// wherever they follow a joiner; the rest only when an object follows ("and
// snapshot the film"), because "and install date" and "and sync state" are
// nouns. Measured against the real descriptions before shipping.
const JOINED = new Set(`
apply bring build check commit compare confirm delete deploy diagnose extract find fix identify inspect kill launch list locate
measure open publish push read rebase rebuild recheck recompile refresh regenerate relaunch reload remove rename replace rerun
re-run restart restore retest retry revert run save show stop summarize swap validate verify wait write re-check re-verify
re-render
`.trim().split(/\s+/));
// A capitalized word or a path after the verb is its object ("and start Meeting
// Assistant", "and read C:\\dev\\x"); a lowercase noun is not ("and sync state").
const OBJECT_START = /^(?:(?:the|a|an|its|it|their|them|his|her|our|my|this|that|these|those|all|every|each|any|both|for|to|with|from|into|on|in|at|whether|which|what|how|if|again|once|up|down|out|off|back|over|until|as)\b|[A-Z]|["'`~/\\.])/;

function retense(description, form) {
  const text = String(description || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const words = text.split(' ');
  const first = inflectWord(words[0], form);
  if (!first) return null;
  words[0] = first;
  for (let i = 1; i < words.length; i += 1) {
    const prev = words[i - 1];
    const joined = /[,;]$/.test(prev) || /^(and|then)$/i.test(prev);
    if (!joined) continue;
    if (/^then$/i.test(words[i]) && i + 1 < words.length) continue; // ", then verify"
    const lower = words[i].replace(/[,;:.]$/, '').toLowerCase();
    if (!VERBS.has(lower) && !HYPHENATED.has(lower)) continue;
    const next = words[i + 1];
    const atEnd = next === undefined || /[,;:.]$/.test(words[i]);
    if (!JOINED.has(lower) && !(next !== undefined && OBJECT_START.test(next)) && !atEnd) continue;
    if (atEnd && !JOINED.has(lower)) continue;
    const inflected = inflectWord(words[i], form);
    if (inflected) words[i] = inflected.toLowerCase() === inflected ? inflected : inflected[0].toLowerCase() + inflected.slice(1);
  }
  return words.join(' ');
}

// "Install py-spy into C:\tools" -> "Installed py-spy into C:\tools", or null
// when the description does not open with a known verb.
function pastTense(description) {
  return retense(description, 'past');
}

// "Install py-spy into C:\tools" -> "Installing py-spy into C:\tools", or null.
function progressive(description) {
  return retense(description, 'ing');
}

module.exports = { pastTense, progressive, VERBS, HYPHENATED };
