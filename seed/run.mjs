// Lumen stage-0 runner: load a Lumen-mu IR program, execute it. Usage: node run.mjs
// (runs fib, asserts output "55\n"). The interpreter is program-agnostic; the program below is
// fib(10) hand-lowered (see fib.lmir).
//
// R5: runs via native/ir_interpreter.mjs (a faithful, zero-wasm port of the retired seed's own
// $run function) instead of assembling and instantiating seed.wat. This file never compiled
// anything (it interprets a hardcoded IR array directly), so there is no compiler to swap in -
// only the interpreter, which is exactly what changed.
import { createInterpreter, CODE_BASE } from '../native/ir_interpreter.mjs';

const MAIN_ENTRY = 28;     // word index of `main` in the program below

// fib(10) in Lumen-mu IR bytecode (see fib.lmir for the annotated listing).
const program = [
  2,0, 1,2, 5, 6,10, 2,0, 9,                      // fib: if n<2 return n
  2,0, 1,1, 4, 8,0,1, 2,0, 1,2, 4, 8,0,1, 3, 9,   // else fib(n-1)+fib(n-2)
  1,10, 8,0,1, 10, 0,                             // main: print fib(10); halt
];

const interp = createInterpreter();
interp.writeCode(Int32Array.from(program));
interp.run(MAIN_ENTRY);
const out = interp.getOut();

process.stdout.write(out);
const expected = '55\n';
if (out === expected) {
  console.error('PASS: fib(10) on the Lumen-mu interpreter => ' + JSON.stringify(out));
  process.exit(0);
} else {
  console.error('FAIL: expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(out));
  process.exit(1);
}
