// effects_test.mjs (C0) - unit tests for the pure functions in effects.mjs (oplen, extractFunctions,
// closeEffects) exercised as in-memory fixtures, plus integration checks against real conformance-
// corpus programs (mutual/forward recursion, decimal.lm's DPUSH-heavy body, a real finance kernel
// file). Style mirrors tools/scoreboard_gate_test.mjs: plain check()/checkEmpty()/checkDeepEqual
// helpers, PASS/FAIL per case, exit 1 on any failure.
//
// Run: node effects_test.mjs

import fs from 'node:fs';
import { createCompiler } from './compiler_core.mjs';
import { oplen, extractFunctions, closeEffects, effectsFromSource, CAPABILITY_REGISTRY } from './effects.mjs';

let failures = 0;
function check(cond, msg) {
  if (cond) { console.log(`PASS  ${msg}`); }
  else { console.error(`FAIL  ${msg}`); failures++; }
}
function checkEq(actual, expected, msg) {
  check(actual === expected, `${msg} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}
function checkSetEq(actual, expected, msg) {
  const a = [...actual].sort(), e = [...expected].sort();
  check(JSON.stringify(a) === JSON.stringify(e), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(e)})`);
}

// ---------------------------------------------------------------------------
// oplen(): every two-operand op must be recognized, INCLUDING op 64 (DPUSH) - this is the exact
// bug this file's own header comment names (found independently in native/pipeline.mjs,
// native/optimize.lm, native/emit_llvm.lm before D2/D3 fixed each; and in seed/lumen_mcp.mjs's
// typesFromSource/ir(), still unfixed as of this writing). Getting this wrong silently desyncs
// every walk below on any program containing a Dec literal.
// ---------------------------------------------------------------------------
checkEq(oplen(8), 2, 'oplen(CALL=8) is 2 (entry, argc)');
checkEq(oplen(29), 2, 'oplen(FPUSH=29) is 2 (lo, hi)');
checkEq(oplen(64), 2, 'oplen(DPUSH=64) is 2 (lo, hi) - the regression this file exists to pin');
for (const op of [1, 2, 6, 7, 13, 14, 15, 25]) checkEq(oplen(op), 1, `oplen(${op}) is 1`);
for (const op of [0, 3, 4, 5, 9, 10, 11, 12, 16, 17, 18, 19, 20, 21, 22, 23, 24, 26, 27, 28, 53, 54, 55, 56, 58, 59, 60, 61, 62, 63, 65, 66, 67, 68, 69, 70]) {
  checkEq(oplen(op), 0, `oplen(${op}) is 0 (stack-only, no inline operand)`);
}

// ---------------------------------------------------------------------------
// extractFunctions(): hand-built IR word arrays. Layout per function: [13, framesize, 57, ntot,
// rettype, <types...>, <body...>]. These are synthetic - not real compiler output - deliberately
// so the walk's own correctness is isolated from the compiler.
// ---------------------------------------------------------------------------
{
  // fn f() -> Int { return 1 }: RESERVE 0, TYPEMAP(ntot=0), PUSH 1, RET. No calls, no Console.
  const words = [13, 0, 57, 0, 0, 1, 1, 9];
  const fns = extractFunctions(words);
  checkEq(fns.length, 1, 'single trivial function: one entry found');
  checkEq(fns[0].entry, 0, 'single trivial function: entry is 0');
  checkEq(fns[0].calls.size, 0, 'single trivial function: no calls');
  check(!fns[0].directOps.has(10) && !fns[0].directOps.has(16), 'single trivial function: no Console ops');
}
{
  // fn f(console: Console) -> Unit { console.print_int(1) }: RESERVE 1, TYPEMAP(ntot=1,[Int]),
  // GETARG 0, PUSH 1, PRINTINT.
  const words = [13, 1, 57, 1, 0, 0, 2, 0, 1, 1, 10];
  const fns = extractFunctions(words);
  checkEq(fns.length, 1, 'PRINTINT function: one entry found');
  check(fns[0].directOps.has(10), 'PRINTINT function: op 10 recorded as a direct op');
}
{
  // Two functions: f() calls g() (CALL entry=<g's pc> argc=0); g() does nothing.
  //   f @0: [13,0, 57,0,0,  8,?,0, 9]     (CALL patched below, RET)
  //   g @9: [13,0, 57,0,0, 9]             (RET)
  const words = [13, 0, 57, 0, 0, 8, 9, 0, 9, 13, 0, 57, 0, 0, 9];
  const fns = extractFunctions(words);
  checkEq(fns.length, 2, 'two-function call graph: both entries found');
  checkEq(fns[0].entry, 0, 'caller entry is 0');
  checkEq(fns[1].entry, 9, 'callee entry is 9');
  check(fns[0].calls.has(9), 'caller records a call to the callee entry (9)');
}
{
  // DPUSH-then-more-ops regression: a function whose body is DPUSH(lo,hi) then PRINTINT then RET.
  // If oplen(64) were wrong (treated as 0 or 1 operand), the walk would either read `hi` (a huge
  // arbitrary word, here 0) as a fresh opcode, or misalign PRINTINT/RET entirely.
  const words = [13, 0, 57, 0, 0, 64, 1500000, 0, 10, 9];
  const fns = extractFunctions(words);
  checkEq(fns.length, 1, 'DPUSH-containing function: exactly one function found (walk did not desync)');
  check(fns[0].directOps.has(10), 'DPUSH-containing function: PRINTINT after the DPUSH is still seen');
  check(!fns[0].directOps.has(1500000) && !fns[0].directOps.has(0), 'DPUSH-containing function: the DPUSH operand words are never read as opcodes');
}

