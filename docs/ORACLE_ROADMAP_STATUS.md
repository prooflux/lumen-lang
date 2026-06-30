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
Python/Excel. Roadmap steps 1-4 are done. The only remaining item is the native
backend (step 5).

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

## Remaining

**Native backend** (roadmap Phase 4: Cranelift for debug, LLVM for release) — full plan in `NATIVE_BACKEND_PLAN.md`:
   compile the existing IR to machine code. This is the piece that makes "faster
   ops/sec than Python" fully true for scalar/custom math. It is a multi-week
   subsystem, not a seed edit, and is NOT completable in a single session. Until it
   lands the engine is the bootstrap interpreter: correct and good for an oracle,
   but it will not beat numpy/BLAS on vectorized math. Concrete first step: lower the
   IR opcode stream to Cranelift IR behind the same `run` entry point, keeping the
   interpreter as the reference and diffing the two for every conformance program.

## Known follow-ups
- A float-aware `print_float` / `float_to_text` (today floats are output by scaling
  with `to_int`/`round`); the formatter is a moderate WAT routine.
- The builtin dispatch in `c_primary` is a linear name chain; length-bucket or hash
  it to recover the ~15% compile-throughput drift if it keeps growing.
- Int arrays / generic element type; a real `Bool`; exponent-form float literals.
