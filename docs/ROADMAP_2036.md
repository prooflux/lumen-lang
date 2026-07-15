# Lumen 2026 - 2036: the decade roadmap

Status: plan of record for the ten-year horizon. `VISION_2035.md` is the destination and the
bets; `docs/ROADMAP.md` is the original phase plan (now largely delivered); `docs/ROADMAP_YEAR1.md`
is the current year's plan of record and is absorbed here as Arc 1. This document is the bridge
between what exists today and the vision, written the way this repo writes everything: an honest
inventory, a gap register, sequenced arcs with exit criteria, and kill criteria so failure is
detected instead of narrated away. Dates are targets, not promises; the gates are the promises.

---

## 1. The starting line (2026-07-13, verified against the tree)

What is real, CI-gated, on main:

- **Self-hosted at full parity.** `lumenc.lm` compiles the seed's entire language surface -
  Int/Text/Float, booleans, arrays, records, sum types, match, `?` - bit-identically to the
  frozen WAT oracle (census 29/29, `SELF: MATCH`, plus a 3,092-program float fuzz, all in CI;
  verified live via `seed/selfhost_diff.mjs`, up from 26/26 as this section was first written).
- **The native fixpoint.** Compiler, optimizer, and C emitter are Lumen programs running as
  native binaries built by the language's own toolchain; a generation-2 compiler rebuilds
  byte-identically. Native compile is ~23x the interpreted path (~59x work-only).
- **Bit-exact numerics.** Float literals, arithmetic, and the math kernel reproduce the oracle
  to the bit in interpreter and native; the pricing kernels (Black-Scholes x2, implied vol)
  are census members compiled by the self-hosted compiler.
- **A serving stack in embryo.** Pure-Lumen HTTP kernels and a table-driven server live on a
  real edge; dynamic handlers with per-request arena reset; opt-in fuel metering; host-keyed
  multi-tenant routing; an event-log state kernel; a 34 KB Node-free native socket binary.
- **Agent-native tooling.** Warm daemon, MCP server (14 tools including native execution),
  structured diagnostics with explain and confident fixes, FOR_LLMS.md and the spec bundle,
  one-line agent-ecosystem packaging.
- **Measurement seeds.** `bench/` has the honesty-gate harness, ULP diff, timing rig,
  compiler-speed rig, and DASHBOARD; `forge/` grows the corpus by differential fuzzing.
- **Open under Apache-2.0** from the first commit, with the free-versus-paid boundary already
  documented (`docs/OPEN_SOURCE_AND_BUSINESS.md`).

What this adds up to: flywheel steps 1 and 2 (self-hosting, native speed) are done or nearly
done. The decade is steps 3, 4, and 5 - batteries, the corpus that resolves the zero-legacy
paradox, and the beachhead - plus the five gates in `VISION_2035.md`.

## 2. The gap register (what the vision requires that does not exist)

Ordered by how load-bearing each gap is. Nothing here is hidden; each maps to work in the arcs.

1. **The effect system is not in the language.** Capability-as-the-only-effect is the product
   thesis - "prove what it can touch" - and today the only capability is `Console`. No derived
   effect rows, no capability set (Clock, Random, FileSystem, Network, and the SaaS set), no
   deterministic fakes versus tainted reals, no handlers, no contracts. Until this lands, the
   trust layer is a design document. The single biggest gap.
2. **True self-containment is not yet met.** The air-gap test fails today: node/npm drive the
   harnesses, wabt assembles the seed, clang compiles the emitted C. The year-1 plan's native
   code generator (Lumen IR to machine instructions, plus an executable writer) and the CI
   purity gate are specified but not built.
3. **The debugger flagship does not exist.** Record/replay, backward stepping, and `why`
   provenance are the debuggability commitment's visible half; none is implemented.
4. **The metatheory is unproven.** The lambda-cap calculus is on paper only; the capability x
   ownership x handler triple-point (RISKS 1 and 2) has no mechanized proof.
5. **Flywheel step 4 has not started.** No corpus pipeline, no reinforcement environment, no
   running authorship benchmark or rounds-to-green rig (the Pillar A rig in the coverage plan
   is designed, not built). This is the keystone bet and it is at zero.
6. **The language floor has holes.** No Bool, no Int arrays or generic elements, no
   first-class functions or closures (handlers and most of the stdlib need them), no modules
   or namespaces, no string/Unicode model, no maps, no float formatter (`print_float`), no
   exponent literals, record fields are read-only.
7. **Batteries are missing.** No canonical formatter, no LSP, no test runner, no package
   manager, no editions mechanism, stdlib near-empty relative to the coverage plan's D1-D20.
