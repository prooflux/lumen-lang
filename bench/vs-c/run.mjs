#!/usr/bin/env node
// bench/vs-c/run.mjs - the vs-C scoreboard: matched .lm/.c kernel pairs, each compiled through
// its own real toolchain at -O3 (Lumen: native/pipeline.mjs's compileToIR -> optimizeIR ->
// emitWith -> clang -O3; C: clang -O3 directly) and timed by repeated wall-clock execution
// (bench/harness.mjs's runTimedBinary; hyperfine is not installed on this machine, verified via
// `which hyperfine` before falling back - see SCOREBOARD.md "Methodology").
//
// G0 gate: every kernel's Lumen and C twin must print byte-identical stdout before any timing
// is trusted - a mismatch aborts with a clear error rather than reporting a bogus number for a
// pair that computes different things.
//
// Compiler provenance (see SCOREBOARD.md for the full discussion): this machine has GCC and
// LLVM/Clang cloned FROM SOURCE at /Users/freedom/repos-languages/{gcc,llvm} specifically so
// comparisons can race real modern optimizing compilers, not a stale system toolchain. Neither
// tree has a built compiler binary or install receipt (`*/build/`, `*/obj*` checked, none found;
// a from-source GCC/LLVM build is a multi-hour undertaking not attempted in this pass - see
// SCOREBOARD.md "Follow-up"). This run therefore falls back to the newest system-installed
// clang (Apple clang 21.0.0 / LLVM 21, `clang --version` printed below at run time), used for
// BOTH the C twins and as the backend of Lumen's own native pipeline (so both sides of every
// row go through the identical clang -O3 codegen backend; only the front end differs).
//
// Run: node bench/vs-c/run.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileToIR, optimizeIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from '../../native/pipeline.mjs';
import { runTimedBinary, getSystemInfo } from '../harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KERNEL_DIR = __dirname;
const SCOREBOARD_PATH = path.join(KERNEL_DIR, 'SCOREBOARD.md');

const KERNELS = ['fib', 'matmul', 'sort', 'hash'];
const BENCHMARK_RUNS = 15;
const CLANG_OPT = '-O3';

