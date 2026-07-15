# Lumen in 2036: surpassing Python on every dimension a machine measures

Status: strategic document, not a spec. This is the competitive companion to `VISION_2035.md`. That document is the honest ten-year strategy and the floor the project is nearly guaranteed to find useful. This one states the target the mandate demands and refuses to soften it: beat Python, by a lot, on every dimension, and say exactly how and by what number. Python is the incumbent Lumen has to reason about, because it is what models write most and what the beachhead (quant and finance) already runs on. Beating it is not tribal and not a mood; it is the design specification, and this file is how the specification is scored.

## The scoring rule (the honesty gate, carried over from 2035)

"Beat Python by a lot in all dimensions" is a testable claim only if each dimension is scored. Every row below resolves to one of three verdicts, and never to a boast a referee could puncture:

- **Won by design.** Lumen's architecture wins the axis, and Python's cannot follow without ceasing to be Python. Gated by a number that already exists or is specified.
- **Winnable, gated, open.** The design should win, but the number is not yet in Lumen's favor. It stays aspiration, named as such, until the benchmark moves.
- **Subsumed, not out-competed.** Python owns the axis today and will still own it in 2036. Lumen does not match it; it consumes it, so the axis stops being a reason to choose Python over Lumen.

A win claimed without its metric is downgraded to aspiration in plain words. Triumphalism a referee can break makes the language weaker, not stronger. This file is built to survive the referee, exactly like the one it accompanies. Where 2035 asks "is Lumen useful," this file asks the sharper question: on each axis, is Lumen better than the thing the world already uses, and can that be measured.

The living, machine-readable form of this scorecard is `bench/scoreboard.json` (rendered into `bench/DASHBOARD.md`), which carries both this file's `python_verdict` and `LANGUAGE_COMPARISON.md`'s wider-field verdict per dimension, flipped only in the PR that lands the cited gate.

## The scorecard

| # | Dimension | Python today | Lumen 2036 target | Gating metric | Verdict |
|---|-----------|--------------|-------------------|---------------|---------|
| 1 | Provable correctness | dynamic types, errors surface at runtime, no proofs | effects and contracts proven at compile time; fail-below-proven semantics | proof discharge on the verified kernel; fraction of a program's effects statically proven | Won by design |
| 2 | Numeric exactness (money) | float by default; `decimal.Decimal` is an opt-in library; no decimal literal in the language | exact-decimal / fixed-point as a first-class, native, oracle-gated type | `0.1d + 0.2d == 0.3` in the core; decimal kernels bit-identical across interpreter and native | Winnable now, Won by design once landed |
| 3 | Determinism and replay | nondeterministic by default (hash seeding, FMA variance, wall-clock, threads) | deterministic by default; nondeterminism is capability-tainted and quarantined | replay-to-the-bit on every recorded run | Won by design |
| 4 | Effect safety and sandboxing | any import can touch filesystem and network; no capability system | capability as the only effect; a no-capability function is provably pure | provable no-effect fraction; multi-tenant isolation as a compile error | Won by design |
| 5 | Toolchain trust (self-hosting fidelity) | CPython is a C codebase trusted by reputation and a test suite | compiler reproduces its seed bit-for-bit; native emitters byte-identical to the oracle every commit | fixpoint byte-identity in CI | Won by design |
| 6 | Compiler as a reward environment | not built to be one: flaky tests, ambiguous prose errors, nondeterministic runs | dense, reproducible, structured verdict plus replay | RL against the compiler lifts a model's correct-code rate | Won by design (Python cannot contest) |
| 7 | Generated-code speed | reference interpreter is slow; speed needs C extensions, a JIT, or PyPy | native by default: Lumen C and LLVM emitters match or beat hand-written C | native artifact vs hand-C; the throughput floor in `perf.mjs` | Won on its own generated code |
| 8 | Build determinism and supply chain | networked pip, deep transitive dependency trees, real supply-chain exposure | no network during compile; single self-contained binary; zero-legacy | reproducible single-binary build with zero network access | Won by design |
| 9 | AI-authorability (intent-to-green) | fluent through 35 years of familiarity, but pays for ambiguity, silent runtime failure, and prose errors | the obvious program compiles; structured JSON diagnostics; the compiler applies the confident fix for free; the spec rides in context | `tokens-to-green`, `rounds-to-green`, `first-try-compile-rate` on held-out tasks | Winnable, not yet won |
| 10 | Governance and evolution velocity | PEP plus Steering Council, measured in years | a language change lands in days, gated byte-identical by an executable oracle, not a committee | intent-to-landed-feature wall-clock | Won (with an honest note, below) |
| 11 | Debuggability | pdb and tracebacks, post-hoc and at runtime | structured diagnostics, deterministic time-travel replay, compiler-applied fixes | `fix-application-rate`; replay coverage of recorded runs | Won by design on replay and structure; Python leads on tooling maturity today |
| 12 | Ecosystem breadth, libraries, hiring | dominant: PyPI, numpy, the largest talent pool | not matched; made irrelevant to Lumen's value proposition | fraction of verified cores that lower and run on a host ecosystem | Subsumed, not out-competed |
| 13 | Human familiarity today | enormous | small today, grown by the corpus | `first-try-compile-rate` for models that loaded the spec bundle | Python wins today; Subsumed over time |

