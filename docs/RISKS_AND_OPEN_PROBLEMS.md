# Lumen Risks and Open Problems

Status: draft v0.1. The honest output of the design-deepening workflow's completeness critic. A language this ambitious has real risks and real gaps, and naming them is part of building it well. Nothing here is hidden in optimistic prose; this is the list a skeptical reviewer would write, kept as a living document.

## Top risks

1. **The formal semantics is the single point of failure, and does not yet exist.** Governance now declares that a formal, mechanized operational semantics for the canonical IR is the true normative ground, with the conformance corpus as the witness. The entire correctness story (bootstrap double-compilation, conformance-as-witness, provenance grounding) hangs on that semantics. It is not written. Until it is, "correctness" is underdefined. Mitigation: write the formal core calculus first (see next designs).

2. **The capability + Perceus + affine-non-escape metatheory is an unproven triple-point.** The whole design rests on one invariant being simultaneously (a) inferable by Perceus-style ownership without source annotations, (b) sound under algebraic-effect handlers including multi-shot resumption, and (c) the basis for security's no-ambient-authority guarantee. These three have not been proven to hold together. This is the deepest technical risk. Mitigation: a mechanized proof of the core calculus, with the captured-capability-across-a-handler-boundary case as the explicit hard case.

3. **The zero-legacy constraint is operationally unfalsifiable and is being selectively enforced.** Borrowings are "re-earned" via the authorship benchmark, but the benchmark measures current models, which were trained on legacy languages, so anything that looks like Rust, Python, or ML scores well precisely because it is familiar, not because it is best for AI. The benchmark therefore rewards legacy-familiarity, which is the opposite of the stated goal. The critique flags that `Result`/`?`, traits with coherence, bidirectional checking, structured concurrency, move-only channels, and SMT-discharged refinements are all conventional best answers imported rather than genuinely re-derived. Mitigation: treat "re-earned" as requiring an explicit articulated AI-first argument that does not reduce to "models already know it," and add held-out and metamorphic benchmark shards so familiarity alone cannot pass.

4. **The Determinism Contract over-promises on floating point across two backends.** Requiring both backends to hit one canonical floating-point lowering for all recorded pure code forbids fused multiply-add contraction, reassociation, and vendor-math divergence, which effectively pushes toward a single soft-float path and a real performance cost. This is tracked as decision D9 and as a highest-leverage next design. See `spec/DETERMINISM_CONTRACT.md`.

5. **The total scope is the union of several state-of-the-art systems.** Two production-quality backends, a query compiler, a verified-enough IR, a deterministic record-replay runtime, an SMT layer, and a self-hosting bootstrap together approximate the union of Rust, Koka, Roc, LiquidHaskell, rr/Pernosco, and CakeML. Even granting AI authorship, the integration risk is severe. Mitigation: the walking-skeleton-first plan (a minimal internally-complete subset) so the architecture is validated end to end before breadth is added.

6. **The AI-authorship feedback loop is a moving target that can invalidate frozen decisions.** The language is tuned to current model capabilities, while the grammar is frozen per version for a stationary surface distribution. On a 6-to-18-month horizon these are in tension: model capabilities shift, and a grammar optimized for today's cohort may be wrong for tomorrow's. Mitigation: a specified model-drift and re-pinning protocol (how the blocking open-weight snapshot rotates, how a frozen grammar decision is revisited), and routing model-specific friction to skill guidance rather than grammar changes.

## Remaining legacy assumptions the critique still flags

These survived the synthesis and are kept honestly on the watch list rather than pretended away:

- `Result[T, E]` and the propagation operator are Rust, re-earned only by removing the implicit `From`; the `Result` monad itself (versus error channels via the handler mechanism Lumen already has) is an unexamined import.
- Traits with coherence and orphan rules are Rust/Haskell typeclasses renamed; trait-as-the-abstraction is an inherited answer, not a re-derived one.
- Bidirectional type checking with mandatory boundary annotations is a defensible AI-first choice but is presented as obviously correct; whether current models produce more correct code with full inference or with mandatory annotations is an empirical question that has not been measured.
- Structured concurrency (Trio/Kotlin), move-only channels (Rust/Pony), and the reduction-tree reduce (data-parallel Haskell/Futhark) are each sensible but imported as the conventional best answer.
- SMT-discharged refinement types (LiquidHaskell/F-star/Dafny lineage) assume SMT is the discharge mechanism; an AI-first design might prefer AI-generated, trivially-checkable proof terms.
- The five-tier CST/AST/HIR/MIR/LIR stack is a compiler convention re-justified post hoc.
- WASM/WAT as the bootstrap substrate is chosen for pragmatic availability, not AI-first merit.

## Missing dimensions (to design next)

The 17-dimension sweep did not cover these, and they are real:

- **Numeric tower and numeric semantics.** For a language whose flagship users are quantitative, the integer hierarchy (fixed-width-trap versus range-typed versus arbitrary-precision is currently undecided), decimal types, and the floating-point story need a first-class design.
- **String / text / Unicode model.** The synthesis removed UTF-16 spans but never states what a Lumen string is: encoding, normalization, grapheme handling, the one canonical text type.
- **Time, I/O, and the primordial-capability surface.** The exact set of primordial capabilities at the trusted root, and their deterministic semantics, are referenced but not enumerated.
- **Module system and namespacing semantics** beyond content-addressing: declaration, visibility, public-interface composition, how the frozen public-effect-row normal form serializes.
- **Data serialization, wire format, and schema evolution.** Values, diagnostics, tapes, and IR all need a canonical deterministic serialization with versioning.
- **The AI-consumption documentation format.** The exact machine-readable surface an agent reads to learn the language (the `/lumen` skill, the queryable API, capability discovery).
- **Testing semantics** as a first-class, deterministic, capability-injecting construct: generators, shrinking, bounded-exhaustive, golden tests, and the relationship to the conformance corpus.
- **Observability** (logging, metrics, tracing) as runtime capabilities, distinct from authorship telemetry, and their interaction with the seam-log tape.

## Highest-leverage next designs (in order)

1. **Write the formal core calculus first (lambda-cap):** a tiny mechanized calculus with capabilities-as-values, derived effect rows, the affine scope-bounded non-escape invariant, one-shot and multi-shot handlers, and Perceus-style ownership, with machine-checked proofs of type soundness, purity-implies-no-effects, and capability non-escape. This de-risks the deepest technical question (risk 2) before any breadth is built.
2. **Build the end-to-end walking skeleton (Lumen-mu):** the smallest internally-complete subset that parses, type-checks (bidirectional local), derives one effect row, emits one canonical Diagnostic, lowers to one backend, runs deterministically, and records one tape. Validates the architecture end to end (risk 5).
3. **Fully specify the floating-point / determinism-versus-performance resolution** as a standalone decision (D9): soft-float everywhere, reproducible-fast with proven canonicalization, or a declared per-build determinism level.
4. **Author the canonical Diagnostic schema and the Determinism Contract as executable artifacts**, not prose, with a conformance test asserting no dimension forks them.
5. **Design the Perceus x effect-handler x captured-capability interaction explicitly**, with worked examples and the actual typing and inference rules, since this is the unproven triple-point.
6. **Specify the model-drift / re-pinning protocol** for the authorship loop (risk 6).

This document is updated as risks are retired and gaps are filled.
