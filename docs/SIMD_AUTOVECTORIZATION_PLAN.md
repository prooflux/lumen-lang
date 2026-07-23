# Lumen SIMD and Auto-Vectorization Plan

Status: draft v0.1, research-grounded. This document answers one question honestly: what would
it actually take for Lumen to match or beat GCC/LLVM's auto-vectorization and SIMD codegen,
targeting Apple Silicon (M-series, ARM64 NEON/SVE) as the primary platform. It follows this
project's standard: concrete exit criteria, no vibes, explicit about what is realistic in months
versus what is a multi-year bet.

Everything below is checked against the tree as it exists today (`native/emit_fn.lm`,
`native/emit_llvm.lm`), not against an idealized description of the pipeline.

---

## 1. The starting line: what Lumen already gets, and how

Lumen has two native lowering paths from IR, both gated bit-identical to the interpreter
(`native/native_diff.mjs`, `native/llvm_diff.mjs`):

- **C backend** (`native/emit_fn.lm`, 989 lines of Lumen): emits portable C99, handed to `clang
  -O3` (or the platform's system compiler) for final codegen.
- **LLVM backend** (`native/emit_llvm.lm`, 1286 lines of Lumen): emits LLVM IR text directly,
  handed to `llc`/`opt` for final codegen.

Neither backend runs its own vectorizer. Both hand a scalar-looking program (the C backend: a C
loop; the LLVM backend: an SSA loop in `.ll`) to a downstream compiler and rely entirely on
**that compiler's own auto-vectorizer** (LLVM's Loop Vectorizer / SLP Vectorizer, reached either
directly through the LLVM backend or transitively through clang on the C backend). This is stated
plainly so there is no ambiguity in what follows: as of this writing, "Lumen's vectorization" is
almost entirely "LLVM's vectorization, invoked once removed."

There is exactly one exception, and it is hand-written, not general: `emit_fn.lm` lines 616-710
contain a pattern-matched pass (`detect_map` / `is_vec_fn` / `emit_vec_map` / `emit_vec_body`)
that recognizes one fixed IR idiom,

```
while idx < lim { aset(out, idx, f(aget(in, idx))); idx = idx + 1 }
```

where `f` is a straight-line `Float -> Float` function built only from a whitelisted op set
(`load`, `store`, `const`, `add`, `sub`, `mul`, `div`, `sqrt`, `abs`, `exp`, `ln`), and emits a
hand-rolled 2-wide `float64x2_t` NEON loop (`vld1q_f64`/`vst1q_f64`/`vaddq_f64`/... ) guarded by
`#if defined(__ARM_NEON)`, plus a scalar tail for the remainder. This is a real, working,
CI-gated vectorization: it is genuinely faster than the naive scalar loop clang would otherwise
see, and it is architecture-aware (ARM64/NEON only; there is no x86 SSE/AVX equivalent and no
SVE/SVE2 path). But it is a single idiom match, not a vectorizer: change the loop shape (two
input arrays instead of one, a reduction instead of a map, an `if` inside `f`, integer instead of
float element type) and the pass silently falls back to `is_vec_fn` returning 0 and the compiler
gets a scalar loop with no vectorization attempt of Lumen's own.

The LLVM backend (`emit_llvm.lm`) has no equivalent at all: grepping it for `vec`, `neon`,
`simd`, `<N x`, or `vector` returns nothing. Every LLVM-path program is scalar IR text; whatever
vectorization it gets comes exclusively from LLVM's own passes once `opt`/`llc` run on it.

### 1.1 Measured evidence: what clang's own vectorizer does with a plain loop

To grounds this in fact rather than assumption, two versions of the textbook AXPY-style loop
(`out[i] = a[i]*2.0 + b[i]`, `double`, `int64_t` trip count) were compiled with
`clang -O3 -mcpu=apple-m1` on this machine, one with `restrict`-qualified pointers and one
without:

```c
void axpy(double* restrict out, const double* restrict a, const double* restrict b, int64_t n){
  for (int64_t i=0;i<n;i++) out[i] = a[i]*2.0 + b[i];
}
```

