#!/usr/bin/env node
// effects_gate_test.mjs (C0) - smoke test for tools/effects_gate.mjs's pure functions
// (hasConsoleParam, checkSoundness, checkFinanceKernels, isRatchetRegression), exercised as
// in-memory fixtures. No compiler, no filesystem, no git - mirrors scoreboard_gate_test.mjs's own
// split between pure logic (tested here) and its thin fs/compiler-facing glue (untested, exactly
// like purity_gate.mjs's and scoreboard_gate.mjs's own git calls).
//
// Run: node tools/effects_gate_test.mjs

import { hasConsoleParam, checkSoundness, checkFinanceKernels, isRatchetRegression } from './effects_gate.mjs';

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else { console.error(`FAIL  ${msg}`); failures++; }
}

// ---------------------------------------------------------------------------
// hasConsoleParam
// ---------------------------------------------------------------------------
check(hasConsoleParam('fn norm_cdf(x: Float) -> Float {') === false, 'hasConsoleParam: a Float-only signature has no Console param');
check(hasConsoleParam('fn show(console: Console, p: Float) -> Unit {') === true, 'hasConsoleParam: console: Console is detected');
check(hasConsoleParam('fn main(c: Console) -> Unit {') === true, 'hasConsoleParam: c: Console is detected (short param name)');
check(hasConsoleParam('fn main() {') === false, 'hasConsoleParam: zero-arg main has no Console param (this is exactly the exempted case)');
check(hasConsoleParam('') === false, 'hasConsoleParam: empty signature is false, not a throw');
check(hasConsoleParam(undefined) === false, 'hasConsoleParam: undefined signature is false, not a throw');
check(hasConsoleParam('fn f(a: Int, console: Console, b: Text) -> Unit {') === true, 'hasConsoleParam: detected in a non-first parameter position');

// ---------------------------------------------------------------------------
// checkSoundness
// ---------------------------------------------------------------------------
{
  const clean = [
    { name: 'norm_cdf', line: 1, signature: 'fn norm_cdf(x: Float) -> Float {', effects: [] },
    { name: 'show', line: 2, signature: 'fn show(console: Console, p: Float) -> Unit {', effects: ['Console'] },
  ];
  check(checkSoundness('f.lm', clean).length === 0, 'checkSoundness: a well-formed file has no violations');
}
{
  const violating = [
    { name: 'sneaky', line: 1, signature: 'fn sneaky(x: Int) -> Int {', effects: ['Console'] },
  ];
  const failures2 = checkSoundness('f.lm', violating);
  check(failures2.length === 1, 'checkSoundness: a non-main function with Console effects but no Console param is flagged');
  check(failures2[0].includes('sneaky'), 'checkSoundness: the failure message names the offending function');
}
{
  // The exact regression this exemption exists for: mu/examples/count.lm and sum_loop.lm's
  // `fn main() { console.print_int(i) }` shape.
  const zeroArgMain = [
    { name: 'main', line: 1, signature: 'fn main() {', effects: ['Console'] },
  ];
  check(checkSoundness('count.lm', zeroArgMain).length === 0, 'checkSoundness: main is exempt even with no Console param and Console effects');
}

// ---------------------------------------------------------------------------
// checkFinanceKernels
// ---------------------------------------------------------------------------
{
  const byFile = new Map([
    ['finance/a.lm', [
      { name: 'kernel_ok', signature: 'fn kernel_ok(x: Float) -> Float {', effects: [] },
      { name: 'kernel_bad', signature: 'fn kernel_bad(x: Float) -> Float {', effects: ['Console'] },
      { name: 'show', signature: 'fn show(console: Console, p: Float) -> Unit {', effects: ['Console'] },   // has Console param: not a kernel candidate
      { name: 'main', signature: 'fn main(console: Console) -> Unit {', effects: ['Console'] },              // same
    ]],
  ]);
  const { pass, fail } = checkFinanceKernels(byFile);
  check(pass.length === 1 && pass[0].name === 'kernel_ok', 'checkFinanceKernels: a pure non-Console-param function passes');
  check(fail.length === 1 && fail[0].name === 'kernel_bad', 'checkFinanceKernels: an impure non-Console-param function fails, named');
  check(!pass.some((p) => p.name === 'show' || p.name === 'main') && !fail.some((f) => f.name === 'show' || f.name === 'main'),
    'checkFinanceKernels: functions WITH a Console parameter are excluded from both pass and fail (not kernel candidates)');
}

// ---------------------------------------------------------------------------
// isRatchetRegression
// ---------------------------------------------------------------------------
check(isRatchetRegression({ pure: 46, total: 90 }, { pure: 46, total: 90 }) === false, 'isRatchetRegression: identical fractions is not a regression');
check(isRatchetRegression({ pure: 50, total: 90 }, { pure: 46, total: 90 }) === false, 'isRatchetRegression: an improved fraction is not a regression');
check(isRatchetRegression({ pure: 40, total: 90 }, { pure: 46, total: 90 }) === true, 'isRatchetRegression: a lower pure count at the same total IS a regression');
check(isRatchetRegression({ pure: 46, total: 100 }, { pure: 46, total: 90 }) === true, 'isRatchetRegression: the same pure count over a larger total (diluted fraction) IS a regression');
check(isRatchetRegression({ pure: 23, total: 45 }, { pure: 46, total: 90 }) === false, 'isRatchetRegression: the same ratio at smaller absolute numbers (23/45 == 46/90) is not a regression - exercises the cross-multiplication path, not just equal inputs');
check(isRatchetRegression({ pure: 0, total: 0 }, { pure: 46, total: 90 }) === true, 'isRatchetRegression: scanning zero functions against a real baseline IS a regression');
check(isRatchetRegression({ pure: 46, total: 90 }, { pure: 0, total: 0 }) === false, 'isRatchetRegression: no baseline pinned yet (total 0) is never a regression');

console.log(failures === 0 ? '\neffects_gate_test: all checks passed.' : `\neffects_gate_test: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
