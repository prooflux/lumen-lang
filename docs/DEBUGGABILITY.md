# Debuggability in Lumen

Status: draft v0.1.

Most languages treat debugging as something you bolt on with external tools (a debugger, a logging library, a tracing framework). Lumen treats it as a language and compiler responsibility. This document explains the four mechanisms that make a Lumen program debuggable by construction, and in particular debuggable by an autonomous agent that consumes structured data rather than human-oriented text.

The four mechanisms:

1. Structured diagnostics (compile time and run time).
2. Determinism by default.
3. Record and replay with time-travel.
4. A queryable program and execution model.

They are not independent. Each one depends on the ones before it. Determinism is what makes replay sound. Replay is what makes provenance queries possible.

---

## 1. Structured diagnostics

A diagnostic is a typed object (the schema is in `DESIGN.md` section 4). The crucial properties:

- **Stable codes.** `E0102` means the same category of error in v0.1 and in v3.0. Tests and agents match on the code, never on the prose.
- **Exact spans.** Byte-precise start and end. A fix can be applied without re-parsing.
- **Typed expected/actual.** The diagnostic carries the types involved as data, not embedded in a sentence.
- **Machine-applicable fixes.** When the compiler is confident, the diagnostic carries a fix (an edit: a span plus replacement text). `lumen check --fix` applies all confident fixes. An agent can apply them with zero model round-trips.
- **One stable doc per code.** `lumen explain E0102` prints the canonical explanation offline; the same content lives at a stable URL.

### The correction loop this enables

```
agent writes program.lm
  -> lumen check program.lm --errors=json
  -> 0 diagnostics? done.
  -> else: for each diagnostic
        if it has a confident fix: apply it directly
        else: hand the typed diagnostic to the model, which edits the exact span
  -> repeat until green
```

This is the central reason Lumen is described as a compile target for LLMs. The feedback the model receives is structured, exact, and often directly applicable, so the loop converges quickly and predictably instead of thrashing on ambiguous English error text.

### Diagnostic code families

- `E####` compile errors (syntax, type, effect, exhaustiveness).
- `W####` warnings (unused binding, unreachable code).
- `C####` contract violations.
- `R####` runtime diagnostics (panic, unhandled error at boundary, out-of-bounds).

Each family has a documented, stable registry. Adding a new code is an RFC-tracked change.

---

## 2. Determinism by default

A Lumen program is deterministic unless it is explicitly handed a source of nondeterminism. The sources, and how they are controlled:

| Source of nondeterminism | How Lumen controls it |
|--------------------------|------------------------|
| Wall-clock time          | Only via a `Clock` capability. No ambient `now()`. |
| Randomness               | Only via a `Random` capability, which is seedable. |
| Filesystem order         | `FileSystem` directory listing returns a defined order (sorted), not OS order. |
| Map/Set iteration        | Iteration order is defined (insertion order for maps, sorted or insertion for sets), never hash-randomized. |
| Environment              | Only via an `Env` capability. |
| Network                  | Only via a `Network` capability; responses are part of the recorded tape. |
| Concurrency interleaving | Deferred to the concurrency RFC; the sequential core is fully deterministic. |

The payoff: a bug that happens once can be reproduced. This is the precondition for every other debugging technique. "It only fails sometimes" is, in most languages, the hardest class of bug. In Lumen, "sometimes" can only come from a capability you were handed, and that capability's outputs are recorded, so "sometimes" becomes "always, given this tape".

---

## 3. Record and replay with time-travel

Because the pure core is deterministic and the only nondeterminism enters through capabilities, a complete run can be reproduced from:

1. the program (and its compiled form), plus
2. the recorded responses of every capability call (the clock readings, the random draws, the bytes read from files and the network).

`lumen run program.lm --record run.tape` captures exactly that. The tape is compact: it does not record every instruction, it records the program plus the nondeterministic inputs, and replay re-derives everything deterministic.

`lumen debug run.tape` replays the run with a time-travel interface:

- step forward and backward over statements and calls,
- jump to a specific step index,
- inspect any in-scope binding's value at the current step,
- set a "watch" that stops when a given binding changes,
- run backward from a failure to its origin.

For an agent, the same operations are available as structured queries over the tape (a step is an addressable index; state at a step is returned as structured data), so the agent does not drive a human TUI; it queries the trace.

### Why backward stepping matters

The natural debugging question is "this value is wrong here; where did it become wrong?". Forward-only debugging answers this by re-running with more breakpoints, repeatedly. Backward stepping answers it directly: stand at the symptom, walk back to the cause. Lumen makes this a first-class operation because the trace is deterministic and complete.

---

## 4. Provenance: the `why` query

The most valuable single feature for an agent debugging a program is the ability to ask, of any value at any step, "what produced you?".

```
lumen debug run.tape --why total --at 42
```

returns the write that set `total` at or before step 42, the expression that computed it, and the values that fed that expression, each itself a `why`-able node. This walks the data-dependence graph backward. It turns debugging from a search into a traversal.

Provenance is built from the recorded trace and the MIR (the typed SSA mid-level IR), where every value has a single defining assignment (the SSA property is what makes "the write that produced this value" well-defined). The capability model guarantees that external inputs (a file's bytes, a clock reading) are themselves recorded provenance roots, so a `why` chain always terminates at either a literal in the source or a recorded capability response.

---

## 5. The queryable program model

Independent of any particular run, the compiler exposes the program itself as structured data through stable commands. These are the same incremental queries the language server uses, so they are cheap.

| Command | Returns |
|---------|---------|
| `lumen ast file.lm --json` | the abstract syntax tree as JSON |
| `lumen type file.lm:L:C` | the type of the expression at line L, column C |
| `lumen effects fn_name` | the capabilities the function can use |
| `lumen callers fn_name` | call sites of the function |
| `lumen explain E0102` | the canonical explanation of a diagnostic code |

An agent navigating a Lumen codebase reads structure, not text. It asks the compiler for the type of an expression instead of inferring it from surrounding code. It asks what a function can touch instead of reading the body to find out. This is the "machine-legible everything" principle made concrete.

---

## 6. Summary

Determinism makes runs reproducible. Reproducibility makes record-replay sound. Record-replay makes time-travel and provenance possible. Structured diagnostics make every failure addressable as data. The capability model makes the boundary between deterministic and nondeterministic explicit, which is what lets all of the above hold. None of these is a tool you add later; each is a property the language and compiler guarantee, which is why an autonomous agent can rely on them.
