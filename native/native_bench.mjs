// native_bench.mjs - the speed gate (RULES rule 6 / Law P) for the Lumen-owned native backend.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCompiler } from '../seed/compiler_core.mjs';
import { compileToIR, optimizeIR, emitC, buildAndRunFn } from './pipeline.mjs';
import { bsLumen } from './native_float_test.mjs';

const fibSrc = (n) => `fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\nfn main(c: Console) -> Unit { c.print_int(fib(${n})) }\n`;
const CALLS = { 30: 2692537, 40: 331160281 };   // calls to fib = 2*F(n+1)-1
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bench-'));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeRun = (bin) => { const t = process.hrtime.bigint(); execFileSync(bin, { encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6; };

// parse CLI args
const updateMode = process.argv.includes('--update');
let baselinePath = fileURLToPath(new URL('./native.baseline.json', import.meta.url));
const baselineIdx = process.argv.indexOf('--baseline');
if (baselineIdx !== -1 && baselineIdx + 1 < process.argv.length) {
  baselinePath = process.argv[baselineIdx + 1];
}

// Check baseline file existence/validity if not updating
let baseline = null;
if (!updateMode) {
  if (!fs.existsSync(baselinePath)) {
    console.log(`no baseline at ${baselinePath}; run with --update to create it`);
    process.exit(1);
  }
  try {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    console.log(`no baseline at ${baselinePath}; run with --update to create it`);
    process.exit(1);
  }
} else {
  if (fs.existsSync(baselinePath)) {
    try {
      baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    } catch (e) {}
  }
}

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

// 2) Lumen-native: fib(40) via emit.lm -> clang -O3; subtract spawn (fib_native_v1)
const ir = await compileToIR(fibSrc(40));
const { words, main } = await optimizeIR(ir.words, ir.main);
fs.writeFileSync(path.join(dir, 'p.c'), await emitC(words, main));
execFileSync('clang', ['-O3', '-o', path.join(dir, 'p'), path.join(dir, 'p.c')]);
const nativeMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'p')))) - spawnMs);
const nativeRate = Math.round(CALLS[40] / (nativeMs / 1000));

// 3) hand-written C: fib(40), same, for the "match C" reference
fs.writeFileSync(path.join(dir, 'h.c'), '#include <stdio.h>\nlong fib(long n){if(n<2)return n;return fib(n-1)+fib(n-2);}\nint main(){printf("%ld\\n",fib(40));return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'h'), path.join(dir, 'h.c')]);
const handMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'h')))) - spawnMs);
const handRate = CALLS[40] / (handMs / 1000);

// Print context lines
const M = (r) => (r / 1e6).toFixed(1) + 'M calls/sec';
console.log('Lumen-owned native backend - fib recursion rate (compute, spawn-subtracted):');
console.log(`  fib(30) result match (interp vs nothing-to-compare): ${ref.stdout.trim()}`);
console.log(`  process-spawn baseline (subtracted from native runs): ${spawnMs.toFixed(1)} ms`);
console.log(`  interpreter (node+wasm $run)       : ${M(interpRate)}`);
console.log(`  Lumen-native (emit.lm -> clang -O3): ${M(nativeRate)}   (${(nativeRate / interpRate).toFixed(0)}x faster than the interpreter)`);
console.log(`  hand-written C -O3                 : ${M(handRate)}   (Lumen-native is ${(nativeRate / handRate * 100).toFixed(0)}% of hand-C)\n`);

// 4) Gated benches measurements
// B1: fib_native_v1 re-times the emit.lm binary built above (dir/p) inside timeGated below.

// All gated benches build with the determinism default (-ffp-contract=off; #183 set it on the
// pipeline's own clang invocation), so the gate measures binaries the real pipeline would produce.
const GATE_FLAGS = ['-ffp-contract=off', '-fno-fast-math', '-O3'];

// B2: fib_native_fn
const fnCompilerOutput = await buildAndRunFn(fibSrc(40), '-O3');
fs.writeFileSync(path.join(dir, 'fib_fn.c'), fnCompilerOutput.csrc);
execFileSync('clang', [...GATE_FLAGS, '-o', path.join(dir, 'fib_fn'), path.join(dir, 'fib_fn.c')]);

// B3: bs_looped_fn
const bsLoopedOutput = await buildAndRunFn(bsLumen, '-O3');
fs.writeFileSync(path.join(dir, 'bs_looped.c'), bsLoopedOutput.csrc);
execFileSync('clang', [...GATE_FLAGS, '-o', path.join(dir, 'bs_looped'), path.join(dir, 'bs_looped.c')]);

