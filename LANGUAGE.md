# Lumen Language Reference (runnable subset)

This describes the part of Lumen that **actually compiles and runs today** (the bootstrap subset, "Lumen-mu"). If you are an LLM being asked to write Lumen, write programs using only what is on this page; everything here is verified by the conformance suite. The broader language vision lives in `docs/`, but only what is documented here will run.

## Run a program

```
./lumen run   program.lm     # compile and run, print output
./lumen check program.lm     # compile only; report ok or where it failed
./lumen ir    program.lm     # print the compiled IR (for inspection)
```
(First time only: `cd seed && npm install` to fetch the WAT assembler.)

## Program shape

Every program is a list of functions. Execution starts at `main`, which takes the `Console` capability:

```lumen
fn main(console: Console) -> Unit {
  console.print("hello, world\n")
}
```

Functions may be defined in **any order**: forward references and mutual recursion both work.

## Comments

```lumen
# everything after a hash on a line is a comment
```

## Types

- `Int` : 64-bit signed integer. Literals: `0`, `42`, `1000000`.
- `Text` : UTF-8 string. Literals: `"hello"`, `"line one\n"` (the only escape is `\n`).
- `Unit` : the no-value type; a function that returns nothing declares `-> Unit`.
- `Console` : the capability that lets a function print. Only `main` receives it (pass it down to helpers that need to print).

There is no `Bool` type to name; a comparison produces a truth value that `if` consumes directly.

## Functions

```lumen
fn add(a: Int, b: Int) -> Int {
  return a + b
}
```
Every parameter is typed. Every function declares a return type (use `-> Unit` if it returns nothing). The last thing a non-`Unit` function does on each path must be `return <expr>`.

## Statements

```lumen
let x = expr        # immutable local binding (no reassignment, no `var`)
return expr         # return a value
if cond { ... }                 # no else
if cond { ... } else { ... }    # with else
console.print(text)             # an expression used as a statement
```
Write one statement per line.

## Expressions and operators

- Arithmetic: `+  -  *  /  %`  (integer division and remainder; `*` `/` `%` bind tighter than `+` `-`).
- Comparison: `<  <=  >  >=  ==  !=`  (lower precedence than arithmetic). One comparison per expression; do not chain (`a < b < c` is not allowed — write `a < b` and a second `if`, or compute separately).
- Grouping: parentheses `( )`.
- Calls: `f(a, b)`. Functions can be called before they are defined.

```lumen
let area = (w + 1) * (h + 1)
if n == 0 { return 1 }
```

## Built-in operations

- `console.print(t: Text) -> Unit` : print `t` exactly as given (include `\n` yourself for a newline).
- `console.print_int(n: Int) -> Unit` : print `n` in decimal **followed by a newline**.
- `int_to_text(n: Int) -> Text` : the decimal text of `n`.
- `text_concat(a: Text, b: Text) -> Text` : `a` followed by `b`.

```lumen
console.print(text_concat("answer = ", int_to_text(42)))   # prints: answer = 42
console.print("\n")
```

## Control flow

There are **no loops** (`while`/`for` are not in this subset). Iterate with **recursion**:

```lumen
fn sum_to(n: Int) -> Int {
  if n == 0 { return 0 }
  return n + sum_to(n - 1)
}
```

## Not in this subset (do not use)

`var`/mutation, `while`/`for` loops, `match`, sum or record types, `Result`/`?`, generics, traits, boolean literals (`true`/`false`), float numbers, arrays/lists, modules/imports, and string escapes other than `\n`. Using any of these will fail to compile or behave unexpectedly. Stick to what is above.

## A complete example

```lumen
# fizz-ish: classify a number, then report it. Recursion + Text + comparisons.
fn classify(n: Int) -> Text {
  if n == 0 { return "zero" }
  if n < 0 { return "negative" }
  return "positive"
}

fn main(console: Console) -> Unit {
  console.print(text_concat("3 is ", classify(3)))
  console.print("\n")
  console.print_int(fib(10))          # 55, with a trailing newline
}

fn fib(n: Int) -> Int {
  if n < 2 { return n }
  return fib(n - 1) + fib(n - 2)
}
```

Save as `demo.lm` and run `./lumen run demo.lm`. Expected output:
```
3 is positive
55
```
