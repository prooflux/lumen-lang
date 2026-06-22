# Conformance Expectations (seed)

This table is the seed of the Lumen conformance suite. Each example is either a positive case (must compile and run, with an expected stdout) or a negative case (must fail with an exact diagnostic code at an expected location). Once the Phase 1 to 3 toolchain exists, this table becomes executable tests: the runner compiles or runs each file and asserts the expectation. Matching is on the stable diagnostic CODE, never on prose.

## Positive cases (must compile and run)

| File | Expected stdout | Exercises |
|------|-----------------|-----------|
| `fib.lm` | `55` | recursion, `if`, arithmetic, `Console` capability |
| `fizzbuzz.lm` | `1 2 Fizz 4 Buzz ... FizzBuzz` (lines 1..15) | `for in`, tuple `match`, `Text` |
| `read_config.lm` | depends on input file; on valid input prints `listening on HOST:PORT` | capabilities, `Result`, `?`, records, interpolation |
| `contracts.lm` | `4` | `requires`/`ensures`, `while` |

## Negative cases (must fail to compile, with the given code)

| File | Expected code | Category | Confident fix offered |
|------|---------------|----------|-----------------------|
| `negative/type_mismatch.lm` | `E0102` | type mismatch | wrap argument with `to_int(...)` |
| `negative/non_exhaustive_match.lm` | `E0210` | non-exhaustive match | add missing `Triangle` arm |
| `negative/chained_comparison.lm` | `E0150` | chained comparison | split into `a < b and b < c` |

## How this is used

- Phase 1 (front end): the negative `E01xx` syntax-family cases and the formatter round-trip are checked.
- Phase 2 (semantics): `E0102`, `E0150`, `E0210` must appear at the expected spans; positive cases type-check clean.
- Phase 3 (execution): positive cases run and produce the expected stdout; `contracts.lm` exercises `C####` on a deliberately broken variant.

The suite grows by RFC: every new language feature lands with its positive and negative conformance entries before the implementation is considered done.
