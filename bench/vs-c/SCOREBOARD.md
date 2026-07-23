# vs-C Scoreboard

Generated 2026-07-23 by `bench/vs-c/run.mjs`. Real, measured, reproducible numbers on this machine -
not a curated best case. Re-run the script to regenerate.

## Methodology

- Each kernel is written twice: `<name>.lm` (Lumen) and `<name>.c` (hand-written C), matched
  line-by-line where the language allows it.
- **G0 gate**: both twins must produce byte-identical stdout before any timing is trusted.
  All four passed on this run.
- Lumen path: `native/pipeline.mjs` (`compileToIR` -> `optimizeIR` -> `emitWith` using
  `native/emit_fn.lm`'s C emitter) -> `clang -O3` -> standalone native binary.
- C path: `clang -O3` directly on the hand-written `.c` twin.
- Both sides therefore share the identical clang -O3 codegen backend; only the front end
  (Lumen's compiler vs. clang's own C front end) differs.
- Timing: 15 repeated wall-clock runs per binary (median reported), 1 warmup run
  discarded first. `hyperfine` is NOT installed on this machine (`which hyperfine` checked at
  run time); this is `bench/harness.mjs`'s `runTimedBinary` fallback, stated here rather than
  silently substituting a different measurement method.

## Compiler provenance

This machine has GCC and LLVM/Clang cloned from source at `/Users/freedom/repos-languages/gcc`
and `/Users/freedom/repos-languages/llvm` specifically so comparisons race real modern optimizing
compilers, not a stale system toolchain. **Checked before this run**: neither tree has a built
compiler binary or install receipt (`find */build/ */obj*` under both repos returned nothing
for GCC/LLVM themselves, only unrelated sibling repos' own build dirs). A full GCC or LLVM
build from source is a multi-hour undertaking (LLVM alone is commonly 1-3+ hours even on a
fast machine with a full Release build); that build was NOT attempted in this pass given the
time budget. Per the task brief, this run falls back cleanly to the newest system-installed
compiler instead: **Apple clang version 21.0.0 (clang-2100.1.1.101)**. This is stated explicitly rather than silently
presented as a from-source build. Building real GCC/Clang from the cloned trees and re-running
this scoreboard against them is the natural follow-up (tracked below).

## Kernels

| Kernel | Category | Source inspiration |
|--------|----------|---------------------|
| `fib` | recursive call | `llvm/examples/Fibonacci/fibonacci.cpp` (LLVM's own naive-recursive-fib example) and the classic GCC recursion torture-test shape |
| `matmul` | dense matrix multiply | the ijk dense-matmul kernel shape used throughout GCC's `gcc.dg/vect/vect-*.c` and LLVM's LoopVectorize auto-vectorization regression corpus |
| `sort` | sort | O(n^2) in-place array-permutation kernel, same shape as GCC's array-sorting torture cases (e.g. `gcc.c-torture/execute/920501-*`) |
| `hash` | hash / probe loop | open-addressing linear-probing hash table (stands in for the "string-processing loop" category - see `hash.lm`'s header comment for why: Lumen's currently-documented subset has no character indexing or mutable byte buffers, so a byte-stream scan/checksum loop cannot be written as a matched twin today) |

All four are written from scratch in this PR (not lifted verbatim from the cited files), matched
line-by-line between the `.lm` and `.c` twin, with a fixed deterministic input (no RNG in Lumen's
documented subset) so G0 is a meaningful, reproducible check.

## Results

Host: Apple M1 Max, 10 cores, darwin/arm64, 64.00 GB RAM.
node v25.2.1, Apple clang version 21.0.0 (clang-2100.1.1.101), 15 runs/binary (median).

| Kernel | Lumen native (median) | C (clang -O3, median) | Lumen/C ratio | Checksum (both twins) |
|--------|------------------------|-------------------------|----------------|--------------------------|
| fib | 8.506 ms | 8.918 ms | 0.95x | 2178309 |
| matmul | 1.812 ms | 1.814 ms | 1.00x | 2636866 |
| sort | 2.942 ms | 2.415 ms | 1.22x | 85322368278 |
| hash | 1.956 ms | 1.816 ms | 1.08x | 1946 |

A ratio > 1.0x means Lumen's native binary is slower than the C binary for that kernel on this
run; < 1.0x means Lumen is faster. Both binaries are produced by the same clang -O3 backend, so
a ratio far from 1.0x reflects a difference in the C emitted by `native/emit_fn.lm` (e.g. missed
inlining, extra bounds-adjacent arithmetic, or array-indexing overhead versus raw pointer/index
arithmetic in the hand-written C), not a difference in the underlying machine-code generator.

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

- Build real GCC and LLVM/Clang from the cloned source trees at `/Users/freedom/repos-languages/
  {gcc,llvm}` (multi-hour, background job) and re-run this scoreboard against those binaries
  instead of the system clang fallback used here.
- Root-cause the N=39 array-size boundary bug found above.
- Consider a `-O2` row alongside `-O3` for both toolchains, and a GCC row once a from-source
  GCC binary exists (currently every row uses clang on both sides).
