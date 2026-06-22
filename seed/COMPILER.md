# lumenc: the stage-0 Lumen-mu compiler (working)

`lumenc.wat` is a real compiler, written in WebAssembly text (a compilation substrate, not a legacy high-level language, so zero-legacy holds). It takes Lumen-mu **source text** and produces the Lumen-mu IR, then runs it on the built-in bytecode interpreter. This is the walking skeleton the roadmap calls for: source in, correct output out, end to end, with no legacy language anywhere in the pipeline.

## Pipeline

```
source text (host writes bytes into the SRC region)
  -> $lex          tokenizer (idents, ints, operators, comments, keywords)
  -> $c_program    recursive-descent parser that EMITS IR directly
                   (precedence ladder cmp -> add -> mul -> primary;
                    JZ/JMP backpatching for if/else; a function symbol table)
  -> IR words      (the Lumen-mu IR, in the CODE region)
  -> $run          the bytecode interpreter (operand stack + call stack)
  -> output        via the single Console seam
```

The compiler and the interpreter are the same module; `compile_and_run(srclen)` does both. `compile(srclen)` returns the IR word count; `run(entry)` executes; `dbg_*` expose token/IR/entry counts.

## Verified results

Conformance (`node test.mjs`):

```
PASS  fib_print.lm  -> "55\n"   (ir_words=35)
PASS  add.lm        -> "42\n"   (ir_words=19)
PASS  max.lm        -> "13\n"   (ir_words=28)
PASS  fact.lm       -> "120\n"  (ir_words=33)
PASS  locals.lm     -> "31\n"   (ir_words=31)
PASS  forward.lm    -> "42\n"   (ir_words=17)
PASS  mutual.lm     -> "1\n"    (ir_words=51)

7/7 Lumen-mu programs compiled from source and ran correctly.
```

These exercise: recursion, multi-argument calls, `if`/`else` (with jump backpatching), the full integer arithmetic set (`+ - * / <`), `let` local bindings (`locals.lm`), forward references (`forward.lm`: `main` calls a function defined after it), and mutual recursion (`mutual.lm`: `is_even`/`is_odd` call each other). Functions may be defined in any order: every call is recorded in a fixup table and resolved after the whole program is parsed.

Performance (`node bench.mjs`, fib(30) = 832040):

```
compile source->IR:       ~0.24 ms   (35 IR words)
run (interpret fib(30)):  ~200 ms
~2.69 M function calls  ->  ~13.5 M calls/sec on the bytecode interpreter
```

This is the bootstrap interpreter's speed. The "fastest, most optimized" target is delivered later by the native backend (roadmap Phase 4: Cranelift for debug, LLVM for release), which compiles the same IR to machine code and is expected to be one to two orders of magnitude faster. The interpreter exists to bootstrap, not to be fast.

## Subset compiled today

`fn`, parameters, `let` local bindings, `if`/`else`, `return`, integer literals, `+ - * / <`, function calls in **any order** (forward references and mutual recursion), and `console.print_int(expr)`. The grammar is a strict subset of `../docs/spec/GRAMMAR.md`.

The frame model scales cleanly: a call's arguments occupy frame slots `[0, nparam)` and `let` locals occupy `[nparam, nparam+nlocal)`; a `RESERVE` at function entry sizes the frame (backpatched once the local count is known), `GETARG` reads any slot, `SETLOCAL` writes a local, and `RET` discards the whole frame. Forward references work because every `CALL` records a fixup (code position plus callee name) and all fixups are resolved against the symbol table after the entire program is parsed.

Not yet: `Text`, sum and record types, `Result`/`?`, and block-scoped (rather than function-scoped) locals. These are the next increments. After enough of them land, the goal is to rewrite this compiler IN Lumen-mu and run it on the seed, reaching the self-hosting fixpoint.

Capacity (current region sizes, all trivially enlargeable in `lumenc.wat`'s memory map): about 83 functions, 62 params and 62 locals per function, 1666 tokens, and thousands of call fixups. Enough for the bootstrap and the self-hosted Lumen-mu compiler; the sizes are constants, not architecture.

## How it was built

Written and verified directly with a growing conformance suite (`test.mjs`), one feature at a time, test-first. Two real bugs were found and fixed during bring-up, both via the deterministic, inspectable pipeline (dump the IR, see the cause, fix it):

1. `$streq` returned "equal" for every comparison (a mis-targeted branch), so the symbol and parameter tables always resolved to their first entry. `fib` passed by luck (single parameter, first symbol); `add(20,22)` gave 40 and `max(7,13)` gave 7, which exposed it.

This is the project's own thesis in miniature: a deterministic pipeline makes a bug reproducible and a fix verifiable.
