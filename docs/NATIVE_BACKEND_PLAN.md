# Phase 4: the native backend — Lumen-owned, foundation-first

Status: in progress. Flywheel step 2 in `VISION_2035.md` ("Native backend. Speed stops being
a disqualifier"), the in-code ops/sec win delivered honestly. This plan follows the
architecture ruling: **the IR→native translation is itself a Lumen program, run by Lumen;
clang is a scoped, deletion-clocked assistant; a Lumen optimizer carries the speed; the
self-host compiler is the foundation the native emitter plugs into.** The previous
Cranelift-first sequencing is superseded (no host rust; clang reaches the same LLVM-class
target on the machine that exists today). Build log: [`../native/HISTORY.md`](../native/HISTORY.md).

## Landed so far (2026-06-30, gated bit-identical to the interpreter)
- **Keystone — raw-memory opcodes `load32/store32/load8/store8` (53–56)** in the seed +
  bounds-checked source loader. Conformance 18/18, perf gate PASS. The single unblock for all
  three Lumen-owned tracks.
- **`emit.lm` v1 (the IR→C translator, in Lumen) + `pipeline.mjs` driver + `native_diff.mjs`
  harness + `native_bench.mjs`.** Goto-threaded VM, scalar core: **11/11 bit-identical**,
  ≈19× the interpreter, ≈22% of hand-C. First proof Lumen translates its own IR to native.
- **`emit_fn.lm` v2 — per-function emitter that MATCHES/BEATS C.** Lowers each Lumen function
  to a real C function with compile-time-constant stack slots, so clang -O3 register-allocates.
  **11/11 bit-identical**; `fib(40)` at **≈1186M calls/sec = ~110% of hand-written C**
  (≈99× the interpreter). The "beat C" goal, met for the scalar/control/calls core.
- **`optimize.lm` — the first Lumen-owned IR optimizer (point 2).** Jump-threading, in Lumen,
  via the keystone; length-preserving. Gate (`optimize_diff.mjs`):
  `interpret(optimize(IR))==interpret(IR)` on 11 programs + a synthetic chain (4→6), **12/12**.
- **Token-cap wall raised** 1600→1665 (region max) to fit v2 — a non-regressing point-3 step.
- **Fixed: `$local_find` returned the oldest matching local, not the nearest.** A name
  re-declared in a sibling `if`/`else if` branch (e.g. `let t` in both) resolved reads to the
  first declaration's slot instead of the current branch's — a real correctness bug, not just
  the `optimize.lm` workaround that exposed it. `optimize.lm` now uses the natural `else if`
  form (the workaround is gone).
- **Token-region RESIZE done (real fix, point 3).** TOKENS grown 1666->8000 slots (cap 1665->7999)
  by shifting `SYMBOLS..DIAG` +76000; `$hp` 100000->176000; `compiler_core` `DIAG_BASE` ->166000.
  Seed + native scalar gates green, zero regression. This unblocked v3 and is a down-payment on
  self-host's capacity walls.
- **`emit_fn.lm` v3 — float (29-48) + array (49-52), M2 codegen, gated bit-identical.** 11/11
  float/array/record programs `golden==interpreter==native` byte-for-byte, BOTH Black-Scholes variants
  included; records need zero new codegen. Floats match by the SHARED transcribed `f_exp/f_ln/f_pow`
  series (not libm), so the determinism risk is now a passing gate.
- **Honest speed (M2 not yet "beats C" for float):** native BS = **74% of identical-algorithm hand-C,
  21% of libm-C** (modern libm `exp/log` is ~3.5x faster than the 16-term series; the int64 value-stack
  forces GPR<->FPR churn on floats). Scalar/int still ~108% of C. Closing the float gap needs
  type-tracked `double` slots, blocked on untyped `AGET` -> front-end must carry per-slot types into the
  IR. Scoped as the next milestone, not faked.
- **Not done (honest):** full `lumenc.lm` self-host (multi-week); type-tracked float slots (above);
  ditching clang (M4).

## The goal, stated without hedging
Compile the existing Lumen IR to native machine code that **matches or beats the fastest
ahead-of-time languages** (C, Rust, the LLVM class) on the kernels Lumen exists for: pricing,
risk, numeric loops. The bootstrap interpreter exists only to bootstrap and to be the
reference oracle forever; the native backend is the speed engine.

## The non-negotiable: the interpreter is the reference oracle, forever
Correctness is defined by the interpreter (`lumenc.wat` `$run`), not the backend. Every native
build must produce **bit-identical output** to the interpreter on every conformance and basics
program — `docs/spec/DETERMINISM_CONTRACT.md` made operational. The backend is allowed to be
fast; it is never allowed to disagree.

## The architecture ruling (what "Lumen-owned" means)
1. **Translation in Lumen, run by Lumen.** The IR→native translator is `emit.lm`; the optimizer
   is `optimize.lm`. Both are `.lm` source compiled and executed by the seed (today) and by the
   self-hosted `lumenc.lm` (end state). The host (`*.mjs`) only moves words and invokes
   compile/run/clang — the disposable bootstrap driver, the "scaffolding, not the artifact"
   status already granted `lumen.mjs`.
2. **clang is a scoped assistant on a deletion clock.** `emit C → clang -O3 → binary` is allowed
   now as build-time scaffolding (clang's backend *is* LLVM -O3, so this reaches the release
   target on the host today). Explicit removal milestone (M4): `emit.lm` emits LLVM-IR, then
   ARM64 asm, directly — clang/LLVM leave the codegen path.
3. **A Lumen optimizer carries the speed story** (`optimize.lm`), so dropping clang is
   performance-credible, not a regression.
4. **Self-host is the foundation, plugged into by native emit.** Native codegen is another
   Lumen back-end module bolted onto the Lumen compiler pipeline. The keystone is literally the
   self-host keystone; the headline track is repairing `lumenc.lm`.

**Honest status:** `lumenc.lm` does NOT self-host today (diagnosed: SRC overflow [now guarded],
token/symbol/CODE capacity walls, and it needed exactly the `load32/store32/load8/store8`
builtins the keystone now provides; it had also collided opcodes 25–28 with
`MKSUM/SUMTAG/SUMVAL/TEXTEQ`). We state this; we do not pretend the foundation is finished.

## Why the IR makes this tractable
The compiler already lowers all of Lumen-mu to a flat opcode stream the interpreter walks
(opcodes 0..52, + raw-mem 53..56). The backend is a second consumer of that same IR; the
optimizer is an IR→IR pass. Values are 64-bit slots (i64, or f64 bits); records/arrays/sum
cells are heap cells. One IR, three+ executors.

## The purity ladder (each rung removes exactly one borrowed dependency)
Two standing gates apply at every rung: **diff-identity** (byte-for-byte vs the interpreter,
Rule 5) and **Law P** (≥ as fast and accurate as what it replaces, Rule 6). The interpreter is
never on the removal list — it is the oracle.

| Rung | Artifact | Removes | Translation lives in |
|---|---|---|---|
| R0 | WAT seed + JS shim, interpreter only | — | WAT |
| R0.5 keystone (DONE) | opcodes 53–56 + bounds-checked loader + M0 harness | the enabler for every later removal | seed change |
| R1 front-end self-host | `lumenc.lm` compiles clean + emits IR bit-identical on the covered subset | moves front-end WAT→Lumen | lex/parse/emit-IR in Lumen |
| R2 emit C + clang (DONE, scalar) | `emit.lm` reads IR via `load32`, prints C; `clang -O3` builds | interpreter from the hot path (stays oracle); introduces clang | opcode→C in Lumen |
| R3a emit LLVM-IR | `emit_llvm.lm`; `llc`/`opt` lower | clang the C front-end | opcode→LLVM-IR in Lumen |
| R3b emit ARM64 asm | `emit_arm64.lm`; only `as`+`ld` remain | LLVM entirely | opcode→asm in Lumen |
| R4 Lumen optimizer + regalloc | `optimize.lm` passes + a register allocator | LLVM's optimizer as the source of speed | IR→IR + asm-level opt in Lumen |
| R5 native self-host fixpoint | self-hosted `lumenc.lm`, compiled native, compiles itself | `lumenc.wat`, the JS shims, `wabt`, `node` — the whole borrowed *language* layer | only the OS floor (`as`/`ld`, loader) remains |

Asymptote (stated, not over-claimed): Lumen emits a linked Mach-O directly — its own
assembler+linker — removing even `as`/`ld`. The kernel/loader is the floor nobody removes.

## Milestones (sequenced, each gated by the diff harness)
- **M0. Differential harness — DONE.** `native_diff.mjs`: interpreter vs any native executable,
  identical stdout + exit. No backend code merges without it. Backend-agnostic.
- **M1. Scalar core (emit C + clang) — DONE.** `emit.lm` for opcodes 0–24: per-program i64
  value-stack mirroring `$run`, one label per IR word, computed-`goto` for `CALL`/`RET`, exact
  `print_i64`, div/mod trap guards, no `"`/char-escapes in emitted C. Memory protocol: two seed
  instances; the host copies the IR snapshot into page-9 scratch `[524288,589824)` (untouched
  by `$run`). Diff-green 11/11 scalar; ≈19× the interpreter.
- **M1.5. Optimizer Pass A — next.** `optimize.lm` jump-threading (length-preserving), proving
  the Lumen-owned `optimize → interpret → diff` loop.
- **M2. Heap + runtime — float (29–48) + arrays (49–52) DONE in `emit_fn.lm` v3** (diff-green 11/11,
  floats bit-identical via the transcribed non-libm series; records free). **Pending:** text/heap
  (15–18,28), sum (25–27), and type-tracked `double` slots so float pricing beats C (currently 74% of
  identical-algorithm C — see Landed-so-far).
- **M3. Ahead-of-time single binary.** Standalone exe, no node/interpreter; no networked package
  manager, no network at build (Rule 7). clang still the assistant.
- **M4. Ditch the assistant.** `emit.lm` emits LLVM-IR then ARM64 asm directly; clang/LLVM out
  of codegen. Diff-green; perf within release target.
- **M5. Determinism hardening.** Reproducible floats by default; optional step counter for
  fuel-cap parity with the interpreter's silent halt.

## The Lumen optimizer (the speed engine that makes ditching clang viable)
`optimize.lm`: `optimize(code) -> code` over the IR; correctness = interpreting `code_out` ==
interpreting `code_in`, byte-identical, on the whole corpus. Hazard: `JZ/JMP/CALL` targets are
absolute word indices, so length-changing passes must rebuild targets via an `old→new` map.
Universal fail-safe: any opcode the scanner cannot size → return the input unchanged.

| Pass | Class | Win | When |
|---|---|---|---|
| A — jump threading | length-preserving | throughput | first (writable via array opcodes today; ports to `load32`) |
| B — int const-fold + relocation | compacting | IR size + throughput | next |
| C — DCE after RET/HALT/JMP | compacting | IR size | rides on B |
| regalloc, scheduling, inlining/LICM | asm-level | the big constant factor | at R3b/R4 (mandatory once LLVM stops doing regalloc) |

Excluded from v1 (documented): `DIV`/`MOD` folding (trap), float folding (bit-exactness), local
elimination (needs slot liveness). Gate: diff-identity is the veto; the size/throughput delta is
the justification; both required to enable a pass.

## Honest performance targets
- **Interim (emit C + clang -O3):** native ≥ the interpreter on every scalar benchmark (the
  flip). Achieved: ≈19× on `fib`; ≈21% of hand-C (the gap is the optimizer + better-lowering
  work).
- **Release:** match C and Rust within a small constant on scalar and array kernels.
  Numpy/BLAS keeps the edge on large dense vector math until a vectorizing path is added; we
  state that boundary.
- **Gate (Law P, Rule 6):** a new backend release may not regress any benchmark.
  `native_bench.mjs` is the rate gate.

## Self-containment and zero-legacy, handled honestly (Rule 7)
clang/LLVM are build-time scaffolding, not the artifact — same resolution as the `lumen.mjs`
host shim. The plan does not pretend M1–M3 are clang-free; **M4 is the explicit removal
milestone**, funded by the Lumen optimizer so the removal is performance-credible. Shipped
programs stay self-contained: a single native binary, no networked package manager, no network
at build.

## Files
Seed: `seed/{lumenc.wat,lumenc.lm,compiler_core.mjs,test.mjs,perf.mjs}`,
`seed/native/test_load32.lm`. Native: `native/{emit.lm,pipeline.mjs,native_diff.mjs,
native_bench.mjs}` (+ `optimize.lm` next). `RULES.md` rules 5/6/7/8 are the gates.