8. **The paid layers are unbuilt.** Verify (the oracle as a service), Cloud (prompt to
   deployed verified service), and the certified-kernel catalog exist as plans and as one
   live edge deployment.
9. **Pre-launch legal scaffolding.** CLA/DCO, trademark and certification mark, corpus
   instrumentation with a data-rights notice: named in the business doc as irreversible if
   done late, none evidenced in the repo.

## 3. The five arcs

Each arc has a theme, the work, an exit gate (measurable, CI-checkable where possible), and a
kill-or-pivot criterion. Arcs overlap; the exit gates do not.

### Arc 1 (2026 H2 - 2027): Owes nothing

Theme: finish the year-1 condition - Lumen self-hosted to the metal - and close the language
floor, so everything later is built on a substrate that depends on nothing.

- Native code generator in Lumen (IR to arm64 first, per the R3b notes; x86-64 second),
  register allocation, and the executable writer. clang stays only as a deletion-clocked
  release-build assistant until the Lumen optimizer reaches parity on the bench suite.
- The CI purity gate: the build fails the moment a non-Lumen artifact enters the shipped path.
- Language floor, seed-first then selfhost-lockstep (the proven pattern): Bool, Int arrays /
  generic elements, first-class functions and closures, modules and namespaces, the one
  canonical text type with a decided Unicode stance, maps, `print_float`, exponent literals.
- Memory: a Lumen allocator with reclamation so long-running programs stay flat (the arena
  reset covers services; the compiler and tools need real reclamation).
- Measurement live: the rounds-to-green rig (`bench/promptgreen/`), the authorship benchmark
  running weekly against a pinned open-weight model, DASHBOARD auto-updated, honesty gates
  wired into every "beats X" claim.
- Pre-launch legal: DCO from day one of external contributions, trademark filed, corpus
  instrumentation on with a data-rights notice.
- Content: the oracle-gated self-hosting methodology paper (the credibility artifact).

**Exit gate:** the air-gap test passes - the toolchain builds and runs itself end to end on a
machine containing only Lumen and its named substrate; the purity gate is green in CI; the
language floor items each have census entries; the promptgreen rig produces its first honest
Lumen-versus-Python numbers, whatever they say.

**Kill/pivot:** none. This arc is survival-grade; it only ends done.

### Arc 2 (2027 - 2028): The trust machine

Theme: put the product thesis into the language. This is the arc where "prove what it can
touch and replay what it did" becomes a compiler feature instead of a manifesto sentence.

- Capabilities v1: the primordial set (Console, Clock, Random, FileSystem, Network, Env) plus
  the service set (Http, Sql, Queue, Auth, Tenant, Secret) as ordinary typed parameters;
  purity is provable as "no capability parameters"; deterministic fakes for every capability;
  real ones tainted and quarantined per the determinism contract.
- Derived effect rows in the type surface and in `lumen effects`; the multi-tenant isolation
  claim ("a handler without Tenant cannot touch tenant data") as a type error with a test.
- Record/replay: `lumen run --record`, deterministic tape, backward stepping, and the `why`
  provenance query. The demo that sells the decade: an agent-written service, its proof, and
  its bit-exact replay.
- Contracts v0 (`requires`/`ensures`, runtime-checked, structured C-codes).
- Mechanize the lambda-cap core (soundness, purity-implies-no-effects, capability non-escape),
  one-shot handlers first; multi-shot stays out of the language until its lemma is proven.
- Batteries v1: canonical `lumen fmt`, `lumen test`, the LSP on the same queries, the package
  manager and lockfile, editions mechanism, RFC process live.
- Certified Fast Math lands as compiler passes (FMA, reassociation, minimax with
  certificates), rebased onto the post-parity toolchain; SIMD lowering as a real pass (G1).
- **The public launch** at the undeniable demo: prompt in, verified capability-typed
  multi-tenant service out, with proof and replay, live on the edge. Show HN and the docs
  site happen here, not before.

**Exit gate:** the effect system, record/replay, and contracts are census-covered and gated;
the mechanized core proofs are machine-checked; a stranger can reproduce the launch demo from
the README in under an hour.

**Kill/pivot:** if the triple-point proof fails structurally (not just slowly), narrow the
language: one-shot handlers only, capabilities without general handlers, and say so in
RISKS. The trust claims shrink to what is proven; they never float free of the proofs.

### Arc 3 (2028 - 2030): The corpus resolves the paradox

Theme: flywheel step 4, the load-bearing bet. Stop depending on legacy-trained familiarity;
train the fluency in. Plus the first real money.

- The corpus pipeline: every conformance program, forge output, kernel, and (opted-in) trace
  becomes training data with provenance; the generator that turns specs into task corpora.
