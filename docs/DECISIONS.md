# Open Decisions (ADR register)

Status: draft v0.1. These are the decisions where reasonable engineers disagree and where a wrong default is expensive to reverse. Each is an ADR (Architecture Decision Record): options, recommendation, reasoning, reversibility. Two of the original four blocking decisions are now RESOLVED; two are deliberately kept OPEN with deepened analysis, because they are Phase 4 (backend) concerns and do not block the Phase 1 to 3 front end.

---

## D1 (RESOLVED): Name and identity

- **Decision:** The language is **Lumen** (chosen by the project owner). File extension `.lm`. CLI binary `lumen`.
- **Reasoning:** A lumen is the SI unit of luminous flux, the measure of visible light. The metaphor fits the language's defining pillar precisely: Lumen exists to make a program fully visible. Every error is a structured object you can read, every value's origin is recoverable through the provenance `why` query (`DEBUGGABILITY.md`), and every effect a function can have is declared in its signature. Nothing is hidden; the language brings the program into the light. The extension `.lm` is short, in the spirit of the brief's "Make / `.mk`" preference. Collision note: "Lumen" is also a large telecom (Lumen Technologies) and other products; in the programming-language namespace the name is free, but a public launch should confirm trademark and domain availability.
- **Reversibility:** Cheap now (a rename), expensive after a public launch, hence resolving it before any code.

---

## D2 (OPEN, deepened): Memory model

Kept open by request, with the instruction to think hard about what is best for an AI-authored language over the long run. The analysis below is the basis for a later, deliberate decision (it does not block Phase 1 to 3; it must be settled before Phase 4, the native backend).

### What "best for an AI language, long run" actually optimizes

An AI-authored, AI-debugged, natively compiled language weights the criteria differently than a human-first language does:

1. **Generatable correctly without nonlocal reasoning.** The model should not have to track lifetimes or aliasing across a function boundary to satisfy the compiler. Nonlocal constraints are the single biggest source of model failure. This argues strongly against surfacing manual ownership and borrowing in the source.
2. **No surprise pauses, predictable performance.** The "eliminate bottlenecks / fast native binary" goal argues against a tracing garbage collector with stop-the-world pauses and against nondeterministic collection timing (which also weakens the determinism guarantee that the debugger depends on).
3. **Deterministic destruction.** Determinism is a core pillar. Deterministic, eager reclamation (an object is freed at a well-defined point) is far better for the record-replay model than a tracing collector that runs whenever it wants.
4. **The compiler can be smart, because the compiler is also built by AI and is improvable.** We can afford a sophisticated analysis pass that infers ownership the source never spells out, because that pass is itself part of the toolchain we are building and can keep improving.

### The synthesis these point to

**Surface ergonomics of a managed language; runtime performance of a manually managed one; achieved by the compiler inferring ownership the programmer never writes.**

Concretely: value semantics with automatic reference counting as the model the programmer (human or AI) sees, with no lifetime annotations anywhere in the source, plus an aggressive compiler analysis that:

- elides reference-count increments and decrements when it can prove a value does not escape (so most refcount traffic disappears),
- promotes non-escaping allocations to the stack,
- reuses memory in place when a value is uniquely owned and about to be overwritten (the optimization that makes functional-style updates fast),
- and handles cycles explicitly (weak references in the type system, or an opt-in cycle collector), since pure reference counting leaks cycles.

This is not hypothetical; it is where the research frontier already is, and citing the prior art keeps the decision honest:

- **Perceus reference counting (Koka language).** Precise, compiler-inserted reference counting with reuse analysis that achieves performance competitive with manual management, while the source has no lifetime annotations. This is the closest existing model to what Lumen wants.
- **Roc language.** Opportunistic in-place mutation driven by uniqueness/ownership inference, with a fully managed surface. Demonstrates the "looks managed, runs like manual" target.
- **Vale's generational references.** A different safety mechanism (generation checks) that avoids both a borrow checker and a tracing GC; relevant as an alternative safety strategy.
- **Mojo / Swift.** Ownership and ARC with value semantics; Swift shows ARC at production scale, Mojo shows ownership inference aimed at performance.

### The three named options, scored against the long-run criteria

- **Tracing GC.** Best raw generatability (the model never thinks about memory), but loses on predictable performance, deterministic destruction, and determinism-of-timing. Weakens the debugger. Rejected as the primary model for those reasons, though a GC could be a fallback for cyclic data.
- **Manual ownership and borrowing (Rust-style, surfaced).** Best performance and compile-time safety, worst generatability (the nonlocal lifetime calculus is exactly what models fail at, and exactly what fights the clarity pillar). Rejected as a *surface* model.
- **Inferred ownership over an ARC value-semantics surface (Perceus/Roc-style).** Recovers most of the performance of manual management while keeping the surface free of lifetimes. Best fit for the long-run criteria. This is the leaning.

### Leaning (not yet final)

Adopt the **inferred-ownership-over-ARC** model: the source has value semantics and no lifetime annotations, and a Perceus-style analysis pass recovers performance. Keep an explicit, clearly-marked escape hatch for arena/region allocation on hot paths. Validate the performance claim with a prototype on representative workloads before locking it in at Phase 4. Cycles handled via weak references first, with a cycle collector considered only if needed.

