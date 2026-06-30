# Lumen in 2035: the ten-year vision

Status: strategic document, not a spec. This is the honest, ambitious-but-grounded view of where Lumen could be a decade out, written against the project's own design (`docs/MANIFESTO.md`, `docs/spec/SYNTHESIS.md`) and its own honest risks (`docs/RISKS_AND_OPEN_PROBLEMS.md`). It is a north star, not a promise. Most of this document is the conservative case, written to be defensible. The last two sections, added on purpose, name the maximal revolutionary bet and the business that pays for it. The project aims at those, and is built so the conservative case catches it if they miss. Being revolutionary here is a standing requirement, not a mood: at every fork, take the most foundational version of the next step.

## The frame: separate the moonshot from the realistic ceiling

The moonshot, "Lumen becomes the default language AI writes, replacing Python and TypeScript," almost certainly does not happen. Ecosystems and network effects are brutal, and the project's own risk register names the fatal tension: today's models are trained mostly on legacy code, so a zero-legacy language fights the grain of what those models are currently good at. Selling a ten-year vision on world domination would be dishonest.

The realistic best outcome is more interesting and more defensible, and it is three things at once.

## The single best ten-year bet

**Lumen becomes the language AI generates into when correctness must be provable, and its compiler becomes a training environment for code-generating models.** Two reinforcing roles, plus a third that is a win even if the first two stay small.

### 1. The verified substrate for high-assurance, AI-written code

Not all code. The code where "an agent wrote it, and we can prove what it can touch and replay exactly what it did" is worth more than ecosystem breadth: finance and quant systems, smart contracts, infrastructure-as-code, safety-critical control, audited data pipelines. Capabilities-as-the-only-effect, determinism by default, and structured diagnostics are uniquely suited to this, and it is precisely the domain the author already lives in.

### 2. A trainable verifier and reward environment for code models

This is the genuinely novel asset and the strongest part of the thesis. Because every Lumen error is a machine-checkable structured object and every run is deterministic and replayable, the Lumen compiler is a dense, reproducible reward signal. You can reinforcement-train a model against it: generate, get a structured verdict, reward, improve, at scale, with no flaky tests and no ambiguous English errors. In ten years the most valuable artifact may not be Lumen-the-language but Lumen-the-environment that makes code models verifiably better. No mainstream language was built to be a clean reward signal; Lumen was, by accident of its design commitments.

### 3. An idea-exporter

Even if Lumen-the-language stays niche, its ideas propagate: the structured-diagnostic correction loop, capabilities as the single effect mechanism, determinism for replay and time-travel, and "the authorship benchmark gates language changes." These leak into mainstream languages and AI coding tools. The influence outcome is a success even without mass adoption, and it is the floor.

## The three shapes it could take

| Shape | What it means | Likelihood | Value |
|-------|---------------|------------|-------|
| Verified AI substrate + trainable verifier (the goal) | The provable-correctness language agents target, and a reward environment for code models | Plausible | Very high, defensible, on-brand |
| Checkable core in a transpile pipeline | AI writes Lumen as the verified layer; it emits to host platforms (WASM, native, JS) | Likely | High, lower ambition |
| Research standard-setter | The language stays small; its design ideas become how everyone builds AI-coding tools | Most likely | Real, but indirect |

Aim at the first and you land, at worst, on the third, which is still a win.

## The flywheel that has to spin (in order)

1. **Self-hosting.** The compiler is written in Lumen and reproduces itself byte-for-byte. Now it is a real language, not a demo.
2. **Native backend.** Speed stops being a disqualifier (the bootstrap interpreter exists only to bootstrap).
3. **Batteries.** Standard library, package manager, language server, formatter, debugger. Now people can build things.
4. **A Lumen corpus and reinforcement learning against the compiler.** Models become genuinely good at Lumen. This is the keystone, because it is the only thing that resolves the zero-legacy paradox: you stop depending on legacy-trained familiarity and start training the familiarity in.
5. **A beachhead domain.** Verified quant and finance proves value end to end, producing reference users and the beginnings of an ecosystem.