- The reinforcement environment v1: generate, structured verdict, reward, at scale - the
  deterministic compiler as the reward function. Fine-tune open-weight models against it and
  publish the deltas, whatever they are (the honesty gate applies to our own keystone bet).
- The prompt-to-green benchmark at full protocol: 100+ frozen tasks, hidden tests, control
  languages, published logs. The vision's numbers (rounds-to-green at half of Python's,
  one-shot-green at twice) are claimed only from this rig.
- Coverage Tiers 1-2 of the universal coverage plan (elementary functions, linalg core, RNG,
  stats, optimization, AD-as-a-compiler-pass as the flagship), each domain gated G1-G8.
- Verify v0 as a product: submit an artifact, get the effect certificate plus the bit replay,
  operated on the self-hosted stack. The finance vertical sells the certified kernel catalog
  (pricing, curves, risk) - the first sustained revenue, funding the rest.
- Cloud v0: the edge grows into "prompt to deployed verified service" for outside users,
  gated on demand signals, not built speculatively.
- Crypto and secure transport in Lumen (the year-1 Q4 stretch realistically lands here):
  primitives against test vectors, then the encrypted handshake, then the public endpoint
  served by one self-built binary.

**Exit gate:** a model measurably improves at Lumen authorship from training against the
environment (published, reproducible); at least one domain tier is DONE by the coverage
plan's definition; Verify or the kernel catalog has paying users.

**Kill/pivot:** if by end-2029 reinforcement against the compiler shows no measurable
authorship gain, the keystone bet is failing: pivot the primary identity to maximal bet 2 -
Lumen as the verified intermediate representation that lowers to legacy targets - where
in-context fluency is enough and the corpus is a nice-to-have. The floor (verified substrate
plus idea-exporter) survives this pivot intact.

### Arc 4 (2030 - 2033): The environment trains the models

Theme: the largest prize, attempted from a position of proof. Plus running everywhere.

- The hosted reward environment for labs: the authorship benchmark, the RL traces, the
  certification of model outputs - operated, with the trace corpus as the moat.
- Lower-to-any-runtime: the verified IR emits WASM, native, TypeScript, Python, Rust. Teams
  adopt Lumen as the provable middle without leaving their stack; the proof travels with the
  artifact. This is what makes "used by everyone" mechanically possible.
- "Lumen-certified" as an operated mark: the conformance suite published so alternative
  implementations exist, the trademark enforcing that the name means the tests.
- Coverage Tiers 3-4 (exact and symbolic math, the applied domains); the parallel/GPU model
  once SIMD-from-the-compiler is old news.
- Foundation formation once (and only once) external companies depend on Lumen.

**Exit gate:** at least one serious external organization trains or evaluates code models
against the environment, or embeds the verified-IR pipeline in production. One is enough;
it converts the story from ours to the industry's.

**Kill/pivot:** if labs build in-house equivalents and the environment cannot win on data
plus trust, sell trust alone: double down on Verify, certification, and the finance vertical
as a durable, smaller business. Named in the business doc as the graceful floor.

### Arc 5 (2033 - 2036): Used by everyone, written by almost no one

Theme: infrastructure. TLS-shaped success: ubiquity through the tools and models everyone
already uses.

- The trust layer as a default stage in agent stacks: the checkers, the certificates, and the
  replay riding inside IDEs, agent frameworks, and CI systems that never mention Lumen on the
  box.
- The machine-to-machine experiment (maximal bet 5): capability-typed, proof-carrying
  components that agents buy, sell, and compose without trust-by-reputation; run it as a real
  marketplace pilot in the finance vertical first.
- Steady state: editions on a slow clock, a boring governance process, the conformance suite
  as the constitution, the language finished in the way TCP is finished.

**Exit gate:** none. This is the steady state the vision calls 2035-if-it-works: the
compiler-as-trainer thesis either became infrastructure or became the best-documented
near-miss in language history, and the docs will say which, plainly.

## 4. The standing disciplines (never stop, any arc)

These are the reason the last three weeks produced seven merged language features with zero
regressions, and they do not relax with scale:

1. **The seed is the oracle, forever.** Every front-end feature lands seed-first, then the
   self-hosted compiler catches up to bit-identity. The census only grows.
2. **Bit-identity or a declared ULP bound, nothing in between** (the hybrid gate from the
   CFM plan). Every value is `exact` or `<= N ULP certified`, and CI checks the matching kind.
3. **The perf gate and Law P.** No change ships slower without a measured, argued reason.
4. **Honesty gates G1-G8 on every claim.** Two false "beats C" numbers already happened; the
   gates exist so the third is real. A number that fails a gate is deleted, not shipped.
5. **The authorship regression gate.** Any change that raises rounds-to-green or lowers
   first-try-compile for the pinned model is a regression, same as a perf loss.