// ---------------------------------------------------------------------------
// closeEffects(): pure graph-closure fixtures. entry numbers are arbitrary distinct ints, not
// real PCs - closeEffects never inspects them beyond using them as map keys.
// ---------------------------------------------------------------------------
{
  // A(直接 Console) ; B calls A ; C and D mutually recurse, neither touches Console.
  const registry = { Console: new Set([10, 16]) };
  const functions = [
    { entry: 1, directOps: new Set([10]), calls: new Set() },           // A: direct Console
    { entry: 2, directOps: new Set(), calls: new Set([1]) },            // B: calls A
    { entry: 3, directOps: new Set(), calls: new Set([4]) },            // C <-> D, pure
    { entry: 4, directOps: new Set(), calls: new Set([3]) },
  ];
  const closed = closeEffects(functions, registry);
  checkSetEq(closed.get(1), ['Console'], 'direct Console user has {Console}');
  checkSetEq(closed.get(2), ['Console'], 'one-hop caller inherits {Console}');
  checkSetEq(closed.get(3), [], 'mutually-recursive pure pair, member 1: stays pure (fixpoint does not spuriously propagate)');
  checkSetEq(closed.get(4), [], 'mutually-recursive pure pair, member 2: stays pure');
}
{
  // Mutual recursion where ONE member also calls a Console-using leaf: capability must propagate
  // to BOTH cycle members, not just the one with the direct call.
  const registry = { Console: new Set([10, 16]) };
  const functions = [
    { entry: 10, directOps: new Set([16]), calls: new Set() },          // leaf: direct Console
    { entry: 11, directOps: new Set(), calls: new Set([12, 10]) },      // C: calls D and the leaf
    { entry: 12, directOps: new Set(), calls: new Set([11]) },          // D: calls C only
  ];
  const closed = closeEffects(functions, registry);
  checkSetEq(closed.get(11), ['Console'], 'cycle member with the direct leaf call gets Console');
  checkSetEq(closed.get(12), ['Console'], 'the OTHER cycle member also gets Console, via the cycle');
}
{
  // Diamond: A calls B and C; both call D (Console). A must end up with exactly {Console}, once.
  const registry = { Console: new Set([10, 16]) };
  const functions = [
    { entry: 20, directOps: new Set([10]), calls: new Set() },          // D
    { entry: 21, directOps: new Set(), calls: new Set([20]) },          // B
    { entry: 22, directOps: new Set(), calls: new Set([20]) },          // C
    { entry: 23, directOps: new Set(), calls: new Set([21, 22]) },      // A
  ];
  const closed = closeEffects(functions, registry);
  checkSetEq(closed.get(23), ['Console'], 'diamond call graph converges to {Console} exactly once');
}

// ---------------------------------------------------------------------------
// effectsFromSource(): integration against the real compiler + real conformance-corpus files.
// ---------------------------------------------------------------------------
const lumen = await createCompiler();