Result: **both versions vectorize.** The non-`restrict` version compiles to a multi-version loop:
LLVM emits a runtime aliasing check, a 4-way-unrolled `float64x2_t` (`.2d`) NEON main loop
(`fmov.2d`, `fmla.2d v5,v0,v1` / `v6` / `v7` / `v16`, four independent FMA chains for
instruction-level parallelism) guarded by a scalar fallback loop (`fmadd d1,d1,d0,d2`) that only
runs if the runtime check finds the pointers alias or the byte-count is below the vector
threshold (8 iterations). The `restrict` version elides the runtime check but produces the same
vector body. This is the standard shape of LLVM's Loop Vectorizer output when profitability
analysis clears the bar: SIMD width from the target's vector registers (128-bit NEON: 2 lanes for
`f64`), unroll factor chosen by the cost model for latency hiding, and (when aliasing can't be
proven at compile time) a versioned loop rather than giving up.

**Implication for Lumen:** any loop the C backend emits in the same idiomatic shape (a simple
counted loop over `double`/`int64_t` arrays with no aliasing between the value stack's runtime
representation and control flow clang can't see through) gets this same treatment for free,
*without Lumen's own hand-rolled NEON pass ever firing*. The hand-written map-detection pass in
section 1 above is therefore not filling a total gap; it is filling the specific gap where clang's
vectorizer does *not* clear its profitability bar on Lumen's actual emitted C, which is the next
question.

### 1.2 Where Lumen's current C emission likely defeats clang's vectorizer

Three things in `emit_fn.lm`'s general (non-map-detected) code shape work against
auto-vectorization, none of them fundamental, all fixable:

1. **No `restrict` anywhere.** Every array read/write goes through `AHEAP`, a single shared
   backing array (see `hdr()`/`ir_word()`/the `AHEAP[F<slot>+1]` addressing seen in
   `emit_vec_map`, line 693). A generic emitted loop reads and writes through pointers derived
   from the *same* base array with runtime-computed offsets. LLVM's alias analysis has no way to
   prove two such accesses don't overlap, and unlike the measured AXPY case above (three
   distinct top-level parameters), Lumen's IR->C lowering does not distinguish "two logically
   independent array slots" from "the same array, different offset" at the C source level. Without
   `restrict` (or without provable distinctness), the vectorizer either emits a runtime check
   (costly if it can't, and for generic AHEAP-relative accesses it very often can't derive a
   sound one) or bails to scalar.
2. **No alignment hints.** `vld1q_f64`/`vst1q_f64` (unaligned load/store) is what the hand-rolled
   NEON pass already uses precisely because Lumen's heap gives no alignment guarantee; the general
   C emission path has the identical problem for anything clang might try to vectorize on its own.
   Unaligned accesses aren't fatal on ARM64 (NEON handles them, just marginally slower than
   aligned `ld1`/`st1` with hint), but a Lumen-native array type with a known, emitted alignment
   would let LLVM skip the alignment-peeling prologue entirely, which matters more at small trip
   counts (options-pricing kernels are frequently small: dozens to low hundreds of paths, not
   millions).
3. **Value-stack indirection.** Emitted code threads scalars through named C locals like `s0`,
   `s1`, `sd0` (see the `sl_int`/`sd` naming visible around line 590-610), one per stack slot, which
   is exactly the shape LLVM's own `mem2reg`/SROA passes are built to clean up, so this specific
   point is not expected to block vectorization once the loop body itself is a clean counted loop;
   it is listed here because it is a real difference from hand-written C, just one LLVM already
   absorbs well, not a gap worth spending effort on.

None of this means Lumen "loses" to hand-written C across the board; it means Lumen wins for free
wherever its emitted C happens to look like case 1.2's restrict/aliasable AXPY-shaped loop with a
provable trip count, and it needs either the hand-rolled pass (today, one idiom) or new codegen
discipline (below) everywhere the shared-heap addressing defeats LLVM's alias analysis, which is
most non-trivial numeric code once more than one array is live in the same loop.

---

## 2. What real auto-vectorizers do, and the profitability question

This is the load-bearing fact for the entire plan: **modern auto-vectorization is not "detect a
loop and vectorize it."** It is a cost-modeled decision with a real chance of saying no. Grounding
the plan in how LLVM and GCC actually work:

