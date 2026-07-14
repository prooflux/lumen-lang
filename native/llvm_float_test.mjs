// llvm_float_test.mjs - the R3a gate's float extension: interpreter vs emit_llvm.lm (now with
// float ops 29-48, plus array ops 49-52 since record field access lowers through them - see
// header note in emit_llvm.lm) -> clang(.ll) -> exe. Same corpus and byte-for-byte comparison
// approach as native_float_test.mjs's diff section (part 1 of that file): golden == interpreter
// == native, verbatim stdout, no rounding tolerance. This file adds two heap-boundary cases
// (BUG_ARRAY_OUTPUT.md) the same way native_float_test.mjs does, since the array ops this round
// added share the exact same heap-capacity constants as the emit_fn.lm runtime and must halt at
// the identical point, not just agree on values below the boundary.
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { buildAndRunLlvm } from './pipeline.mjs';

const lumen = await createCompiler();
const corpus = JSON.parse(fs.readFileSync(new URL('./float_corpus.json', import.meta.url), 'utf8'));

// Heap-halt parity pins (BUG_ARRAY_OUTPUT.md): the language's heap bound silently halts
// allocation-heavy programs at the SAME point on both sides (interpreter ANEW guard == emitted
// lm_anew guard, LM_CAP_BYTES 36288 for this shape, shared by runtime_llvm.c). One case just
// under the boundary (prints), one just over (both sides silent, golden "").
const arrPair = (n) => `fn main(c: Console) -> Unit {
  let n = ${n}
  let vols = array(n)
  let prices = array(n)
  c.print_int(123)
}
`;
corpus.push({ name: "heap_boundary_under", source: arrPair(2267), goldenStdout: "123\n", features: ["float"] });
corpus.push({ name: "heap_boundary_over_silent_halt", source: arrPair(2268), goldenStdout: "", features: ["float"] });

console.log('== diff: float/array/record programs vs interpreter oracle, emit_llvm.lm (byte-for-byte) ==');
let pass = 0, fail = 0;
for (const t of corpus) {
  const ref = lumen.run(t.source).stdout;
  let cand;
  try { cand = (await buildAndRunLlvm(t.source, '-O3')).stdout; }
  catch (e) { console.log(`FAIL  ${t.name}: ${e.message.slice(0, 200)}`); fail++; continue; }
  const ok = cand === ref && ref === t.goldenStdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name.padEnd(30)} native=${JSON.stringify(cand)} ref=${JSON.stringify(ref)} gold=${JSON.stringify(t.goldenStdout)}`);
  if (ok) pass++; else fail++;
}
console.log(`\n${pass}/${corpus.length} float/array/record programs translated by emit_llvm.lm are bit-identical to the interpreter (fail ${fail})`);

process.exit(fail === 0 ? 0 : 1);
