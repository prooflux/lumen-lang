// ir_interpreter_test.mjs - R5: the permanent correctness gate for native/ir_interpreter.mjs, the
// pure-JS in-process interpreter that replaced the retired WebAssembly interpreter as
// seed/compiler_core.mjs's run()/ir() engine. Zero wasm anywhere in this file's own call graph
// (compiles via native_compile.mjs's native compiler; the frozen seed/corpus.mjs golden strings
// are the oracle - they were themselves proven against the wasm interpreter before it was
// retired, so they remain a faithful regression anchor going forward).
//
// Three layers of proof:
//   A. Full corpus (32 programs): native-compile -> interpret -> byte-identical to the frozen
//      golden AND deterministic across two independent interpreter instances.
//   B. Trap parity: div-by-zero / mod-by-zero must throw (matches llvm_diff.mjs's TRAPS
//      convention and the retired wasm interpreter's trap behavior).
//   C. Safety: the fuel cap halts an infinite loop fast (no hang), and an unrecognized opcode
//      halts silently rather than throwing - both mirror the retired $run's own guarantees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileToIRNative } from './native_compile.mjs';
import { createInterpreter } from './ir_interpreter.mjs';
import { CASES } from '../seed/corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '../seed');

let pass = 0, fail = 0;
function check(name, cond, extra = '') { if (cond) pass++; else { fail++; console.log(`FAIL  ${name}  ${extra}`); } }

function compileAndRun(src) {
  const { words, main, strings } = compileToIRNative(src);
  const interp = createInterpreter();
  interp.writeCode(words);
  interp.seedStrings(strings);
  interp.set_fuel_max(4000000000n);
  try { interp.run(main); return { stdout: interp.getOut(), crash: null }; }
  catch (e) { return { stdout: interp.getOut(), crash: String(e.message || e) }; }
}

console.log(`== Part A: full corpus (${CASES.length} cases), native compile + JS interpret vs frozen golden ==`);
for (const [rel, expected] of CASES) {
  const src = fs.readFileSync(path.join(SEED_DIR, rel), 'utf8');
  const r1 = compileAndRun(src);
  const r2 = compileAndRun(src);   // second, independent instance: determinism check
  const ok = r1.stdout === expected && !r1.crash && r1.stdout === r2.stdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${rel}`);
  check(`corpus:${rel}`, ok, `expected=${JSON.stringify(expected)} got=${JSON.stringify(r1.stdout)} crash=${r1.crash}`);
}

console.log('\n== Part B: trap parity (div/mod by zero must throw, matching the retired wasm interpreter) ==');
{
  const r1 = compileAndRun('fn main(c: Console) -> Unit { c.print_int(123)\n  let x = 1 / 0 }\n');
  check('div-zero traps (stdout printed before the trap)', r1.stdout === '123\n' && !!r1.crash, JSON.stringify(r1));
  const r2 = compileAndRun('fn main(c: Console) -> Unit { c.print_int(456)\n  let x = 1 % 0 }\n');
  check('mod-zero traps (stdout printed before the trap)', r2.stdout === '456\n' && !!r2.crash, JSON.stringify(r2));
}

console.log('\n== Part C: safety (fuel cap halts fast; unrecognized opcode halts, does not throw) ==');
{
  const { words, main } = compileToIRNative('fn main(console: Console) -> Unit {\n  var i = 0\n  while i == 0 {\n    i = 0\n  }\n}\n');
  const interp = createInterpreter();
  interp.writeCode(words);
  interp.set_fuel_max(200000n);
  const t0 = Date.now();
  interp.run(main);
  const elapsed = Date.now() - t0;
  check('fuel cap halts an infinite loop fast (no hang)', elapsed < 2000, `elapsed=${elapsed}ms`);
}
{
  const interp = createInterpreter();
  interp.writeCode(Int32Array.from([1, 7, 99, 10, 0]));   // PUSH 7; <unrecognized op 99>; PRINTINT; HALT
  let threw = false;
  try { interp.run(0); } catch { threw = true; }
  check('unrecognized opcode halts silently (does not throw)', !threw);
}

console.log(`\n${pass}/${pass + fail} ir_interpreter checks passed.`);
process.exit(fail === 0 ? 0 : 1);
