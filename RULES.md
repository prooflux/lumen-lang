# Lumen rules: the bandwidth laws that win 2035

Status: operating rules, not a spec. These are the laws that decide whether Lumen
wins the bet in `VISION_2035.md`. They turn the four commitments in
`docs/MANIFESTO.md` and the bandwidth thesis into day-to-day, measured, gated
rules. Every rule has a metric; a rule without a number is a mood. The first three
are the core (the speed laws); the rest exist to protect them so the speed never
costs trust, correctness, or authorability.

The single sentence: **Lumen wins by being the shortest, tightest, most trustworthy
path from a human's intent to a proven running binary, for a model writing it.**
Optimize that path; gate every change on it.

## The three core laws (speed)

### Rule 1: Prompt-to-code speed. Minimize intent-to-green.
The unit of progress is not lines written, it is the distance from a human's
prompt to a compiling, correct program. Drive it down relentlessly.

- Metric: `tokens-to-green` and `rounds-to-green` and `first-try-compile-rate` on
  the authorship benchmark, plus wall-clock intent-to-running-binary.
- Gate: a language or tooling change that raises `tokens-to-green` or
  `rounds-to-green` does not ship without a named, larger win elsewhere.
- Practice: the obvious, clear program should be the one that compiles. Every
  construct earns its place by lowering this number, never by adding surface.

### Rule 2: The hot compiler. LLMs develop at lightning speed because compile is free.
The compiler is always warm and sub-millisecond, so the only latency left in the
loop is the model's own. A confident fix the compiler applies costs the model zero
output tokens and zero round-trips; that is the highest-bandwidth lever in the
whole design.

- Metric: warm `edit-to-diagnostic` p50 (target < 5 ms), and the fraction of
  errors the compiler fixes itself (`fix-application-rate`).
- Gate: the warm path stays sub-millisecond; a change that makes a single compile
  meaningfully slower must justify it (`docs/spec/DETERMINISM_CONTRACT.md`,
  `perf.mjs`). Structured diagnostics and confident fixes are mandatory surface,
  not optional polish.
- Practice: `lumen serve` (the warm daemon) and the MCP server are first-class.
  Author against the warm compiler, never cold `node` calls.

### Rule 3: High bandwidth, both directions, local-first.
Maximize information per token between the local machine and the model, in both
directions. The model sends a patch, not a file; the compiler answers structured
JSON, not prose; the spec rides in context so the model is grounded, not guessing.

- Metric: `tokens-per-construct` under a pinned tokenizer (program-per-context),
  and bytes-per-round in the `lumen serve` span-edit protocol.
- Gate: clarity wins on conflict. We measure lexeme density and review it; a
  token-golf change that hurts the clearer form does not ship.
- Practice: local-first (`/tmp/lumen.sock`), span-edit patches, `check`/`fix`/
  `type`/`effects`/`callers`/`ast` as JSON, and the LLM accessibility layer
  (`FOR_LLMS.md`, a machine-readable spec bundle, `lumen caps --json`, the /lumen
  skill). The model should never pay for a round-trip it did not need.

## The protective laws (so speed never costs the win)

### Rule 4: The authorship benchmark gates every language change.
No change ships that makes Lumen harder for an AI to author correctly, even if all
other tests pass. The benchmark keeps held-out and metamorphic shards so it scores
genuine authorability, never mere legacy-familiarity. This is the rule that
resolves the zero-legacy paradox over time: we train the familiarity in rather
than borrow legacy syntax.

### Rule 5: Trust is the product, not a feature. Determinism and capabilities are non-negotiable.
Speed without trust is just another fast language, and the world already has those.
Every run replays to the bit; the only way to cause an effect is a capability
passed as an ordinary typed parameter; a function with no capability parameters is
provably pure. This is why the speed matters: it is the shortest path to a binary
you can prove and re-run, not merely ship.

- Gate: the native backend and every optimization must produce bit-identical
  output to the reference interpreter on every conformance program
  (`docs/NATIVE_BACKEND_PLAN.md`); reproducible floats by default, `fast` only on
  an explicitly non-recorded path.

### Rule 6: Never regress speed or accuracy (Law P).
Any change, fix, or refactor must measure at least as fast and at least as accurate
as what it replaces. No silent slowdowns, no accuracy traded for convenience.
`perf.mjs` gates compile and interpret throughput every cycle; the native backend
adds a machine-code benchmark gate.

### Rule 7: Zero-legacy and self-contained stay; the bridge is the corpus, not borrowed syntax.
The compiler is one self-contained artifact: no networked package manager, no
network during compile, a single binary. We do not adopt legacy-familiar syntax as
a shortcut to first-try-compile-rate. The bridge to fluency is in-context grounding
now and the Lumen corpus plus reinforcement-against-the-compiler later (the
load-bearing flywheel step). If that bridge underperforms, the accessibility claim
stays aspirational; we do not paper over it.

### Rule 8: Improve the language from how the AI writes it (the loop is the method).
Build with Lumen, hit friction, turn the friction into a failing test, make the
minimal compiler change, prove no speed regression, land it. Every cycle leaves the
language more capable and never slower. Friction is the roadmap; the authorship
benchmark is the judge.

## How the rules compose into the win
Rules 1-3 make Lumen the fastest path from intent to code for a model. Rules 5-6
make that path end in something trustworthy and fast at runtime, so the output is
worth shipping. Rule 4 and 7-8 make the language get better at being authored over
time instead of decaying. Together they aim at the maximal bet in `VISION_2035.md`:
the trust layer and high-bandwidth substrate that every model's code passes through
to be believed and to run fast. Govern these rules with the executable gates in
`docs/GOVERNANCE.md`, so they hold as the project opens to everyone.