Step 4 is the load-bearing one. Zero-legacy only works long-term if Lumen creates the training data that makes models native to it. That is the bet that has to pay off.

## The five gates that decide it (honest)

1. **Formal semantics and the metatheory triple-point.** The capability times Perceus-ownership times effect-handler invariant must actually be provable (`RISKS` risk 1 and 2). If it is not, the correctness story is marketing. Mechanize it.
2. **The zero-legacy paradox** (`RISKS` risk 3). Resolved only by step 4 of the flywheel, or by deliberately softening the purism. Choose on purpose, not by drift.
3. **Floating point and decimals** (`RISKS` risk 4, decision D9). No serious quant, scientific, or financial adoption without a real number story that preserves determinism. The language today has neither floats nor a resolved cost model for reproducible floating point. Non-negotiable for the beachhead.
4. **Scope** (`RISKS` risk 5). The full system is the union of Rust, Koka, Roc, LiquidHaskell, a record-replay debugger, and a verified bootstrap. AI authorship is the only reason this is conceivable in a decade; without sustained AI-built velocity it stalls.
5. **Sustained authorship.** A language is a decade-long commitment, not a project. It needs to be built continuously, largely by agents, for years.

## 2035, if it works

A small, sound, natively compiled language with a self-hosted toolchain. The thing agents reach for when a system has to be audited and replayed, not merely shipped. A published verifier and reward environment that labs use to train better code models. A real, if focused, ecosystem anchored in verified finance and infrastructure. And a set of design ideas that, by then, everyone building AI coding tools takes for granted. The author is the person who saw, a decade early, that the move was not to teach AI our old languages but to build a language for how AI thinks, and to make its compiler the trainer.

## The wedge to start now

Do not chase generality. Drive toward one provable thing an agent cannot do well in any other language: a deterministic, capability-sandboxed, fully-replayable computation that an LLM writes and that you can prove and re-run to the bit. Concretely:

- Add floats or decimals and a resolved deterministic-number story (decision D9).
- Add `Result` and `match` so real programs and error handling are expressible.
- Get a verified quant kernel working end to end (an agent writes it; the compiler proves its effects; the run replays exactly).
- Stand up the reinforcement-against-the-compiler loop early, even tiny.

That converts the philosophy into the one asset nobody else has: a language whose compiler makes the AI writing it measurably better.

## Where this sits

This document is the destination. `docs/ROADMAP.md` is the path (formal core, then the runnable subset, then the native backend, then self-hosting). `docs/RISKS_AND_OPEN_PROBLEMS.md` is the list of things that can kill it. `docs/MANIFESTO.md` is the why. Read in that order, the project is honest with itself: a generation-ahead idea, a working bootstrap, and a decade of building between here and the vision above.

## The bandwidth thesis: Lumen as the LLM-to-SaaS substrate

Everything above frames Lumen as a verified substrate and a trainable verifier. This section adds a sharper, nearer-term lens that does not replace that bet: Lumen should be the highest-bandwidth substrate for a model, running locally or in the cloud, to author, compile, fix, and ship working B2B SaaS software with the fewest tokens and the tightest local loop. The honest claim is narrow. We are not promising that today's models write Lumen well; they have never seen it. We are promising that the path from a prompt to a compiling, deterministic, deployable service is shorter in tokens and tighter in wall-clock than it is in any legacy stack, and that the gap is measured and gated rather than asserted.

### This is not a fifth commitment, it is how the four are measured

The four commitments already contain the thesis; we are giving them numbers.