### 2.1 LLVM's Loop Vectorizer

- Operates on LLVM IR loops that survive canonicalization (LCSSA form, rotated to a single
  latch, trip count known or speculatable). It builds a *Vectorization Plan* (VPlan) representing
  candidate vector widths and interleave (unroll) factors, then asks the **cost model**
  (`TargetTransformInfo`) for the estimated cost of each candidate versus the scalar baseline on
  the specific target (vector register width, number of vector ports, load/store throughput,
  gather/scatter cost if any, reduction cost, masked-operation cost for SVE-style predication).
  It picks the plan with the lowest estimated cost, including "do not vectorize" as a valid
  outcome when the estimated cost is not better than scalar (small trip counts, expensive
  gather/scatter, poor memory access pattern).
- Handles **runtime aliasing checks** ("versioning"): when it cannot statically prove pointers
  are independent, it can emit both a vectorized and a scalar version of the loop guarded by a
  cheap runtime disjointness check, exactly as measured in section 1.1's non-`restrict` case.
  This is the single most important escape hatch for a compiler (like Lumen's C backend) that
  cannot emit `restrict` easily: LLVM will still try, at the cost of a small runtime branch.
- Handles reductions (sum, product, min/max, dot-product-style fused patterns), a critical case
  for quant kernels (running sums, dot products in linear algebra, path-average payoffs) and one
  Lumen's hand-rolled pass does not attempt at all (it only matches pure elementwise maps).
- SLP (Superword-Level Parallelism) vectorization is a separate pass: instead of vectorizing
  across loop iterations, it finds isomorphic scalar operations *within* straight-line code (e.g.
  four independent scalar adds of struct fields) and packs them into one vector op. This is
  actually closer to the semantics of pricing kernels that unroll a small fixed-size basket (4-8
  correlated legs) than the loop vectorizer is, and it fires on both the C and LLVM backend's
  output today for free wherever the emitted C/IR happens to contain the right shape, with zero
  Lumen-side work, which is worth exploiting deliberately (write emitted code so small fixed-size
  unrolled blocks are isomorphic) rather than by accident.

### 2.2 GCC's tree-vectorizer

- Broadly the same shape (cost-modeled, versioning-capable, handles reductions and SLP) but a
  separate implementation with its own cost model and its own strengths/weaknesses; GCC has
  historically been more aggressive at auto-vectorizing reductions and slightly more conservative
  on versioning heuristics. Not the primary target for this plan (Apple Silicon toolchains default
  to clang/LLVM, and `native/` already assumes `clang`), but relevant if a portable-C fallback
  path is ever needed on a non-Apple/non-LLVM target; noted for completeness, not pursued further
  here.

### 2.3 ARM-specific: NEON vs SVE/SVE2 on Apple Silicon

- **NEON** (Advanced SIMD): fixed 128-bit vector registers, 2 lanes of `f64` / 4 lanes of `f32`.
  This is what the existing hand-rolled pass targets and what every M-series chip supports.
- **SVE/SVE2** (Scalable Vector Extension): vector-length-agnostic ISA using predicated
  (masked) operations, present on some server-class ARM64 (e.g. AWS Graviton 3/4, Fujitsu A64FX)
  but **not implemented on any shipping Apple Silicon M-series chip** (M1 through M4 generation,
  as of this writing, are NEON-only; Apple has not adopted SVE). This matters directly for scope:
  since the stated target is M-series Macs, an SVE/SVE2 lowering path would be dead code on the
  actual deployment target. It is listed in the roadmap only as an ARM64-in-general design note
  (worth keeping the IR-to-native-vector abstraction general enough not to hard-code 128-bit/NEON
  assumptions if a non-Apple ARM64 server target is ever added), not as near-term work.
- Practical consequence: any Lumen-native vectorization work for the stated M-series target
  should assume NEON's fixed 128-bit width (2x `f64`, 4x `f32`) as the only real hardware
  contract, matching what `emit_vec_map` already assumes. There is no near-term ARM-side reason to
  chase SVE.

---

## 3. Gap analysis: hand-written intrinsic C vs Lumen's current output

Where hand-tuned C using explicit NEON intrinsics (or `restrict`/alignment-annotated plain C)
still wins over what Lumen emits today, concretely:

1. **Multi-array kernels** (more than one input array plus an output array in the same loop,
   e.g. `out[i] = a[i]*w1 + b[i]*w2 + c[i]*w3`, the shape of a basis-function or weighted-sum
   pricing kernel): the hand-rolled map pass doesn't match (it is single-input only), and the
   general emission path lacks `restrict`, so this either fails to vectorize or requires clang to
   prove non-aliasing on shared-heap-derived pointers, which it usually cannot. Hand-written C
   with `restrict` on three independent parameters vectorizes trivially (measured in 1.1). **This
   is today's largest concrete gap** and the most valuable near-term target.
2. **Reductions** (running sum / dot product / running max, e.g. a Monte Carlo path-average
   payoff or a portfolio-weighted sum): not handled by the hand-rolled pass at all (it only
   matches pure elementwise maps with no cross-iteration accumulator). LLVM's own vectorizer can
   still find and vectorize a reduction loop in vanilla emitted C if the loop body is simple
   enough and aliasing is provable/versioned, but Lumen gives it no help and no guarantee.
3. **Gather/scatter and irregular access** (indexed access, e.g. `out[i] = table[idx[i]]`,
   relevant to lookup-table interpolation in vol-surface or yield-curve code): genuinely hard for
   any auto-vectorizer (cost model usually says no, correctly, since NEON gather/scatter is
   expensive or absent depending on the exact op); hand intrinsics rarely help either unless the
   access pattern has exploitable structure (e.g. a strided or sorted index). Out of scope for
   near-term Lumen work; flagged as a case where "beat the auto-vectorizer" isn't really the
   available prize (nobody beats it cheaply here, including hand-written C).
4. **Alignment-sensitive small-trip-count kernels**: for the smallest kernels typical of pricing
   code (a handful to a few hundred elements, not millions), the fixed cost of an unaligned-load
   prologue or a runtime aliasing check is proportionally larger. Hand-tuned C with known
   alignment and no aliasing ambiguity skips both; today's Lumen output pays for both whenever the
   generic (non-map-detected) path is taken.

None of these four gaps require abandoning the "hand the vectorization work to LLVM" strategy.
All four are addressable by *emitting C (or LLVM IR) that gives LLVM's existing vectorizer the
same information hand-written C gives it*, which is a much smaller and more tractable project
than building a Lumen-native vectorizer from scratch (see section 5).

---

## 4. Staged plan: closing the gap without abandoning "piggyback on LLVM"

Ordered by effort, each stage has a concrete exit criterion in this codebase's existing style
(gated by `native_diff.mjs`/`llvm_diff.mjs`/a new perf benchmark, never "trust me").

### Stage A (weeks, not months): `restrict`-equivalent emission for provably-independent arrays

When Lumen's IR already proves two array-slot accesses are backed by *distinct* allocations (not
overlapping views into the same `AHEAP` region with runtime-computed offsets), emit those C
pointers with `restrict`. This requires no new analysis beyond what the type/allocation tracker
already knows at the point each array is created (Lumen arrays are allocated, not aliased views,
per the `AHEAP[F<slot>+1]` addressing already used in `emit_vec_map`); it is a matter of tagging
that fact through to C emission and adding the keyword. Exit criterion: a new
`native/simd_restrict_test.mjs` that compiles a two-input-array kernel (the AXPY shape from 1.1)
through the C backend, greps the emitted assembly for `.2d`/`fmla.2d` NEON vector mnemonics (not
merely `#if defined(__ARM_NEON)` in the source, which proves nothing about whether the vectorizer
actually fired), and fails if the vector path is absent. This directly closes gap 1 in section 3
for the common case.

