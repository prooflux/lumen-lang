// Lumen speed + scale gate. Measures the numbers that decide whether the language stays
// fast as it grows, and FAILS if any regresses past a tolerance versus perf.baseline.json.
// Run it every improvement cycle so "aiming for speed and scale" is enforced, not asserted.
//
//   node perf.mjs            measure and gate against the committed baseline
//   node perf.mjs --update   rewrite the baseline (do this on purpose, with a reason)
//
// Scale note: the compiler is a deterministic, stateless, self-contained pure function, so
// throughput scales linearly with cores (run N processes). This gate measures single-core
// throughput; multiply by cores for the parallel ceiling.
import fs from 'node:fs';
import { createCompiler } from './compiler_core.mjs';

const lumen = await createCompiler();

// a representative program that exercises calls, recursion, branches, and arithmetic
const PROG = 'fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nfn main(c: Console) -> Unit { c.print_int(fib(20)) }\n';
const FIB30 = 'fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nfn main(c: Console) -> Unit { c.print_int(fib(30)) }\n';
const FIB30_CALLS = 2692537;

function timed(fn) { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; }

// warm up (JIT) then measure
for (let i = 0; i < 200; i++) lumen.compile(PROG);
const N = 20000;
const compileMs = timed(() => { for (let i = 0; i < N; i++) lumen.compile(PROG); });
const compilesPerSec = Math.round(N / (compileMs / 1000));
const compileUs = +(compileMs / N * 1000).toFixed(1);

const runMs = timed(() => lumen.run(FIB30));
const callsPerSec = Math.round(FIB30_CALLS / (runMs / 1000));

const metrics = { compilesPerSec, compileUs, callsPerSec };
console.log('Lumen perf (single core):');
console.log(`  compile throughput : ${compilesPerSec.toLocaleString()} programs/sec  (${compileUs} us each)`);
console.log(`  interpret throughput: ${(callsPerSec / 1e6).toFixed(1)}M calls/sec  (fib(30) in ${runMs.toFixed(0)} ms)`);
console.log(`  scale ceiling      : ~${compilesPerSec.toLocaleString()} programs/sec/core  (stateless, multiply by cores)`);

const baseFile = new URL('./perf.baseline.json', import.meta.url);
if (process.argv.includes('--update') || !fs.existsSync(baseFile)) {
  fs.writeFileSync(baseFile, JSON.stringify(metrics, null, 2) + '\n');
  console.log('\nbaseline written.');
  process.exit(0);
}

const base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
const TOL = 0.80;   // a metric may drop to 80% of baseline before it fails (absorbs machine noise)
let ok = true;
console.log('\nvs baseline:');
for (const k of ['compilesPerSec', 'callsPerSec']) {
  const ratio = metrics[k] / base[k];
  const verdict = ratio >= TOL ? 'OK' : 'REGRESSED';
  if (ratio < TOL) ok = false;
  console.log(`  ${k}: ${(ratio * 100).toFixed(0)}% of baseline (${base[k].toLocaleString()})  ${verdict}`);
}
console.log(ok ? '\nperf gate: PASS' : '\nperf gate: FAIL (a speed regression beyond tolerance)');
process.exit(ok ? 0 : 1);
