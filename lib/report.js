'use strict';
// One verification envelope for every verb a machine might read (plan §8 `O2`, finding F10).
//
// Before this file, `--json` meant three different things: `doctor` dumped its raw probe rows,
// `status` printed `{lines, state, archives}`, `verify-core` built a good envelope inline, and the
// mutating verbs printed nothing machine-readable at all. Anything consuming asb-mods — an agent, CI,
// a dashboard — had to know which verb spoke which dialect, and `grep` for the answer.
//
// Shape contract (docs/wiki/05-components-lib.md holds the copy a test compares against):
//
//   { verb, ok, checks: [{name, verdict, detail, fix}], summary, exitCode }
//
// `ok` is exactly one thing: zero checks with a verdict other than `pass`. It is not "the run was
// healthy", it is not a severity judgement, and because it is defined that way the exit code needs no
// prose explanation anywhere. Verb-specific extras are allowed (`core`, `inventory`, `hosts`) and must
// be documented where the verb is documented.
//
// Deliberately NOT included, per §12's trim: no nonce, no run id, no stale-report anti-forgery. That
// machinery answers a threat this package does not face (caliper's checker runs untrusted third-party
// tests; ours run in our own fixture homes), and carrying it would have cost a write per run for no
// change in what a reader can conclude.

const VERDICTS = ['pass', 'fail', 'warn', 'skipped'];

// A row of the report. `fix` is the command that resolves the row, or '' when nothing does — an empty
// string rather than a missing key, so a consumer never has to guess whether absence meant "no fix" or
// "not computed".
function check(name, verdict, detail, fix) {
  if (!VERDICTS.includes(verdict)) throw new Error(`unknown verdict "${verdict}" for check ${name}`);
  return { name, verdict, detail: detail || '', fix: fix || '' };
}

const passed = (c) => c.verdict === 'pass';

// The envelope. `ok` counts non-pass checks and nothing else; exitCode follows the same rule so a
// consumer that only reads the code and a consumer that reads `ok` agree by construction.
function envelope(opts) {
  const checks = opts.checks || [];
  const failures = checks.filter((c) => !passed(c)).length;
  const env = {
    verb: opts.verb,
    ok: failures === 0,
    checks,
    summary: Object.assign({
      checks: checks.length,
      passed: checks.filter(passed).length,
      failed: failures,
    }, opts.summary || {}),
    exitCode: failures ? 1 : 0,
  };
  // Verb-specific extras are opt-in; `hosts` only appears for verbs that can answer per-host counts.
  if (opts.hosts) env.hosts = opts.hosts;
  return Object.assign(env, opts.extra || {});
}

// Turn a doctor-style probe row ({name, ok, detail, fix}) into a check.
function fromRow(row) {
  return check(row.name, row.ok ? 'pass' : 'fail', row.detail, row.fix);
}

// Turn a status-style line ([label, detail, ok]) into a check. Status lines are [label, detail, ok]
// triples, so the third element is the verdict — warn-or-worse when it is falsy.
function fromLine(line) {
  return check(String(line[0]), line[2] ? 'pass' : 'warn', String(line[1] === undefined ? '' : line[1]), '');
}

// Per-host counters, §8 `O2`: {discovered, applied, held_back, failed, unverified}. Built only from
// data a verb actually has — see hostCounters in install.js, which feeds this from the hook phase's
// per-tool results. An absent host means the verb did not look, which is why the caller omits `hosts`
// rather than sending zeros: a zero reads as "checked and found nothing".
function hostCounters({ discovered = 0, applied = 0, heldBack = 0, failed = 0, unverified = 0 }) {
  return { discovered, applied, held_back: heldBack, failed, unverified };
}

/**
 * Print exactly one machine-readable object, or hand control to the human renderer.
 *
 * `prose` is a thunk so the human path costs nothing when a machine is reading: verification verbs
 * emit *only* the object on `--json` (a document a consumer has to dig out of a banner is the failure
 * mode this whole file exists to remove). Mutating verbs pass `{ trailer: true }` — suppressing an
 * install's progress output would hide what the run is doing while it does it, so those keep their
 * logs and put the single envelope last on stdout.
 */
function emit(flags, env, prose, opts) {
  const machine = !!(flags && flags.json);
  // A machine reading a check verb gets exactly one object and no prose at all.
  if (machine && !(opts && opts.trailer)) {
    console.log(JSON.stringify(env, null, 2));
    return env;
  }
  if (prose) prose();
  // A mutating run keeps its progress output and ends with the single envelope object.
  if (machine) console.log(JSON.stringify(env, null, 2));
  return env;
}

module.exports = { check, envelope, fromRow, fromLine, hostCounters, emit, VERDICTS };
