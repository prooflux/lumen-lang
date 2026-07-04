// rawmem_diff.mjs - differential gate for the 5 opcodes emit_fn.lm was missing: raw-memory
// load/store (53-56) and integer NE (20). Same shape as native_diff.mjs: the interpreter
// ($run in lumenc.wat, via compiler_core) is the reference oracle; the candidate is the C
// backend (emit_fn.lm) via buildAndRunFn. Isolated from native_diff.mjs's PROGRAMS list per
// the manager's brief, so a future corpus edit there can't silently drop this coverage.
//
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { buildAndRunFn } from './pipeline.mjs';

const PROGRAMS = ['rawmem'];

const lumen = await createCompiler();
let pass = 0, fail = 0;

for (const name of PROGRAMS) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`FAIL  ${name}: interpreter compile error`); fail++; continue; }
  let cand;
  try { cand = await buildAndRunFn(src); }
  catch (e) { console.log(`FAIL  ${name}: native build/run error: ${e.message.slice(0, 200)}`); fail++; continue; }
  const ok = cand.stdout === ref.stdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} native=${JSON.stringify(cand.stdout)}  ref=${JSON.stringify(ref.stdout)}`);
  if (ok) pass++; else fail++;
}

console.log(`\n${pass}/${PROGRAMS.length} raw-memory + NE programs translated by emit_fn.lm (Lumen) are bit-identical to the interpreter  (fail ${fail})`);
console.log(fail === 0 ? 'PASS' : 'FAIL');
process.exit(fail === 0 ? 0 : 1);