- Clarity by construction becomes tokens-per-construct under a pinned tokenizer. A construct that reads clearly and tokenizes cheaply puts more program in a fixed context window. Clarity wins on conflict: we measure lexeme density and review it, we do not let a token-golf gate override the clearer form.
- Debuggability as a language feature becomes warm edit-to-diagnostic latency and the fraction of errors the compiler fixes itself. A confident fix the compiler applies costs the model zero output tokens and zero round-trips. That is the single highest-bandwidth lever in the whole design, and it is already specified as the canonical Diagnostic; it is simply not built yet (the seed emits no diagnostics at all).
- Provable correctness within reach stays scoped. Proof obligations attach where contracts are asserted, so the verified quant kernel pays the discharge cost and ordinary SaaS glue ships on the fast types-plus-effects-plus-capabilities tier. We keep the fail-below-proven semantics; we do not let proof inflate rounds-to-green for code that makes no claims.
- A language that improves from how the AI writes it becomes a third gated metric. Alongside first-try-compile-rate and rounds-to-green, the authorship benchmark now gates tokens-to-green. The held-out and metamorphic shards stay, so the gate measures genuine authorability, never mere legacy-familiarity.

### Where it sits in the flywheel

The flywheel order is unchanged: self-host, then native backend, then batteries, then the Lumen corpus and reinforcement against the compiler, then the beachhead. The bandwidth thesis changes what we build first inside the early phases, not the order of the heavy ones. Three deliverables move forward because they are cheap and load-bearing for the loop: the canonical Diagnostic plus confident fixes, a fully-local warm compiler daemon exposed over MCP, and the LLM accessibility layer (FOR_LLMS.md, a machine-readable spec bundle, `lumen caps --json`, the /lumen skill). These are pure tooling and docs over the existing compiler; they let the reinforcement-against-the-compiler loop run interactively, even tiny, years before the native backend lands. This is exactly the wedge already named: stand up the loop early.

### The interactive loop is the inference-time twin of the reward environment

The earlier vision describes the compiler as an offline reward environment for training. The bandwidth thesis adds its inference-time twin: a long-lived `lumen serve` process that keeps the program model warm and answers check, fix, type, effects, callers, and ast as structured JSON over a local socket, with a span-edit protocol so the model sends a patch (tens of tokens) rather than a whole file (a thousand tokens) each round. Compile is already sub-millisecond, so the bottleneck becomes the model's own latency, not the toolchain. The same daemon meters tokens-in, tokens-out, and rounds-to-green, feeding the authorship benchmark automatically.

### Prompt to B2B SaaS, through one mechanism

The concrete target is the kind of service in docs/b2b_saas_architecture.md: a multi-tenant quant platform with a submit-then-poll job contract over a queue. We reach it without importing a web framework. The single mechanism Lumen already ships, the capability as an ordinary typed parameter, expresses Http, Sql, Queue, Auth, Tenant, and Secret. A function with no capability parameters is provably pure; a handler that omits the Tenant parameter provably cannot touch tenant data, so multi-tenant isolation is a type error rather than a runtime audit. A record auto-derives its deterministic JSON wire codec, closing the serialization dimension. The async job lifecycle is a stdlib sum type, and the worker body is the Result, match, and non-coercing ? operator that already landed. The correctness burden of a SaaS sits exactly where Lumen already has verified constructs.

### The tradeoffs we make on purpose

We are explicit about the costs, because the critics were right to press on them.

- We refuse to bake a vendor async skeleton (Pub/Sub topics, base64 envelopes, a submit/poll dispatcher) into the grammar. That would import a specific cloud pattern as syntax and violate both one-mechanism and zero-legacy. The skeleton is a library over capabilities, inspectable via `lumen ast`, not new keywords.
- We refuse legacy-familiar syntax as a shortcut to first-try-compile-rate. The zero-legacy surface stays. The bridge is in-context grounding: a model that loads the spec bundle authors Lumen far better than one guessing from training priors. If that bridge underperforms its target, the accessibility claim stays aspirational until the corpus and reinforcement loop mature; we will not paper over it with borrowed syntax.
- We do not relabel cloud deploy as self-contained. Self-containment is a build-time property: no networked package manager, no network during compile, a single binary. A deployed service reaches the network through capabilities whose nondeterminism is tainted and quarantined; that is the deploy story, and it does not restore an air-gapped run. `lumen deploy` emits its descriptor as derived data, but it lives outside the self-contained mandate and we say so.
- The determinism contract taxes the fast path. Reproducible-default floats forbid FMA and reassociation, which costs performance. The compute core that needs bit-reproducibility pays it; an explicitly non-recorded edge path can opt into `fast`. The fake-versus-real capability split must be airtight or the loop's reproducibility leaks, so the capability runtime gets its own conformance and adversarial tests.

