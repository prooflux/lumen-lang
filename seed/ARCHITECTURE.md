# The Lumen-mu WAT seed

Status: draft v0.1. This is the one piece of the toolchain not written in Lumen, and it is deliberately tiny and disposable. It is a hand-authored WebAssembly module (in the text format, WAT) that executes the Lumen-mu IR (`../docs/spec/LUMEN_MU.md` section 4). WebAssembly is a compilation substrate (a target, not a high-level programming language), so this honors the zero-legacy commitment: no C, C++, Rust, or other legacy language is part of Lumen. The seed exists only to break the bootstrap circularity and is discarded at the self-hosting fixpoint.

## Role in the bootstrap

```
stage 0   the WAT seed (this)               executes Lumen-mu IR
stage 1   the Lumen-mu compiler             written in Lumen-mu, lowers Lumen-mu source -> Lumen-mu IR
stage 2   run stage 1 ON the seed           seed executes the compiler's IR, so the compiler now runs
stage 3   the compiler compiles ITSELF      producing native (or WASM) output
stage 4   fixpoint                          the compiler compiles itself again; output is byte-identical; the seed is DISCARDED
```

After stage 4, nothing in the shipped toolchain is non-Lumen except the code-generation backend (decision D4), which is the irreducible "produce machine code" step.

## Trusted computing base

Explicitly named, not hidden:
1. **A pinned WebAssembly engine** running the seed. Pinned to a specific version, configured to a pure source-to-artifact function: no clock, no randomness, no environment, a constrained host import surface (see below), NaN canonicalization on, deterministic resource metering (fuel, not wall-clock).
2. **This seed module** itself, which is small enough to be read and adversarially checked by hand and by independent agents.

The correctness of the bootstrap does not rest on `lc1 == lc2` alone (that is only a stability check). It rests on: conformance-suite pass, diverse double-compilation convergence (a second, independently-authored seed must agree), and, as the formal backstop, the mechanized lambda-cap proofs plus a mechanized mu-evaluator semantics. See `../docs/spec/SYNTHESIS.md` (bootstrap) and `../docs/RISKS_AND_OPEN_PROBLEMS.md`.

## Memory layout (linear memory)

```
[0 .. 1024)        scratch / VM registers (operand stack pointer, frame pointer)
[1024 .. heap_lo)  the loaded IR program (functions, blocks, instructions) as a flat table
[heap_lo .. )      a bump+refcount heap for boxed values (Int box, Text bytes, sum, record, Result)
```

Boxed value header (8 bytes): `[ tag:u32 | refcount:u32 ]`, payload follows. `tag` distinguishes Int / Text / Sum / Record / Result. Refcount is the Perceus count (the seed implements `dup`/`drop` as refcount inc/dec with free-on-zero), which is the deterministic-reclamation discipline of `LUMEN_MU.md` realized at the lowest level.

## The single host import (the Console seam)

The seed imports exactly one host function, the primordial `Console` capability operation. Everything else is pure and computed inside the module. The seam is where the deterministic tape records `(Console, arg, result)`.

```
(import "lumen" "console_print" (func $console_print (param i32 i32)))  ;; ptr,len of UTF-8 bytes
```

A WASI-constrained host may instead route this to `fd_write` on stdout; either way it is the only nondeterminism boundary, and it is recorded.

## Runnable WAT sketch (the dispatch core)

This is the smallest piece that actually runs on a WASM engine: a fetch-decode-execute loop over a trivial encoding of three IR opcodes (`const.int`, `add`, `use console`), enough to execute a program that computes a sum and prints it. It is illustrative of the real interpreter, not the whole thing.

```wat
(module
  (import "lumen" "console_print" (func $console_print (param i32 i32)))
  (memory (export "mem") 2)

  ;; opcodes
  (global $OP_CONST_INT i32 (i32.const 1))
  (global $OP_ADD       i32 (i32.const 2))
  (global $OP_USE_PRINT i32 (i32.const 3))
  (global $OP_HALT      i32 (i32.const 0))

  ;; a tiny operand stack at [0..1024); $sp is the byte offset of the next free slot
  (global $sp (mut i32) (i32.const 0))

  (func $push (param $v i32)
    (i32.store (global.get $sp) (local.get $v))
    (global.set $sp (i32.add (global.get $sp) (i32.const 4))))
  (func $pop (result i32)
    (global.set $sp (i32.sub (global.get $sp) (i32.const 4)))
    (i32.load (global.get $sp)))

  ;; run: $pc points at the first instruction word in the IR table.
  ;; instruction encoding (4 bytes opcode, then opcode-specific operands, 4 bytes each)
  (func $run (param $pc i32)
    (local $op i32) (local $a i32) (local $b i32)
    (block $done
      (loop $next
        (local.set $op (i32.load (local.get $pc)))
        (local.set $pc (i32.add (local.get $pc) (i32.const 4)))

        (if (i32.eq (local.get $op) (global.get $OP_HALT))
            (then (br $done)))

        (if (i32.eq (local.get $op) (global.get $OP_CONST_INT))
            (then
              (call $push (i32.load (local.get $pc)))
              (local.set $pc (i32.add (local.get $pc) (i32.const 4)))
              (br $next)))

        (if (i32.eq (local.get $op) (global.get $OP_ADD))
            (then
              (local.set $b (call $pop))
              (local.set $a (call $pop))
              ;; checked add omitted in this sketch; real seed traps to an R#### on overflow
              (call $push (i32.add (local.get $a) (local.get $b)))
              (br $next)))

        (if (i32.eq (local.get $op) (global.get $OP_USE_PRINT))
            (then
              ;; operands: ptr,len of a Text already materialized in memory (sketch)
              (local.set $b (i32.load (local.get $pc)))                       ;; len
              (local.set $a (i32.load (i32.add (local.get $pc) (i32.const 4)))) ;; ptr
              (call $console_print (local.get $a) (local.get $b))
              (local.set $pc (i32.add (local.get $pc) (i32.const 8)))
              (br $next)))

        (br $next)))
    )

  (func (export "main")
    ;; the loader writes the IR program into memory starting at offset 1024,
    ;; then calls $run with pc=1024. (loader omitted in this sketch.)
    (call $run (i32.const 1024)))
)
```

The real seed extends this with: boxed/refcounted values instead of raw i32 (so Text, sum, record, Result work), the full opcode set from `LUMEN_MU.md` (`make.sum`, `proj`, `switch`, `call` with a frame stack, `try`), checked arithmetic that produces a `Result`/`R####` on overflow, and the IR loader that decodes the program table. It stays small because Lumen-mu is small.

## How to run and verify the sketch

A WASM engine compiles the WAT to a module, supplies `lumen.console_print` (writing the bytes to stdout, and recording them as the tape), and calls `main`. Verification is by the conformance suite (`../conformance/`): each Lumen-mu example program, lowered to IR and run on the seed, must produce its expected stdout; each negative program must produce its expected diagnostic code. Because the engine is pinned and its host surface is the single recorded seam, a run is fully reproducible: same IR, same tape, same output, on any machine.

## Why this is disposable

Nothing depends on the seed after stage 4. Its only job is to run the Lumen-mu compiler once so that the compiler can begin compiling itself. The moment the self-hosted compiler reproduces itself byte-for-byte, the seed is removed from the build, and the only remaining non-Lumen artifacts are the pinned WASM engine used during bootstrap (gone from the shipped product) and the codegen backend (decision D4).
