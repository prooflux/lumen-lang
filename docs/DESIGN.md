# Lumen Language Design

Status: design of record. This is the long-horizon language design; the implementation has since reached a self-hosting fixpoint on the Lumen-mu subset (see `../README.md` and `../SELFHOST_CAMPAIGN_LOG.md`). Where this document describes features beyond the current runnable surface, treat it as the intended design, and `../LANGUAGE.md` as what compiles today.
Name: Lumen (`.lm`, CLI `lumen`)
Audience: language designers, compiler engineers, and the AI agents that will build and use this language.

> This document is the long-form design. The integrated design of record, after the adversarial multi-agent deepening pass, is `spec/SYNTHESIS.md`. Where the two differ, the synthesis wins. The two normative through-lines live in `spec/DETERMINISM_CONTRACT.md` and (to be authored) `spec/DIAGNOSTIC_SCHEMA.md`. Honest risks and gaps are in `RISKS_AND_OPEN_PROBLEMS.md`.

---

## 0. The organizing principle

Lumen is not a pile of features. It radiates from one mechanism and one artifact, and every other subsystem is a consequence rather than an independent invention:

- **The unforgeable capability value** is the single mechanism for effects, authority, purity, and determinism classification. Effect rows are derived from the capabilities a function transitively uses, never hand-written. No capability parameters means the compiler proves the function pure. There is no separate effect system and no `async`/`unsafe`/`throws` keyword family.
- **The canonical structured Diagnostic** is the single artifact every tool, pass, and runtime emits: one schema, schema-versioned, typed arguments, with the human message rendered downstream. No part of the language forks it.

A third unifier, the **Determinism Contract**, is referenced by every dimension instead of being re-asserted. These three (capability, Diagnostic, Determinism Contract) are why the language stays coherent at scale. See `spec/SYNTHESIS.md` for the full integration and the four root conflict resolutions.

---

## 1. Motivation and thesis

Every mainstream language was designed for a human at a keyboard. That assumption shows up everywhere: terse sigils, implicit control flow, many ways to write the same thing, style that is a matter of taste, and error messages written as prose for a person to read.

Two things have changed.

1. A large fraction of new code is now written by language models, and that fraction is rising.
2. Those models have a different performance profile than humans. They almost never make a typo. They are fluent at producing and consuming structured data. But they drift on long-range delimiter matching, they hallucinate APIs that look plausible, they confuse types that coerce silently, and they cannot "run the program in their head" the way an experienced engineer can.

Lumen takes those facts as first-class design inputs. It is a general-purpose, statically typed, natively compiled language whose surface and whose compiler diagnostic contract are engineered so that:

- a model rarely emits a syntactically invalid or ambiguous program,
- when the model is wrong, the compiler tells it exactly what is wrong and how to fix it, in a machine-readable form,
- the program's behavior is reproducible, so a bug found once can always be reproduced and replayed,
- and a human reading the result is never surprised, because there is exactly one way the code could have been written and exactly one way it could have been formatted.

The bet: the language that is easiest for an AI to write correctly, and easiest for an AI to debug, is also one of the clearest languages for a human to own. Clarity is not a tax on the AI use case. It is the same property.

### 1.1 Design principles (in priority order)

1. **One way to do it.** Prefer a single canonical construct over several equivalent ones. Fewer choices means fewer ways to be subtly wrong.
2. **No silent behavior.** No implicit coercion, no null, no hidden control flow, no action at a distance. If it can happen, it is visible at the call site or in the type.
3. **Errors are data.** Every diagnostic, compile-time or run-time, is a structured object with a stable code, a precise span, and a suggested fix. Human-readable text is rendered from that object, never the other way around.
4. **Deterministic by default.** Same inputs produce the same outputs and the same execution trace. Nondeterminism (clock, randomness, concurrency interleaving, filesystem order) is only reachable through an explicit capability.
5. **Effects are explicit.** What a function can touch is visible in its signature. A function with no capability parameters is pure, and the compiler guarantees it.
6. **Static and sound.** A strong inferred type system with algebraic data types and exhaustive pattern matching catches the bug classes that AI code generation produces most often.
7. **Fast native output.** Ahead-of-time compilation to a standalone binary. No required runtime VM, no interpreter in the hot path. Performance is a feature, not a later optimization.
8. **Machine-legible everything.** The grammar, the AST, the type of any expression, the effects of any function, and every diagnostic are queryable as structured data through the compiler itself.

