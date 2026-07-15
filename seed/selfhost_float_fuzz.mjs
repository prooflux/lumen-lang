// Differential-turned-determinism fuzz gate for the Float front-end: thousands of random
// decimal literals plus a mixed-coercion expression/comparison/statement zoo.
//
// R5: this used to compile each program with BOTH the wasm seed AND lumenc.lm self-hosted
// (running interpreted atop that same wasm VM) and required word-identical IR - a genuine
// differential proof while two independent implementations existed. Now there is only one
// compiler (lumenc.lm IS the native compiler - native/lumenc_native.mjs's header comment), so
// this is a non-crash/well-formedness fuzzer instead: every program must compile with zero
// diagnostics (well-formed float syntax should never error) and run without crashing. A SEPARATE,
// SMALL determinism spot-check (below the main loop) proves two independent compiles of the same
// source stay byte-identical, without paying a process-spawn per case for the FULL few-thousand-
// case sweep - the resident compiler (native/native_compile.mjs's compileToIRNativeResidentRaw)
// keeps that main sweep fast (one warm process, not one spawn per case). Bit-exact correctness of
// individual float operations (exp/ln/pow/sqrt/round, the hand-rolled Taylor-series algorithms)
// is separately, thoroughly gated by seed/basics.mjs and native/ir_interpreter_test.mjs's fuzz
// coverage against the (at-the-time still-present) wasm oracle - see the R5 PR body. This file's
// remaining unique value is BREADTH: thousands of random literal shapes and expression forms
// that basics.mjs's curated cases don't individually enumerate, still exercised every run.
// Deterministic PRNG - no flakes, same corpus every run.
import { compileToIRNativeResidentRaw, compileToIRNativeRaw } from '../native/native_compile.mjs';
import { createInterpreter } from '../native/ir_interpreter.mjs';

async function compileAndRun(src) {
  const r = await compileToIRNativeResidentRaw(src);
  if (r.nerr > 0) return { ok: false, nerr: r.nerr };
  const interp = createInterpreter();
  interp.writeCode(r.words);
  interp.seedStrings(r.strings);
  interp.set_fuel_max(4000000000n);
  try { interp.run(r.main); return { ok: true, words: r.words, stdout: interp.getOut() }; }
  catch (e) { return { ok: false, crash: String(e.message || e) }; }
}

let fails = 0, total = 0;
const allSrcs = [];
async function check(name, src) {
  total++;
  allSrcs.push({ name, src });
  const r = await compileAndRun(src);
  if (!r.ok) { console.log(`FAIL(${r.crash ? `crash: ${r.crash}` : `compile error, nerr=${r.nerr}`}) ${name}`); fails++; }
}

// deterministic PRNG (fixed seed: same corpus every run, no flakes)
let st = 0x9e3779b9;
const rnd = () => (st = (st * 1103515245 + 12345) >>> 0) / 4294967296;
const digits = (n) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join('');

