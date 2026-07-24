#!/usr/bin/env node
// bench/vs-lang/run.mjs - matched-kernel scoreboard: Lumen (native) vs. C, Rust, and Python, each
// compiled/run through its own real toolchain (Lumen: native/pipeline.mjs's compileToIR ->
// optimizeIR -> emitWith -> clang -O3; C: clang -O3 directly; Rust: rustc -O directly; Python:
// CPython interpreted, no compile step) and timed by repeated wall-clock execution
// (bench/harness.mjs's runTimedBinary; hyperfine is not installed on this machine, verified via
// `which hyperfine` before falling back - see SCOREBOARD.md "Methodology").
//
// Formerly bench/vs-c/ (C only); renamed when Python and Rust twins were added, since the
// directory no longer means "vs C specifically."
//
// HONEST FRAMING (read before drawing conclusions from the numbers below): Lumen's native path
// compiles to C and hands it to clang -O3. That means it can MATCH hand-written C, C++-shaped
// code, and Rust (which also targets an LLVM-optimized native backend) once both sides are
// "going through an LLVM-class optimizer" - it has no architectural reason to consistently BEAT
// them, and this scoreboard does not claim it does. Against Python, expect and report a large,
// real gap: compiled native code vs. a bytecode interpreter is a structurally different
// comparison, not a close race. Report the actual numbers, not an adjusted narrative - a kernel
// where Lumen loses to hand-written C or Rust is reported as a loss, because that is what makes
// every other number in this file trustworthy.
//
// G0 gate: every kernel's Lumen, C, Rust, and Python twin must print byte-identical stdout before
// any timing is trusted - a mismatch aborts with a clear error rather than reporting a bogus
// number for twins that compute different things.
//
// Compiler provenance (see SCOREBOARD.md for the full discussion): this machine has GCC and
// LLVM/Clang cloned FROM SOURCE at /Users/freedom/repos-languages/{gcc,llvm} specifically so
// comparisons can race real modern optimizing compilers, not a stale system toolchain. Neither
// tree has a built compiler binary or install receipt (`*/build/`, `*/obj*` checked, none found;
// a from-source GCC/LLVM build is a multi-hour undertaking not attempted in this pass - see
// SCOREBOARD.md "Follow-up"). This run therefore falls back to the newest system-installed
// clang (Apple clang 21.0.0 / LLVM 21, `clang --version` printed below at run time), used for
// BOTH the C twins and as the backend of Lumen's own native pipeline (so both those rows share
// the identical clang -O3 codegen backend; only the front end differs). `gcc`/`g++` on this
// machine are the SAME Apple clang binary under a different argv[0] (verified via `--version`,
// not assumed) - never presented as a distinct data point from clang/clang++ anywhere in this
// file or SCOREBOARD.md. Rust is a real, separately-installed toolchain (rustc via rustup, not
// the source clone at /Users/freedom/repos-languages/rust, which has no build artifacts and was
// not built from source given the multi-hour cost - same disclosure pattern as GCC/LLVM above).
// Python is the system CPython at `python3` (version printed below at run time).
//
// Run: node bench/vs-lang/run.mjs

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
const RUSTC_OPT = '-O';

// rustc/cargo were installed via rustup at ~/.cargo/bin, which is NOT on this process's default
// PATH (confirmed: `rustc` alone fails to resolve; `~/.cargo/bin/rustc --version` works). Resolve
// it explicitly rather than silently failing or requiring the caller to have sourced
// ~/.cargo/env first.
const RUSTC = path.join(os.homedir(), '.cargo', 'bin', 'rustc');
const PYTHON3 = 'python3';

