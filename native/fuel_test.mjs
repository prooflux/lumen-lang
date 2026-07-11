// fuel_test.mjs - gate for the opt-in native fuel counter (SaaS Stone C: metering/billing/
// hard-isolation primitive). FUEL_MODE is off by default (see emit_fn.lm); this file exercises
// the ON path via fuel_build.mjs's buildAndRunFnFueled, which is the only caller that sets it.
//
// (a) a runaway program built fueled with a small budget traps: exit 71, "lumen: out of fuel"
//     on stderr. Backstopped by a wall-clock timeout so a regression that reintroduces the
//     infinite loop fails the gate instead of hanging CI.
// (b) a normal terminating program built fueled with an ample budget produces stdout
//     byte-identical to the same program built with fuel OFF (buildAndRunFn).
// (c) a program that consumes a known number of iterations: probe the exact budget boundary
//     (just below traps, just above completes) and report the observed fuel-per-iteration cost.
// (d) throughput cost of fuel mode on a loop-heavy benchmark (fueled vs unfueled), informational.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildAndRunFn } from './pipeline.mjs';
import { buildAndRunFnFueled } from './fuel_build.mjs';

let fail = 0;
const WALL_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms wall-clock backstop`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ============================== (a) runaway program traps ==============================
console.log('== (a) runaway program, small fuel budget: must trap (exit 71), not hang or segfault ==');

const runawayLoop = `
fn main(console: Console) -> Unit {
  var i = 0
  while i < 2000000000 {
    i = i + 1
  }
  console.print_int(i)
}
`;
{
  const r = await withTimeout(buildAndRunFnFueled(runawayLoop, 5000, '-O2'), WALL_TIMEOUT_MS, 'runaway while-loop');
  const ok = r.exit === 71 && r.stderr === 'lumen: out of fuel\n';
  console.log(`${ok ? 'PASS' : 'FAIL'}  runaway while-loop: exit=${r.exit} stderr=${JSON.stringify(r.stderr)}`);
  if (!ok) fail++;
}

function fibSrc(n) {
  return `
fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }
fn main(console: Console) -> Unit { console.print_int(fib(${n})) }
`;
}
{
  // deep recursion that never terminates within the budget (fib(40) is ~331M calls; a tiny
  // budget traps long before the first return).
  const r = await withTimeout(buildAndRunFnFueled(fibSrc(40), 5000, '-O2'), WALL_TIMEOUT_MS, 'runaway recursion (fib 40, tiny budget)');
  const ok = r.exit === 71 && r.stderr === 'lumen: out of fuel\n';
  console.log(`${ok ? 'PASS' : 'FAIL'}  runaway recursion (fib 40, tiny budget): exit=${r.exit} stderr=${JSON.stringify(r.stderr)}`);
  if (!ok) fail++;
}

// ============================== (b) fuel-on vs fuel-off: byte-identical output ==============
console.log('\n== (b) fuel must not change results: ample budget vs fuel OFF, byte-identical stdout ==');

const NORMAL_PROGRAMS = [
  { name: 'loop_sum', src: `
fn main(console: Console) -> Unit {
  var i = 0
  var sum = 0
  while i < 10000 {
    sum = sum + i
    i = i + 1
  }
  console.print_int(sum)
}
` },
  { name: 'fib_30', src: fibSrc(30) },
];

for (const { name, src } of NORMAL_PROGRAMS) {
  const off = await buildAndRunFn(src, '-O2');
  // FUEL_BUDGET is a 32-bit word (per the fuel-flag design); keep budgets comfortably under
  // INT32_MAX (~2.1e9) so the ample-budget runs below stay ample without overflowing the flag.
  const on = await buildAndRunFnFueled(src, 1500000000, '-O2');
  const ok = on.exit === 0 && on.stdout === off.stdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: fueled=${JSON.stringify(on.stdout)} unfueled=${JSON.stringify(off.stdout)} (fueled exit=${on.exit})`);
  if (!ok) fail++;
}

// ============================== (c) fuel-per-iteration boundary ==============================
console.log('\n== (c) known block-count program: budget just above/below the boundary ==');

const N_ITERS = 1000;
const boundarySrc = `
fn main(console: Console) -> Unit {
  var i = 0
  while i < ${N_ITERS} {
    i = i + 1
  }
  console.print_int(i)
}
`;

