# Lumen Roadmap

> **Current status (2026-07-03): the self-hosting fixpoint is reached.** The phase plan below
> is the original design-era roadmap, kept as the plan of record; the project has since moved
> far faster than its phase numbering. Where things actually stand:
> - **Phase 1-3 (seed, front end, run):** DONE. The pure-WAT seed (`seed/lumenc.wat`) lexes,
>   parses, type-checks, and runs the full Lumen-mu corpus deterministically, with structured
>   diagnostics and the MCP/daemon feedback loop live.
> - **Phase 4 (native backend):** substantially delivered as *Lumen-written* backends: a C
>   emitter (`native/emit_fn.lm`) and an LLVM emitter (`native/emit_llvm.lm`), both gated
>   bit-identical to the interpreter, plus a Lumen-written optimizer (`native/optimize.lm`)
>   that now optimizes the compiler itself. Remaining: the native fixpoint (run `lumenc.lm`
>   through the backends so the compiler runs natively and the seed retires).
> - **Phase 6 (self-hosting):** its exit criterion, **byte-identical self-compilation**, is
>   ACHIEVED and CI-gated (`seed/selfhost_diff.mjs` reports `SELF: MATCH` on every commit;
>   the generation-closure theorem in `../research/drafts/lumen-oracle-gated-self-hosting/`
>   lifts that per-commit check to all bootstrap generations at once).
> - **Beyond the plan:** a deterministic differential fuzzer that grows the oracle corpus
>   (`forge/`), deterministic profiling, and a formal research core (theorem + pre-registered
>   experiment + tagged claims inventory).
>
> The living, per-commit narrative is `../SELFHOST_CAMPAIGN_LOG.md`; the exact runnable
> language is `../LANGUAGE.md`.

Status: draft v0.1. This roadmap is deliberately honest about scope. Building a self-hosting, natively compiled language with its own toolchain is a multi-phase effort measured in many months to years, even with heavy AI assistance. The phases below each have a concrete exit criterion so progress is verifiable rather than vibes.

The development method throughout is conformance-test-driven (see `DESIGN.md` section 10): a feature lands as RFC, spec change, conformance tests, then implementation that turns those tests green.

---

## Phase 0: Foundations (this phase, design)

Goal: a complete, reviewed design and the scaffolding to build against.

- [x] Vision and design principles (`DESIGN.md`).
- [x] Draft grammar for the v0.1 core (`GRAMMAR.md`).
- [x] Debuggability model (`DEBUGGABILITY.md`).
- [x] Community and scale plan (`COMMUNITY.md`).
- [x] Open-decisions register (`DECISIONS.md`).
- [x] Adversarial multi-agent design deepening (17 dimensions) integrated into `spec/SYNTHESIS.md`, `spec/DETERMINISM_CONTRACT.md`, `RISKS_AND_OPEN_PROBLEMS.md`.
- [x] Name resolved (Lumen), bootstrap resolved (zero-legacy, D3), through-lines resolved (D8), core-first sequencing resolved (D10).
- [ ] Seed conformance suite: a corpus of v0.1 programs with expected outputs and expected diagnostic codes.

Exit criterion: the resolved decisions are recorded and the conformance suite has its first programs.

---

## Phase 0.5: Formal foundations (de-risk before breadth)

Per decision D10 and the highest-leverage-next-designs list in `RISKS_AND_OPEN_PROBLEMS.md`, the deepest technical questions are settled with mechanized proof before broad implementation, because the whole design rests on one unproven metatheory triple-point.

- [x] **lambda-cap core calculus** drafted (`spec/LAMBDA_CAP.md`): syntax, effect-row typing (derived not declared), operational semantics with one-shot handlers, the affine capability-non-escape rule (region-no-escape on `handle`), Perceus drop, and the four theorems (soundness, purity, non-escape, determinism) with proof sketches and obligations. On-paper; mechanization pending.
- [x] **Floating-point determinism strategy (D9)** resolved: declared determinism level, `reproducible` default (canonical FP), explicit `fast` opt-in forbidden on recorded paths.
- [x] **Lumen-mu defined** (`spec/LUMEN_MU.md`): the minimal internally-complete subset (grammar, bidirectional local checking, what is excluded), its A-normal-form IR, the canonical Diagnostic instance, and a lowering example.
- [x] **WAT seed architecture** (`seed/ARCHITECTURE.md`) with a runnable dispatch-loop sketch, memory layout, the single Console seam import, the trusted computing base, and the discard plan.
- [x] **Conformance seed** (`conformance/`, `mu/examples/`): fib, safe_div, propagate, with expectations.
- [ ] **Mechanize the lambda-cap proofs** in a proof assistant (verification meta-tool, not a Lumen dependency; tool TBD), Theorem 3 under multi-shot resumption first (the riskiest lemma).
- [ ] **Determinism Contract and Diagnostic as executable schemas** (not just prose), with a conformance test asserting no dimension forks them.

Exit criterion: the lambda-cap soundness and capability-non-escape proofs are mechanized; the Determinism Contract and Diagnostic schema are executable and conformance-gated. (D9 resolved; Lumen-mu, its IR, and the seed plan are drafted.)

---

## Phase 1: Bootstrap front end (lex, parse, format)