The shape of the answer is already visible in the verdict column. On the machine-measured axes of trust (rows 1, 3, 4, 5, 6, 8) Lumen wins by design and Python cannot follow. On speed and governance (7, 10) Lumen wins with a stated caveat. On the number that is the whole bet (9) the win is honest aspiration until the benchmark says otherwise. On the axes Python built its empire on (12, 13) Lumen does not out-grow it; it swallows it. That distribution is the real meaning of "beat Python by a lot in all dimensions," and it is defensible precisely because it is not uniform.

## Where "by a lot" is literally true: the axes Python cannot follow

Three of these wins are not "we implemented it better." They are structural: Python cannot reach them from where it is without becoming a different language, so the gap is a chasm rather than a lead.

**Provable correctness and capability-scoped effects (rows 1 and 4).** Lumen makes what a function can touch part of its type, and a function with no capability parameter is pure by construction, checked, not hoped. Multi-tenant isolation becomes a type error rather than a runtime audit. Python's entire value is dynamic openness: any object, any import, any monkey-patch, at any time. Bolting a sound effect system onto that would break the compatibility that is Python's whole moat. Python cannot become capability-safe and stay Python.

**The compiler as a clean reward signal (row 6).** Because every Lumen error is a machine-checkable structured object and every run is deterministic and replayable, the compiler is a dense, reproducible reward environment a model can be reinforcement-trained against, with no flaky tests and no ambiguous English. This is the strongest asset in the whole plan, and no mainstream language was built for it. Python's errors are prose, its runs are nondeterministic, its tests flake; it is a noisy reward signal by construction. This is an axis Python essentially cannot enter, not merely one where it trails.

**Self-hosting fidelity plus a numeric primitive shipped in days (rows 5 and 10).** Lumen's compiler reproduces its seed bit-for-bit and its native emitters are gated byte-identical to the reference oracle on every commit; CPython offers no equivalent guarantee that its binary faithfully realizes its own source. And because an executable oracle decides what is in the language, not a human committee, Lumen can add a first-class type and gate it byte-identical in days. That combination, a provably faithful pipeline that also evolves at machine speed, is exactly what Python's C core and its Steering-Council governance are built to prevent.

## The decimal emblem: same capability, opposite governance

The clearest single proof of the row-10 win is money. Python has exact decimal arithmetic in `decimal.Decimal`, so the capability is not the difference. The difference is where it lives and how fast the language can bless it. In Python, decimal is a library beside a float-first language; making it ergonomic at the language level, a literal such as `1.50d` so the exact form is as cheap to write as the lossy one, is a multi-year PEP and Steering-Council undertaking, and it is not in the language. The implementation cost is tiny (the front-end change is a lexer and parser edit of a few hundred lines), which proves the bottleneck is governance, not engineering.

Lumen inverts exactly that bottleneck. An exact-decimal or fixed-point money type, with `0.1d + 0.2d` evaluating to `0.3` and every decimal kernel gated bit-identical across the interpreter and both native backends, is a normal turn of the authorship loop: write the kernel, watch the literal fail to parse, make it a failing test, land the minimal seed change, prove it did not slow the compiler down. Same capability, opposite governance. The language that treats money as decimal by right, and can make that true in a week, beats the language that keeps money in a side library and needs a committee and a year to sweeten the syntax. For a beachhead whose buyers are auditors, this is not a nicety; it is the axis they are paying for.

## The axes Lumen does not win by matching, and the subsumption that beats them anyway

Honesty demands the plainest possible statement of row 12: Lumen will not have more libraries than Python in 2036, will not have a bigger hiring pool, and will not out-mature Python's debuggers and profilers. Trying to out-library Python is the one strategy guaranteed to lose. So the win is not conquest; it is subsumption, and it is genuinely strong.

