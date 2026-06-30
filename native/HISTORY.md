# Lumen native backend — build log

A running, dated log of the Lumen-owned native backend (Phase 4). Newest first.
The architecture ruling it follows: **the IR→native translation is a Lumen program, run by
Lumen — no 3rd language does the translating**; clang is a scoped assistant on a deletion
clock; a Lumen optimizer carries the speed; the self-hosted compiler is the foundation the
native emitter plugs into. Plan: [`../docs/NATIVE_BACKEND_PLAN.md`](../docs/NATIVE_BACKEND_PLAN.md).
Reference oracle forever: the `lumenc.wat` `$run` interpreter (every layer is gated
bit-identical to it).

---

## 2026-06-30-1936 — v3: float + array + record native codegen (usable for pricing; honest on speed)

### Landed
1. **Real token-region resize (point 3), not the 1665 stopgap.** Grew the TOKENS region 1666->8000
   slots by shifting the `SYMBOLS..DIAG` block +76000 (a single boundary-safe numeric rule on
   `i32.const N` for 50000<=N<=100000, replacing the spec's 11 hand-edits and provably never touching
   the 6-digit page-9 scratch at 524288). `$hp` 100000->176000 (top stays 524288); `compiler_core`
   `DIAG_BASE` 90000->166000; cap guard 1665->7999. Gate: seed 18/18 + 102/102 basics + 7/7 safety +
   perf PASS; native scalar 11/11 bit-identical, v2 still ~108% of hand-C. Zero regression.

2. **`emit_fn.lm` v3 — float opcodes 29-48 + array opcodes 49-52.** `oplen` FPUSH(2-word) entry; three
   tiny Lumen helpers (`farith`/`fcmp`/`fun1`) collapsing 18 of 24 arms; the 24 dispatch arms; and a
   one-`c.print` C runtime block (l2d/d2l/f2i_sat + the transcribed `f_exp`/`f_ln`/`f_pow` series +
   an untyped array heap with lm_anew/aget/aset/alen). A whole string literal is ONE seed token, so the
   runtime block is ~O(1) tokens. **Records need zero new codegen** — they lower to ANEW/ASET/AGET.
   Determinism flags added to the clang call (`-ffp-contract=off -fno-fast-math`, never `-Ofast`).

3. **Float gate (`native_float_test.mjs`).** 11/11 programs **golden == interpreter == native**,
   byte-for-byte, including BOTH Black-Scholes variants (scalar + record, price 10.4506). Floats match
   by the SHARED truncated series, not libm — the transcription is bit-exact (the determinism risk
   `float_semantics.md` flagged is now a passing gate, not a hope).

### Honest speed result (the headline did NOT land for float; it did for scalar)
Black-Scholes, 2M evals, clang -O3 + determinism flags:
- native (emit_fn.lm) **18.1M prices/sec** = **74% of identical-algorithm hand-C** (24.4M), **21% of
  hand-C-with-libm** (85.5M). The native BS output is bit-identical to the truncated-series C
  (`2165282847`) across all 2M accumulated prices — the lowering is correct, just not yet fast.
- **Two findings that correct the spec's optimism:** (a) modern libm `exp/log` is ~3.5x FASTER than the
  16-term scalar series, so "truncated series beats libm" is empirically false on this machine; (b) the
  per-function lowering that beats C for ints (`int64_t` IS the natural type, 108%) is only 74% for
  floats because every float value lives as `int64_t` bits in `s[256]` and crosses the ABI in integer
  registers, forcing GPR<->FPR shuffling that clang can't elide.

### Diagnosed next step (scoped, not faked)
"Float beats C" needs **type-tracked slots**: emit `double` locals/params for float-typed slots instead
of reinterpreting through `int64_t`. Blocker: `AGET` returns an untyped array cell (int-or-float bits),
so clean typing needs the front-end to carry per-slot types into the IR (the IR is currently untyped at
the opcode boundary). That is a real feature with its own gate, not this commit. Until then the honest
claim is: **Lumen native float/array/record pricing is correct, deterministic, and usable (bit-identical
to the oracle); it matches C's algorithm at 74% and is not yet faster than C on floats.**

---

## 2026-06-30-1857 — Root-caused and fixed the else-if shadowing bug