async function completesAt(budget) {
  const r = await buildAndRunFnFueled(boundarySrc, budget, '-O2');
  return { completed: r.exit === 0 && r.stdout.trim() === String(N_ITERS), r };
}

// Binary search the smallest budget that completes the loop (bounded search space, no long loops).
// hi must itself be a completing budget for the invariant to hold; verify and grow if not.
let lo = 1, hi = 20 * N_ITERS;
while (!(await completesAt(hi)).completed) hi *= 2;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const { completed } = await completesAt(mid);
  if (completed) hi = mid; else lo = mid + 1;
}
const boundary = lo;
const below = await completesAt(boundary - 1);
const at = await completesAt(boundary);
const perIter = boundary / N_ITERS;
console.log(`observed boundary: ${boundary} fuel units for ${N_ITERS} iterations (~${perIter.toFixed(2)} fuel/iteration; every IR op line decrements once, not just the loop head)`);
const okBelow = !below.completed && below.r.exit === 71;
const okAt = at.completed;
console.log(`${okBelow ? 'PASS' : 'FAIL'}  budget=${boundary - 1} (just below): traps (exit=${below.r.exit})`);
console.log(`${okAt ? 'PASS' : 'FAIL'}  budget=${boundary} (at boundary): completes`);
if (!okBelow) fail++;
if (!okAt) fail++;

// ============================== (d) throughput cost of fuel mode (informational) ============
console.log('\n== (d) throughput cost of fuel mode: loop-heavy benchmark, fueled vs unfueled (informational) ==');

const CALLS35 = 29860703;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fuelbench-'));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeRun = (bin) => { const t = process.hrtime.bigint(); execFileSync(bin, { encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6; };
fs.writeFileSync(path.join(dir, 'noop.c'), 'int main(void){return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'noop'), path.join(dir, 'noop.c')]);
const spawn = median(Array.from({ length: 7 }, () => timeRun(path.join(dir, 'noop'))));

// fib(35), not fib(40): FUEL_BUDGET is a 32-bit word (see fuel-flag design), and fib(40)'s ~331M
// calls at ~9 fuel/op would need a budget past INT32_MAX. fib(35)'s ~29M calls comfortably fit.
const fibBenchSrc = fibSrc(35);
const AMPLE_BUDGET = 2000000000; // well above fib(35)'s call count * per-op fuel cost, under INT32_MAX

const unfueled = await buildAndRunFn(fibBenchSrc, '-O3');
if (unfueled.stdout.trim() !== '9227465') { console.log('FAIL  (d) unfueled fib(35) sanity check'); fail++; }
fs.writeFileSync(path.join(dir, 'unfueled.c'), unfueled.csrc);
execFileSync('clang', ['-O3', '-o', path.join(dir, 'unfueled'), path.join(dir, 'unfueled.c')]);
const unfueledMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'unfueled')))) - spawn);

const fueled = await buildAndRunFnFueled(fibBenchSrc, AMPLE_BUDGET, '-O3');
if (fueled.exit !== 0 || fueled.stdout.trim() !== '9227465') { console.log(`FAIL  (d) fueled fib(35) sanity check exit=${fueled.exit} stdout=${JSON.stringify(fueled.stdout)}`); fail++; }
fs.writeFileSync(path.join(dir, 'fueled.c'), fueled.csrc);
execFileSync('clang', ['-O3', '-o', path.join(dir, 'fueled'), path.join(dir, 'fueled.c')]);
const fueledMs = Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(path.join(dir, 'fueled')))) - spawn);

const unfueledRate = CALLS35 / (unfueledMs / 1000);
const fueledRate = CALLS35 / (fueledMs / 1000);
const M = (r) => (r / 1e6).toFixed(0) + 'M calls/sec';
console.log(`  fib(35) unfueled : ${M(unfueledRate)}  (${unfueledMs.toFixed(1)}ms)`);
console.log(`  fib(35) fueled   : ${M(fueledRate)}  (${fueledMs.toFixed(1)}ms)`);
console.log(`  fuel-mode cost   : ${(fueledMs / unfueledMs).toFixed(2)}x slower, ${(fueledRate / unfueledRate * 100).toFixed(1)}% of unfueled throughput (informational, opt-in only)`);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'}: fuel_test ${fail === 0 ? 'all checks green' : fail + ' failing check(s)'}`);
process.exit(fail === 0 ? 0 : 1);