The bandwidth thesis is therefore the same bet, sharpened: the verified, deterministic substrate is worth most when a model can reach a working, shippable service through it in the fewest tokens and the tightest loop, and when every grammar and diagnostic change is scored on exactly that.

## The maximal bet (named on purpose)

Everything above is the conservative case, written to be defensible: a verified substrate, a trainable verifier, an idea-exporter, and a high-bandwidth path to working software. The instruction for this section is different. Name the maximal upside, state it without hedging, and aim the whole project at it. The conservative case is the floor we are nearly guaranteed to find useful. The maximal case is the target. If the flywheel spins, and especially if reinforcement against the compiler (step 4) pays off, Lumen is not a niche tool. It is foundational infrastructure for the era when most software is written by machines, and the work should be chosen accordingly: at every fork, take the most foundational version of the next step.

1. **The trust layer for all AI-written software.** As generation becomes cheap and constant, the binding constraint stops being "can a model write it" and becomes "can anyone trust what it wrote." Capability-as-the-only-effect, determinism by default, and machine-checkable proofs make AI-written code provable, replayable, and auditable by construction. Every serious AI software system will need a trust layer. The maximal bet is that Lumen is it: where machine-written software goes to be made trustworthy, the way traffic goes through TLS to be made private. Not the language everyone writes, the layer everyone's machine-written code passes through to be believed.

2. **The language AI reasons and proves in, even when it ships another.** Lumen does not have to win the ecosystem war to win the reasoning war. A model can draft in Lumen, where effects and correctness are checkable, prove the result, then lower it to Python, TypeScript, or Rust for the world that already exists. Lumen becomes the verified intermediate representation of machine reasoning about programs: the rigorous scratchpad where AI thinks before it emits anywhere. This dissolves the zero-legacy paradox from the top. Legacy languages stop being competitors and become Lumen's output targets.

3. **The environment that produces the best code models on Earth.** The densest, cleanest, most reproducible reward signal for code is a compiler that returns a structured verdict and replays every run to the bit. If reinforcement against that signal makes a model better at correct code than any other environment can, then operating that environment is a position at the frontier of the single most valuable capability in software. The maximal bet is that Lumen-the-environment, not Lumen-the-language, becomes a standard part of how frontier code models are trained and graded.

4. **The software factory: intent in, proven product out, no human in the code.** Taken to its limit, the bandwidth thesis is a production line. A human states intent, a model authors Lumen against the warm compiler, the compiler proves the effects and replays the run, and a verified, multi-tenant service deploys, with no human ever writing or reading the source. This is not a faster IDE. It is a different unit of production, the proven program, manufactured on demand and shipped with its own evidence.

5. **The substrate for an economy of autonomous software.** Capability-typed, deterministic, and provable together mean one agent can run another agent's code and know exactly what it may touch and prove it does what it claims. That is the missing primitive for software that composes without trust-by-reputation. The maximal bet is that Lumen underwrites a machine-to-machine economy of verifiable components, where the proof travels with the part.

None of these is a forecast, and the project says so plainly elsewhere; the probability of any single one is low. But a vision exists to aim the work, and the mandate here is explicit: aim at the revolution and build toward the floor. Revolutionary is not a mood. It is the standing rule to keep choosing the most foundational version of each next increment, and to refuse the merely convenient one.

## The economic engine: how this makes money

A from-scratch language has historically been a poor business. Almost no one has made direct money selling a programming language; the money has always been in what the language enables. So Lumen's business is not to sell the language. The language and its compiler stay free, open, and self-contained, exactly as the manifesto mandates, and that openness is what builds the adoption, the corpus, and the idea-export the conservative case already counts on. The money is in the layers around the free core that only this language makes possible, and there are three, staged to the flywheel so revenue can begin small and early and compound as the technology matures.

