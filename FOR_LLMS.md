# Testing Lumen with an LLM

This is a ready-to-use kit for handing Lumen to a language model and having it write and run programs. Lumen is a small, AI-native language; this is its first runnable subset.

## How to use this kit

1. Give the model the prompt below (and, if you want, the full `LANGUAGE.md`).
2. The model writes a `.lm` program.
3. You run it: `./lumen run program.lm`. (First time: `cd seed && npm install`.)
4. If it prints an error like `program.lm:5:12: error: unknown function 'foo'`, paste that back to the model and let it fix the program. Repeat until it runs. This generate-check-fix loop is the whole point: a structured error the model can act on.

## The prompt to give the model

> You are writing programs in **Lumen**, a small language. Use ONLY the features below; anything else will not compile.
>
> - Entry point: `fn main(console: Console) -> Unit { ... }`. Functions may be defined in any order.
> - Types: `Int` (64-bit), `Text` (string), `Unit`. Comments start with `#`.
> - Functions: `fn name(p: Int, q: Int) -> Int { ... }`. Every parameter and the return type are annotated. End each path with `return <expr>` (except `Unit` functions).
> - Locals: `let x = expr` (immutable; no reassignment, no `var`).
> - Control: `if cond { ... }` and `if cond { ... } else { ... }`. **There are no loops** — use recursion.
> - Operators: arithmetic `+ - * / %`, comparison `< <= > >= == !=` (one comparison per expression, no chaining). Parentheses group.
> - Strings: `"text"`, with `\n` for newline. `int_to_text(n)` gives the decimal text of an Int. `text_concat(a, b)` joins two Texts.
> - Output: `console.print(t)` prints a Text exactly; `console.print_int(n)` prints an Int followed by a newline. (Pass `console` down to any helper that prints.)
> - NOT available: `var`/mutation, `while`/`for`, `match`, sum/record types, `Result`, `?`, generics, `true`/`false`, floats, arrays, imports, escapes other than `\n`.
>
> Write one statement per line. Output only the program, as a single `.lm` file.

## Starter tasks to test the model

1. Print `hello, world` followed by a newline.
2. Compute and print the 20th Fibonacci number.
3. Print `"<n>! = <result>"` for the factorial of 6 (use `int_to_text` and `text_concat`).
4. Write `gcd(a, b)` with the Euclidean algorithm (recursion, `==`, `%`) and print `gcd(48, 36)`.
5. Write mutually recursive `is_even` / `is_odd` and print whether 17 is even (print `1` for true, `0` for false).
6. Sum the integers 1..100 by recursion and print the total.

After each, run `./lumen run task.lm` and feed any error back to the model.

## What to look for (the actual test)

- **First-try compile rate:** how often the model's program compiles with no error.
- **Rounds to green:** how many error-and-fix cycles until it runs correctly.
- **Does the structured error help?** A good error (`file:line:col: error: unknown function 'foo'`) should let the model fix the exact spot in one step.

These are the metrics the project's authorship benchmark is built around (`docs/AI_FEEDBACK_LOOP.md`). This kit is the manual version of that loop.

## Reference

Full, verified reference of the runnable subset: `LANGUAGE.md`. Eleven worked examples: `mu/examples/`. The compiler itself: `seed/lumenc.wat` (and `seed/COMPILER.md`).
