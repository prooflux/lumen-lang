---
name: lumen
description: Author, check, or run Lumen (.lm) code. Use whenever the user wants to write a Lumen program, fix a Lumen compile error, run a .lm file, or asks about the Lumen language.
---

# Lumen

Lumen is a small, AI-native language. This skill authors `.lm` programs against the current
runnable subset and uses the `lumen-mcp` tools to check/fix/run them in a tight loop instead of
guessing at syntax.

## What the language supports today (seed interpreter)

- Types: `Int` (64-bit signed), `Float` (f64), `Text` (UTF-8, `\n` escape), `Unit`,
  user sum types (`type DivError = | DivByZero`), `Result[T, E]` with `ok`/`err` and the
  non-coercing `?` operator, records (`type P = { a: Float, b: Int }`, `P { a: .., b: .. }`,
  `p.a`), and heap-backed Float arrays (`array(n)` / `aget` / `aset` / `alen`).
- `fn name(p: Int) -> Int { ... }` with annotated params/return; forward references and
  mutual recursion work; non-Unit functions must return on every path.
- `let` (immutable) AND `var` (mutable, reassignment allowed); `while` loops;
  `if` / `else if` / `else`; `and` / `or` / `not` (short-circuit); `match` with exhaustive
  variants; unary minus; automatic Int->Float coercion in mixed arithmetic.
- Arithmetic `+ - * / %` (Int and Float; `/` and `%` by zero trap), comparisons
  `< <= > >= == !=`.
- Builtins: `console.print(t)`, `console.print_int(n)`, `int_to_text`, `text_concat`,
  `text_eq`, `to_int` / `round` / `to_float`, math kernel `sqrt` / `abs` / `exp` / `ln` /
  `pow`, raw memory `load8` / `store8` / `load32` / `store32`.
- `Console` is a capability passed to `main`; pass it down to helpers that print.
- Enough for real verified kernels: a full Black-Scholes call in pure Lumen prices to
  10.4506; the compiler itself (lumenc.lm, ~1200 lines of Lumen) self-compiles
  bit-identically to the seed.

**Not yet:** generics beyond `Result`, imports/modules, I/O beyond console, a real `Bool`,
Int arrays. Do not author code that assumes those.

## Beyond the interpreter: certified native backends

Separately from the interpreter above, the project has a native-codegen track (`projects/lumen/native/`)
that lowers Lumen-mu IR to LLVM/NEON and validates it bit-exact against a POSIX libm reference
(Black-Scholes-class float math kernels, verified to 0 ULP or documented cancellation error). That
work is not exposed through this skill's authoring loop; treat it as a separate, in-progress
pipeline rather than something you can casually target from a `.lm` program today.

## MCP tools (lumen-mcp)

- `lumen_check(source)` — compile and return structured diagnostics; empty list means it compiles.
- `lumen_fix(source)` — apply the compiler's confident automatic fixes and return the repaired
  source plus any remaining diagnostics.
- `lumen_run(source)` — compile and run; returns stdout, or diagnostics if it doesn't compile.
- `lumen_ir(source)` — compile and return the IR disassembly.
- `lumen_explain(code)` — explain a diagnostic code (e.g. `E0003`).

## The rule: author naturally, capture friction as a failing test

Write the program the way a human would first attempt it. When `lumen_check`/`lumen_run` rejects
something, do not just silently patch around it and move on — that failure is signal. If the
rejected construct looks like it should reasonably exist (a loop, a float, a boolean literal),
capture it as a minimal failing `.lm` snippet plus the diagnostic under
`projects/lumen/conformance/` or `projects/lumen/examples/` rather than discarding it. That is how
the language subset grows: real authoring friction becomes the next test case, not a rabbit hole
you work around forever.

Practical loop:
1. Write the smallest `.lm` program that expresses the intent within the supported subset.
2. `lumen_check` it. If diagnostics are non-empty, try `lumen_fix` first (it only makes confident,
   mechanical fixes — deleting a stray token, closing an unterminated block).
3. If `lumen_fix` doesn't fully clear it, read the diagnostic (`file:line:col: error: ...`) and
   edit by hand; use `lumen_explain` for an unfamiliar code.
4. `lumen_run` to confirm the output matches intent.