> Stage-0 progress: the WAT seed interpreter (`seed/seed.wat`) is implemented and RUNS. It executes the Lumen-mu IR for `fib(10)` to `55` end to end through the single `Console` seam (`seed/README.md`, `node run.mjs`). Next seed increment: boxed values (sum, `Text`, `Result`) so `safe_div.lm` and `propagate.lm` run; then write the Lumen-mu compiler in Lumen-mu.

Goal: a Stage 0 tool that can read v0.1 source, build the CST and AST, and format it canonically.

- Lexer producing tokens with spans and preserved trivia.
- Parser producing a lossless CST and an AST, with structured syntax diagnostics (`E0xxx` syntax family).
- `lumen fmt`: canonical formatter (the single valid formatting).
- `lumen ast --json`: structured AST output.
- Conformance: every v0.1 grammar construct round-trips through fmt to a fixed point.

Exit criterion: `lumen fmt` is idempotent on the whole example corpus, and `lumen ast --json` matches expected trees.

---

## Phase 2: Semantic core (resolve, type-check, effects)

Goal: the program is understood, not just parsed.

- Name and scope resolution.
- Type inference and checking (local inference, the system in `DESIGN.md` section 3).
- Exhaustiveness checking for `match`.
- Effect and capability checking.
- The structured diagnostic engine with the stable code registry and confident-fix support (`lumen check --errors=json`, `lumen check --fix`).
- Query interfaces: `lumen type file:L:C`, `lumen effects fn`, `lumen callers fn`.

Exit criterion: the negative conformance suite (programs that must fail) produces exactly the expected diagnostic codes at the expected spans, and the positive suite type-checks clean.

---

## Phase 3: Lowering, interpretation, and the debugger

Goal: run programs, deterministically, with record and replay. A tree-walking or MIR-interpreting executor is acceptable here; native codegen is Phase 4. This gets us to "it runs and is debuggable" fast.

- Lowering HIR to MIR (typed SSA).
- A deterministic MIR interpreter (the executor for `lumen run` before native codegen exists).
- The capability runtime (`FileSystem`, `Clock`, `Random`, `Console`, `Network`, `Env`) with deterministic fakes for testing.
- Record and replay: `lumen run --record`, `lumen debug` with forward/backward stepping.
- Provenance: the `why` query over the trace.
- Contracts (`requires`/`ensures`) checked at runtime with `C####` diagnostics.

Exit criterion: every program in the positive conformance suite runs and produces expected output; the debugger can answer `why` queries on a chosen set of debugging scenarios.

---

## Phase 4: Native backend (the fast binary)

Goal: compile to a standalone native binary. This is where "eliminate bottlenecks" is delivered.

- MIR optimization passes (inline, const-fold, DCE, devirtualize).
- Move/borrow/ARC analysis (per the memory-model decision).
- Dev backend (fast compile) for `lumen build`.
- Release backend (optimizing) for `lumen build --release`.
- Static linking; single-file binaries for `x86-64` and `aarch64`.
- Reproducible builds (byte-identical output from identical input).

Exit criterion: the example corpus compiles to native binaries that pass the conformance suite, and a benchmark set demonstrates competitive native performance.

---

## Phase 5: Standard library and tooling completeness

Goal: enough library and tooling that real programs (including the next-phase self-hosted compiler) can be written.

- Standard library: collections, text, math, the capability interfaces, structured-error helpers, JSON.
- `lumen test`: the test runner.
- `lumen doc`: documentation generator from `#:` doc comments.
- `lumen lsp`: the language server (built on the same incremental queries).
- The package manager and lockfile format (design in `COMMUNITY.md`).
- WASM target for the web playground.

Exit criterion: a non-trivial real program (for example, a portion of the compiler's own front end) is written in Lumen and passes its tests.

---

## Phase 6: Self-hosting

Goal: the toolchain becomes our own.

- Rewrite the compiler in Lumen.
- Stage 0 compiler compiles the Lumen-written compiler.
- The Lumen-written compiler compiles itself and reproduces a byte-identical binary (the bootstrap fixpoint).

Exit criterion: byte-identical self-compilation. This is the milestone at which Lumen is a real, self-sustaining language.

---

## Phase 7: Ecosystem and scale (ongoing)

Goal: a living open-source project.

- Public package registry and `lumen add`.
- RFC process live (`docs/rfcs/`), editions mechanism for non-breaking evolution.
- Conformance suite published so alternative implementations are possible.
- The Claude Code `/lumen` skill and a machine-readable spec bundle so any agent can target Lumen correctly.
- Web playground for zero-install trial.

Exit criterion: there is no single exit; this phase is the steady state of a healthy language.

---

## Long-horizon (Phase 8, optional): backend independence

Replace the external codegen backend with an in-house one so the toolchain has no third-party dependency in the codegen path. This is a multi-year stretch goal and is explicitly optional; until then, relying on a world-class external optimizer for release builds is the correct tradeoff.

---

## Honest scope statement

The phases above are sequenced, but Phases 1 through 3 can be reached relatively quickly because they target an interpreter-backed executor, not native code. Phase 4 (native backend) and Phase 6 (self-hosting) are the heavy ones. Anyone reading this roadmap should understand that a usable, runnable v0.1 (Phases 1 through 3) is a meaningful early milestone, and that "your own complete toolchain with a native binary and self-hosting" is the destination of a long road, not a weekend.