Root cause: `$local_find` in `lumenc.wat` scanned the locals table oldest-first and returned
the first name match. The table is flat and append-only for the whole function (no scope
push/pop), so a name re-declared in a sibling `if`/`else if` branch (`let t` in both) got a
second slot via `SETLOCAL`, but every later read resolved via `$local_find` back to the first
(stale, possibly never-written-this-call) slot instead of the current branch's own. Fixed by
scanning newest-first. Failing-test-first: `basics.mjs` gained
"else-if: sibling branches can reuse a let name without reading a stale slot"; confirmed red,
applied the fix, confirmed green. Full suite (102/102 + 18/18 + 7/7 + 13/13) and perf gate
hold (100-102% of baseline).

Dogfooded immediately: `optimize.lm`'s `is_jump` flag-function workaround (forced because this
bug made the natural `if op==6 {...} else if op==7 {...}` silently thread zero jumps) is
deleted; `optimize.lm` now uses the natural else-if form the language was always supposed to
support. Re-gated through the real pipeline (not a standalone script): `optimize_diff.mjs`
12/12, `native_diff.mjs` 11/11, `native_fn_test.mjs` 11/11 + still beats hand-C.

---

## 2026-06-30-1809 — The Lumen optimizer (point 2) + per-function emitter that BEATS C

### Landed
1. **`optimize.lm` — the first Lumen-owned IR optimizer pass (point 2).** Jump-to-jump
   threading, written in Lumen, reading/writing the IR via the load32/store32 keystone.
   Length-preserving, so bit-identity holds by construction. Gate (`optimize_diff.mjs`):
   `interpret(optimize(IR)) == interpret(IR)` byte-for-byte on 11 scalar programs + a
   synthetic jump-chain the pass collapses (4->6), **12/12**. `pipeline.mjs` gained
   `optimizeIR` and `runIR`. This is the speed engine that makes ditching clang (M4)
   performance-credible.

2. **`emit_fn.lm` — v2 per-function emitter that MATCHES/BEATS hand-written C.** v1's
   goto-threaded VM hit ~22% of hand-C because dynamic stack indexing defeats clang's
   register allocator. v2 lowers each Lumen function to a REAL C function whose value-stack
   slots use COMPILE-TIME-CONSTANT indices (scheduled at emit time by tracking stack depth),
   so clang -O3 register-allocates and inlines. Result on `fib(40)` (compute rate, clang -O3,
   spawn-subtracted): interpreter 12M -> v1 237M (22% of C) -> **v2 1186M calls/sec = ~110% of
   hand-written C (≈99x the interpreter).** **11/11 scalar programs bit-identical** to the
   interpreter oracle. The translation is still 100% Lumen; clang only assembles.

3. **Token-capacity wall raised (point 3 / self-host).** `emit_fn.lm` is a bigger Lumen
   program and hit the seed's 1600-token lexer cap. Raised it to the TOKENS region's true
   capacity (1665; index 1664 ends at 49980 < SYMBOLS@50000) — a safe, non-regressing
   wall-raise (seed suite 101/101+18/18+7/7+13/13, perf PASS). `emit_fn.lm` kept lean (1509
   tokens) by minimizing `c.print` call count (each call ~6 tokens regardless of string
   length) and supporting exactly the opcodes the scalar corpus uses (0..11,13,14,19,21,24).

### Bug found via the loop (Rule-5 hazard, worked around, fix pending)
`if a {} else if b {}` FOLLOWED BY more statements in the same block silently miscompiles in
the current seed (the trailing statements are mis-placed) — it made `optimize.lm`'s threading
silently never fire. Worked around with a single-`if` flag form (and `emit_fn.lm` avoids
else-if entirely via sequential `if .. return`). Captured for a seed fix.

### Honest status
"Beat C in speed" is met for the scalar/control/calls core (≈110% of hand-C, bit-identical).
Still pending (multi-week): the token-region RESIZE for the full opcode set + `lumenc.lm`
self-host (the 1665 cap is the region max; a real resize needs ~15 interlocking offsets);
float/heap emit in v2 (M2); ditching clang (M4). Reference oracle stays the interpreter.

---

## 2026-06-30-1709 — Keystone + the first Lumen-owned native wedge (scalar core)

**Question that drove it:** "Can Lumen translate itself into a native binary — run by Lumen,
no 3rd language?" Answer: yes, and this is the first working, gated proof.