- **Reversibility:** Very expensive once the backend and analysis exist. Hence: keep open, prototype, decide before Phase 4.

---

## D3 (REVISED, RESOLVED): Bootstrap and self-hosting with zero legacy languages

This decision was previously "Stage 0 host = Rust". The **zero-legacy** directive (no legacy programming language is part of Lumen's identity or shipped toolchain) overrides that. Rust is rejected as a host.

- **Decision:** Lumen is **self-hosting in identity from day one**. The compiler, standard library, and all tooling are written in Lumen. There is no legacy high-level host language. The one unavoidable bootstrap seed targets a **low-level substrate** (a compilation target, not a programming language: WebAssembly text format / WAT, or LLVM IR), and the seed is **discarded** at the self-hosting fixpoint. The only persistent external dependency is the code-generation substrate (D4), which is a target, not a language.
- **Why a substrate is not a legacy language:** WASM and LLVM IR are compilation targets that any compiler must ultimately emit to reach the machine. Targeting them is not "writing Lumen in another language"; it is the irreducible act of producing executable code. Honoring "zero legacy" means no C/C++/Rust/etc. source is part of Lumen, which this satisfies.
- **Seed mechanism (choose at Phase 1, both are "by AI"):**
  1. **AI-as-bootstrap-compiler.** Define Lumen-0, the minimal subset needed to express the Lumen compiler. The Lumen compiler is written in Lumen-0/Lumen. To run it the first time, Claude lowers a minimal Lumen-0 executor directly to the substrate (WAT or LLVM IR). That throwaway executor runs the Lumen-written compiler, which compiles itself to native. Seed discarded.
  2. **Metacircular seed.** A tiny Lumen-0 interpreter, hand-lowered once to WAT, runs the Lumen compiler; same fixpoint.
- **Verifying the hand-produced seed:** the seed is tiny by construction, is checked against the executable language spec and the conformance suite, and is subjected to adversarial verification (multiple independent agents re-deriving and attacking it). Crucially, once self-hosting is reached, the native Lumen compiler re-compiles itself to a **byte-identical** binary (the bootstrap fixpoint), which is strong evidence the whole chain is correct, regardless of how the seed was produced.
- **Honesty note:** this path is harder and slower than bootstrapping in Rust. The ultracode directive ("remove all boundaries and blockers", token cost not a constraint) accepts that cost in exchange for purity. The risk is bounded by keeping the bootstrap subset minimal and relying on the self-compilation fixpoint as the final correctness check.
- **Reversibility:** The seed is disposable by design, so the seed mechanism is low-risk to change. The "no legacy host" identity is the permanent commitment.

> Note: the design deepening workflow (`lumen-design-deepening`) explores this dimension adversarially; its synthesized recommendation refines the seed mechanism above.

---

## D4 (OPEN, deepened): Codegen backend strategy

Kept open by request, to pick what is best for the language rather than what is expedient. Does not block Phase 1 to 3 (which target an interpreter-backed executor). Must be settled at Phase 4.

### Options against the language's goals

- **LLVM only.** Best optimization (the fastest shipped binaries), broadest target coverage, mature. Costs: slow compile times (hurts the dev loop while the compiler is being built and while users iterate) and a large, heavy dependency.
- **Cranelift only.** Very fast compile times (great dev loop), simpler, pure-Rust (clean dependency for the Stage 0 host). Costs: less aggressive optimization, so shipped binaries are not as fast, which fights the "eliminate bottlenecks" goal.
- **Cranelift for debug, LLVM for release (both over the same MIR).** Fast iteration while building and while developing, plus a maximally optimized release binary. Costs: two backends to maintain against one IR contract.
- **Custom backend now.** Full toolchain independence immediately. Cost: an enormous effort that would stall the entire language; not justified before the language even runs.

### Why this is the most reversible of the four

The MIR-as-contract design (`DESIGN.md` section 8) exists precisely so a backend is a swappable consumer of a stable, typed, SSA IR. A backend can be added or replaced without touching the front end, the type system, or the semantics. That is what makes "start with one, add or replace later" safe here, and it is why this stays open with low risk.

### Leaning (not yet final)

**Cranelift for debug builds, LLVM for release builds**, both consuming the same MIR, with a custom in-house backend reserved as the optional Phase 8 stretch goal for full independence. This serves the two goals that pull in opposite directions: a fast loop while the language is being built, and a fast binary once it ships. Confirm at Phase 4 against real compile-time and runtime-performance measurements.

- **Reversibility:** Highest of the four (the MIR contract isolates it).

---

## D5 (recommendation): License

- **Recommendation:** Apache-2.0 (permissive plus an explicit patent grant). See `COMMUNITY.md`. Low controversy; confirm before the first public release.

---

## D6 (deferred): Concurrency model

- Deferred to a dedicated RFC after the sequential core self-hosts. Deterministic concurrency is genuinely hard and deserves its own design. The sequential core is fully deterministic in the meantime.

---

## D7 (revised in synthesis): Integer / arithmetic fault semantics

- **Decision:** Arithmetic faults reachable from untrusted input (overflow, divide-by-zero) live on the `Result` plane by construction, so a single adversarial integer cannot abort a process. Named `wrapping`/`saturating`/`checked` variants exist for hot paths. Where range-typed integers apply, overflow becomes a construction-time type error (removing the covert-timing channel). This unifies the previously asymmetric overflow=panic / div=Result behavior. The numeric tower (fixed-width vs range-typed vs arbitrary-precision) is a missing dimension to design next (see `RISKS_AND_OPEN_PROBLEMS.md`).

---

## D8 (RESOLVED in synthesis): The two through-lines

- **Decision:** Lumen has exactly two load-bearing through-lines that every dimension references rather than re-inventing: (1) the **Determinism Contract** (`spec/DETERMINISM_CONTRACT.md`), and (2) the **canonical Diagnostic** (one generated, schema-versioned, typed-args structure; `spec/DIAGNOSTIC_SCHEMA.md` to be authored as an executable schema). A third unifier, the **capability**, is the single mechanism for effects, authority, purity, and determinism classification. No dimension may fork the Diagnostic or re-assert determinism locally; conformance verifies no fork. See `spec/SYNTHESIS.md`.

---

## D9 (RESOLVED): Floating-point determinism strategy

- **Question:** how do two backends satisfy one canonical floating-point lowering for recorded pure code (the single biggest cross-cutting risk)?
- **Decision:** option (c), a declared determinism level, with **`reproducible` as the default**. In `reproducible` mode (the default for every build and for all recorded pure code) the backend must hit the canonical lowering: strict IEEE-754, no FMA contraction, no reassociation, vendored libm, canonical NaN. A module or build may opt into `fast` explicitly, which permits backend-specific FP optimization, but `fast` is forbidden for any code that is recorded into a tape (the compiler rejects `fast` on a recorded path with a diagnostic), so replay determinism is never silently lost. This is what serves the quant target users: risk and pricing numbers default to bit-reproducible across machines and backends, while a Monte Carlo hot loop can be marked `fast` when its results are not part of a replayed trace.
- **Enforcement:** the determinism level is part of the build/module manifest; mixing a `fast` value into a recorded computation is a static error; a replay against a backend that cannot reproduce a tape's FP results yields `TAPE_BACKEND_MISMATCH` rather than diverging. See `spec/DETERMINISM_CONTRACT.md`.
- **Note:** Lumen-mu (the bootstrap subset) has no floating point at all, so the seed and self-hosting path are unaffected by this decision; it binds only the eventual native backend.

---

## D10 (RESOLVED, sequencing): Formal core calculus before breadth

- **Decision:** Before broad implementation, write **lambda-cap**: a tiny mechanized core calculus (capabilities-as-values, derived effect rows, the affine scope-bounded non-escape invariant, one-shot/multi-shot handlers, Perceus ownership) with machine-checked proofs of type soundness, purity-implies-no-effects, and capability non-escape. This de-risks the deepest open metatheory question (the capability x Perceus x handler triple-point) before the architecture is committed. The mechanized operational semantics of the canonical IR is the normative ground; the conformance corpus is its witness. See `RISKS_AND_OPEN_PROBLEMS.md` next-designs list.

---

## Decision status summary

| ID | Topic | Status | Decision / leaning |
|----|-------|--------|--------------------|
| D1 | Name | Resolved | Lumen, `.lm`, CLI `lumen` |
| D2 | Memory model | Open (strengthened) | Perceus inferred-ownership refcount; acyclic value world + explicit `Graph` arena; unified affine `Resource` layer; prototype before native backend |
| D3 | Bootstrap (zero legacy) | Resolved | Self-hosting identity; two-seed three-stage WAT/Lumen-mu bootstrap; byte-identity gate over a deterministic artifact only; NO legacy host language |
| D4 | Backend | Open (deepened) | Leaning: Cranelift (debug) + LLVM (release) over one MIR |
| D5 | License | Recommendation | Apache-2.0 toolchain, CC0 spec/corpus/schemas |
| D6 | Concurrency | Semantics specified, surface deferred | Deterministic scheduler (pure over program + log); move-only channels; nursery; typed `relaxed` mode |
| D7 | Arithmetic faults | Revised | Untrusted-reachable faults on the `Result` plane; range-typed where applicable; numeric tower TBD |
| D8 | Through-lines | Resolved | Determinism Contract + canonical Diagnostic + the capability; no forks |
| D9 | FP determinism | Resolved | Declared level; `reproducible` default (canonical FP), explicit `fast` opt-in forbidden on recorded paths |
| D10 | Formal core first | Resolved (sequencing) | lambda-cap mechanized calculus + proofs before breadth |

D2 (memory) and D4 (backend) remain open and do not block the front end; they are settled before the native backend. D9 is resolved. The lambda-cap core calculus (D10) is drafted in `spec/LAMBDA_CAP.md`; mechanizing its proofs is the highest-leverage remaining formal work.
