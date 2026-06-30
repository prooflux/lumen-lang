# Phase 4: the native backend (beat or match native binaries)

Status: plan, not built. This is the concrete plan for flywheel step 2 in
`VISION_2035.md` ("Native backend. Speed stops being a disqualifier"). It is the
fifth roadmap item from `docs/ORACLE_ROADMAP_STATUS.md`: the in-code ops/sec win,
delivered honestly. It is a multi-week subsystem in a separate toolchain, and per
the roadmap it comes after self-hosting. I will not pretend it is done; this
document is the path, the discipline, and the targets.

## The goal, stated without hedging
Compile the existing Lumen IR to native machine code that **matches or beats the
fastest ahead-of-time languages** (C, Rust, the LLVM class) on the kernels Lumen
exists for: pricing, risk, numeric loops. The bootstrap interpreter exists only to
bootstrap and to be the reference oracle forever; the native backend is the speed
engine. The ops/sec claim in the vision lands here and only here.

## The non-negotiable: the interpreter is the reference oracle, forever
Correctness is defined by the interpreter, not the backend. Every native build must
produce **bit-identical output** to the interpreter on every conformance and basics
program. This is the determinism contract (`docs/spec/DETERMINISM_CONTRACT.md`) made
operational. The backend is allowed to be fast; it is never allowed to disagree.

### The first concrete step (the wedge)
Lower the IR opcode stream to Cranelift IR behind the **same `run` entry point**,
keep the interpreter as the reference, and **diff the two on every conformance
program**. Differential testing is the safety net and the gate: a backend opcode is
"done" only when every program that exercises it yields identical stdout and exit
under interpreter and native. Build the diff harness before the backend, not after.

## Why the IR makes this tractable
The compiler already lowers all of Lumen-mu to a flat opcode stream that the
interpreter walks (PUSH, GETARG, ADD/SUB/MUL/DIV, the float ops FADD..FPOW, JZ/JMP,
CALL/RET, RESERVE/SETLOCAL, MKTEXT/CONCAT, MKSUM/SUMTAG/SUMVAL, ANEW/AGET/ASET/ALEN,
etc.). The backend is a second consumer of that same IR. Values are 64-bit slots
(i64, or f64 bits); records and arrays are heap cells; this maps directly onto
machine registers and a native heap. No new front end, no new semantics, one IR.

## Architecture: two backends behind one contract
- **Stage A, Cranelift (debug/JIT).** Fast to build, fast to compile, good code.
  Used for the iteration loop and quick native runs. This is where the diff harness
  proves correctness opcode by opcode.
- **Stage B, LLVM (release).** Same IR lowered to LLVM IR, `-O3`, for the final
  "match C/Rust" performance. The optimizer earns the last constant factor.
Both expose the identical `run(entry)` contract and must pass the same diff harness.
The interpreter, Cranelift, and LLVM are three executors of one IR; the test is that
they never differ on output.

## Milestones (sequenced, each gated by the diff harness)
- **M0. Differential harness.** Run every basics + conformance program under the
  interpreter AND the backend; assert identical stdout + exit. Wire it into CI. No
  backend code merges without it.
- **M1. Scalar core (Cranelift JIT).** Int and Float arithmetic, comparisons,
  control flow (JZ/JMP), calls/frames (CALL/RET/RESERVE/GETARG/SETLOCAL),
  `to_int`/`round`, the coercions. Diff-green on every scalar program.
- **M2. Heap + runtime.** Text (MKTEXT/CONCAT/INT2TEXT/TEXTEQ), arrays
  (ANEW/AGET/ASET/ALEN), records, sum cells (MKSUM/SUMTAG/SUMVAL), and the pure-WAT
  math helpers (`f_exp`/`f_ln`/`f_pow`) reimplemented as native intrinsics or
  linked-in routines. Diff-green including Black-Scholes and the cashflow PV.
- **M3. Ahead-of-time single binary.** Emit a standalone native object/executable
  with no node and no interpreter in the loop, honoring the self-containment
  mandate (one binary, no networked package manager, no network at build). Cranelift
  object emission or LLVM.
- **M4. LLVM release path.** Same IR to LLVM IR to `-O3`. Hit the "match the fastest
  native binary" target on the benchmark suite below.
- **M5. Determinism hardening.** Reproducible floats by default (no FMA, no
  reassociation) so native output equals interpreter output bit-for-bit across
  platforms; the `fast` opt-in for explicitly non-recorded paths; the diff harness
  runs cross-platform.

## Performance targets (honest, measured, gated)
Benchmark suite (the kernels Lumen is for): Black-Scholes pricing loop, cashflow PV
over arrays, a Monte-Carlo step, an array reduction, and control-flow microbenchmarks
(fib, gcd). Compare wall-clock against C (`-O2`/`-O3`), Rust (`--release`), and
Python (CPython and numpy where it applies).
- **Interim (Cranelift JIT):** at least 20x to 50x faster than the bootstrap
  interpreter; within ~2x to 3x of C on scalar pricing. (Today the interpreter is
  ~4x slower than CPython on scalar Black-Scholes; this milestone flips that.)
- **Release (LLVM -O3):** match C and Rust within a small constant factor on the
  scalar and array kernels. Numpy/BLAS keeps the edge on large dense vector math
  until/unless a vectorizing path is added; we state that boundary, we do not
  overclaim it.
- **Gate:** a new release of the backend may not regress any benchmark (Law P,
  `RULES.md` rule 6). The benchmark suite is part of CI.

## Self-containment and zero-legacy, handled honestly
Cranelift and LLVM are build-time dependencies of the toolchain, which is a real
tension with zero-legacy. The resolution is the same as for the `lumen.mjs` host
shim: they are bootstrap scaffolding, not the artifact, and are re-derived in Lumen
at full self-hosting (the long-horizon end state). The shipped programs stay
self-contained: a single native binary, no networked package manager, no network at
build; effects reach the world only through capabilities whose nondeterminism is
tainted and quarantined.

## Why this is a separate, scoped project
This is weeks of work in Rust/native toolchains, it depends on self-hosting landing
first (roadmap order), and it carries real risk (the metatheory and determinism
guarantees must survive optimization). It is deliberately not a seed edit and not
something to fake as finished. The interpreter-based oracle that exists today is
correct and usable now; this plan is how its speed becomes competitive with the
fastest languages, on a timeline measured in weeks, gated every step by the diff
harness against the interpreter.

## Where this sits
`VISION_2035.md` is the destination (flywheel step 2). `docs/ROADMAP.md` is the
broader path. `docs/ORACLE_ROADMAP_STATUS.md` records steps 1-4 done (Float, math,
arrays, records) and this as the remaining item. `RULES.md` rules 5 and 6 are the
correctness and no-regression gates this plan must satisfy.