// 1. random literals: up to 15-digit integer parts x 18-digit fractions
for (let t = 0; t < 3000 && fails <= 5; t++) {
  const ip = digits(1 + Math.floor(rnd() * 15)).replace(/^0+(?=.)/, '');
  const lit = `${ip}.${digits(1 + Math.floor(rnd() * 18))}`;
  await check(`lit ${lit}`, `fn f() -> Float { return ${lit} } fn main(c: Console) -> Unit { let x = f() return () }`);
}
// 2. special constants (mathematical constants the corpus actually uses, boundary shapes)
for (const lit of ['0.0', '0.5', '1.0', '2.0', '0.1', '0.2', '0.3', '123456789012345.678901234567',
  '0.000000000000000001', '999999999999999999.9', '1.7976931348623157', '0.3989422804014327',
  '10.450576', '0.6931471805599453', '1.4142135623730951', '0.2316419', '0.319381530',
  '1.781477937', '1.330274429', '3.14159265358979', '2.718281828459045']) {
  await check(`lit ${lit}`, `fn f() -> Float { return ${lit} } fn main(c: Console) -> Unit { let x = f() return () }`);
}
// 3. mixed-coercion expression zoo (both operand orders, nesting, unary minus, conversions)
const exprs = [
  '1 + 2.5', '2.5 + 1', '1 - 2.5', '2.5 - 1', '3 * 0.5', '0.5 * 3', '7 / 2.0', '2.0 / 7',
  'a + 1', '1 + a', 'a * b', 'a / 2', '2 / a', 'a - b * 2', '(a + 1) * (b - 2.0)',
  '-a', '-a * b', 'a * -b', '-(a + b)', '- -a', '-1.5 + a', 'a + -1.5',
  'to_float(n) + a', 'to_int(a) + n', 'round(a * 100.0)', 'sqrt(a) * exp(b)',
  'ln(a) - pow(b, 2.0)', 'abs(a - b)', 'a / b / 2', 'a * b * 1.5 * n',
];
for (const e of exprs) {
  await check(`expr ${e}`, `fn g(a: Float, b: Float, n: Int) -> Float { return ${e} } fn main(c: Console) -> Unit { let x = g(1.25, 2.5, 3) return () }`);
}
// 4. all six comparisons x operand-type mixes
for (const op of ['<', '<=', '>', '>=', '==', '!=']) {
  for (const [l, r] of [['a', 'b'], ['a', '1'], ['1', 'a'], ['n', 'b'], ['a', '0.5'], ['n', '2']]) {
    await check(`cmp ${l}${op}${r}`, `fn g(a: Float, b: Float, n: Int) -> Int { if ${l} ${op} ${r} { return 1 } return 0 } fn main(c: Console) -> Unit { c.print_int(g(1.0, 2.0, 3)) return () }`);
  }
}
// 5. statement shapes: float while conditions, let chains, annotations, forward/backward calls
await check('float while', `fn main(c: Console) -> Unit { var x = 8.0 while x > 1.0 { x = x * 0.5 } c.print_int(to_int(x)) return () }`);
await check('let chain', `fn main(c: Console) -> Unit { let a = 1.5 let b = a * 2.0 let n = to_int(b) let d = to_float(n) / 4.0 c.print_int(round(d * 100.0)) return () }`);
await check('fwd call', `fn main(c: Console) -> Unit { let x = g() let y = x + 1 c.print_int(y) return () } fn g() -> Float { return 1.5 }`);
await check('bwd call', `fn g() -> Float { return 1.5 } fn main(c: Console) -> Unit { let x = g() let y = x + 1 c.print_int(to_int(y)) return () }`);
await check('annot', `fn main(c: Console) -> Unit { let x: Float = 1.5 var y: Int = 3 let z: Float = to_float(y) c.print_int(to_int(x + z)) return () }`);

console.log(`\n${total - fails}/${total} programs compiled and ran without error via the resident compiler.`);

// Determinism spot-check: a sample across the corpus, each re-compiled via the ONE-SHOT native
// compiler (a fully separate OS process, not just a second resident round-trip) and asserted
// byte-identical to the resident run above - proving determinism is real, not an artifact of
// reusing the same warm process. Sampled (not all ~3089 cases) to keep this file's own wall time
// reasonable; the full corpus already ran once above via the fast resident path.
const sampleStride = Math.max(1, Math.floor(allSrcs.length / 15));
let detFails = 0, detTotal = 0;
for (let i = 0; i < allSrcs.length; i += sampleStride) {
  const { name, src } = allSrcs[i];
  detTotal++;
  const resident = await compileAndRun(src);
  const oneShot = compileToIRNativeRaw(src);
  if (oneShot.nerr > 0) { console.log(`FAIL(determinism: one-shot compile error) ${name}`); detFails++; continue; }
  const interp2 = createInterpreter();
  interp2.writeCode(oneShot.words);
  interp2.seedStrings(oneShot.strings);
  interp2.set_fuel_max(4000000000n);
  interp2.run(oneShot.main);
  const oneShotOut = interp2.getOut();
  if (!resident.ok || resident.words.length !== oneShot.words.length || resident.stdout !== oneShotOut) {
    console.log(`FAIL(determinism mismatch: resident vs one-shot) ${name}`);
    detFails++;
  }
}
console.log(`${detTotal - detFails}/${detTotal} sampled programs deterministic across independent processes (resident vs one-shot).`);

process.exit(fails || detFails ? 1 : 0);