These principles are ordered. When two principles conflict, the lower-numbered one wins. For example, if a terser syntax (more ergonomic) would introduce a second way to express the same thing (violating principle 1), principle 1 wins and the terser form is rejected.

---

## 2. Syntax overview

The full grammar is in `docs/GRAMMAR.md`. This section conveys the feel.

```lumen
# Comments start with '#'. There is one comment form.

# Bindings. Immutable by default; 'var' for mutable.
let pi = 3.14159
var counter = 0

# Functions. Parameter types required at the boundary; inference inside.
fn add(a: Int, b: Int) -> Int {
  return a + b
}

# Algebraic data types.
type Shape =
  | Circle(radius: Float)
  | Rect(width: Float, height: Float)

# Pattern matching is exhaustive. The compiler rejects a missing case.
fn area(s: Shape) -> Float {
  match s {
    Circle(r)      -> pi * r * r
    Rect(w, h)     -> w * h
  }
}

# No null. Absence is Option. Recoverable failure is Result.
fn first(xs: List<Int>) -> Option<Int> {
  if xs.is_empty() { return None }
  return Some(xs[0])
}

# Error propagation with '?'. No exceptions for recoverable errors.
fn load(fs: FileSystem, path: Text) -> Result<Config, Error> {
  let raw = fs.read(path)?        # short-circuits on Err, carrying a structured Error
  let data = json.parse(raw)?
  return Ok(Config.from(data))
}
```

Notes that matter for the thesis:

- `fn`, `let`, `var`, `type`, `match`, `return`, `if`, `for` are full words. The keyword set is small (target: about 25 keywords).
- Blocks are always braces. There is no significant whitespace and no semicolon insertion. A statement ends at a newline inside a block; the grammar is designed so this is never ambiguous.
- There is no ternary operator, no second loop keyword that means the same as another, no two ways to declare a function. One construct per concept.
- `load` can read the filesystem only because it was handed a `FileSystem`. A function that does not take one cannot do I/O. This is the capability model (section 5).

### 2.1 The formatter is part of the language

`lumen fmt` defines exactly one valid formatting for any program, and it is mandatory in the sense that the canonical form is what tooling, diffs, and the conformance suite assume. This is the Go lesson taken further: zero formatting options. Two consequences matter here.

- Diffs are minimal and meaningful, which makes AI-proposed changes reviewable.
- Model output is normalized. Two models, or one model on two days, produce byte-identical source for the same AST. That determinism extends from runtime behavior up into the source text itself.

---

## 3. Type system

- **Static, sound, inferred at the edges.** You annotate function parameters, return types, and top-level bindings. Inside a function, types are inferred. The inference is local and predictable (no whole-program type inference that produces errors far from their cause, which is exactly the kind of nonlocal error that confuses both humans and models).
- **Primitive types:** `Int` (64-bit signed by default, with sized variants `Int32`, `UInt64`, and so on), `Float` (64-bit IEEE 754, with `Float32`), `Bool`, `Text` (UTF-8 string), `Byte`, `Unit`.
- **Composite types:** tuples, records (named-field structs), `List<T>`, `Map<K, V>`, `Set<T>`.
- **Algebraic data types:** sum types with named variants and fields, as shown above. This is the workhorse for modeling.
- **Generics:** parametric polymorphism (`fn id<T>(x: T) -> T`). Bounded by traits.
- **Traits:** interfaces for ad-hoc polymorphism. A trait is a named set of method signatures; a type implements a trait explicitly. No structural duck typing, because explicit implementation is more legible and more checkable.
- **No null, no implicit nil.** Absence is `Option<T>`. The compiler will not let you use an `Option<T>` as a `T` without handling the `None` case.
- **No implicit coercion.** `Int` does not silently become `Float`. You write `to_float(n)`. This kills a large class of model-generated arithmetic bugs.
- **Errors are values.** Recoverable failure is `Result<T, Error>`. `Error` is a structured type (section 4). The `?` operator propagates. There are no exceptions for recoverable conditions. There is a `panic` for unrecoverable programmer bugs (failed invariant, index out of bounds), and panics are themselves structured and carry a trace.

### 3.1 Pattern matching and exhaustiveness

`match` must cover every case of a sum type, or the program does not compile. There is no fallthrough. This is one of the highest-leverage features for AI-written code: it converts "the model forgot a case" from a silent runtime bug into a compile error with an exact list of the missing variants.

```lumen
# If a third variant 'Triangle' is added to Shape, this fails to compile
# with E0210 'non-exhaustive match: missing case Triangle', pointing here.
match s {
  Circle(r)  -> ...
  Rect(w, h) -> ...
}
```