function which(cmd) {
  try { execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
  catch { return false; }
}

function versionOf(bin, args = ['--version']) {
  return execFileSync(bin, args, { encoding: 'utf8' }).trim().split('\n')[0];
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

function buildRustBinary(rsPath, outDir) {
  const bin = path.join(outDir, 'rust_bin');
  execFileSync(RUSTC, [RUSTC_OPT, '-o', bin, rsPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

async function main() {
  console.log('vs-lang scoreboard: Lumen (native) vs. C, Rust, and Python\n');
  console.log('clang:  ' + versionOf('clang'));
  console.log('rustc:  ' + versionOf(RUSTC));
  console.log('python: ' + versionOf(PYTHON3));
  console.log('node:   ' + process.version);
  const sys = getSystemInfo();
  console.log(`host:   ${sys.cpuModel} (${sys.cpuCores} cores), ${sys.platform}/${sys.arch}, ${sys.totalMemGb} GB RAM`);
  console.log(`hyperfine available: ${which('hyperfine')}\n`);

  const rows = [];
  for (const name of KERNELS) {
    console.log(`--- ${name} ---`);
    const lmPath = path.join(KERNEL_DIR, `${name}.lm`);
    const cPath = path.join(KERNEL_DIR, `${name}.c`);
    const rsPath = path.join(KERNEL_DIR, `${name}.rs`);
    const pyPath = path.join(KERNEL_DIR, `${name}.py`);
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), `vs-lang-${name}-`));

    const lumenBin = await buildLumenBinary(lmPath, outDir);
    const cBin = buildCBinary(cPath, outDir);
    const rustBin = buildRustBinary(rsPath, outDir);
    // Python has no build step - the "binary" IS the interpreter, run against the script.

    // G0: byte-identical stdout across all four, or abort.
    const lumenOut = execFileSync(lumenBin, { encoding: 'utf8' });
    const cOut = execFileSync(cBin, { encoding: 'utf8' });
    const rustOut = execFileSync(rustBin, { encoding: 'utf8' });
    const pyOut = execFileSync(PYTHON3, [pyPath], { encoding: 'utf8' });
    const outputs = { lumen: lumenOut, c: cOut, rust: rustOut, python: pyOut };
    const distinct = new Set(Object.values(outputs));
    if (distinct.size !== 1) {
      console.error(`G0 FAILED for ${name}: ${JSON.stringify(outputs)}`);
      process.exit(1);
    }
    console.log(`G0 PASS: byte-identical stdout across lumen/c/rust/python: ${JSON.stringify(lumenOut.trim())}`);

    const lumenResult = runTimedBinary({ name: `${name} (lumen native)`, binaryPath: lumenBin, benchmarkRuns: BENCHMARK_RUNS });
    const cResult = runTimedBinary({ name: `${name} (c, clang ${CLANG_OPT})`, binaryPath: cBin, benchmarkRuns: BENCHMARK_RUNS });
    const rustResult = runTimedBinary({ name: `${name} (rust, rustc ${RUSTC_OPT})`, binaryPath: rustBin, benchmarkRuns: BENCHMARK_RUNS });
    // Python: timing execFileSync('python3', [pyPath]) necessarily includes CPython's own
    // interpreter startup on every run, same as it would for any real invocation - this is not
    // an artifact to correct for, it is the actual cost of running a Python program.
    const pyResult = runTimedBinary({ name: `${name} (python3)`, binaryPath: PYTHON3, args: [pyPath], benchmarkRuns: BENCHMARK_RUNS });

    const msOf = (r) => r.medianSec * 1000;
    console.log(`lumen median:  ${msOf(lumenResult).toFixed(3)} ms`);
    console.log(`c median:      ${msOf(cResult).toFixed(3)} ms`);
    console.log(`rust median:   ${msOf(rustResult).toFixed(3)} ms`);
    console.log(`python median: ${msOf(pyResult).toFixed(3)} ms`);
    console.log(`lumen/c: ${(msOf(lumenResult) / msOf(cResult)).toFixed(2)}x  lumen/rust: ${(msOf(lumenResult) / msOf(rustResult)).toFixed(2)}x  lumen/python: ${(msOf(lumenResult) / msOf(pyResult)).toFixed(2)}x\n`);

    rows.push({
      name,
      lumenMs: msOf(lumenResult), cMs: msOf(cResult), rustMs: msOf(rustResult), pyMs: msOf(pyResult),
      output: lumenOut.trim(),
    });
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  renderScoreboard(rows, sys);
  console.log(`Wrote ${SCOREBOARD_PATH}`);
}

function renderScoreboard(rows, sys) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [];
  lines.push('# vs-lang Scoreboard');
  lines.push('');
  lines.push(`Generated ${date} by \`bench/vs-lang/run.mjs\`. Real, measured, reproducible numbers on this`);
  lines.push('machine, not a curated best case. Re-run the script to regenerate.');
  lines.push('');
  lines.push('## Read this before the numbers below');
  lines.push('');
  lines.push('Lumen\'s native path compiles to C and hands it to `clang -O3` (see `native/emit_fn.lm`).');
  lines.push('That means it can MATCH hand-written C, and Rust (which also targets an LLVM-optimized');
  lines.push('native backend), once both sides are "going through an LLVM-class optimizer" for a given');
  lines.push('kernel - there is no architectural reason for it to consistently BEAT either, and this');
  lines.push('scoreboard does not claim that it does. Against Python, expect and see a large, real gap:');
  lines.push('compiled native code vs. a bytecode interpreter is not a close race by design, in either');
  lines.push('language. Every number below is what this machine actually measured; a kernel where Lumen');
  lines.push('loses to hand-written C or Rust is reported as a loss.');
  lines.push('');
  lines.push('## Methodology');
  lines.push('');
  lines.push('- Each kernel is written four times: `<name>.lm` (Lumen), `<name>.c` (hand-written C),');
  lines.push('  `<name>.rs` (hand-written Rust), `<name>.py` (hand-written Python) - matched line-by-line');
  lines.push('  where each language allows it, same algorithm, same fixed input, same output format.');
  lines.push('- **G0 gate**: all four twins must produce byte-identical stdout before any timing is');
  lines.push('  trusted. All four kernels passed on this run.');
  lines.push('- Lumen path: `native/pipeline.mjs` (`compileToIR` -> `optimizeIR` -> `emitWith` using');
  lines.push('  `native/emit_fn.lm`\'s C emitter) -> `clang -O3` -> standalone native binary.');
  lines.push('- C path: `clang -O3` directly on the hand-written `.c` twin.');
  lines.push('- Rust path: `rustc -O` directly on the hand-written `.rs` twin (rustup-installed');
  lines.push('  toolchain, NOT built from the source clone at `~/repos-languages/rust`, which has no');
  lines.push('  build artifacts - see "Compiler provenance"). `-O` is rustc\'s standard optimized-build');
  lines.push('  flag; it is not the literal same flag namespace as clang\'s `-O3` but is the correct');
  lines.push('  "give me an optimized release build" flag for this compiler, same intent.');
  lines.push('- Python path: `python3 <name>.py` directly - CPython, interpreted, no compile step. Timing');
  lines.push('  necessarily includes interpreter startup on every run, same as any real invocation would.');
  lines.push('- Lumen and C share the identical clang -O3 codegen backend; only the front end (Lumen\'s');
  lines.push('  compiler vs. clang\'s own C front end) differs between those two specifically.');
  lines.push(`- Timing: ${BENCHMARK_RUNS} repeated wall-clock runs per binary (median reported), 1 warmup run`);
  lines.push('  discarded first. `hyperfine` is NOT installed on this machine (`which hyperfine` checked at');
  lines.push('  run time); this is `bench/harness.mjs`\'s `runTimedBinary` fallback, stated here rather than');
  lines.push('  silently substituting a different measurement method.');
  lines.push('');
  lines.push('## Compiler provenance');
  lines.push('');
  lines.push('This machine has GCC and LLVM/Clang cloned from source at `/Users/freedom/repos-languages/gcc`');
  lines.push('and `/Users/freedom/repos-languages/llvm`, and Rust cloned from source at');
  lines.push('`/Users/freedom/repos-languages/rust`, specifically so comparisons could race real modern');
  lines.push('compilers built from source, not stale system/package-manager toolchains. **Checked before');
  lines.push('this run**: none of the three trees has a built compiler binary or install receipt (`find');
  lines.push('*/build/ */obj*` under each returned nothing for the compilers themselves). Building any of');
  lines.push('them from source is a multi-hour undertaking (LLVM alone is commonly 1-3+ hours even on a');
  lines.push('fast machine with a full Release build; Rust\'s `x.py build` similarly); none was attempted in');
  lines.push('this pass given the time budget. This run therefore uses, instead:');
  lines.push(`- **C/C++**: the system-installed **${versionOf('clang')}** (also used as Lumen\'s own native`);
  lines.push('  backend - see Methodology).');
  lines.push('- **Rust**: **' + versionOf(RUSTC) + '**, installed via `rustup` (the standard official');
  lines.push('  release channel), not from the cloned source tree above.');
  lines.push(`- **Python**: the system **${versionOf(PYTHON3)}**.`);
  lines.push('');
  lines.push('`gcc`/`g++` on this machine are the SAME Apple clang binary under a different `argv[0]`');
  lines.push('(verified via `--version`, not assumed) - never presented as a distinct data point from');
  lines.push('`clang`/`clang++` anywhere in this file. Building real from-source GCC/LLVM/rustc and');
  lines.push('re-running this scoreboard against them is the natural follow-up (tracked below).');
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
  lines.push('All four kernels are written from scratch for this scoreboard (not lifted verbatim from the');
  lines.push('cited files), matched line-by-line between all four language twins, with a fixed deterministic');
  lines.push('input (no RNG in Lumen\'s documented subset) so G0 is a meaningful, reproducible check.');
  lines.push('');
  lines.push('## Results');
  lines.push('');
  lines.push(`Host: ${sys.cpuModel}, ${sys.cpuCores} cores, ${sys.platform}/${sys.arch}, ${sys.totalMemGb} GB RAM.`);
  lines.push(`node ${process.version}, ${versionOf('clang')}, ${versionOf(RUSTC)}, ${versionOf(PYTHON3)}, ${BENCHMARK_RUNS} runs/binary (median).`);
  lines.push('');
  lines.push('| Kernel | Lumen native | C (clang -O3) | Rust (rustc -O) | Python 3 | Lumen/C | Lumen/Rust | Lumen/Python | Checksum |');
  lines.push('|--------|--------------|----------------|-------------------|----------|---------|------------|--------------|----------|');
  for (const r of rows) {
    const rC = r.lumenMs / r.cMs, rR = r.lumenMs / r.rustMs, rP = r.lumenMs / r.pyMs;
    lines.push(
      `| ${r.name} | ${r.lumenMs.toFixed(3)} ms | ${r.cMs.toFixed(3)} ms | ${r.rustMs.toFixed(3)} ms | ${r.pyMs.toFixed(3)} ms ` +
      `| ${rC.toFixed(2)}x | ${rR.toFixed(2)}x | ${rP.toFixed(2)}x | ${r.output} |`
    );
  }
  lines.push('');
  lines.push('A "Lumen/X" ratio > 1.0x means Lumen\'s native binary is SLOWER than X for that kernel on this');
  lines.push('run; < 1.0x means Lumen is faster. Lumen and C share the identical clang -O3 backend, so a');
  lines.push('Lumen/C ratio far from 1.0x reflects a difference in the C emitted by `native/emit_fn.lm`');
  lines.push('(e.g. missed inlining, extra bounds-adjacent arithmetic, array-indexing overhead versus raw');
  lines.push('pointer/index arithmetic in hand-written C), not a difference in the underlying machine-code');
  lines.push('generator. The Lumen/Python ratio is expected to be far below 1.0x (Lumen faster) across the');
  lines.push('board - that gap is the honest, structural one this scoreboard actually demonstrates.');
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
  lines.push('- Build real GCC, LLVM/Clang, and rustc from the cloned source trees at');
  lines.push('  `/Users/freedom/repos-languages/{gcc,llvm,rust}` (multi-hour each, background jobs) and');
  lines.push('  re-run this scoreboard against those binaries instead of the system/rustup fallbacks used');
  lines.push('  here.');
  lines.push('- Root-cause the N=39 array-size boundary bug found above.');
  lines.push('- Consider a `-O2` row alongside `-O3`/`-O` for Lumen/C/Rust, and a GCC row once a');
  lines.push('  from-source GCC binary exists (currently every native row uses clang on both sides).');
  lines.push('- A PyPy row would meaningfully change the Lumen-vs-Python story (JIT vs. AOT-native rather');
  lines.push('  than bytecode-interpreter vs. AOT-native); not attempted here since PyPy is not installed');
  lines.push('  on this machine and installing a second Python implementation was out of scope for this pass.');
  lines.push('');

  fs.writeFileSync(SCOREBOARD_PATH, lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