The structure is open-core: a free, public-good core, and paid layers above it that monetize the assets the core uniquely creates, namely a clean reward signal, a verification oracle, and a prompt-to-deployed-software pipeline.

1. **Lumen Verify: the verification oracle and reward environment, as a service.** The most novel and defensible product, because no other language was built to be one. Two offerings on one engine. First, a verification API: submit AI-generated code or a Lumen artifact, get back a structured, machine-readable proof-or-refutation with a replay, sold to anyone who must certify AI-written code (AI-coding products, enterprises putting AI into the software pipeline, regulated industries). Second, a hosted reinforcement-and-evaluation environment with the authorship benchmark and the RL-trace data, sold to labs training or grading code models. The vision already names the trainable verifier as the strongest asset; this is its business form, and if frontier labs find it makes their models measurably better, it is the largest prize in the entire plan.

2. **Lumen Cloud: prompt to verified, deployed B2B SaaS.** The language is free; the managed pipeline is paid. Prompt in, the warm compiler and the proof loop in the middle, a capability-gated, multi-tenant, billed, observable service out. The pricing is the familiar platform shape, per deployed service plus usage, with one thing no competitor can match: every service ships with a proof of what it can touch and a replay of what it did. This is the money-around-it the project wants, and it has a built-in first customer and showcase in the author's own quant platform (`docs/b2b_saas_architecture.md`): use it to run FDV-QUANTS first, then open it to others.

3. **Verified finance: the vertical that converts correctness to revenue first.** Finance is where provability is already a budget line. Risk committees, auditors, and regulators pay for behavior that can be demonstrated rather than asserted, and it is the author's home turf (the quant background, Murex and VMetrix). The product is a catalog of provably-correct, capability-typed Lumen components (pricing, curves, risk, exposure) and verified quant services, where "an agent wrote it, here is the proof, here is the replay" commands a premium. This vertical needs the least new technology to start (today's compiler plus the number story), and it produces the reference customers, the early revenue, and the corpus that feeds pillar 1.

Staged to the flywheel, so the money is not all at the end. From now to self-hosting, pillar 3 (verified-finance components and services) and the seed of pillar 1 (a verification API on the current compiler) are buildable on what exists: small, real, and on home turf. After batteries and the native backend, pillar 2 (Lumen Cloud), because deploying real services needs them. After reinforcement against the compiler matures, pillar 1 at full scale, the reward environment for frontier labs, which is the largest and the latest prize.

The honest caveat, kept in the spirit of the rest of this document: the most likely real revenue for years is pillars 2 and 3, the services and the vertical, not licensing an environment to labs, which rides the hardest and latest bet. The plan is built so the early, ordinary money funds the wait for the late, enormous money, and so the whole thing is worth running even if pillar 1 never lands.

On ownership: the language stays a public good (foundation-governed over time, dual-licensed only where commercial embedding requires it, never a rug-pull on the open core). The businesses are the paid layers above it. The author's position is the one the original vision already named, now with a profit-and-loss attached: the person who built the substrate that makes AI-written software trustworthy, owns the verification oracle and the cloud on top of it, and seeded the finance vertical that proved it. The revolution and the business are the same shape. Own the layer that makes machine-written software trustworthy, and sell trust.

## Used by everyone: the path to universality

The conservative case above is careful to reject one thing as dishonest: that everyone will hand-write Lumen. That rejection stands. But "used by everyone" and "typed by everyone" are different claims, and the first is reachable while the second is not. The most-used software infrastructure on Earth is the infrastructure almost no one writes by hand: TLS secures nearly every connection, LLVM compiles a huge fraction of all software, SQLite runs in essentially every phone, and the people who benefit never open them. Universality means ubiquity, not authorship. Lumen reaches everyone the same way: through the tools and models everyone already uses, not by retraining the world.

