# Lumen Conformance Suite (seed)

The conformance suite is the executable definition of what a Lumen implementation must do. Each entry is a program plus an expectation: a positive program with expected stdout, or a negative program with an expected diagnostic code at an expected span. Matching is on the stable diagnostic CODE, never on prose. Once the WAT seed and the Lumen-mu compiler exist, this suite is the gate every stage must pass, and it is the witness against the mechanized IR semantics (the normative ground; see `../docs/spec/SYNTHESIS.md` governance).

## Lumen-mu positive cases (`../mu/examples/`)

| Program | Expected stdout | Exercises |
|---------|-----------------|-----------|
| `fib.lm` | `55` | recursion, `if`, checked arithmetic, the `Console` seam |
| `safe_div.lm` | `ok 4` then `div by zero` | user sum type, `Result`, nested exhaustive `match` |
| `propagate.lm` | `9` | non-coercing `?` propagation, error-type matching |

## Surface (v0.1) illustrative cases (`../examples/`)

Positive: `fib.lm`, `fizzbuzz.lm`, `read_config.lm`, `contracts.lm`. Negative: `negative/type_mismatch.lm` (E0102), `negative/non_exhaustive_match.lm` (E0210), `negative/chained_comparison.lm` (E0150). See `../examples/EXPECTATIONS.md`.

## How the suite is used per stage

- WAT seed (stage 0): each Lumen-mu program, lowered to IR by hand or by a trivial lowerer, runs on the seed and must produce the expected stdout. This validates the seed against the IR semantics.
- Lumen-mu compiler (stage 1+): the compiler must reproduce the same outputs and emit the expected diagnostic codes at the expected byte spans for the negative cases.
- Self-hosting (stage 4): the suite must pass identically before and after the byte-identical fixpoint.

## Anti-overfitting

A held-out private shard (run by steward infrastructure) and metamorphic/property generators supplement this public corpus, so passing is not achievable by memorizing a finite enumerable set. See `../docs/RISKS_AND_OPEN_PROBLEMS.md` and the governance section of `../docs/spec/SYNTHESIS.md`.

## Growth rule

Every new language feature lands with its positive and negative conformance entries before the implementation is considered done. The suite is the spec made executable.
