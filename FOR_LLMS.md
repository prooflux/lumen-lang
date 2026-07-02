# Testing Lumen with an LLM

This is a ready-to-use kit for handing Lumen to a language model and having it write and run programs. Lumen is a small, AI-native language, optimized for clarity and direct agent authorship. This describes the current runnable subset.

## How to use this kit

1. Give the model the prompt below (and, optionally, the full `LANGUAGE.md`).
2. The model writes a `.lm` program.
3. You run it: `./lumen run program.lm`. (First time: `cd seed && npm install`.)
4. If it prints an error like `program.lm:5:12: error: unknown function 'foo'`, paste that back to the model and let it fix it. Repeat until it runs. This **generate-check-fix loop** is the entire point: structured compiler errors let the model self-correct without guessing.

## The prompt to give the model

> You are writing programs in **Lumen**, a small language designed for agent authorship. Use ONLY the features below; anything else will fail to compile.
>
> **Core:**
> - Entry point: `fn main(console: Console) -> Unit { ... }`. Functions may be defined in any order; forward references work.
> - Types: `Int` (i64), `Float` (f64), `Text` (string), `Unit`. Type annotations required on all parameters and return types. Comments start with `#`.
>
> **Functions:**
> - `fn name(p: Int, q: Float) -> Text { ... }`. Every parameter and the return type must be annotated. Each code path in a non-`Unit` function must end with `return <expr>`.
>
> **Variables and constants:**
> - `let x = expr` (immutable; cannot be reassigned).
> - `var y = 0` (mutable; can be reassigned with `y = y + 1`).
>
> **Control flow:**
> - `if cond { ... }` or `if cond { ... } else if ... { ... } else { ... }`.
> - `while cond { ... }` for loops (use `var` to track mutable state).
> - Recursion (functions can call themselves; forward references work).
> - `match` expressions with exhaustive pattern matching on sum types and tuples.
>
> **Operators:**
> - Arithmetic: `+ - * / %` (standard precedence: `* / %` tighter than `+ -`). Unary minus: `-x`.
> - Comparison: `< <= > >= == !=` (lower precedence than arithmetic; do NOT chain).
> - Logical: `and` (short-circuit), `or` (short-circuit), `not` (negation).
>
> **Type system:**
> - Sum types: `type Color = | Red | Green | Blue` or `type Shape = | Circle(Float) | Rect(Float, Float)`.
> - Records: `type Point = { x: Float, y: Float }`. Construct as `Point { x: 1.0, y: 2.0 }`. Access as `p.x`.
> - `Result[T, E]`: `Ok(value)` or `Err(error)`. Use with `match` or the `?` operator for propagation.
> - Float arrays: `array(n)` allocates `n` floats. Read with `aget(arr, i)`. Write with `aset(arr, i, value)`. Length: `alen(arr)`.
>
> **Built-in functions:**
> - Output: `console.print(t: Text)` (print exactly), `console.print_int(n: Int)` (print + newline).
> - Conversion: `int_to_text(n)`, `to_int(t)`, `to_float(n)`, `round(f)`.
> - Text: `text_concat(a, b)`, `text_eq(a, b)` (returns 1 or 0).
> - Math: `sqrt(x)`, `abs(x)`, `exp(x)`, `ln(x)`, `pow(x, y)` (all Float).
> - Memory (unsafe): `load32(addr)`, `store32(addr, val)`, `load8(addr)`, `store8(addr, val)`.
>
> **NOT available:** imports/modules, I/O beyond console, boolean literals (`true`/`false`), generics (except `Result`), tuples as values (only in patterns), inheritance, traits, string interpolation, exceptions, `for` loops (use `while`).
>
> Write one statement per line. Capture patterns that look like they should work but don't as minimal test cases rather than silently working around them. Output the entire program as a single `.lm` file.

## Starter tasks

1. Print `hello, world` followed by a newline.
2. Compute and print the 20th Fibonacci number (recursion + arithmetic).
3. Print results of FizzBuzz 1..15 (use `while`, `match`, and the tuple pattern `(n % 3, n % 5)`).
4. Write a `gcd` function using the Euclidean algorithm and print `gcd(48, 36)`.
5. Write mutually recursive `is_even` / `is_odd` and print whether 17 is even (print 1 or 0).
6. Sum integers 1..100 with a `while` loop and print the total.
7. Compute Black-Scholes call price (requires `Float`, math functions, and `if`; tests numeric depth).

After each task, run `./lumen run task.lm` and paste any errors back to the model. The error message (`file:line:col: error: ...`) should be precise enough that the model can fix it in one step.

## What to look for (the authorship benchmark)

- **First-try compile rate:** what fraction of programs compile on the first attempt (no error)?
- **Rounds to green:** median number of error-and-fix cycles before the program runs correctly.
- **Self-correction:** does the model recognize the error message and fix it, or does it randomly patch around it?

These metrics measure how well the language and its error messages support agent authorship. Higher compile-on-first-try rate and fewer rounds to green indicate better language design. See `docs/AI_FEEDBACK_LOOP.md` for the full benchmark harness.

## Reference

- **Full language spec:** `LANGUAGE.md` (verified against the conformance suite).
- **Worked examples:** `examples/` — positive cases (must compile and run with expected output) and negative cases (must fail with a specific diagnostic code).
- **Compiler:** `seed/lumenc.lm` (the compiler itself, written in Lumen, ~1200 lines, self-compiles bit-identically to the seed interpreter).
- **Test suite:** `seed/test.mjs` and `seed/basics.mjs` (run with `cd seed && npm test`).
