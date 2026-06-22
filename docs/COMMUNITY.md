# Lumen: Built for Scale and Community

Status: draft v0.1.

A programming language succeeds or fails on its ecosystem, not its grammar. This document is the plan for making Lumen a real open-source project that other people (and other AI agents) can contribute to and build on. The lessons baked in come from how Go, Rust, and Python grew: great tooling out of the box, a clear evolution process, and a low barrier to a first contribution.

---

## 1. Licensing

Recommendation: **Apache License 2.0** for the compiler, standard library, and tooling.

Rationale: Apache-2.0 is permissive (maximizes adoption, allows commercial use) and includes an explicit patent grant (protects contributors and users), which MIT lacks. This is the same choice many modern language projects make. The decision is recorded in `DECISIONS.md`.

The conformance suite is published under the same license so that alternative implementations are legally clear.

---

## 2. Governance

- **Early stage: benevolent maintainer.** A single decision-maker keeps velocity high while the language is small and changing fast.
- **As it grows: an RFC process.** Substantial changes (new syntax, new semantics, standard-library additions) go through a written RFC in `docs/rfcs/`, modeled on Rust RFCs and Python PEPs. An RFC states motivation, the design, alternatives considered, and the migration impact. This makes the language's evolution legible and reviewable, which is itself in the spirit of the language.
- **A core team forms** from sustained contributors, with areas of ownership (front end, type system, backend, standard library, tooling).

The RFC template lives at `docs/rfcs/0000-template.md` (to be added in Phase 0/1).

---

## 3. Evolution without breakage: editions

Languages that cannot change ossify; languages that change carelessly lose their users. Lumen adopts an **editions** mechanism (as Rust does): a program declares the edition it was written against, and the compiler supports multiple editions simultaneously. Backwards-incompatible improvements land in a new edition; old code keeps compiling under its declared edition. This lets the language keep improving for decades without a flag day.

The language and the compiler follow semantic versioning. The conformance suite is the definition of what a given version must do.

---

## 4. Batteries-included tooling (adoption driver)

The strongest single lesson from Go and Rust: ship the tooling with the language, and make it good. A contributor or a user should never have to assemble a toolchain. From early phases, `lumen` is one binary that provides:

| Command | Purpose |
|---------|---------|
| `lumen run` | compile and run |
| `lumen build` / `--release` | native binary (dev / optimized) |
| `lumen repl` | interactive session |
| `lumen fmt` | the one canonical formatter |
| `lumen test` | the test runner |
| `lumen doc` | documentation generator |
| `lumen check` / `--fix` / `--errors=json` | diagnostics, applied or as data |
| `lumen debug` | record-replay time-travel debugger |
| `lumen lsp` | the language server for editors |
| `lumen add` / `lumen lock` | package manager and lockfile |
| `lumen explain E0102` | explain a diagnostic code |

One tool, no configuration required to start, sensible everywhere.

---

## 5. Packages and the registry

- A package manifest (`lumen.toml` or equivalent) declares dependencies with version constraints.
- A committed lockfile pins exact versions for reproducible builds.
- A central registry hosts packages; `lumen add name` resolves and records the dependency.
- Reproducibility is a first-class promise: the same manifest and lockfile produce the same build, everywhere, byte for byte.

The package model is a tool, not part of the language semantics, so it can evolve independently of the language spec.

---

## 6. The AI-native adoption flywheel

This is Lumen's distinctive growth mechanism, and it follows directly from the design.

1. Lumen ships a **machine-readable specification bundle**: the grammar, the type rules, the diagnostic code registry, and the standard-library signatures, all as structured data, not just prose.
2. Lumen ships a **Claude Code `/lumen` skill** (and equivalent tool definitions for other agents) so any AI agent can generate correct Lumen and self-correct against the structured diagnostics.
3. Because the structured-diagnostic correction loop converges quickly, agents produce correct Lumen reliably. That lowers the cost of writing Lumen libraries.
4. More libraries make Lumen more useful, which attracts more users and more agents, which produces more libraries.

The same properties that make the language AI-legible make it the easiest language for an agent to contribute to. The community includes both humans and agents, and the contribution experience is designed for both: structured issues, a conformance suite anyone can run, machine-applicable fixes, and good-first-issues labeled and scoped.

---

## 7. Lowering the barrier to a first contribution

- A **web playground** (via the WASM target) lets anyone try Lumen with zero install. This is consistently one of the highest-leverage adoption tools a language can have.
- The **conformance suite is public and runnable** by a single command, so a contributor can verify their change.
- **Good-first-issues** are scoped to a single pass or a single diagnostic, which the stable pass contracts make tractable.
- **The structured-error design helps newcomers**, human or agent, exactly as it helps everyone else: the compiler tells you precisely what is wrong and often how to fix it.

---

## 8. Where the project lives

For now the project is developed inside this monorepo at `projects/lumen/`. When it reaches a public-readiness milestone (around Phase 5), it is spun out into its own dedicated open-source repository with its own issue tracker, RFC process, registry, and documentation site. The roadmap notes this transition; nothing in the design assumes a monorepo.
