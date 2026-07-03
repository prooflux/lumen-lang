# Lumen quant-oracle roadmap: status

Goal (set 2026-06-30): a 3rd independent oracle in Lumen to validate prices and do
math, fast to author (MCP + warm daemon) and eventually fast to run (native backend).

## Done and validated (via the loop: failing test, minimal WAT change, perf gate, land)

1. **Float type** (`feat/lumen Float`, commit on trunk): float literals, `+ - * /`,
   comparisons, automatic Int->Float coercion in mixed expressions, `to_int` /
   `round` / `to_float`. Per-frame-slot and per-symbol-return type tracking.
2. **Float arithmetic + comparisons**: landed with (1).
3. **Math kernel**: `sqrt`, `abs` (native f64) and `exp`, `ln`, `pow` (pure-WAT
   numerics: range-reduced Taylor for exp, atanh series for ln, `pow = exp(y ln x)`).
4. **Float arrays** (step 4): `array(n)` / `aget` / `aset` / `alen`, heap-backed,
   bounds-guarded. Curves and cashflow vectors.
5. **Records/structs** (step 4 complete): `type T = { a: Float, b: Int }`, construct
   `T { a: .., b: .. }`, read `p.a`. Compile-time sugar over arrays (a field name
   interns to a stable global slot, so `p.field` lowers to `AGET`; zero new runtime
   opcodes). Structured deal inputs for the oracle.

Each cycle kept the full suite green (basics, conformance, safety, loop) and passed
`perf.mjs` (compile throughput drifted 100% -> ~85% of baseline as the builtin
dispatch chain grew; still within tolerance; see "Known follow-ups").

### Oracle proof (real instruments, exact)
- Black-Scholes call, normal CDF written in Lumen: S=K=100, r=5%, T=1, vol=20% -> **10.4506** (exact).
- Record-driven Black-Scholes (`Opt { s, k, r, t, vol }`) -> **10.4506** (exact).
- Discounted cashflow PV over Float arrays: 3x100 at t=1,2,3, r=5% -> **272.32** (exact).

The oracle goal is met on the bootstrap interpreter: it prices correctly, and the
author loop (warm daemon, sub-ms compiles, MCP) is faster than spinning up
Python/Excel. Roadmap steps 1-4 are done.

> **Update (2026-07-03):** everything below this line marked "remaining" or "started" has
> since landed. Both native backends exist and are gated bit-identical (a C emitter,
> `native/emit_fn.lm`, and an LLVM emitter, `native/emit_llvm.lm`); the Lumen optimizer
> `native/optimize.lm` landed and now optimizes the compiler itself; and `lumenc.lm`
> **self-hosts** (`SELF: MATCH`, byte-identical, CI-gated). The remaining native item is the
> fixpoint (run `lumenc.lm` through the backends so the compiler runs natively). The full,
> current narrative is `../SELFHOST_CAMPAIGN_LOG.md`. The text below is preserved as the
> 2026-06-30 status snapshot.

### Honest speed status (the part gated on the native backend)
Benchmark, 200k Black-Scholes evaluations, both exact (104506):
- Lumen interpreter: ~0.64s wall (includes node start + WAT assemble + run).
- Python (CPython scalar loop): 0.153s.

So **today the interpreter is slower than CPython** for scalar pricing, and well
behind numpy/BLAS for vectorized math. The two speed wins delivered now are
DEVELOPMENT speed (the MCP/daemon author loop) and CORRECTNESS/INDEPENDENCE (a
clean-room oracle that agrees with the textbook). The IN-CODE ops/sec win is NOT
delivered and is exactly what the native backend below provides; until then, value
the oracle for independence, not raw throughput.

## Native backend — started (Lumen-owned; full plan in `NATIVE_BACKEND_PLAN.md`)

Architecture ruling (2026-06-30): the IR->native TRANSLATION is itself a Lumen program
(`native/emit.lm`), run by Lumen; clang is a scoped, deletion-clocked assistant; a Lumen
optimizer carries the speed; the self-hosted compiler is the foundation it plugs into.
Cranelift is superseded (no host rust; clang reaches the same LLVM target today).

**Landed this session (gated bit-identical to the interpreter oracle):**
- Keystone: raw-memory opcodes `load32/store32/load8/store8` (53..56) + bounds-checked loader
  (conformance 18/18, perf PASS) — the single unblock for self-host, native emit, and optimizer.
- `native/emit.lm` (the IR->C translator, in Lumen) + driver + diff harness + bench. Scalar
  core (opcodes 0..24) is **11/11 diff-green** and runs `fib` at **~19x the interpreter
  (231M vs 12.3M calls/sec), ~21% of hand-written C**. First proof Lumen translates its own IR
  to a native binary, no 3rd language in the translation.

**Remaining as of the 2026-06-30 snapshot (nearly all since landed — see the update banner
above):** the Lumen optimizer `optimize.lm` (LANDED, and now optimizes the compiler itself);
float/heap emit (LANDED in `emit_fn.lm`); direct LLVM-IR emission (LANDED as `emit_llvm.lm`);
and the headline spine — `lumenc.lm` self-hosting (ACHIEVED, `SELF: MATCH`, byte-identical).
Still open: the single AOT native binary and the native fixpoint (retiring the seed). The
bootstrap interpreter stays the reference oracle forever.

## Known follow-ups
- A float-aware `print_float` / `float_to_text` (today floats are output by scaling
  with `to_int`/`round`); the formatter is a moderate WAT routine. (Still open.)
- The builtin dispatch in `c_primary` is a linear name chain. The ~15% "drift" worry is
  empirically retired: the 2026-07-02 speed campaign measured five such micro-optimizations
  (including length-bucketing this chain) at or below baseline under V8 and reverted them all;
  the seed is at a local optimum (~615k compiles/sec/core). The real speed lever is the native
  fixpoint, not seed micro-tuning.
- Int arrays / generic element type; a real `Bool`; exponent-form float literals. (Still open.)