function which(cmd) {
  try { execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
  catch { return false; }
}

function clangVersion() {
  return execFileSync('clang', ['--version'], { encoding: 'utf8' }).trim().split('\n')[0];
}

// --- Build the Lumen twin down to a standalone native binary (source -> IR -> optimize ->
// emit_fn.lm's C emitter -> clang -O3), mirroring bench/compile_latency_bench.mjs's
// lumenBuildOnly but keeping the resulting binary on disk (not deleted) so run.mjs can time
// its *execution*, not its build. ---
async function buildLumenBinary(lmPath, outDir) {
  const EMIT_FN_SRC = fs.readFileSync(path.join(REPO_ROOT, 'native', 'emit_fn.lm'), 'utf8');
  const src = fs.readFileSync(lmPath, 'utf8');
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) { pc = pc + 3 + words[pc + 1]; }
    else {
      if (op === 15) ptrs.push(words[pc + 1]);
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) oplen = 1;
      else if (op === 8 || op === 29 || op === 64) oplen = 2;
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(ir.strings.map(s => [s.ptr, s]));
  const strings = uniquePtrs.map(ptr => { const s = stringsMap.get(ptr); if (!s) throw new Error(`missing string ptr ${ptr}`); return s; });
  const csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  const cfile = path.join(outDir, 'lumen_emitted.c');
  const bin = path.join(outDir, 'lumen_bin');
  fs.writeFileSync(cfile, csrc);
  execFileSync('clang', [CLANG_OPT, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

function buildCBinary(cPath, outDir) {
  const bin = path.join(outDir, 'c_bin');
  execFileSync('clang', [CLANG_OPT, '-o', bin, cPath, '-lm'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

async function main() {
  console.log('vs-C scoreboard: matched Lumen-native vs. clang-C kernel benchmarks\n');
  console.log('clang: ' + clangVersion());
  console.log('node:  ' + process.version);
  const sys = getSystemInfo();
  console.log(`host:  ${sys.cpuModel} (${sys.cpuCores} cores), ${sys.platform}/${sys.arch}, ${sys.totalMemGb} GB RAM`);
  console.log(`hyperfine available: ${which('hyperfine')}\n`);

  const rows = [];
  for (const name of KERNELS) {
    console.log(`--- ${name} ---`);
    const lmPath = path.join(KERNEL_DIR, `${name}.lm`);
    const cPath = path.join(KERNEL_DIR, `${name}.c`);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-c-${name}-`));

    const lumenBin = await buildLumenBinary(lmPath, outDir);
    const cBin = buildCBinary(cPath, outDir);

    // G0: byte-identical stdout, or abort.
    const lumenOut = execFileSync(lumenBin, { encoding: 'utf8' });
    const cOut = execFileSync(cBin, { encoding: 'utf8' });
    if (lumenOut !== cOut) {
      console.error(`G0 FAILED for ${name}: lumen=${JSON.stringify(lumenOut)} c=${JSON.stringify(cOut)}`);
      process.exit(1);
    }
    console.log(`G0 PASS: byte-identical stdout ${JSON.stringify(lumenOut.trim())}`);

    const lumenResult = runTimedBinary({ name: `${name} (lumen native)`, binaryPath: lumenBin, benchmarkRuns: BENCHMARK_RUNS });
    const cResult = runTimedBinary({ name: `${name} (c, clang ${CLANG_OPT})`, binaryPath: cBin, benchmarkRuns: BENCHMARK_RUNS });

    const ratio = lumenResult.medianSec / cResult.medianSec;
    console.log(`lumen median: ${(lumenResult.medianSec * 1000).toFixed(3)} ms`);
    console.log(`c median:     ${(cResult.medianSec * 1000).toFixed(3)} ms`);
    console.log(`lumen/c ratio: ${ratio.toFixed(2)}x\n`);

    rows.push({ name, lumenMs: lumenResult.medianSec * 1000, cMs: cResult.medianSec * 1000, ratio, output: lumenOut.trim() });
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  renderScoreboard(rows, sys);
  console.log(`Wrote ${SCOREBOARD_PATH}`);
}

function renderScoreboard(rows, sys) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# vs-C Scoreboard');
  lines.push('');
  lines.push(`Generated ${date} by \`bench/vs-c/run.mjs\`. Real, measured, reproducible numbers on this machine -`);
  lines.push('not a curated best case. Re-run the script to regenerate.');
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  lines.push('- Each kernel is written twice: `<name>.lm` (Lumen) and `<name>.c` (hand-written C), matched');
  lines.push('  line-by-line where the language allows it.');
  lines.push('- **G0 gate**: both twins must produce byte-identical stdout before any timing is trusted.');
  lines.push('  All four passed on this run.');
  lines.push('- Lumen path: `native/pipeline.mjs` (`compileToIR` -> `optimizeIR` -> `emitWith` using');
  lines.push('  `native/emit_fn.lm`\'s C emitter) -> `clang -O3` -> standalone native binary.');
  lines.push('- C path: `clang -O3` directly on the hand-written `.c` twin.');
  lines.push('- Both sides therefore share the identical clang -O3 codegen backend; only the front end');
  lines.push('  (Lumen\'s compiler vs. clang\'s own C front end) differs.');
  lines.push(`- Timing: ${BENCHMARK_RUNS} repeated wall-clock runs per binary (median reported), 1 warmup run`);
  lines.push('  discarded first. `hyperfine` is NOT installed on this machine (`which hyperfine` checked at');
  lines.push('  run time); this is `bench/harness.mjs`\'s `runTimedBinary` fallback, stated here rather than');
  lines.push('  silently substituting a different measurement method.');
  lines.push('');
  lines.push('## Compiler provenance');
  lines.push('');
  lines.push('This machine has GCC and LLVM/Clang cloned from source at `/Users/freedom/repos-languages/gcc`');
  lines.push('and `/Users/freedom/repos-languages/llvm` specifically so comparisons race real modern optimizing');
  lines.push('compilers, not a stale system toolchain. **Checked before this run**: neither tree has a built');
  lines.push('compiler binary or install receipt (`find */build/ */obj*` under both repos returned nothing');
  lines.push('for GCC/LLVM themselves, only unrelated sibling repos\' own build dirs). A full GCC or LLVM');
  lines.push('build from source is a multi-hour undertaking (LLVM alone is commonly 1-3+ hours even on a');
  lines.push('fast machine with a full Release build); that build was NOT attempted in this pass given the');
  lines.push('time budget. Per the task brief, this run falls back cleanly to the newest system-installed');
  lines.push(`compiler instead: **${clangVersion()}**. This is stated explicitly rather than silently`);
  lines.push('presented as a from-source build. Building real GCC/Clang from the cloned trees and re-running');
  lines.push('this scoreboard against them is the natural follow-up (tracked below).');
  lines.push('');
  lines.push('## Kernels');
  lines.push('');
  lines.push('| Kernel | Category | Source inspiration |');
  lines.push('|--------|----------|---------------------|');
  lines.push('| `fib` | recursive call | `llvm/examples/Fibonacci/fibonacci.cpp` (LLVM\'s own naive-recursive-fib example) and the classic GCC recursion torture-test shape |');
  lines.push('| `matmul` | dense matrix multiply | the ijk dense-matmul kernel shape used throughout GCC\'s `gcc.dg/vect/vect-*.c` and LLVM\'s LoopVectorize auto-vectorization regression corpus |');
  lines.push('| `sort` | sort | O(n^2) in-place array-permutation kernel, same shape as GCC\'s array-sorting torture cases (e.g. `gcc.c-torture/execute/920501-*`) |');
  lines.push('| `hash` | hash / probe loop | open-addressing linear-probing hash table (stands in for the "string-processing loop" category - see `hash.lm`\'s header comment for why: Lumen\'s currently-documented subset has no character indexing or mutable byte buffers, so a byte-stream scan/checksum loop cannot be written as a matched twin today) |');
  lines.push('');
  lines.push('All four are written from scratch in this PR (not lifted verbatim from the cited files), matched');
  lines.push('line-by-line between the `.lm` and `.c` twin, with a fixed deterministic input (no RNG in Lumen\'s');
  lines.push('documented subset) so G0 is a meaningful, reproducible check.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push(`Host: ${sys.cpuModel}, ${sys.cpuCores} cores, ${sys.platform}/${sys.arch}, ${sys.totalMemGb} GB RAM.`);
  lines.push(`node ${process.version}, ${clangVersion()}, ${BENCHMARK_RUNS} runs/binary (median).`);
  lines.push('');
  lines.push('| Kernel | Lumen native (median) | C (clang -O3, median) | Lumen/C ratio | Checksum (both twins) |');
  lines.push('|--------|------------------------|-------------------------|----------------|--------------------------|');
  for (const r of rows) {
    lines.push(`| ${r.name} | ${r.lumenMs.toFixed(3)} ms | ${r.cMs.toFixed(3)} ms | ${r.ratio.toFixed(2)}x | ${r.output} |`);
  }
  lines.push('');
  lines.push('A ratio > 1.0x means Lumen\'s native binary is slower than the C binary for that kernel on this');
  lines.push('run; < 1.0x means Lumen is faster. Both binaries are produced by the same clang -O3 backend, so');
  lines.push('a ratio far from 1.0x reflects a difference in the C emitted by `native/emit_fn.lm` (e.g. missed');
  lines.push('inlining, extra bounds-adjacent arithmetic, or array-indexing overhead versus raw pointer/index');
  lines.push('arithmetic in the hand-written C), not a difference in the underlying machine-code generator.');
  lines.push('');
  lines.push('## Known limits found while building this scoreboard');
  lines.push('');
  lines.push('- **`matmul`\'s N is capped at 38, not a rounder number, and this is deliberate, not a bug**:');
  lines.push('  `N >= 39` (three `Array(N*N)` allocations, as `matmul.lm` is structured) produced silently');
  lines.push('  empty stdout on both `seed/lumen.mjs run` and the full native pipeline, with no exception');
  lines.push('  anywhere. Root-caused (not left as a mystery): `native/emit_fn.lm` defines a fixed');
  lines.push('  `LM_CAP_BYTES 36288` byte cap on the array/record heap (`native/emit_fn.lm:838`), and');
  lines.push('  `lm_anew()` (`native/emit_fn.lm:845`) intentionally does `fflush(stdout); exit(0);` if an');
  lines.push('  allocation would exceed it - this exact silent-halt-on-overflow behavior is itself a gated');
  lines.push('  golden test (`heap_boundary_over_silent_halt` in `native/native_float_test.mjs`, asserting');
  lines.push('  empty stdout is the CORRECT output past the boundary). `matmul`\'s 3 arrays of N*N doubles');
  lines.push('  cost `3 * (4 + 8*N*N)` bytes: 34,668 B at N=38 (under the cap), 36,516 B at N=39 (over it) -');
  lines.push('  the exact number matches the 36,288 B cap. So this is a documented, deliberate heap-capacity');
  lines.push('  limit in the current native emitter, not a fixpoint or correctness bug; `matmul.lm` is sized');
  lines.push('  to stay under it. Raising `LM_CAP_BYTES` is a real lever for a future PR (out of scope here:');
  lines.push('  one-language-change-per-PR, and this is an emitter-capacity change, not a benchmark change).');
  lines.push('- Separately, `seed/lumen.mjs`\'s `run` command (`seed/lumen.mjs:132-138`) does not check the');
  lines.push('  `crash` field `compiler_core.mjs`\'s `run()` can return; if the interpreter ever throws');
  lines.push('  mid-run, the CLI would still exit 0 having printed nothing rather than surfacing the crash.');
  lines.push('  Not implicated in the heap-cap behavior above (that path is an intentional `exit(0)`, not a');
  lines.push('  thrown exception - `r.crash` was `undefined` in every reproduction), but a real gap noticed');
  lines.push('  in passing, left unfixed here for the same one-change-per-PR reason.');
  lines.push('');
  lines.push('## Follow-up');
  lines.push('');
  lines.push('- Build real GCC and LLVM/Clang from the cloned source trees at `/Users/freedom/repos-languages/');
  lines.push('  {gcc,llvm}` (multi-hour, background job) and re-run this scoreboard against those binaries');
  lines.push('  instead of the system clang fallback used here.');
  lines.push('- Root-cause the N=39 array-size boundary bug found above.');
  lines.push('- Consider a `-O2` row alongside `-O3` for both toolchains, and a GCC row once a from-source');
  lines.push('  GCC binary exists (currently every row uses clang on both sides).');
  lines.push('');

  fs.writeFileSync(SCOREBOARD_PATH, lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