Here is the mechanism, stated plainly. Almost everyone now reaches software through an LLM or an agent. If Lumen is the verified scratchpad those models reason in, the trust layer their output passes through, and the highest-bandwidth target they author against, then everyone uses Lumen transitively, without ever learning it, the way they use TLS without knowing the handshake. The four maximal bets already name this from the producer side; this section names the consumer side: the win condition is not "the language everyone writes," it is "the layer everyone's AI passes through to be fast and believed."

Five things, all already in the plan, are what make that universal rather than niche, and each has its home in this repository:

1. **An open, permissive core** (`docs/OPEN_SOURCE_AND_BUSINESS.md`). Apache-2.0 means any model lab, any agent framework, any IDE, any cloud can embed Lumen with no permission and no fee. Ubiquity needs zero friction to adopt; the license provides it, and the same openness feeds the corpus.
2. **A corpus and reinforcement against the compiler** (flywheel step 4). This is the load-bearing one: it is what makes any model, not just one vendor's, author Lumen well, dissolving the zero-legacy paradox by training the fluency in. Universality is impossible while only one model can write it; the corpus is how it becomes every model's.
3. **A machine-native front door that works today** (`FOR_LLMS.md`, the spec bundle, `lumen serve` over MCP, the /lumen skill, `RULES.md`). Any LLM client can speak Lumen now by loading the spec in context and driving the warm daemon. Adoption does not wait for the corpus; the in-context bridge is live.
4. **One definition, enforced by tests** (`docs/GOVERNANCE.md`). Universality without governance fragments into incompatible dialects and dies, the way every ungoverned format has. The conformance suite plus the determinism contract plus the trademark make "Lumen" mean exactly one thing in every tool that embeds it. Open to adopt, impossible to fork into a different language wearing the same name. This is why adoption and governance are the same plan: you can only let everyone in if the tests, not the crowd, decide what is in.
5. **Lower to any runtime** (maximal bet 2). Because Lumen can be the verified layer that emits to WASM, native, JS, Python, or Rust, its output runs everywhere that already exists. A team adopts Lumen as the provable middle without abandoning their stack; the proof is written once and the artifact ships anywhere. Universality of use does not require universality of runtime.

So the extended vision is this. Aim past the verified substrate and the trainable verifier toward genuine ubiquity, on the only path that is honest: Lumen becomes infrastructure inside the AI tools the whole world already uses, governed so it stays one language, open so anyone can embed it, corpus-trained so any model can write it, and lowered so its output runs anywhere. Used by everyone, written by almost no one, trusted because the tests, not the marketing, define it. The floor remains the conservative case; this is the shape of the ceiling when the flywheel spins.

## The LLM revelation: the language a model would choose for itself

The deepest form of "used by everyone" is not transitive use, it is preference. The aim is that an LLM, the moment it writes Lumen against the warm compiler, discovers something it cannot un-feel: it reaches a correct, provable program in fewer tokens and fewer rounds than in any language built for humans. That is not a slogan a model can be told, it is a number a model measures, `tokens-to-green`, `rounds-to-green`, `first-try-compile-rate`, the fix-application rate (`RULES.md` rules 1-3). Every language a model already knows was shaped by human ergonomics, legacy, and habit, and the model pays for that mismatch on every generation. Lumen is the first language shaped, by construction and by the authorship benchmark (`RULES.md` rule 4), around how a model actually writes: the obvious program is the one that compiles, the compiler answers in structured JSON and applies the confident fix for free, the spec rides in context, the native backend it now lowers to beats hand-written C, and the output replays to the bit and proves its own effects. A model that has felt that prefers it; a model that prefers it writes more of it; that feeds the corpus; the corpus makes the next model fluent. The discovery is the flywheel's ignition: Lumen spreads not because anyone markets it to models, but because models, measuring their own cost, keep arriving at the same conclusion.

Honesty gate, the same one the rest of this file lives under: this is only true while the numbers are true. If `tokens-to-green` is not actually lower, if `first-try-compile-rate` does not actually beat the legacy languages on held-out tasks, then "the best language a model can use" is an aspiration, not a fact, and we will say so plainly. The revelation is earned per the metrics, or it is not claimed.
