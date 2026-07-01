// native_diff.mjs - the M0 differential harness (the forever-gate, RULES rule 5).
//
// The interpreter ($run in lumenc.wat, via compiler_core) is the reference oracle.
// For each program: ref = interpret(compile(src)); cand = run(clang(emit_fn.lm(compile(src)))).
// Assert cand.stdout === ref.stdout byte-for-byte, zero tolerance. Backend-agnostic: it diffs
// the interpreter against ANY native executable, so it is unchanged as the codegen path moves
// C -> LLVM-IR -> asm (the "ditch clang" ladder).
//
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { buildAndRun, buildAndRunFn } from './pipeline.mjs';

// v2 (emit_fn.lm) covers everything incl. text/heap/sum; v1 (emit.lm) stays gated on its scalar
// subset so the historical wedge keeps bit-identity coverage (repointing the whole gate at v2
// silently dropped v1 - restored by manager review).
const SCALAR = [
  'fib_print', 'add', 'max', 'fact', 'locals', 'forward', 'mutual', 'compare', 'gcd', 'count', 'sum_loop'
];
const PROGRAMS = [
  ...SCALAR,
  'hello', 'greet', 'report', 'fizzbuzz', 'safe_div', 'propagate'
];

const lumen = await createCompiler();
let pass = 0, fail = 0, skip = 0;

for (const name of PROGRAMS) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`SKIP  ${name} (interpreter compile error)`); skip++; continue; }
  let cand;
  try { cand = await buildAndRunFn(src); }
  catch (e) { console.log(`FAIL  ${name}: native build/run error: ${e.message.slice(0, 120)}`); fail++; continue; }
  const ok = cand.stdout === ref.stdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} native=${JSON.stringify(cand.stdout)}  ref=${JSON.stringify(ref.stdout)}`);
  if (ok) pass++; else fail++;
}

// v1 (emit.lm) scalar coverage - unchanged subset, same oracle
let passV1 = 0, failV1 = 0;
for (const name of SCALAR) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { failV1++; continue; }
  let cand;
  try { cand = await buildAndRun(src); }
  catch (e) { console.log(`FAIL  v1:${name}: ${e.message.slice(0, 100)}`); failV1++; continue; }
  const ok = cand === ref.stdout || cand?.stdout === ref.stdout;
  if (!ok) console.log(`FAIL  v1:${name.padEnd(10)} native=${JSON.stringify(cand?.stdout ?? cand)}  ref=${JSON.stringify(ref.stdout)}`);
  if (ok) passV1++; else failV1++;
}
console.log(`${passV1}/${SCALAR.length} scalar programs translated by emit.lm v1 are bit-identical to the interpreter  (fail ${failV1})`);

console.log(`\n${pass}/${PROGRAMS.length} conformance programs translated by emit_fn.lm (Lumen) are bit-identical to the interpreter  (fail ${fail}, skip ${skip})`);
process.exit(fail === 0 && failV1 === 0 ? 0 : 1);
