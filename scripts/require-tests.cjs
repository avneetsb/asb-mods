#!/usr/bin/env node
'use strict';
// A suite that ran zero tests must not be able to report success (plan §8 `O2`, §5 limitation 30).
//
// The failure this closes is quiet and total: a rename, a bad glob or an early return can leave the runner
// with nothing to execute, and "0 failed" then reads exactly like a green suite to both a human skimming
// the tail and a CI job reading only the exit code. `grep`-ing the output for "0 failed" is not a gate;
// this is.
//
// It lives in its own file rather than inline in the runner so the rule is unit-testable without running
// the fixtures, which is most of the point of `P10`'s tier split.

/**
 * @param {{passed: number, failed: number}} totals what the runner counted
 * @throws {Error} when nothing ran, with the reason a human needs
 */
function assertTestsRan(totals) {
  const passed = Number(totals && totals.passed) || 0;
  const failed = Number(totals && totals.failed) || 0;
  const ran = passed + failed;
  if (ran === 0) {
    throw new Error(
      'zero tests ran — this is a broken suite, not a passing one. '
      + 'Check that the test file defines tests before its summary block and that no early return skipped them.'
    );
  }
  return ran;
}

module.exports = { assertTestsRan };

if (require.main === module) {
  try {
    const ran = assertTestsRan({ passed: Number(process.argv[2] || 0), failed: Number(process.argv[3] || 0) });
    console.log(`suite ran ${ran} test(s)`);
  } catch (e) {
    console.error(`[zero-test] ${e.message}`);
    process.exit(1);
  }
}