// bs_batch_fn is NOT gated: the batch workload exceeds the language's heap bound, and BOTH sides
// halt silently at the same boundary (byte-exact parity, see BUG_ARRAY_OUTPUT.md; the earlier
// "native loses output" claim here was wrong - the oracle halts too). The batch harness only runs
// natively by patching the arena beyond what the oracle permits, so gating it would measure a
// non-conformant configuration. Re-add when the language's own heap can hold the workload.

// A timed binary must PROVE it ran before its wall time means anything: a binary that aborts or
// halts early posts a phenomenal rate (observed: an arena-cap regression measured 500000M/sec and
// the lower-bound-only gate said OK). One verification run per binary: exit 0 + non-empty stdout.
const verifyRuns = {};
for (const [key, bin] of [['fib_native_v1', 'p'], ['fib_native_fn', 'fib_fn'], ['bs_looped_fn', 'bs_looped']]) {
  let out = '';
  try { out = execFileSync(path.join(dir, bin), { encoding: 'utf8' }); }
  catch (e) { console.log(`${key}: benched binary CRASHED (exit ${e.status}); timing would be garbage  FAIL`); process.exit(1); }
  if (!out.trim()) { console.log(`${key}: benched binary produced NO output; timing would be garbage  FAIL`); process.exit(1); }
  verifyRuns[key] = out;
}

// Timing is separated from building so --update can re-time the SAME binaries several times and
// write per-bench medians (a single-run baseline bakes one run's noise into every later verdict).
const timeGated = () => {
  const v1Ms = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'p')))) - spawnMs);
  const fnMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'fib_fn')))) - spawnMs);
  const bsLoopedMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'bs_looped')))) - spawnMs);
  return {
    fib_native_v1: Math.round(CALLS[40] / (v1Ms / 1000)),
    fib_native_fn: Math.round(CALLS[40] / (fnMs / 1000)),
    bs_looped_fn: Math.round(2000000 / (bsLoopedMs / 1000)),
  };
};
const measured = timeGated();

if (updateMode) {
  // Median-of-3: two more timing passes over the same binaries, so the stored rate is a median,
  // not one run's luck.
  const runs = [measured, timeGated(), timeGated()];
  const medianOf = (key) => median(runs.map((r) => r[key]));
  const oldBenches = (baseline && baseline.benches) ? baseline.benches : {};
  const newBenches = {};

  for (const key of Object.keys(measured)) {
    const oldRate = oldBenches[key] ? oldBenches[key].rate : 0;
    const tol = oldBenches[key] ? oldBenches[key].tolerance : 0.15; // default/fallback tolerance
    const newRate = medianOf(key);
    console.log(`${key}: ${oldRate} -> ${newRate}  (median of 3 timing passes: ${runs.map((r) => r[key]).join(', ')})`);
    newBenches[key] = { rate: newRate, tolerance: tol };
  }
  
  const newBaseline = {
    updated: new Date().toISOString().slice(0, 10),
    machine: (baseline && baseline.machine) || "MacBook Pro M1 Max, macOS 25.5.0, clang -O3, node 25",
    benches: newBenches
  };
  
  fs.writeFileSync(baselinePath, JSON.stringify(newBaseline, null, 2) + '\n');
  console.log(`\nbaseline written to ${baselinePath}`);
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

// Default run: verify against baseline
let allPassed = true;
const formatRateValue = (key, r) => {
  const isFib = key.startsWith('fib');
  const unit = isFib ? 'calls/sec' : 'prices/sec';
  return (r / 1e6).toFixed(1) + 'M ' + unit;
};

for (const key of Object.keys(measured)) {
  const baseEntry = baseline.benches[key];
  if (!baseEntry) {
    console.log(`${key}: no baseline entry found!  FAIL`);
    allPassed = false;
    continue;
  }
  
  const mRate = measured[key];
  const bRate = baseEntry.rate;
  const tol = baseEntry.tolerance;
  const pct = bRate > 0 ? Math.round((mRate / bRate) * 100) : 100;
  const passed = mRate >= bRate * (1 - tol);
  if (!passed) allPassed = false;
  
  console.log(`${key}: ${formatRateValue(key, mRate)} (${pct}% of baseline, tolerance ${(tol * 100).toFixed(0)}%)  ${passed ? 'OK' : 'FAIL'}`);
}

fs.rmSync(dir, { recursive: true, force: true });
process.exit(allPassed ? 0 : 1);
