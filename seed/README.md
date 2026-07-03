# Lumen seed (the reference compiler and oracle)

This is the trust root of Lumen. `lumenc.wat` is a pure-WebAssembly-text compiler-and-interpreter for Lumen-mu: it lexes and parses `.lm` source, emits IR, and executes that IR. WebAssembly is a compilation substrate (a target, not a high-level language), so this honors the zero-legacy commitment. The seed serves two roles at once: the reference compiler, and the definitional-semantics interpreter that every other artifact (the self-hosted compiler, the C and LLVM backends, the optimizer) is gated against by bit-identity. It is disposable in principle, discarded when the native fixpoint retires it (see `ARCHITECTURE.md`).

## Status: self-hosts

```
$ npm install                 # one-time: fetches wabt (a WAT assembler dev tool, not a Lumen dependency)
$ node lumen.mjs run  ../mu/examples/fib_print.lm      # compile and run a .lm program
$ node lumen.mjs check lumenc.lm                       # -> ok: compiled lumenc.lm (8749 IR words, main at 0)
$ node selfhost_diff.mjs                               # the fixpoint gate: SELF(lumenc.lm): MATCH
$ npm test                                             # basics + conformance + safety + daemon/MCP loop
```

`lumen.mjs` assembles `lumenc.wat`, writes `.lm` source into the seed's linear memory, compiles it, and runs the emitted IR. The single host import `console_print` is the `Console` capability seam (the only nondeterminism boundary). `lumenc.lm` is the Lumen-mu compiler written in Lumen; the seed compiles it, and `selfhost_diff.mjs` verifies that `lumenc.lm` running on the seed re-emits its own source to byte-identical IR (`SELF: MATCH`).

## What the seed implements now

The full Lumen-mu language and IR: `Int`/`Float`/`Text`/`Unit`, arithmetic and comparisons with Int->Float coercion, `let`/`var`, `if`/`while`, `and`/`or`/`not`, functions with forward references and mutual recursion, sum types + `Result` + `match` + `?`, records, heap-backed Float arrays, the math kernel (`sqrt`/`abs`/`exp`/`ln`/`pow`), text builtins, raw-memory ops, and a `TYPEMAP` metadata opcode the native emitters consume. The interpreter is fuel-bounded and hang-proof on any input; execution is deterministic and step-countable (the profiler reads exact step totals). The full `mu/examples/` conformance corpus compiles and runs; `safe_div`/`propagate` compile and run here (the two remaining self-host gaps are the self-hosted lexer's sum-type syntax, tracked in `../SELFHOST_CAMPAIGN_LOG.md`).

## Why this matters

It proves the bootstrap substrate end to end on real hardware: `.lm` source compiles and runs deterministically on a pinned WASM engine through a single recorded seam, with no legacy high-level language anywhere in the path, and the compiler written in Lumen reproduces the seed's compilation of its own source byte-for-byte. The next milestone is the native fixpoint: compile `lumenc.lm` with the Lumen-written backends so the compiler runs at native speed and retires the seed.
