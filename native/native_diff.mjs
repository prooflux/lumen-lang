// native_diff.mjs - the M0 differential harness (the forever-gate, RULES rule 5).
//
// The interpreter ($run in lumenc.wat, via compiler_core) is the reference oracle.
// For each program: ref = interpret(compile(src)); cand = run(clang(emit.lm(compile(src)))).
// Assert cand.stdout === ref.stdout byte-for-byte, zero tolerance. Backend-agnostic: it diffs
// the interpreter against ANY native executable, so it is unchanged as the codegen path moves
// C -> LLVM-IR -> asm (the "ditch clang" ladder).
//
// Scope: the scalar/control/calls subset (opcodes 0..24). Float/text/heap programs are
// EXCLUDED explicitly (listed below), not silently dropped; they enter at later milestones.
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { buildAndRun } from './pipeline.mjs';

// pure scalar/control/calls conformance programs (no Float, Text, arrays, sum types)
const SCALAR = ['fib_print', 'add', 'max', 'fact', 'locals', 'forward', 'mutual', 'compare', 'gcd', 'count', 'sum_loop'];
// excluded from the scalar gate (named, not silently dropped) - they need text/sum opcodes:
const EXCLUDED = { hello: 'text', greet: 'text', report: 'text', fizzbuzz: 'text', safe_div: 'sum', propagate: 'sum' };

const lumen = await createCompiler();
let pass = 0, fail = 0, skip = 0;

for (const name of SCALAR) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`SKIP  ${name} (interpreter compile error)`); skip++; continue; }
  let cand;
  try { cand = await buildAndRun(src); }
  catch (e) { console.log(`FAIL  ${name}: native build/run error: ${e.message.slice(0, 120)}`); fail++; continue; }
  const ok = cand.stdout === ref.stdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} native=${JSON.stringify(cand.stdout)}  ref=${JSON.stringify(ref.stdout)}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${SCALAR.length} scalar programs translated by emit.lm (Lumen) are bit-identical to the interpreter  (fail ${fail}, skip ${skip})`);
console.log(`excluded from the scalar gate (need later milestones): ${Object.keys(EXCLUDED).join(', ')}`);
process.exit(fail === 0 ? 0 : 1);
