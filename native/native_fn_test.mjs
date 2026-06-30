// native_fn_test.mjs - gate + speed for the v2 per-function emitter (emit_fn.lm), the "beat C" path.
// Diff: bit-identical to the interpreter oracle on the scalar corpus. Speed: fib(40) compute rate
// (process-spawn subtracted) for v1 (emit.lm), v2 (emit_fn.lm), and hand-written C, all clang -O3.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCompiler } from '../seed/compiler_core.mjs';
import { compileToIR, buildAndRunFn, buildAndRun } from './pipeline.mjs';

const SCALAR = ['fib_print', 'add', 'max', 'fact', 'locals', 'forward', 'mutual', 'compare', 'gcd', 'count', 'sum_loop'];
const lumen = await createCompiler();
let pass = 0, fail = 0;
console.log('== diff: v2 per-function emitter vs interpreter oracle ==');
for (const name of SCALAR) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  let cand;
  try { cand = await buildAndRunFn(src); }
  catch (e) { console.log(`FAIL  ${name}: ${e.message.slice(0, 110)}`); fail++; continue; }
  const ok = cand.stdout === ref.stdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} native=${JSON.stringify(cand.stdout)} ref=${JSON.stringify(ref.stdout)}`);
  if (ok) pass++; else fail++;
}
console.log(`${pass}/${SCALAR.length} v2 programs bit-identical (fail ${fail})\n`);

// speed: fib(40), compute rate, spawn-subtracted
const fib = (n) => `fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nfn main(c: Console) -> Unit { c.print_int(fib(${n})) }\n`;
const CALLS40 = 331160281;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fnb-'));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeRun = (bin) => { const t = process.hrtime.bigint(); execFileSync(bin, { encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6; };
fs.writeFileSync(path.join(dir, 'noop.c'), 'int main(void){return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'noop'), path.join(dir, 'noop.c')]);
const spawn = median(Array.from({ length: 7 }, () => timeRun(path.join(dir, 'noop'))));

async function rate(emit, label) {
  const r = await emit(fib(40), '-O3');
  if (r.stdout.trim() !== '102334155') return { label, bad: r.stdout.trim() };
  // emit already built+ran once; rebuild to a stable path for timing
  fs.writeFileSync(path.join(dir, label + '.c'), r.csrc);
  execFileSync('clang', ['-O3', '-o', path.join(dir, label), path.join(dir, label + '.c')]);
  const ms = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, label)))) - spawn);
  return { label, rate: CALLS40 / (ms / 1000) };
}
const handC = '#include <stdio.h>\nlong fib(long n){if(n<2)return n;return fib(n-1)+fib(n-2);}\nint main(){printf("%ld\\n",fib(40));return 0;}\n';
fs.writeFileSync(path.join(dir, 'h.c'), handC);
execFileSync('clang', ['-O3', '-o', path.join(dir, 'h'), path.join(dir, 'h.c')]);
const handMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'h')))) - spawn);
const handRate = CALLS40 / (handMs / 1000);

const v1 = await rate(buildAndRun, 'v1');
const v2 = await rate(buildAndRunFn, 'v2');
const M = (r) => (r / 1e6).toFixed(0) + 'M calls/sec';
console.log('== speed: fib(40) compute rate (clang -O3, spawn-subtracted) ==');
console.log(`  interpreter            : 12M calls/sec (ref)`);
console.log(`  v1 threaded-VM (emit.lm)   : ${M(v1.rate)}   (${(v1.rate / handRate * 100).toFixed(0)}% of hand-C)`);
console.log(`  v2 per-function (emit_fn.lm): ${M(v2.rate)}   (${(v2.rate / handRate * 100).toFixed(0)}% of hand-C)`);
console.log(`  hand-written C             : ${M(handRate)}   (100%)`);
console.log(v2.rate >= handRate ? '\n>>> v2 MATCHES OR BEATS hand-C <<<' : `\n>>> v2 is ${(v2.rate / handRate * 100).toFixed(0)}% of hand-C <<<`);
process.exit(fail === 0 ? 0 : 1);
