// llvm_diff.mjs - the R3a gate: interpreter vs emit_llvm.lm -> clang(.ll) -> exe.
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { buildAndRunLlvm, buildAndRunFn } from './pipeline.mjs';

const INLINE = [
  ['arith', `fn main(c: Console) -> Unit { c.print_int(1 + 2 + 39) }`],
  ['call-ret', `fn inc(x: Int) -> Int { return x + 1 }
fn twice(x: Int) -> Int { return inc(inc(x)) }
fn main(c: Console) -> Unit { c.print_int(twice(40)) }`],
  ['branch', `fn pick(x: Int) -> Int {
  if x { return 7 }
  return 9
}
fn main(c: Console) -> Unit {
  c.print_int(pick(1))
  c.print_int(pick(0))
  c.print_int(pick(5) + pick(0))
}`],
  ['locals', `fn main(c: Console) -> Unit {
  let a = 10
  let b = 20
  var s = a + b
  s = s + 12
  c.print_int(s)
}`],
];

const SCALAR = [
  'fib_print', 'add', 'max', 'fact', 'locals', 'forward', 'mutual', 'compare', 'gcd', 'count', 'sum_loop'
];

const lumen = await createCompiler();
let pass = 0, fail = 0;

// 1. Run 4 inline programs
for (const [name, src] of INLINE) {
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`FAIL  ${name} (interpreter compile error)`); fail++; continue; }
  const cand = await buildAndRunLlvm(src, '-O3');
  const ok = cand.stdout === ref.stdout && cand.exit === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} native=${JSON.stringify(cand.stdout)}  ref=${JSON.stringify(ref.stdout)}`);
  if (ok) pass++; else fail++;
}

// 2. Run 11 corpus programs
for (const name of SCALAR) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`FAIL  ${name} (interpreter compile error)`); fail++; continue; }
  const cand = await buildAndRunLlvm(src, '-O3');
  const ok = cand.stdout === ref.stdout && cand.exit === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(9)} native=${JSON.stringify(cand.stdout)}  ref=${JSON.stringify(ref.stdout)}`);
  if (ok) pass++; else fail++;
}

const totalNormal = INLINE.length + SCALAR.length;
console.log(`\n${pass}/${totalNormal} scaffold-subset programs translated by emit_llvm.lm are bit-identical to the interpreter (fail ${fail})`);

// 3. Run the two trap-parity programs (Honesty rules)
const TRAPS = [
  ['div-zero-trap', `fn main(c: Console) -> Unit { c.print_int(123) let x = 1 / 0 }`],
  ['mod-zero-trap', `fn main(c: Console) -> Unit { c.print_int(456) let x = 1 % 0 }`],
];

let trapPass = 0, trapFail = 0;
for (const [name, src] of TRAPS) {
  const ref = lumen.run(src);
  const cand = await buildAndRunLlvm(src, '-O3');
  const stdoutOk = cand.stdout === ref.stdout;
  const exitOk = cand.exit !== 0;
  const ok = stdoutOk && exitOk;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(15)} native=${JSON.stringify(cand.stdout)} exit=${cand.exit} ref=${JSON.stringify(ref.stdout)} crash=${JSON.stringify(ref.crash)}`);
  if (ok) trapPass++; else trapFail++;
}

// 4. Print informational fib rate line
const fibSrc = fs.readFileSync(new URL(`../mu/examples/fib_print.lm`, import.meta.url), 'utf8');
const startLlvm = performance.now();
await buildAndRunLlvm(fibSrc, '-O3');
const endLlvm = performance.now();
const llvmTime = endLlvm - startLlvm;

const startFn = performance.now();
await buildAndRunFn(fibSrc, '-O3');
const endFn = performance.now();
const fnTime = endFn - startFn;

console.log(`\nInformational: fib_print build & run time (wall time):`);
console.log(`  LLVM path (buildAndRunLlvm): ${llvmTime.toFixed(1)}ms`);
console.log(`  C path (buildAndRunFn):      ${fnTime.toFixed(1)}ms`);

process.exit(fail === 0 && trapFail === 0 ? 0 : 1);
