# vs-lang Scoreboard

Generated 2026-07-23 by `bench/vs-lang/run.mjs`. Real, measured, reproducible numbers on this
machine, not a curated best case. Re-run the script to regenerate.

## Read this before the numbers below

Lumen's native path compiles to C and hands it to `clang -O3` (see `native/emit_fn.lm`).
That means it can MATCH hand-written C, and Rust (which also targets an LLVM-optimized
native backend), once both sides are "going through an LLVM-class optimizer" for a given
kernel - there is no architectural reason for it to consistently BEAT either, and this
scoreboard does not claim that it does. Against Python, expect and see a large, real gap:
compiled native code vs. a bytecode interpreter is not a close race by design, in either
language. Every number below is what this machine actually measured; a kernel where Lumen
loses to hand-written C or Rust is reported as a loss.

## Methodology

- Each kernel is written four times: `<name>.lm` (Lumen), `<name>.c` (hand-written C),
  `<name>.rs` (hand-written Rust), `<name>.py` (hand-written Python) - matched line-by-line
  where each language allows it, same algorithm, same fixed input, same output format.
- **G0 gate**: all four twins must produce byte-identical stdout before any timing is
  trusted. All four kernels passed on this run.
- Lumen path: `native/pipeline.mjs` (`compileToIR` -> `optimizeIR` -> `emitWith` using
  `native/emit_fn.lm`'s C emitter) -> `clang -O3` -> standalone native binary.
- C path: `clang -O3` directly on the hand-written `.c` twin.
- Rust path: `rustc -O` directly on the hand-written `.rs` twin (rustup-installed
  toolchain, NOT built from the source clone at `~/repos-languages/rust`, which has no
  build artifacts - see "Compiler provenance"). `-O` is rustc's standard optimized-build
  flag; it is not the literal same flag namespace as clang's `-O3` but is the correct
  "give me an optimized release build" flag for this compiler, same intent.
- Python path: `python3 <name>.py` directly - CPython, interpreted, no compile step. Timing
  necessarily includes interpreter startup on every run, same as any real invocation would.
- Lumen and C share the identical clang -O3 codegen backend; only the front end (Lumen's
  compiler vs. clang's own C front end) differs between those two specifically.
- Timing: 15 repeated wall-clock runs per binary (median reported), 1 warmup run
  discarded first. `hyperfine` is NOT installed on this machine (`which hyperfine` checked at
  run time); this is `bench/harness.mjs`'s `runTimedBinary` fallback, stated here rather than
  silently substituting a different measurement method.

## Compiler provenance

This machine has GCC and LLVM/Clang cloned from source at `/Users/freedom/repos-languages/gcc`
and `/Users/freedom/repos-languages/llvm`, and Rust cloned from source at
`/Users/freedom/repos-languages/rust`, specifically so comparisons could race real modern
compilers built from source, not stale system/package-manager toolchains. **Checked before
this run**: none of the three trees has a built compiler binary or install receipt (`find
*/build/ */obj*` under each returned nothing for the compilers themselves). Building any of
them from source is a multi-hour undertaking (LLVM alone is commonly 1-3+ hours even on a
fast machine with a full Release build; Rust's `x.py build` similarly); none was attempted in
this pass given the time budget. This run therefore uses, instead:
- **C/C++**: the system-installed **Apple clang version 21.0.0 (clang-2100.1.1.101)** (also used as Lumen's own native
  backend - see Methodology).
- **Rust**: **rustc 1.97.1 (8bab26f4f 2026-07-14)**, installed via `rustup` (the standard official
  release channel), not from the cloned source tree above.
- **Python**: the system **Python 3.14.4**.

`gcc`/`g++` on this machine are the SAME Apple clang binary under a different `argv[0]`
(verified via `--version`, not assumed) - never presented as a distinct data point from
`clang`/`clang++` anywhere in this file. Building real from-source GCC/LLVM/rustc and
re-running this scoreboard against them is the natural follow-up (tracked below).

## Kernels

| Kernel | Category | Source inspiration |
|--------|----------|---------------------|
| `fib` | recursive call | `llvm/examples/Fibonacci/fibonacci.cpp` (LLVM's own naive-recursive-fib example) and the classic GCC recursion torture-test shape |
| `matmul` | dense matrix multiply | the ijk dense-matmul kernel shape used throughout GCC's `gcc.dg/vect/vect-*.c` and LLVM's LoopVectorize auto-vectorization regression corpus |
| `sort` | sort | O(n^2) in-place array-permutation kernel, same shape as GCC's array-sorting torture cases (e.g. `gcc.c-torture/execute/920501-*`) |
| `hash` | hash / probe loop | open-addressing linear-probing hash table (stands in for the "string-processing loop" category - see `hash.lm`'s header comment for why: Lumen's currently-documented subset has no character indexing or mutable byte buffers, so a byte-stream scan/checksum loop cannot be written as a matched twin today) |

All four kernels are written from scratch for this scoreboard (not lifted verbatim from the
cited files), matched line-by-line between all four language twins, with a fixed deterministic
input (no RNG in Lumen's documented subset) so G0 is a meaningful, reproducible check.

## Results

Host: Apple M1 Max, 10 cores, darwin/arm64, 64.00 GB RAM.
node v25.2.1, Apple clang version 21.0.0 (clang-2100.1.1.101), rustc 1.97.1 (8bab26f4f 2026-07-14), Python 3.14.4, 15 runs/binary (median).

| Kernel | Lumen native | C (clang -O3) | Rust (rustc -O) | Python 3 | Lumen/C | Lumen/Rust | Lumen/Python | Checksum |
|--------|--------------|----------------|-------------------|----------|---------|------------|--------------|----------|
| fib | 8.039 ms | 9.194 ms | 9.693 ms | 185.951 ms | 0.87x | 0.83x | 0.04x | 2178309 |
| matmul | 2.307 ms | 2.093 ms | 2.289 ms | 20.375 ms | 1.10x | 1.01x | 0.11x | 2636866 |
| sort | 2.371 ms | 2.036 ms | 2.439 ms | 39.079 ms | 1.16x | 0.97x | 0.06x | 85322368278 |
| hash | 1.988 ms | 1.880 ms | 2.178 ms | 16.184 ms | 1.06x | 0.91x | 0.12x | 1946 |

A "Lumen/X" ratio > 1.0x means Lumen's native binary is SLOWER than X for that kernel on this
run; < 1.0x means Lumen is faster. Lumen and C share the identical clang -O3 backend, so a
Lumen/C ratio far from 1.0x reflects a difference in the C emitted by `native/emit_fn.lm`
(e.g. missed inlining, extra bounds-adjacent arithmetic, array-indexing overhead versus raw
pointer/index arithmetic in hand-written C), not a difference in the underlying machine-code
generator. The Lumen/Python ratio is expected to be far below 1.0x (Lumen faster) across the
board - that gap is the honest, structural one this scoreboard actually demonstrates.

## Known limits found while building this scoreboard

- **`matmul`'s N is capped at 38, not a rounder number, and this is deliberate, not a bug**:
  `N >= 39` (three `Array(N*N)` allocations, as `matmul.lm` is structured) produced silently
  empty stdout on both `seed/lumen.mjs run` and the full native pipeline, with no exception
  anywhere. Root-caused (not left as a mystery): `native/emit_fn.lm` defines a fixed
  `LM_CAP_BYTES 36288` byte cap on the array/record heap (`native/emit_fn.lm:838`), and
  `lm_anew()` (`native/emit_fn.lm:845`) intentionally does `fflush(stdout); exit(0);` if an
  allocation would exceed it - this exact silent-halt-on-overflow behavior is itself a gated
  golden test (`heap_boundary_over_silent_halt` in `native/native_float_test.mjs`, asserting
  empty stdout is the CORRECT output past the boundary). `matmul`'s 3 arrays of N*N doubles
  cost `3 * (4 + 8*N*N)` bytes: 34,668 B at N=38 (under the cap), 36,516 B at N=39 (over it) -
  the exact number matches the 36,288 B cap. So this is a documented, deliberate heap-capacity
  limit in the current native emitter, not a fixpoint or correctness bug; `matmul.lm` is sized
  to stay under it. Raising `LM_CAP_BYTES` is a real lever for a future PR (out of scope here:
  one-language-change-per-PR, and this is an emitter-capacity change, not a benchmark change).
- Separately, `seed/lumen.mjs`'s `run` command (`seed/lumen.mjs:132-138`) does not check the
  `crash` field `compiler_core.mjs`'s `run()` can return; if the interpreter ever throws
  mid-run, the CLI would still exit 0 having printed nothing rather than surfacing the crash.
  Not implicated in the heap-cap behavior above (that path is an intentional `exit(0)`, not a
  thrown exception - `r.crash` was `undefined` in every reproduction), but a real gap noticed
  in passing, left unfixed here for the same one-change-per-PR reason.

## Follow-up

- Build real GCC, LLVM/Clang, and rustc from the cloned source trees at
  `/Users/freedom/repos-languages/{gcc,llvm,rust}` (multi-hour each, background jobs) and
  re-run this scoreboard against those binaries instead of the system/rustup fallbacks used
  here.
- Root-cause the N=39 array-size boundary bug found above.
- Consider a `-O2` row alongside `-O3`/`-O` for Lumen/C/Rust, and a GCC row once a
  from-source GCC binary exists (currently every native row uses clang on both sides).
- A PyPy row would meaningfully change the Lumen-vs-Python story (JIT vs. AOT-native rather
  than bytecode-interpreter vs. AOT-native); not attempted here since PyPy is not installed
  on this machine and installing a second Python implementation was out of scope for this pass.