6. **One language change per PR, failing test first.** The census DIFF is the spec.
7. **Corpus instrumentation always on.** No trace is ever lost; the data moat starts at zero
   and only compounds if collection never pauses.
8. **The purity gate** (from Arc 1 on): nothing non-Lumen enters the shipped path, ever.
9. **A verdict flip rides the same PR as its gate.** `bench/scoreboard.json`, `docs/VELOCITY_LEDGER.md`
   where the flip is feature-velocity-tracked, and the row's own prose in whichever of
   `LANGUAGE_COMPARISON.md`, `VISION_2036.md`, or `VISION_2035.md` carries it move together, in one
   changeset, never separately. `tools/scoreboard_gate.mjs --check`'s flip-coupling rule enforces
   this mechanically: a verdict cannot change unless at least one of its cited evidence files
   changes in the same diff, so a claim can never outrun the artifact that earns it.

## 5. The next 90 days (the immediate work packages)

In dependency order, each PR-sized or a short campaign:

1. **Purity gate v0** in CI (inventory what is currently non-Lumen in the shipped path; fail
   on growth; ratchet down). Cheap, and it makes Arc 1 measurable from day one. **Landed** (#49),
   then relaxed to an advisory reporter that inventories and ratchets but never blocks (#56),
   because Lumen is in active development and additions are expected.
2. **Language floor, wave 1:** `print_float` + exponent literals (unblocks honest float
   output everywhere), Bool, Int arrays / generic elements. Seed-first, census lockstep.
3. **Buffered emit output** (the known I/O-bound emit-stage fix; pushes the native pipe
   toward the compile stage's 23-59x).
4. **arm64 codegen spike** from the R3b notes: one function, IR to machine code to a runnable
   Mach-O, oracle-gated. The result decides the Arc 1 codegen plan's shape. **Landed** (#48);
   the codegen plan has since moved further, toward a checked-in C bootstrap of the whole
   native toolchain rather than continued direct arm64 emission (see the note below).
5. **Promptgreen rig v0** (`bench/promptgreen/`): 10 frozen tasks, Lumen versus Python, one
   pinned model, full logs. Publish the first honest numbers even if they are unflattering.
   **Landed** (#50) at the "prove the rig hermetically" stage: 10 frozen tasks and a scripted
   deterministic author exist; a real model and a Python control arm, and the numbers they
   would produce, remain open.
6. **Capabilities v1 RFC**: the primordial set, derived rows, fakes-versus-tainted-reals, and
   the lowering design - written against the mechanization plan so the proof and the
   implementation land aligned. **Landed** (#52) as a design document only, exactly as its own
   status line says; the implementation is Arc 2 work and has not started.
7. **Socket keep-alive reconciliation** (the filed serving-stack follow-up) and LLVM floats
   (keeps the second backend honest until the own-codegen decision retires or repurposes it).
   LLVM floats **landed** (#54, IR ops 29-48, gated bit-identical in CI); the keep-alive
   reconciliation is not separately confirmed in this pass and stays open.
8. **The methodology paper** (oracle-gated self-hosting with agent fleets) submitted; it is
   the credibility floor for every later launch artifact.
9. **DCO + trademark filing + data-rights notice**: the irreversibles, done while they are
   still cheap. DCO and the data-rights notice **landed** (#53: `CONTRIBUTING.md`'s DCO 1.1
   language, `docs/DATA_RIGHTS.md`); trademark filing is a legal action outside the repo and
   its status cannot be verified from the tree.

Beyond this original list, the wasm-removal campaign advanced Arc 1's air-gap goal further
than planned here: the reproducible C bootstrap trio (compiler, #62; emitter and optimizer
together, #64), the native-only compile-and-run backend with its corpus parity gate (R2, #63),
and the resident native compiler server (R3, #65) have all landed. The full air-gap test is
still not green (the purity gate stays advisory, per item 1 above).

## 6. Economics, staged to the arcs

Per the business doc, money arrives smallest-and-earliest to largest-and-latest, each arc
funding the next: Arc 2-3, the certified kernel catalog and Verify v0 in the finance vertical
(needs the least new technology, converts correctness to revenue first). Arc 3-4, Cloud
(prompt to verified deployed service), demand-gated. Arc 4-5, the reward environment for
labs, the largest and least certain prize. The plan degrades gracefully at every stage: if
only the vertical ever pays, it still funds a self-sustaining verified-software business.

## 7. One sentence

Finish owing nothing, put the proof machinery into the language, train the world's models
against the compiler, then let everyone use Lumen without ever writing it - and at every
step, ship only what the gates certify, so that in 2036 the claims and the CI logs are the
same document.