### 3.2 Contracts (optional, checked)

A function may declare preconditions and postconditions. They are checked (in debug builds always, in release builds configurably), and on failure they produce a structured contract-violation diagnostic that points at the exact clause.

```lumen
fn sqrt(x: Float) -> Float
  requires x >= 0.0
  ensures  result >= 0.0
{
  ...
}
```

Contracts give an AI a precise, machine-checkable target to satisfy, and give a human a precise statement of intent. They are optional so the language stays minimal for code that does not need them.

---

## 4. Errors as data (the diagnostic contract)

This is a load-bearing part of the design, not a tooling preference.

Every diagnostic the compiler or runtime can emit is an instance of a structured type. The human-readable rendering is produced from that structure. The structure is also emitted directly with `--errors=json`.

```
Diagnostic {
  code:        "E0102",          # stable, documented, greppable
  severity:    Error,            # Error | Warning | Note
  category:    TypeMismatch,
  message:     "expected Int, got Text",
  span:        { file: "fib.lm", start: {line: 3, col: 10}, end: {line: 3, col: 18} },
  expected:    "Int",
  actual:      "Text",
  fix:         { kind: "wrap", with: "to_int(...)", span: ... },   # machine-applicable
  related:     [ ... ],          # secondary spans, e.g. where the type was decided
  docs:        "https://lumen-lang.org/errors/E0102"
}
```

Why each field matters for an agent loop:

- `code` is stable across versions, so an agent (or a test) can match on it without parsing prose.
- `span` is exact, so a fix can be applied programmatically without re-parsing the whole file.
- `expected`/`actual` are typed, so the agent does not have to infer them from English.
- `fix` is machine-applicable when the compiler is confident, so `lumen check --fix` can apply it, and an agent can apply it without an LLM round-trip.
- `docs` is a stable URL per code, so both humans and agents can read the canonical explanation, and `lumen explain E0102` prints it offline.

The same contract holds at runtime. A panic, a contract violation, or an unhandled `Err` at the program boundary produces a structured runtime diagnostic with the same shape plus an execution trace reference (section 6).

This is the mechanism that closes the generate-check-fix loop. The model is not reading tea leaves in an error string; it is consuming a typed object with a fix attached.

---

## 5. Effects and capabilities

Lumen uses an object-capability model for side effects. The carriers of effects are ordinary values of capability types: `FileSystem`, `Network`, `Clock`, `Random`, `Console`, `Env`. A function can only perform an effect if it holds the corresponding capability, and it can only hold one if it was passed one.

```lumen
# Pure: no capabilities, guaranteed no side effects, deterministic, cacheable.
fn normalize(xs: List<Float>) -> List<Float> { ... }

# Impure, and you can see exactly how, from the signature alone.
fn snapshot(fs: FileSystem, clock: Clock, path: Text) -> Result<Unit, Error> {
  let now = clock.now()
  return fs.write(path, "saved at " + to_text(now))
}
```

Consequences:

- **Auditability.** A reviewer (human or agent) reads a signature and knows the blast radius. There is no hidden global that does I/O.
- **Determinism control.** The only sources of nondeterminism (clock, randomness, network, filesystem ordering, environment) are capabilities. A test harness passes deterministic fakes and gets perfectly reproducible runs. This is what makes the record-replay debugger sound.
- **Safety for AI-written code.** Sandboxing is structural. If you run untrusted or model-generated code without handing it a `Network` or `FileSystem`, it cannot reach them. There is nothing to forget to lock down.
- **Purity is the default and is free.** A function with no capability parameters is pure by construction. The compiler can memoize it, reorder it, run it at compile time, or test it in complete isolation.

`main` is the root of the capability tree. The runtime hands `main` the full set, and `main` distributes them downward. Capabilities cannot be conjured from nothing; they can only be passed, narrowed, or wrapped.

---

## 6. Debuggability model (summary; full version in DEBUGGABILITY.md)

The deterministic-by-default execution plus the capability model make a strong debugger possible. The headline capabilities:

- **Structured diagnostics** everywhere (section 4).
- **Record and replay.** `lumen run --record run.tape` writes a compact, deterministic trace of the execution. Because effects are capability-gated and the pure core is deterministic, the tape plus the captured capability responses fully reproduce the run.
- **Time-travel.** `lumen debug run.tape` replays the recorded run and steps forward and backward. You can move to any step in O(reasonable) time and inspect state.
- **Provenance queries.** `why <variable> at <step>` answers "which write produced this value, and what fed that write", walking the data dependence backward. This is the single most useful question when debugging, and it is answered from the trace, not guessed.
- **Stable, queryable program model.** `lumen ast file.lm --json`, `lumen type file.lm:3:10` (type of the expression at that position), `lumen effects fn_name` (what it can touch), `lumen callers fn_name`. An agent navigates the program as data.

The design intent is that an autonomous agent can debug a Lumen program through these structured interfaces alone, without screen-scraping human-oriented output.

---

## 7. Memory model

This is a genuine fork in the road and is called out as an open decision in `docs/DECISIONS.md`. The design's working recommendation:

**Value semantics with automatic reference counting (ARC) and compiler-optimized move/borrow inference.**

Rationale against the alternatives:

- **Tracing garbage collection** is the easiest for both humans and models to write, but it introduces unpredictable pauses, which fights principle 7 (fast native output) and the "eliminate bottlenecks" goal, and it weakens determinism of timing.
- **Manual ownership and borrowing (Rust style)** gives the best performance and safety, but it imposes a heavy cognitive load (lifetimes, borrow-checker errors) that fights principle 1 (clarity) and is precisely the kind of nonlocal constraint that trips up model-generated code.
- **ARC with value semantics (Swift style)**, with the compiler eliding reference-count traffic through escape analysis and move inference, gives predictable performance, no global pauses, and a low cognitive load. The common case requires no lifetime annotations. Hot paths can opt into manual region or arena allocation behind an explicit, clearly-marked construct.

This recommendation balances "fast native binary with no surprise pauses" against "a model and a human can both write it correctly without a lifetime calculus". The decision is not final; it is the most important single call to make before backend work begins.

---

## 8. Compiler architecture

Lumen compiles ahead of time to a standalone native binary. The pipeline is a sequence of well-typed passes with stable data contracts between them, so that independent contributors and independent agents can work on separate passes in parallel.

```
source text
  -> [lexer]            tokens (with spans and preserved trivia for the formatter)
  -> [parser]           CST (lossless) -> AST
  -> [resolver]         name and scope resolution -> resolved AST
  -> [type checker]     inference + checking -> typed AST (HIR)
  -> [effect checker]   capability/effect validation
  -> [lowering]         HIR -> MIR (typed, SSA-form mid-level IR)
  -> [analysis]         move/borrow/ARC inference, exhaustiveness, contract insertion
  -> [optimizer]        MIR passes: inline, const-fold, DCE, devirtualize
  -> [codegen]          MIR -> native machine code
  -> [linker]           standalone binary
```

Design points:

- **Lossless CST** feeds the formatter and the language server, so tooling sees comments and exact layout. The AST is the semantic view.
- **MIR is the contract.** It is typed, in SSA form, and fully specified. Optimization, the borrow/ARC analysis, contract checks, and codegen all consume MIR. A new backend only needs to consume MIR. This is what keeps "replace the backend later" realistic.
- **Two backends, one MIR.** For the dev loop, a fast backend (Cranelift-class: very fast compile times, good-enough code) powers `lumen run` and `lumen build` debug mode. For release, an optimizing backend (LLVM-class) powers `lumen build --release` to get the fast binary. Backend choice is `docs/DECISIONS.md` item; the dual-backend strategy is the recommendation because it serves both "fast iteration while building" and "eliminate runtime bottlenecks".
- **Incremental from the start.** The compiler is structured around incremental, demand-driven queries (a salsa-style query engine), so the language server and repeated builds are fast. This is also what makes the structured-query interfaces (`lumen type file:line:col`) cheap.
- **Determinism in the compiler too.** The compiler itself is deterministic: same source, same flags, byte-identical binary. Reproducible builds are a baseline, not a feature.

### 8.1 Runtime

The runtime is small: an allocator, the ARC machinery, the panic and contract-violation handler that builds structured runtime diagnostics, and the optional trace recorder. Binaries are statically linked by default so distribution is a single file, which fits a command-line-first workflow.

### 8.2 Targets

1. Native `x86-64` and `aarch64` (primary; the "fast binary").
2. WebAssembly (for the zero-install web playground and for embedding). A pure-by-default core compiles cleanly to a sandboxed WASM module.
3. (Later) a portable bytecode for fast-start scripting and the REPL.

---

## 9. Bootstrapping with zero legacy languages

