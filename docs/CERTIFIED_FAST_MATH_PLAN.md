# Lumen Certified Fast Math — beat libm at f64, at reality-grade accuracy

## Shared base (everyone builds here)

**HEAD commit SHA (immutable base for all Certified-Fast-Math work):**

```
7a573970f21db34beb3f9450fdd84e9396bfb984   (origin/ship/lumen-typed-float, PR #176)
```

This is the green full-slot type-tracked float codegen foundation: `emit_fn.lm` lowers each
value-stack slot to a real native local (`sd_k` double / `s_k` int64), Black-Scholes runs at ~2.1x
hand-C on the identical algorithm, and the seed oracle is green (18/18 + 102/102 + 7/7 + perf,
scalar 11/11, optimize 12/12, float 11/11). `trunk` is at `49599218c` (PR #175, the pre-typing v3);
it does NOT yet carry the typed-slot base, so **do not branch CFM work off trunk** until #176 merges.

**Coordination protocol (no collisions — the agy-vs-mine divergence is the lesson):**
1. `git clone --reference` a fresh checkout under `QUANTS-Working-Trees/<id>`, then
   `git checkout origin/ship/lumen-typed-float` (the branch tip — it carries this plan and the green
   code, foundation SHA `7a573970f21db34beb3f9450fdd84e9396bfb984`). Clone-per-agent; **never
   worktrees**, never edit `QUANTS`. See `tools/swarm/swarm.py`.
2. One agent per lane (below). Commit on `ship/<id>`, PR into `trunk`, merge-queue serializes.
3. **Lane A (P0) must land first** — it is the gate every other lane is measured by. Lanes B/C/D
   branch off the *same* base SHA and rebase onto trunk once P0 merges.
4. When #176 merges to trunk, the base advances to that squashed trunk commit; everyone rebases.

---

## The thesis

We stop chasing bit-identity to a truncated 16-term Taylor series. That constraint was a ceiling on
**both** axes: it forced a kernel *slower* than libm (scalar, no FMA, no SIMD) **and** *less accurate*
than libm (the series is wrong by ~1e-4 vs the true value — we only hid it behind self-consistency).

We chase the thing **only Lumen can**: *faster than libm, at reality-grade (correctly-rounded)
accuracy*, because Lumen owns the three things a C-programmer-plus-libm never has together — the
**language semantics** (it knows a value is `exp` of an argument in a known range), the **accelerator**
(it can rewrite the math), and the keystone, the **accuracy contract**: it can declare "≤1 ULP of the
truth" and then *legally* apply transforms C is forbidden from doing.

**Certified Fast Math (CFM):** every numeric transform is legal iff the accelerator can certify the
result stays within a declared ULP bound of the **correctly-rounded mathematical reference** (offline
113-bit mpmath/MPFR, rounded to f64). C offers only bit-exact-slow (`-fno-fast-math`) or
unbounded-unsafe (`-ffast-math`); CFM is the third mode C structurally cannot express — **bounded-error
fast-math with a certificate.**

---

## The gate is hybrid (this is the correction to make)

Do **not** move everything to ULP. Correctness stays exact where exact is free:

| Value class | Contract | Check |
|---|---|---|
| Integers, control flow, addresses | **bit-identical** across all backends | byte-diff (unchanged) |
| Un-transformed float arithmetic (`+ - * /`, no reassoc/FMA) | **bit-identical** | byte-diff |
| Transformed numeric values (transcendentals, FMA'd / reassociated exprs, minimax) | **≤ declared ULP** of the correctly-rounded reference | ULP-diff vs mpmath truth |

The accelerator tags each emitted value `exact` or `≤N ULP`; the gate applies the matching check. A
program that never triggers a transform stays 100% bit-identical — CFM only "spends" accuracy where it
buys speed, and never silently.

**Success bar (Law P):** a CFM build ships only if, on the corpus + a dense domain grid,
`max_ULP(native, mpmath_truth) ≤ 1` **and** `native_prices_per_sec ≥ scalar_libm_C_prices_per_sec`.
Beating libm at libm-grade accuracy is the whole point; either half failing = not shipped.

**Honesty boundary (RULES.md):** the baseline is the **scalar libm loop a quant actually writes**. If
we ever compare against vectorized C (`-fveclib` / SLEEF), we report *that* number too. Never "beats C"
against a strawman; never "bit-identical" (we are deliberately not); never "≤1 ULP" without the harness
proving it.

---

## The accelerator becomes a certified-numeric optimizer

`optimize.lm` graduates from jump-threading to a numeric pass that, for each transcendental / hot
expression: picks the cheapest **Minimax Kernel Registry** entry meeting the required ULP, fuses,
applies FMA, vectorizes across lanes, and partial-evaluates constant transcendentals — each rewrite
emitting the error bound the gate checks. This is the "Lumen accelerator": it does math no general
compiler will, because none is allowed to know it is pricing options or to carry an accuracy certificate.

### Minimax Kernel Registry (kept from Gemini's draft — the right mechanism)
A **static, offline-derived** table of certified minimax polynomial coefficients, keyed by
`(function, input range, target ULP)` — e.g. `exp` on `[-5,5]` at ≤1 ULP → a degree-7 polynomial with
its proven error bound. Coefficients are generated **offline** (Sollya/Remez, committed as data), so the
build stays deterministic and network-free (Rule 7) — **no compile-time solver**. The optimizer reads the
program's range contracts and inlines the matching entry. A C programmer *could* hand-roll and hand-verify
one of these per site; Lumen does it automatically, per site, with the certificate. That automation +
certification is the only-Lumen edge.

### Accuracy as a compiled parameter
Pricing usually needs ~1e-7 relative, not correctly-rounded. `@accuracy(1ulp)` (or inferred from use)
lets the accelerator pick the *cheapest* registry kernel meeting it — degree-4 `exp` when 1e-6 suffices,
degree-7 when ≤1 ULP is demanded. libm gives one (maximal) accuracy always. Tunable-compiled-accuracy is
a capability C+libm cannot express.

---

## Roadmap (instrument first; one change; publish the number)

Current honest state: 54M prices/sec ≈ 60% of scalar-libm-C; emitted arm64 is **62 scalar f64 ops, 0
vector** (measured on the base SHA). Each phase moves *both* axes and is gated by the hybrid gate above.

### P0 — the certified measuring instrument (LANE A — lands first, blocks the rest)
1. `tools/gen_reference.py` (PEP-723 inline `mpmath`): for the corpus inputs and a dense domain grid,
   emit correctly-rounded 113-bit → f64 goldens for `exp`, `ln`, `pow`, and true Black-Scholes prices.
   Commit the vectors as data (offline, reproducible).
2. `native/ulp_diff.mjs`: exact ULP distance between native f64 output and the reference; reports
   `max_ULP`, `p99_ULP`, and the worst input.
3. Re-baseline honestly: current native's `max_ULP` vs **true** BS (expect it to be *many* ULP off — the
   series is inaccurate) and its prices/sec vs scalar-libm-C. This number motivates everything.
4. Extend the batch bench to price an **array of N options** (contiguous), the shape P3 vectorizes.

### P1 — FMA on (LANE B — cheapest certain win)
Drop `-ffp-contract=off` on the FLOAT path (keep exact-int paths unaffected). FMA is *faster and more
accurate* (one rounding, not two). Keep the existing series for now; just let it contract. Publish the
ULP + speed delta. (Do **not** "replace the series with native double math" — there is no hardware f64
`exp`; that conflation is why the draft's P1 was wrong.)

### P2 — range-bound minimax transcendentals (LANE B, after P1)
Build the Minimax Kernel Registry for `exp`/`ln` on the pricing range at ≤1 ULP (degree ~6–8, branchless).
Add the `optimize.lm` pass that replaces `exp`/`ln` with the inlined kernel under a range contract.
**Also upgrade the interpreter's `exp`/`ln` to a reference-quality path** (or make the offline mpmath
goldens the reference) — the 16-term series won't pass ≤1 ULP, so the oracle itself must be honest.
Expect the big transcendental win here (fewer terms + no range-reduction branches ≈ half libm's cost).

### P3 — f64 SIMD pricer (LANE C — the beat-libm closer; NOT double-double)
Vectorize the *f64* pricer 2-wide over the option array using NEON (128-bit = 2×f64 on this M1; state the
ceiling — AVX2 would be 4× on x86, which we don't ship). Do it at the IR level in the accelerator, not via
clang's auto-vectorizer (which bails on `rint`/bit-twiddling). Per-lane f64 is IEEE-identical, so this is
certified-safe by construction. This is the lever that pushes native clearly past scalar-libm-C.

### P4 — reassociation + constant-transcendental folding (LANE D)
Under the ULP contract: Estrin (parallel polynomial eval, more ILP) where Horner was forced; fold
`exp(-0.05)`-style constant transcendentals to literals at compile time (libm-C cannot — opaque extern).
Stop when the number says the marginal lever isn't worth it.

**Projected (conservative, stacked):** FMA (1.3×) × minimax (1.5×) × SIMD-2wide (2×) ≈ ~4× → ~200M
prices/sec vs 84M scalar-libm-C, at ≤1 ULP of the *true* price — i.e. faster than the libm loop a quant
writes, and simultaneously *more* accurate than we are today.

---

## Governance (RULES.md / AGENTS.md amendment)

- **Rule 5 (Precision), amended:** the reference is the **correctly-rounded mathematical value**, not the
  interpreter's bits. Every backend is **bit-identical where exact** (integers, control, un-transformed
  float) and **within a declared, gated ULP bound where the CFM accelerator transforms**. The interpreter
  is upgraded to a reference-quality numeric path so it, too, satisfies the bound.
- **Law P (Speed), unchanged and binding:** no release regresses any benchmark; the CFM headline is
  native vs scalar-libm-C at ≤1 ULP.
- **Rule 7 (offline/deterministic), preserved:** minimax coefficients are generated offline and committed
  as data; **no compile-time solver, no network at build.**

---

## Appendix A — what "reality-grade" means precisely
f64 has ~15.95 decimal digits. "Same accuracy as reality" = the correctly-rounded f64 value, i.e. ≤0.5
ULP (correctly rounded) or the pragmatic ≤1 ULP (libm-grade). This is the pricing target. We do **not**
need more than f64 for option prices — the market quotes far coarser.

## Appendix B — Double-double (>f64) is a SEPARATE, orthogonal track (not beat-libm)
Gemini's `dd_real` (2×f64 → ~32 decimals / ~106 bits) is a real and valuable capability, but it is the
*opposite* axis: ~10–20× *slower* than f64 and *more* precise than pricing needs. It does **not** belong
on the beat-libm-at-f64 critical path and must not gate P0–P4. Keep it as an optional high-precision mode
(`@accuracy(32dec)`) for the rare kernels that genuinely need > f64 (e.g. catastrophic-cancellation-prone
long-horizon accumulations), vectorized 2-wide via paired hi/lo NEON registers — but measured and shipped
on its own track, with its own gate, never conflated with "more speed."
