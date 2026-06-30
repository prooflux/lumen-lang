// native_bench.mjs - the speed gate (RULES rule 6 / Law P) for the Lumen-owned native backend.
// Honest RATE comparison (calls/sec), not wall-time of a tiny workload:
//   - the interpreter runs fib(30) IN-PROCESS (no spawn), like perf.mjs;
//   - native + hand-C run fib(40) (compute-heavy) and SUBTRACT a measured process-spawn baseline,
//     so the rate reflects computation, not exec() overhead.
// Translation (emit.lm) + clang are build-time; the rate is what the ops/sec claim is about.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCompiler } from '../seed/compiler_core.mjs';
import { compileToIR, emitC } from './pipeline.mjs';

const fibSrc = (n) => `fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nfn main(c: Console) -> Unit { c.print_int(fib(${n})) }\n`;
const CALLS = { 30: 2692537, 40: 331160281 };   // calls to fib = 2*F(n+1)-1
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bench-'));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeRun = (bin) => { const t = process.hrtime.bigint(); execFileSync(bin, { encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6; };

// 0) process-spawn baseline (trivial binary), so we can subtract exec() overhead from native timings
fs.writeFileSync(path.join(dir, 'noop.c'), 'int main(void){return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'noop'), path.join(dir, 'noop.c')]);
const spawnMs = median(Array.from({ length: 7 }, () => timeRun(path.join(dir, 'noop'))));

// 1) interpreter: fib(30) in-process (the seed $run), no spawn
const lumen = await createCompiler();
if (lumen.exports.set_fuel_max) lumen.exports.set_fuel_max(4000000000n);
const ti = process.hrtime.bigint();
const ref = lumen.run(fibSrc(30));
const interpMs = Number(process.hrtime.bigint() - ti) / 1e6;
const interpRate = CALLS[30] / (interpMs / 1000);

// 2) Lumen-native: fib(40) via emit.lm -> clang -O3; subtract spawn
const { words, main } = await compileToIR(fibSrc(40));
fs.writeFileSync(path.join(dir, 'p.c'), await emitC(words, main));
execFileSync('clang', ['-O3', '-o', path.join(dir, 'p'), path.join(dir, 'p.c')]);
const nativeMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'p')))) - spawnMs);
const nativeRate = CALLS[40] / (nativeMs / 1000);

// 3) hand-written C: fib(40), same, for the "match C" reference
fs.writeFileSync(path.join(dir, 'h.c'), '#include <stdio.h>\nlong fib(long n){if(n<2)return n;return fib(n-1)+fib(n-2);}\nint main(){printf("%ld\\n",fib(40));return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'h'), path.join(dir, 'h.c')]);
const handMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'h')))) - spawnMs);
const handRate = CALLS[40] / (handMs / 1000);

const M = (r) => (r / 1e6).toFixed(1) + 'M calls/sec';
console.log('Lumen-owned native backend - fib recursion rate (compute, spawn-subtracted):');
console.log(`  fib(30) result match (interp vs nothing-to-compare): ${ref.stdout.trim()}`);
console.log(`  process-spawn baseline (subtracted from native runs): ${spawnMs.toFixed(1)} ms`);
console.log(`  interpreter (node+wasm $run)       : ${M(interpRate)}`);
console.log(`  Lumen-native (emit.lm -> clang -O3): ${M(nativeRate)}   (${(nativeRate / interpRate).toFixed(0)}x faster than the interpreter)`);
console.log(`  hand-written C -O3                 : ${M(handRate)}   (Lumen-native is ${(nativeRate / handRate * 100).toFixed(0)}% of hand-C)`);