Lumen owes nothing to any prior language, including in how it is bootstrapped. There is no legacy high-level host language (no C, C++, Rust, Go, and so on) anywhere in Lumen's identity or its shipped toolchain. The compiler, standard library, and tooling are written in Lumen. See `MANIFESTO.md` and decision D3 in `docs/DECISIONS.md`.

The one irreducible fact is that the very first executor of Lumen code cannot itself be written in Lumen and already be running. The resolution: the bootstrap seed targets a **low-level substrate**, which is a compilation target, not a programming language.

- **Seed: a minimal executor lowered to a substrate.** Define Lumen-0, the minimal subset needed to express the Lumen compiler. The first executor for Lumen-0 is produced directly in a low-level substrate (WebAssembly text format, or LLVM IR), by AI. This is not "writing Lumen in another language"; emitting to such a target is the irreducible act every compiler performs to reach the machine. The seed is tiny and disposable.
- **Self-hosting.** The Lumen compiler is written in Lumen. The seed runs it; it compiles itself to native code; it then recompiles itself and reproduces a **byte-identical** binary (the bootstrap fixpoint). At that point the seed is discarded and Lumen stands entirely on itself. This fixpoint is also the strongest correctness check on the whole chain.
- **Backend independence (long-horizon, optional).** Replace the external code-generation substrate (LLVM/Cranelift, per D4) with an in-house backend so even the codegen path is ours. This is a multi-year stretch goal; until then, emitting to a world-class external optimizer is the irreducible "produce machine code" step, not a legacy-language dependency.

The end state: a self-hosted compiler, standard library, build tool, package manager, formatter, language server, and time-travel debugger, all written in Lumen, with the only external dependency being a code-generation target, and full backend independence as a stated aspiration. "By AI" means AI agents author every stage of this, test-first against the conformance suite.

---

## 10. The development model ("by AI")

This language is meant to be built primarily by Claude Code. The architecture is shaped to make that effective:

- **Conformance-test-driven.** The language is defined by an executable conformance suite (a corpus of Lumen programs with expected outputs, expected diagnostics by code, and expected formatter results). Every feature lands as: an RFC, a spec change, conformance tests, then an implementation that turns those tests green. This is test-driven development applied to a compiler, and it is how an agent makes verifiable progress.
- **Stable pass contracts enable parallel agents.** Because lexer, parser, resolver, type checker, and codegen communicate through specified data structures (tokens, CST, AST, HIR, MIR), separate agents can own separate passes and work in parallel without stepping on each other.
- **The compiler's own diagnostics help build the compiler.** Structured errors are useful to the agents writing Lumen code (once self-hosting begins) exactly as they are useful to any other user.
- **Self-hosting is the integration test.** When the compiler can compile itself and the result is byte-identical, a large swath of the language is proven correct in one shot.

---

## 11. Non-goals (for v0.1 to keep scope honest)

- No exceptions. Recoverable errors are `Result`; bugs are `panic`.
- No inheritance. Composition plus traits.
- No macros or arbitrary compile-time metaprogramming in v0.1. (A disciplined, hygienic mechanism may come later via RFC; unrestricted metaprogramming fights clarity.)
- No implicit async coloring debate yet. Concurrency model is deferred to a dedicated RFC after the sequential core self-hosts; determinism of concurrent execution is hard and deserves its own design.
- No package ecosystem features baked into the language. The package manager is a tool, designed early (section in COMMUNITY.md) but not part of the v0.1 language semantics.

---

## 12. Decisions

Tracked in `docs/DECISIONS.md`. Status:

1. **Name and identity** (RESOLVED): Lumen, extension `.lm`, CLI `lumen`.
2. **Bootstrap, zero legacy** (RESOLVED): self-hosting identity; a minimal seed lowered to a low-level substrate (WASM / LLVM IR), discarded at the byte-identical self-compilation fixpoint; no legacy high-level host language anywhere. See section 9 and `MANIFESTO.md`.
3. **Memory model** (OPEN, deepened): leaning toward inferred ownership over an ARC value-semantics surface (Perceus/Roc-style: no lifetime annotations in source, compiler recovers performance). Does not block the Phase 1 to 3 front end; settled with prototype evidence before Phase 4.
4. **Codegen backend strategy** (OPEN, deepened): leaning toward Cranelift for debug and LLVM for release over one MIR. Most reversible of the set (the MIR contract isolates it); settled at Phase 4.

The two open decisions are intentionally open and do not block front-end work. Everything else in this document is a recommendation the roadmap refines through the RFC process.
