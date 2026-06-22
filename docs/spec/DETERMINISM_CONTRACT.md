# The Lumen Determinism Contract

Status: draft v0.1, normative. This is the single source of truth for every determinism guarantee in Lumen. Memory, concurrency, debuggability, the compiler IR, security, verification, const-evaluation, FFI, and the bootstrap all reference this document instead of restating determinism themselves. The design-deepening workflow identified floating-point determinism across two backends as the single highest cross-cutting risk in the whole language, so this contract is deliberately concrete and conservative.

## Why this exists

Lumen claims "deterministic by default." That claim is the precondition for record-replay, time-travel debugging, provenance, a reproducible authorship benchmark, and a byte-identical self-hosting bootstrap. If determinism is asserted loosely it is false, because floating-point contraction, allocator nondeterminism, hash-randomized iteration, and wall-clock timing all leak nondeterminism silently. This contract enumerates every leak and closes it, and it is compiler-enforced with stable diagnostic codes, not a convention.

## The closed set of nondeterminism sources

Determinism in Lumen rests on one structural fact: **every effect enters through a capability**. The complete set of nondeterminism sources is therefore closed and enumerable. Each is listed with its control.

| Source | Control |
|--------|---------|
| Wall-clock time | Only via a `Clock` capability. There is no ambient `now()`. Recorded into the tape. |
| Randomness | Only via a `Random` capability, seedable; draws are recomputed from the seed, not stored. |
| Filesystem ordering | The `FileSystem` capability returns directory entries in a defined (sorted) order. |
| Map/Set iteration | Canonical (sorted) order by default. Insertion order is a separate, explicit type. Never hash-randomized. |
| Environment | Only via an `Env` capability. |
| Network and external I/O | Only via a `Network`/IO capability; responses are recorded into the tape. |
| Concurrency interleaving | The scheduler is a pure function of the program plus a recorded capability/select log (see Concurrency). |
| Memory addresses | No pointer identity is observable. There is no address-based equality or hashing in the value world. |
| Allocation | Deterministic allocation and Perceus reuse order; drop placement is specified over real control flow. |
| Floating point | Strict, pinned, identical across backends (see below). This is the hard part. |
| FFI / native boundary | Bridge results carry a propagating nondeterminism taint; deterministic-replay is separated from deterministic-execution (see Interop). |

## Floating-point determinism (the hard requirement)

This is the requirement most languages get wrong and the one most likely to sink Lumen if underspecified.

1. **Strict IEEE-754.** Evaluation is strict IEEE-754 binary64 (and binary32) with a fixed rounding mode (round-to-nearest-even). No `unsafe-math`, no `fast-math`.
2. **No contraction or reassociation.** Fused multiply-add contraction is off by default. Reassociation of floating-point expressions is forbidden in the optimizer. `(a + b) + c` is not silently turned into `a + (b + c)`.
3. **Fixed evaluation and reduction order.** Expression evaluation order is left-to-right and defined. Parallel reductions use a fixed reduction tree decided at compile time; the result is bit-identical across thread counts but is explicitly not equal to a sequential left fold for non-associative operations, and the language never claims it is.
4. **One canonical math library.** Transcendental functions (`sin`, `exp`, and so on) come from a single vendored, version-pinned `libm` whose results are part of the contract. The platform `libm` is not used, because it differs across vendors.
5. **Canonical NaN.** A single canonical NaN bit pattern is produced; NaN payloads are not observable. NaN and infinity are non-propagating by construction at the type level (arithmetic that can produce them is either a sealed sum forcing exhaustive handling or returns `Result`).
6. **The canonical replay-floating-point lowering.** Both backends (the fast debug backend and the optimizing release backend) must hit one canonical floating-point lowering for any code that is recorded and replayed. Where a release optimization would change a floating-point result, it is disabled for recorded pure code. If a tape is replayed against a backend that cannot reproduce its floating-point results, the runtime emits the stable diagnostic `TAPE_BACKEND_MISMATCH` rather than silently diverging.

The open decision (tracked in `DECISIONS.md` as D9) is the global strategy for satisfying point 6: a single soft-float path everywhere (simplest correctness, a performance cost), a reproducible-fast mode with a proven-equal canonicalization the release backend must match, or a per-build determinism level the program declares. This is one of the highest-leverage next designs.

## Compiler determinism

The compiler itself is deterministic and reproducible. Same source, same flags, byte-identical output, on any machine. This requires: pinned floating-point and const-evaluation, deterministic codegen ordering, the vendored `libm`, no timestamps or absolute paths embedded in artifacts, and a cross-machine object-byte conformance suite that is part of CI. Reproducible builds are a baseline, not a feature.

## Const-evaluation determinism

Compile-time evaluation obeys this contract exactly as runtime does: strict IEEE-754, contraction off, and the evaluator version is hashed into provenance so a result is attributable to the exact evaluator that produced it. Compile-time totality is enforced by a discharged termination measure; the fuel budget is an error budget, not a substitute for a totality proof.

## Metering is fuel-based, never wall-clock

Resource limits (sandboxing, build limits, verification budgets) are expressed as deterministic fuel and allocation budgets, never wall-clock timeouts. A wall-clock timeout would make a type-level or runtime verdict depend on machine speed, which would break determinism. This is why the verification layer uses a deterministic SMT instantiation budget rather than a seconds timeout, and why the security sandbox meters fuel rather than time.

## Enforcement

Every clause here is enforced by the compiler or runtime and carries a stable diagnostic code (the `R####`/`E####` families). The Determinism Contract is part of the conformance suite: a program that violates an assumption this contract depends on (for example, a backend that produces a divergent floating-point result for recorded pure code) fails conformance rather than silently producing a non-reproducible run. "Deterministic by default" is therefore a checked property, not a promise.