{
  const src = fs.readFileSync(new URL('../mu/examples/mutual.lm', import.meta.url), 'utf8');
  const r = effectsFromSource(lumen, src);
  check(r.ok, 'mutual.lm compiles for effects analysis');
  const byName = Object.fromEntries(r.functions.map((f) => [f.name, f.effects]));
  checkEq(r.functions.length, 3, 'mutual.lm: 3 functions found (is_even, is_odd, main)');
  checkSetEq(byName.is_even || [], [], 'mutual.lm: is_even is pure despite recursing through is_odd');
  checkSetEq(byName.is_odd || [], [], 'mutual.lm: is_odd is pure despite recursing through is_even');
  checkSetEq(byName.main || [], ['Console'], 'mutual.lm: main has Console (console.print_int)');
}
{
  const src = fs.readFileSync(new URL('../mu/examples/forward.lm', import.meta.url), 'utf8');
  const r = effectsFromSource(lumen, src);
  const byName = Object.fromEntries(r.functions.map((f) => [f.name, f.effects]));
  checkSetEq(byName.helper || [], [], 'forward.lm: helper (defined after main) is pure');
  checkSetEq(byName.main || [], ['Console'], 'forward.lm: main has Console');
}
{
  // decimal.lm: the DPUSH-oplen regression test against REAL compiler output, not a hand-built
  // fixture - many Dec literals (DPUSH) interleaved with Text literals (MKTEXT) and print calls
  // in `main`'s body. If the oplen table were wrong here, this would desync mid-function.
  const src = fs.readFileSync(new URL('../mu/examples/decimal.lm', import.meta.url), 'utf8');
  const r = effectsFromSource(lumen, src);
  check(r.ok, 'decimal.lm compiles for effects analysis');
  const byName = Object.fromEntries(r.functions.map((f) => [f.name, f.effects]));
  checkEq(r.functions.length, 2, 'decimal.lm: 2 functions found (account_value, main)');
  checkSetEq(byName.account_value || [], [], 'decimal.lm: account_value (Dec params/return) is pure');
  checkSetEq(byName.main || [], ['Console'], 'decimal.lm: main has Console');
}
{
  const src = fs.readFileSync(new URL('../examples/finance/black_scholes.lm', import.meta.url), 'utf8');
  const r = effectsFromSource(lumen, src);
  check(r.ok, 'finance/black_scholes.lm compiles for effects analysis');
  const byName = Object.fromEntries(r.functions.map((f) => [f.name, f.effects]));
  checkSetEq(byName.norm_cdf || [], [], 'black_scholes.lm: norm_cdf (the pricing kernel) is pure');
  checkSetEq(byName.bs_call || [], [], 'black_scholes.lm: bs_call (the pricing kernel) is pure, despite calling norm_cdf/sqrt/ln/exp');
  checkSetEq(byName.show || [], ['Console'], 'black_scholes.lm: show has Console (direct print calls)');
  checkSetEq(byName.main || [], ['Console'], 'black_scholes.lm: main has Console, via calling show');
  checkEq(r.summary.total, 4, 'black_scholes.lm: summary.total is 4');
  checkEq(r.summary.pure, 2, 'black_scholes.lm: summary.pure is 2 (norm_cdf, bs_call)');
  checkEq(r.summary.purityFraction, 0.5, 'black_scholes.lm: purityFraction is 0.5');
}
{
  // A genuine compile error (an unresolvable reference; err code 1 = unknown variable) must come
  // back ok:false with diagnostics, never throw. (A bad `let` type ANNOTATION was tried first and
  // rejected as a test case: the current bootstrap seed does not yet check `let`'s optional
  // annotation against its initializer, so it is not actually an error today - not this file's
  // concern to fix, just not a usable fixture.)
  const r = effectsFromSource(lumen, 'fn main(c: Console) -> Unit { c.print_int(totally_undefined_xyz) }');
  check(r.ok === false, 'an unresolvable-reference program returns ok:false, not a thrown exception');
  check(Array.isArray(r.rawDiags) && r.rawDiags.length > 0, 'an unresolvable-reference program carries at least one raw diagnostic');
}
{
  // The registry is threaded through, not hardcoded: an empty registry means every function is
  // trivially "pure" by construction (no capability kind can ever be derived).
  const src = fs.readFileSync(new URL('../mu/examples/hello.lm', import.meta.url), 'utf8');
  const r = effectsFromSource(lumen, src, {});
  check(r.ok, 'hello.lm compiles under an empty registry');
  check(r.functions.every((f) => f.effects.length === 0), 'empty registry: every function is (trivially) pure');
  checkSetEq(r.registry, [], 'empty registry: registry field reflects the empty registry, not the default');
}
check(Object.keys(CAPABILITY_REGISTRY).length === 1 && CAPABILITY_REGISTRY.Console, 'default CAPABILITY_REGISTRY has exactly one kind, Console, today');

console.log(failures === 0 ? '\neffects_test: all checks passed.' : `\neffects_test: ${failures} failure(s).`);
process.exit(failures === 0 ? 0 : 1);