### Landed
1. **Keystone — raw-memory opcodes `load32/store32/load8/store8` (seed opcodes 53–56).**
   - `seed/lumenc.wat`: 4 keyword `(data)` names at `52360..52396`, 4 `$c_primary` dispatch
     arms, 4 `$run` cases. `LOAD32` sign-extends (so `PUSH` immediates round-trip); `LOAD8`
     zero-extends; stores wrap to i32. Fresh codes 53–56 (NOT 25–28, which `lumenc.lm` had
     collided with `MKSUM/SUMTAG/SUMVAL/TEXTEQ`) → one canonical IR for interpreter, future
     self-host, emitter, optimizer.
   - `seed/compiler_core.mjs`: registered 53–56 for disassembly; added a hard
     `loadSource` bounds check (`SRC_CAPACITY = 10000`). That overflow — a 33.8 KB
     `lumenc.lm` overrunning the 10 KB SRC region into the keyword table at 52000 — is the
     diagnosed root cause of `lumenc.lm`'s ~800 `E0003` errors; it now fails loudly.
   - Rule 8 red→green test `seed/native/test_load32.lm` (+ conformance case in `test.mjs`).
   - **Gate:** conformance **18/18**, perf gate **PASS** (102% compile / 98% interpret), guard
     fires on oversize input. Commit `feat(lumen): raw-memory load/store opcodes 53-56`.

2. **`emit.lm` — the IR→C translator, written in Lumen.** Reads the compiled IR from page-9
   scratch via the `load32` keystone and prints C (computed-goto threaded translation, one C
   label per IR word, frame/call semantics mirroring `$run`, exact `print_i64`, div/mod trap
   guards). Opcodes 0–24 (scalar/control/calls). No double-quotes in the emitted C
   (angle-bracket includes + integer char codes), because Lumen string literals cannot hold
   `"`. The translation is 100% Lumen; clang only assembles.

3. **`pipeline.mjs` — the disposable driver.** Does NO translation: compiles the user `.lm`
   with the seed, snapshots the IR, injects it into a fresh emitter instance's page-9 scratch
   (`[524288..]`, untouched by `$run`), runs `emit.lm` to get C, calls `clang`, runs the
   binary. Same status as `lumen.mjs` — re-derived in Lumen at self-hosting.

4. **`native_diff.mjs` — the M0 differential harness (forever-gate).** Interpreter-as-oracle
   vs the native binary, byte-for-byte. Backend-agnostic (unchanged as codegen moves
   C→LLVM-IR→asm). Float/text/heap programs are excluded *by name*, not silently dropped.

5. **`native_bench.mjs` — the speed gate.** Honest calls/sec, process-spawn subtracted.

### Results (gated)
- **Diff harness: 11/11 scalar programs bit-identical** to the interpreter
  (`fib_print, add, max, fact, locals, forward, mutual, compare, gcd, count, sum_loop`).
- **Speed (`fib`, compute rate):** interpreter **12.3M calls/sec** → Lumen-native
  **231M calls/sec (≈19× the interpreter)**; hand-written C `-O3` is **1084M calls/sec**, so
  Lumen-native is **~21% of hand-C** (≈4.7× slower than C). The interpreter-slower-than-CPython
  story is flipped for the scalar core; closing the gap to C is the optimizer + better-lowering
  work below.

### Honest status / not done
- **Full self-host (`lumenc.lm`) is NOT done** — multi-week. Diagnosed roots: SRC overflow
  (now guarded), token/symbol/CODE capacity walls (need a coordinated memory-map resize), and
  it depended on exactly the `load32/store32` builtins the keystone now provides. The keystone
  is the unblock, not the repair.
- **`optimize.lm` (the Lumen optimizer, point 2) — next.** Pass A (jump-threading,
  length-preserving) is specified and low-risk; it proves "Lumen optimizer" and starts the
  speed story that makes ditching clang credible.
- **Ditch clang (M4)** and **float/heap emit (M2)** are later milestones; floats must
  transcribe the seed's exact non-libm `f_exp/f_ln/f_pow` series (libm diverges).

### Orchestration note
Built with multi-model orchestration: understand (4 agents) + diagnose/design (8 agents,
~1.1M tokens) produced the IR contract, corpus, gates, and the implementation spec
(`SPEC.md`, `PLAN_REVISION.md`); the cohesive emitter/harness was implemented against that
spec with the diff harness as the tight feedback loop.