### Stage B (weeks): alignment hints on Lumen-native arrays

Since Lumen controls its own allocator (`AHEAP`), it can guarantee 16-byte alignment for array
allocations above a size threshold at effectively zero cost (a small allocator change, not a
compiler change), then emit `__builtin_assume_aligned` (or an `_Alignas`-annotated typedef) at the
array's use site in C. Exit criterion: same harness as Stage A, additionally checking the emitted
assembly uses aligned `ld1`/`st1` sequences (not the unaligned `ldur`/`vld1q_f64` prologue) on the
now-guaranteed-aligned path, and a microbenchmark showing the small-trip-count win described in
gap 4.

### Stage C (1-2 months): generalize the map-detection pass to reductions and multi-input maps

Extend `detect_map`/`emit_vec_body` in `emit_fn.lm` from the single fixed idiom (one input array,
pure elementwise `f`) to: (a) N-input elementwise maps (the weighted-sum kernel from gap 1), and
(b) the single most common reduction shape (`acc = acc OP f(aget(in,idx))` for `OP` in
`{+, *, min, max}`). This is real, scoped compiler work inside `native/emit_fn.lm`, not a rewrite:
same detection-plus-hand-rolled-NEON-body strategy, wider idiom set. It must ship with new
conformance tests in `native/` mirroring the existing map test's structure and pass
`native_fixpoint_test.mjs` unchanged (a codegen change to the emitter is exactly the kind of
change that must not perturb the self-hosting fixpoint's determinism). Realistic scope: one
idiom-family per PR, per this project's "one language change per PR" rule; do not land maps and
reductions in the same branch.

### Stage D (2-4 months, exploratory, needs a go/no-go after Stage C data): mirror stages A-C into
`emit_llvm.lm`

Everything above targets the C backend because that is where the existing hand-rolled pass and
the measured evidence live. The LLVM backend has none of it. Two sub-options, decided by measuring
after Stage C, not assumed up front:

- **D1 (cheap):** if Stage A/B's `restrict`/alignment metadata is available at the IR level
  already (it should be, since both backends consume the same IR), the LLVM backend gets an
  equivalent win by emitting `noalias`/`align` attributes on the corresponding `.ll` parameters
  and `load`/`store` instructions, LLVM IR's direct equivalents of C's `restrict`/alignment
  hints. This is a small, mechanical addition to `emit_llvm.lm` once the IR carries the fact.
- **D2 (more expensive, only worth it if D1 under-delivers):** port the idiom-detection logic
  from Stage C into `emit_llvm.lm` so the LLVM path also gets a hand-rolled vector fast path
  instead of relying purely on `opt`'s Loop/SLP vectorizer picking up the plain IR. Given that the
  LLVM backend is one level closer to LLVM's own vectorizer than the C backend is (no clang
  front-end re-parse in between), the honest expectation is that D1 alone likely closes most of
  the gap here and D2 is not worth its cost; this should be re-evaluated with actual benchmark
  numbers after D1 ships, not committed to now.

