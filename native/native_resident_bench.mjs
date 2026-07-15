// native_resident_bench.mjs - R3 honest speed measurement: native-resident compile latency vs
// the wat paths it is meant to replace/compete with, across the 32-program corpus plus
// seed/lumenc.lm itself (the big one). Reports median ms per program for FOUR paths so the
// comparison cannot be cherry-picked:
//
//   resident-native   compileToIRNativeResident - the long-lived --resident process (R3, this round)
//   fresh-native      compileToIRNative - one process spawn per compile (R2, the pre-existing native path)
//   warm-wasm         seed/compiler_core.mjs's createCompiler() - ONE wasm instance reused
//                      (what seed/lumend.mjs/lumen_mcp.mjs/lumen.mjs actually ran before this
//                      round; already fast, no process spawn, no wat re-instantiate per call)
//   cold-wasm         native/pipeline.mjs's compileToIR - a FRESH wasm instance every call
//                      (freshInstance()); this is the literal "everyday COMPILE ENGINE" the R3
//                      brief asks to stop being, and what compileToIRAuto falls back to
//
// Usage: node native_resident_bench.mjs [N]   (N = repeats per small program, default 20;
//   lumenc.lm always runs at max(3, floor(N/4)) repeats since cold-wasm on it is expensive)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from '../seed/corpus.mjs';
import { compileToIR } from './pipeline.mjs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { compileToIRNative, compileToIRNativeResident, stopResidentCompiler } from './native_compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '../seed');
function readSrc(rel) { return fs.readFileSync(path.join(SEED_DIR, rel), 'utf8'); }

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

async function timeRepeats(fn, n) {
  const times = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(times);
}

async function main() {
  const N = Number(process.argv[2]) || 20;
  const N_BIG = Math.max(3, Math.floor(N / 4));

  const lumen = await createCompiler();   // warm-wasm: one instance, reused for every case below

  // Warm the resident server and every cache/binary once before measuring, so N=1's result isn't
  // dominated by one-time setup cost for any path (the fair way to compare STEADY-STATE latency).
  await compileToIRNativeResident('fn main(c: Console) -> Unit { c.print_int(1) return () }');
  compileToIRNative('fn main(c: Console) -> Unit { c.print_int(1) return () }');
  await compileToIR('fn main(c: Console) -> Unit { c.print_int(1) return () }');
  lumen.compile('fn main(c: Console) -> Unit { c.print_int(1) return () }');

  const programs = [...CASES.map(([rel]) => rel), '../seed/lumenc.lm'];

  console.log(`== R3 honest speed comparison: median ms/compile, N=${N} (N=${N_BIG} for lumenc.lm) ==`);
  console.log('program'.padEnd(46), 'resident'.padStart(10), 'fresh-native'.padStart(13), 'warm-wasm'.padStart(11), 'cold-wasm'.padStart(11), '  resident-vs-cold-wasm  resident-vs-warm-wasm');

  const rows = [];
  for (const rel of programs) {
    const src = readSrc(rel);
    const name = path.basename(rel) === 'lumenc.lm' ? 'SELF(lumenc.lm)' : path.basename(rel);
    const n = rel === '../seed/lumenc.lm' ? N_BIG : N;

    const resident = await timeRepeats(() => compileToIRNativeResident(src), n);
    const freshNative = await timeRepeats(() => compileToIRNative(src), n);
    const warmWasm = await timeRepeats(() => { lumen.compile(src); }, n);
    const coldWasm = await timeRepeats(() => compileToIR(src), n);

    rows.push({ name, resident, freshNative, warmWasm, coldWasm });
    const vsCold = coldWasm / resident;
    const vsWarm = warmWasm / resident;
    console.log(
      name.padEnd(46),
      resident.toFixed(3).padStart(10),
      freshNative.toFixed(3).padStart(13),
      warmWasm.toFixed(3).padStart(11),
      coldWasm.toFixed(3).padStart(11),
      `  ${vsCold.toFixed(1)}x`.padStart(12),
      `  ${vsWarm.toFixed(1)}x`.padStart(12),
    );
  }

  const totals = rows.reduce((a, r) => ({
    resident: a.resident + r.resident, freshNative: a.freshNative + r.freshNative,
    warmWasm: a.warmWasm + r.warmWasm, coldWasm: a.coldWasm + r.coldWasm,
  }), { resident: 0, freshNative: 0, warmWasm: 0, coldWasm: 0 });
  console.log('\n== Totals (sum of medians across all programs) ==');
  console.log(`resident-native:  ${totals.resident.toFixed(2)}ms`);
  console.log(`fresh-native:     ${totals.freshNative.toFixed(2)}ms  (${(totals.freshNative / totals.resident).toFixed(1)}x resident)`);
  console.log(`warm-wasm:        ${totals.warmWasm.toFixed(2)}ms  (${(totals.warmWasm / totals.resident).toFixed(1)}x resident)`);
  console.log(`cold-wasm:        ${totals.coldWasm.toFixed(2)}ms  (${(totals.coldWasm / totals.resident).toFixed(1)}x resident)`);

  const smallest = rows[0], largest = rows.reduce((a, b) => (b.resident + b.coldWasm > a.resident + a.coldWasm ? b : a));
  console.log('\n== Honest read ==');
  console.log(`Smallest program (${smallest.name}): resident ${smallest.resident.toFixed(3)}ms vs cold-wasm ${smallest.coldWasm.toFixed(3)}ms vs warm-wasm ${smallest.warmWasm.toFixed(3)}ms.`);
  console.log(`Largest program (${largest.name}): resident ${largest.resident.toFixed(3)}ms vs cold-wasm ${largest.coldWasm.toFixed(3)}ms vs warm-wasm ${largest.warmWasm.toFixed(3)}ms.`);
  if (rows.some((r) => r.resident > r.warmWasm)) {
    console.log('NOTE: on at least one program, resident-native is SLOWER than the already-warm wasm path (in-process function call, zero IPC) - reported as measured, not smoothed over.');
  }

  stopResidentCompiler();
}

main().catch((err) => { console.error(err); stopResidentCompiler(); process.exit(1); });
