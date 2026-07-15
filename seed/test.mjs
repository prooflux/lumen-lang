// Lumen-mu compiler conformance runner: compile each source -> IR -> run, check stdout.
// Usage: node test.mjs
//
// R5: compiles via the native one-shot compiler (native/native_compile.mjs) and runs the
// resulting IR through the in-process JS interpreter (native/ir_interpreter.mjs) - zero wasm.
// Each case gets its own fresh interpreter instance (matching the old fresh-wasm-instance-per-
// case behavior this file always had).
import fs from 'node:fs';
import { compileToIRNative } from '../native/native_compile.mjs';
import { createInterpreter } from '../native/ir_interpreter.mjs';
import { CASES as cases } from './corpus.mjs';

function runOne(relPath) {
  const source = fs.readFileSync(new URL(relPath, import.meta.url), 'utf8');
  const { words, main, strings } = compileToIRNative(source);
  const interp = createInterpreter();
  interp.writeCode(words);
  interp.seedStrings(strings);
  interp.set_fuel_max(4000000000n);
  interp.run(main);
  return { out: interp.getOut(), ir: words.length };
}

let pass = 0;
for (const [path, expected] of cases) {
  const { out, ir } = runOne(path);
  const ok = out === expected;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${path.replace('../mu/examples/', '')}  -> ${JSON.stringify(out)}  (expected ${JSON.stringify(expected)}, ir_words=${ir})`);
}
console.log(`\n${pass}/${cases.length} Lumen-mu programs compiled from source and ran correctly.`);
process.exit(pass === cases.length ? 0 : 1);