### Stage E (multi-year, explicitly NOT recommended as a near-term investment): a Lumen-native
vectorization pass ahead of the C/LLVM handoff

This is the "build a real auto-vectorizer" option: implement loop/SLP vectorization analysis
*inside Lumen's own optimizer* (`native/optimize.lm`), producing already-vectorized IR (or
directly emitting NEON intrinsics) before either backend ever sees the loop, rather than relying
on the downstream C/LLVM toolchain's vectorizer at all.

**Honest assessment: this is a multi-year effort with a poor cost/benefit ratio given the
project's actual constraints, and should not be scheduled**, for reasons specific to this
codebase, not vectorization in the abstract:

- LLVM's Loop Vectorizer represents a genuinely large, mature engineering investment (a dedicated
  cost model calibrated against real microarchitectures, VPlan's ability to represent and compare
  multiple vectorization strategies, correct handling of masked/predicated execution, reduction
  idiom recognition across many shapes, runtime versioning, interaction with the rest of LLVM's
  optimization pipeline). Reproducing even a useful subset of this from scratch, in Lumen, without
  regressing correctness on the self-hosting fixpoint, is realistically 1-2 person-years of
  focused work minimum, before it demonstrably beats what Stage A-D already gets essentially for
  free from LLVM.
- Because both existing backends already hand off to LLVM (directly, or via clang, which is
  itself LLVM), a Lumen-native vectorizer would be **competing with, not replacing, LLVM's
  vectorizer** on the same final code generator; the ceiling for "beat GCC/LLVM's auto-
  vectorization" for the 95% case (clean counted loops, provable independence, standard
  reductions) is "reach the same LLVM output LLVM would have produced anyway," which Stage A-D
  reaches for a fraction of the cost by simply not hiding the facts LLVM needs.