- **Lower to the host, so Python becomes an output target, not a rival.** Lumen is designed to emit to C, LLVM, WASM, and to host languages including Python, TypeScript, and Rust. A team writes the verified core in Lumen, proves it, then lowers it to run inside the ecosystem it already has, calling numpy and pandas on the other side of the boundary. Python's library moat stops being a reason to write Python and becomes a runtime Lumen ships onto. The competitor is demoted to a backend.
- **Universality by embedding, the TLS and LLVM and SQLite pattern.** The most-used infrastructure on Earth is the infrastructure almost no one writes by hand. If Lumen is the verified layer the models reason in and the trust layer their output passes through, it is used by everyone transitively, without anyone learning it, the same way everyone uses TLS without knowing the handshake. Ubiquity of use does not require ubiquity of authorship.
- **The corpus dissolves the familiarity moat over time.** Rows 9 and 13 are Python's today because models have read three decades of it. Reinforcement against the compiler and a growing Lumen corpus train that familiarity in, for every model rather than one vendor's. This is slow and it is the load-bearing bet, but it is the only honest path by which the human-network axes tilt.

Beating Python on these axes therefore means making them cease to be reasons to choose Python, not accumulating more of what Python has. That is a weaker-sounding claim and a stronger real one, because it is achievable and the accumulation strategy is not.

## The axis that is the whole bet, and is not yet won

Row 9 is where the project is most tempted to lie and most refuses to. Lumen's design is better shaped for a model than any language built for humans: the obvious program is the one that compiles, the compiler answers in structured JSON and applies the confident fix for zero output tokens, the spec rides in context so the model is grounded rather than guessing. But today's models have never seen Lumen, and on raw first-try-compile a model will often do better in Python out of sheer familiarity. So the verdict is Winnable, not yet won, and it stays there until the authorship benchmark, on held-out and metamorphic tasks that cannot be won by legacy familiarity, shows `tokens-to-green` and `first-try-compile-rate` actually beating the legacy stacks. The resolver is the corpus and the reinforcement loop, the same keystone step 4 of the 2035 flywheel names. If the numbers do not move, this row is aspiration, and the project says so out loud rather than dressing it as fact. That refusal is not a hedge; it is the reason every other row can be believed.

## The honest note on governance velocity

Row 10 deserves its caveat in full, because the naive version of it is unfair to Python. Python moves slowly in part because it carries a vast installed base, and its caution is the price of not breaking millions of programs; velocity that ignores that is cheap. Lumen's advantage is real today and will narrow as it gains users. The durable difference is the mechanism, not the current speed: Lumen gates a change by an executable oracle that proves the whole toolchain still reproduces itself bit-for-bit, so it can stay fast without staking correctness on human review, where Python must slow down because a committee, not a proof, is the safety net. The bet is not "Lumen will always be faster to change." It is "Lumen can be fast and safe at the same time, because the gate is a proof."

## What to build to make each row true

The scorecard is a roadmap when read as work, and it lands squarely inside the `/lumen` loop:

1. **Exact-decimal money type (row 2).** The highest-leverage single feature, because it converts the beachhead's headline correctness claim from nearly-true to true and it is a small front-end change. Build a decimal kernel, let the literal fail, capture the failing test, land the minimal seed change, gate it byte-identical across interpreter and both native backends.
2. **The reinforcement-against-the-compiler loop, even tiny (row 9).** The warm daemon and the MCP surface already exist; the loop that meters `tokens-to-green` and feeds the authorship benchmark is the thing that decides the one contested row. Stand it up early and keep it running.
3. **A lower-to-host emitter aimed at Python first (row 12).** The move that turns the incumbent into a backend. It is also the fastest path to letting a verified Lumen core call the libraries the world already has, which is what makes adoption cost a team nothing.

Each of these is one turn of the loop the project already runs, and each converts a scorecard verdict from claim into gated fact.

## Where this sits

`VISION_2035.md` is the honest ten-year strategy and the floor; this file is the competitive scorecard and the ceiling it aims at, and the two are meant to be read together. `LANGUAGE_COMPARISON.md` widens the same honesty gate from the one incumbent to the fourteen strongest rivals in the field, so every claim scored here against Python is checked again against whoever already owns that axis. `RULES.md` supplies the metrics that turn every verdict here into a gate (`tokens-to-green`, `rounds-to-green`, `first-try-compile-rate`, the fix-application rate, the throughput floor). `docs/MANIFESTO.md` is the why. The single sentence, kept from the rules: Lumen wins by being the shortest, tightest, most trustworthy path from a human's intent to a proven running binary, for a model writing it. Python is the thing to beat on that sentence, and this document is the ledger that says, dimension by dimension, exactly where Lumen already beats it, where it will, and where it wins by swallowing rather than out-running. The claim is earned per row or downgraded to aspiration in plain words. That is the only kind of "best language" worth the name.
