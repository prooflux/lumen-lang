# Governance: open to everyone, controlled by the conformance suite

Status: governance plan. Companion to `docs/OPEN_SOURCE_AND_BUSINESS.md` (licensing
and the free-versus-paid line) and `docs/COMMUNITY.md` (contribution mechanics).
Those answer "who may use and sell what." This answers the harder question for a
language meant to be used by everyone: **as adoption opens up, who decides what
Lumen IS, and how do we stay one language instead of fragmenting into dialects?**

The answer is the project's character, applied to itself: **govern the language by
governing the tests.** Rough consensus and running tests. The executable artifacts,
not a committee's prose, are the source of truth, and the project controls those
artifacts even as the code is given away.

## The principle
The language is open and permissive (Apache-2.0): anyone may read, fork, embed,
re-implement, or ship Lumen inside their own tool or model. That openness is the
adoption strategy and the corpus engine, and it is deliberately irreversible. What
stays governed is not the code (you cannot fence code) but the **definition**: an
executable specification that says, precisely and mechanically, what counts as
Lumen. Adoption is free; identity is earned by passing the tests.

## The four control artifacts (the correctness moats)
These are distinct from the business moats in `OPEN_SOURCE_AND_BUSINESS.md` (data,
cloud, brand). They are the technical control points that keep the open language
coherent.

1. **The conformance suite** (`conformance/`, `seed/basics.mjs`, the spec tests):
   the executable definition of the language. A change to the language IS a change to
   the conformance suite. An implementation that passes it behaves like Lumen by
   definition; one that does not, does not, whatever it calls itself.
2. **The determinism contract** (`docs/spec/DETERMINISM_CONTRACT.md`): every
   conforming implementation and backend must produce bit-identical, replayable runs.
   The interpreter is the reference oracle; the native backend is diffed against it
   on every program (`docs/NATIVE_BACKEND_PLAN.md`). Determinism is what makes the
   suite a sharp definition rather than a fuzzy one.
3. **The authorship benchmark**: gates every language change. Nothing ships that
   lowers how well an AI authors Lumen, even if all other tests pass. Held-out and
   metamorphic shards keep it honest (`RULES.md` rule 4). This is governance over the
   one property that decides the bet, not just over syntax.
4. **The performance gate** (`perf.mjs`, plus the backend benchmark): no change
   regresses speed or accuracy (Law P, `RULES.md` rule 6).

Owning and evolving these four, deliberately and by review, is what governing Lumen
means. They are kept in the open repo, under CODEOWNERS, changed only through the
RFC process.

## What "Lumen" means: the conformance badge
Anyone may implement or embed Lumen. Only an implementation that **passes the
published conformance suite** and is **granted the trademark** may call itself
"Lumen" or "Lumen-certified." This is the Certificate Authority / spec-plus-test
model that let WebAssembly, C, and the web platform have many implementations and
remain one language; it is how Rust, Python, and Java license code permissively while
keeping the name coherent. The trademark is never granted by the source license
(consistent with `OPEN_SOURCE_AND_BUSINESS.md`); it does double duty as the open
conformance badge and the commercial certification mark.

The result is the property the vision needs: Lumen can be **used by everyone** (any
tool, any model, any fork) without becoming **many incompatible Lumens**, because the
suite is the single arbiter and the name follows the suite.

## How changes are decided
- **RFC process** (`docs/rfcs/`): any substantive language or contract change opens
  an RFC. A language RFC must include the conformance-suite delta and the authorship-
  benchmark impact; an RFC that cannot express its change as test deltas is not ready.
- **Stewardship now, foundation later.** Today a benevolent dictator (the author)
  with a welcoming CONTRIBUTING and RFC flow; a neutral foundation when multiple
  organizations depend on Lumen and need one (timing per `OPEN_SOURCE_AND_BUSINESS.md`
  section 5). The control artifacts are what a future foundation would steward.
- **CODEOWNERS over the control artifacts.** The conformance suite, the determinism
  contract, the authorship benchmark, and the perf gate require owner review to
  change. Ordinary library and docs contributions do not; the gate is on the
  definition, not on participation.
- **Editions, not breakage** (`docs/COMMUNITY.md`): the language evolves through
  editions so old programs keep compiling; the conformance suite carries each
  edition. Evolution never silently invalidates the corpus.

## Community and agents are first-class, and the gates are why that scales
Contributions land by pull request and must pass the four gates. Because the gates
are **executable and deterministic**, correctness review does not bottleneck on
human attention: the tests decide. That is what lets development scale with a fleet
of agents plus humans (the manifesto's self-improvement loop), at a rate a human-only
community cannot match. Agents are first-class contributors precisely because the
authorship benchmark makes "can an AI write this well" a measured, gating property.
Every authored program also feeds the corpus (with a clear data-rights notice), so
participation and the data moat grow on the same axis (`OPEN_SOURCE_AND_BUSINESS.md`
section 7).

## The bright line, restated for governance
- **Community / foundation governs the open language:** the spec, the compiler and
  toolchain, the standard library, the conformance suite, the determinism contract,
  the authorship benchmark, and the conformance badge.
- **The company owns the operated layers:** Lumen Cloud, the hosted Verify oracle at
  scale, the trace corpus as a product, and the finance vertical. These are not
  governed by the community and are not strip-mineable (the data and certification
  trust are not forkable).
The trademark is the hinge: open conformance badge on one side, commercial
certification on the other. Same mark, one authority, never in the code license.

## Anti-fragmentation guarantees (the irreversible promises)
1. **Never relicense the open core.** Retroactively closing community-built core is
   the one move that forks the community (the Terraform/OpenTofu lesson). The core
   stays Apache-2.0, forever.
2. **The conformance suite is the single source of truth.** A fork that diverges in
   behavior simply is not Lumen; it cannot use the name or the badge. Forks are
   welcome; dialects-calling-themselves-Lumen are not.
3. **Determinism is the test that makes the others enforceable.** Without bit-exact
   replay, "passes the suite" is fuzzy; with it, conformance is a yes/no fact.
4. **The authorship benchmark protects the bet.** No optimization for humans,
   vendors, or short-term metrics may degrade AI authorability past the gate.

Settle these and Lumen can open to the whole world and still be one language: free to
adopt, impossible to fragment, governed by tests that anyone can run and only the
project can change.