- The only case where a from-scratch pass could plausibly *beat* LLVM's own vectorizer rather than
  merely reach it is where Lumen has semantic information LLVM structurally cannot recover from
  C/LLVM-IR source, most plausibly: Lumen's IR already distinguishes true value-level
  immutability and allocation identity in ways C's type system erases. This is a real, specific
  opportunity (not a generic "write a better vectorizer" claim), but it is exactly the kind of
  claim this project's standard requires proving before investing in, not asserting: it would need
  a pre-registered experiment (per `DESIGN.md` section 10's conformance-test-driven method)
  showing a concrete case where Stage A-D's "tell LLVM the truth" strategy provably cannot recover
  a vectorization that a hypothetical Lumen-native pass could, before committing years to it.
- Given the project's explicit zero-legacy, no-unnecessary-dependency philosophy, "we already
  emit C/LLVM IR and both have world-class vectorizers" is itself the self-contained answer for
  the near term: the self-containment argument that would justify building a first-party
  vectorizer (avoiding a toolchain dependency) does not apply here, since Lumen already depends on
  clang/LLVM for final native codegen regardless of whether it has its own vectorizer; a Lumen-
  native vectorizer would not remove that dependency, only add work on top of it.

**Recommendation:** do not schedule Stage E. Revisit only if (a) Stages A-D are complete, measured,
and show a persistent, well-characterized gap against hand-written intrinsic C that is
specifically attributable to information LLVM cannot recover from Lumen's current C/LLVM-IR
emission (not merely "LLVM didn't vectorize this specific loop shape yet", which is a Stage
A-D-style emission fix, not a case for a new pass), and (b) that gap is large enough on real
pricing-kernel workloads (Black-Scholes families, yield-curve bootstrapping, path-dependent Monte
Carlo payoffs, the actual FE-API numeric hot paths) to justify a multi-year investment against the
project's other committed arcs in `ROADMAP_2036.md`.

---

## 5. Summary table

| Stage | What | Effort | Confidence | Verdict |
|---|---|---|---|---|
| A | `restrict` emission for provably-independent arrays (C backend) | weeks | high (measured today: clang already vectorizes this shape when it can prove independence) | do now |
| B | Alignment hints/guarantees on Lumen-native arrays (C backend) | weeks | high | do now |
| C | Generalize map-detection to N-input maps + common reductions | 1-2 months | medium-high (scoped, same strategy as existing pass) | do next, one idiom family per PR |
| D1 | Mirror `restrict`/alignment as `noalias`/`align` in LLVM backend | weeks, after C | high | do after Stage C data lands |
| D2 | Port idiom-detection into LLVM backend | 1-2 months | low-medium, likely redundant with D1 | only if D1 under-delivers, re-evaluate with numbers |
| E | Lumen-native vectorization pass ahead of C/LLVM handoff | 1-2+ years | speculative; would compete with, not replace, LLVM's own mature vectorizer | do not schedule; revisit only with a proven, specific, measured gap Stage A-D cannot close |

## 6. What this plan deliberately does not claim

- It does not claim Lumen currently beats hand-written C on any general numeric kernel; the one
  place it demonstrably helps today (the single-input elementwise map idiom) is a narrow,
  hand-matched special case, not a general capability.
- It does not claim SVE/SVE2 matters for the stated target; Apple Silicon M-series ships NEON
  only, so an SVE lowering path would be validating dead code on the actual deployment platform.
- It does not claim a from-scratch Lumen vectorizer is impossible or without merit in the abstract
  (LLVM and GCC both prove it's a solvable, valuable engineering problem); it claims specifically
  that, for this codebase, given that both existing backends already terminate in LLVM/clang, the
  near-term, high-confidence, low-cost path is making sure LLVM's already-excellent vectorizer
  gets the facts (aliasing, alignment, idiom shape) it needs, not re-implementing what it already
  does well.
