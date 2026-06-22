# Lumen

> Files end in `.lm`. The toolchain is one binary: `lumen`. A lumen is the unit of visible light, and the metaphor is exact: Lumen's job is to make a program fully visible. Every error, every value's origin, and every effect a function can have is brought into the light, for the AI writing it and the human reading it. Nothing happens in the dark.

**A general-purpose programming language designed to be written and read by AI, and built by AI, without giving up on being excellent for humans.**

Lumen's two non-negotiable pillars:

1. **Clarity by construction.** One canonical way to express each idea. A small, regular, unambiguous grammar. A single mandatory formatting. Minimal keywords, full words, no clever punctuation soup. The grammar is built so a language model rarely produces a syntactically invalid program, and a human can always read what was produced.

2. **Debuggability as a language feature, not an afterthought.** Every error is a structured, addressable object with a stable code, an exact source span, and a machine-readable suggested fix. Execution is deterministic by default. The runtime can record a replayable trace you can step backward through and ask "why does this value hold this?". Effects (I/O, time, randomness, the network) are explicit and visible in a function's type. These are not tooling add-ons; they are guaranteed by the language and compiler.

Together these make Lumen the first language explicitly optimized as a **compile target for LLMs with a correction feedback loop**: an agent generates code, the compiler answers with structured diagnostics, the agent self-corrects to green. The same properties that make it safe and legible for an AI to write make it pleasant and predictable for a human to maintain.

## Status

**Design phase.** This repository currently contains the language design, the draft grammar, the debuggability model, the compiler architecture, and a phased roadmap. There is no compiler yet. The example programs under `examples/` are illustrative of the intended syntax and are not yet runnable.

Start here:

- `docs/MANIFESTO.md` is the why: all for AI, all by AI, zero legacy.
- `docs/spec/SYNTHESIS.md` is the integrated design of record (after the 17-dimension adversarial deepening pass). Start here for the real shape of the language.
- `docs/DESIGN.md` is the long-form language and compiler design.
- `docs/spec/DETERMINISM_CONTRACT.md` is the normative determinism source (the single biggest cross-cutting requirement).
- `docs/GRAMMAR.md` is the draft lexical structure and EBNF grammar for the v0.1 core.
- `docs/DEBUGGABILITY.md` is the deep dive on the differentiating feature.
- `docs/AI_FEEDBACK_LOOP.md` is how Lumen improves itself from the AI's experience of writing it.
- `docs/ROADMAP.md` is the honest, phased plan (formal foundations, then bootstrap seed, then self-hosting).
- `docs/COMMUNITY.md` is how this scales to a real open-source ecosystem.
- `docs/DECISIONS.md` is the decision register (D1, D3, D8, D10 resolved; D2, D4, D9 deepened-and-open).
- `docs/RISKS_AND_OPEN_PROBLEMS.md` is the honest risk register and the next-designs list.

## What Lumen is not

- Not an interpreter bolted onto Python. Lumen compiles ahead-of-time to a standalone native binary.
- Not a transpiler that emits another language. The semantics are its own, so the structured-error and deterministic-trace guarantees hold end to end.
- Not "production-ready". The roadmap is multi-phase. The documents here are honest about scope.

## The one-paragraph pitch

Mainstream languages were designed for humans typing on keyboards. They optimize for human ergonomics: terse operators, implicit context, cleverness. Large language models have different strengths (they rarely make typos, they produce and consume structured data fluently) and different failure modes (delimiter drift in long files, hallucinated APIs, silent type confusion). Lumen redesigns the language surface and the compiler's diagnostic contract around those facts, while keeping a static, sound type system and a fast native backend so the result is not a scripting toy but a serious systems-capable language. Because the spec, the AST, and every diagnostic are machine-readable, AI agents can both build the compiler and target the language, creating a flywheel.
