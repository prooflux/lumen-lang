# Result, sum types, and match: stage-0 compiler design

Status: implementation plan for the next seed increment. Targets the vision's
"wedge to start now" (`docs/VISION_2035.md`): make real programs and error
handling expressible.

## Targets (the project's own waiting conformance examples)

| Example | Exercises | Expected stdout |
|---------|-----------|-----------------|
| `mu/examples/safe_div.lm` | user sum type, `Result`, exhaustive `match`, nested `match` | `ok 4\ndiv by zero\n` |
| `mu/examples/propagate.lm` | `Result`, the non-coercing `?` operator, `text_eq` | `9\n` |

These compile to "unexpected token" diagnostics today (no `type`/`match`/`?`).

## Runtime representation

A sum value is a heap cell, 16 bytes, bump-allocated from `$hp` (the same heap
the interpreter uses for `Text`; at run time `$hp` continues above the string
literals materialized at compile time):

```
[ +0 ] tag     (i32)   which variant. Result: ok=0, err=1. User types: declaration order.
[ +8 ] payload (i64)   the carried value: Int, a Text pointer, or a nested sum pointer.
                       Nullary variants (e.g. DivByZero) carry 0.
```

## New opcodes (encapsulate the layout; no general load/store needed)

| Op | Name | Effect |
|----|------|--------|
| 25 | `MKSUM tag` | pop payload(i64), alloc 16B cell, store tag@+0 + payload@+8, push cell ptr |
| 26 | `SUMTAG` | pop cell ptr, push `i32.load(ptr+0)` |
| 27 | `SUMVAL` | pop cell ptr, push `i64.load(ptr+8)` |
| 28 | `TEXTEQ` | pop b, pop a (Text ptrs), push 1 if equal bytes else 0 |

`MKSUM` adds a heap-bounds guard: if the bump would exceed memory, it halts
(safety: no out-of-bounds, consistent with the hang-proofing already landed).

## Compile-time tables

`VARIANTS [name_off, name_len, tag]`, seeded with `ok`->0 and `err`->1.
Each `type T = | A | B(...)` appends `A`->0, `B`->1, ... in declaration order.
A constructor or a match pattern name resolves to its tag here.

## Parser / codegen

1. **`type NAME = | V1 | V2 | ...`** — new top-level form in `c_program`.
   Register each variant name -> tag. A variant may be nullary (`DivByZero`) or
   carry one field (`Some(Int)`, whose field type is skipped like other types).
   Emits no IR.

2. **Constructors** (in `c_primary`, checked before the generic call path):
   when an IDENT is a known variant name,
   - `Name(arg)` -> eval arg (payload), `MKSUM tag`;
   - bare `Name` (nullary) -> `PUSH 0`, `MKSUM tag`.

3. **`match SCRUT { PAT -> BODY ... }`** (an expression; reachable as a statement):
   - eval SCRUT, store to an anonymous local `S`;
   - for each arm with pattern `P`:
     - `_` wildcard: unconditional;
     - `Name` / `Name(bind)`: load `S`, `SUMTAG`, `PUSH tag(Name)`, `EQ`, `JZ next`;
       if `Name(bind)` and `bind != _`: add `bind` as a local; load `S`, `SUMVAL`, `SETLOCAL bind`;
     - emit BODY; `JMP end`; `next:`
   - `end:`  Nested `match` falls out for free (an arm body is just an expression).

4. **`?` postfix** (in `c_primary`, after a primary yielding a `Result`):
   store to anonymous local `S`; load `S`, `SUMTAG`, `PUSH 1`, `EQ`, `JZ ok`;
   (err) load `S`, `RET`; `ok:` load `S`, `SUMVAL`. Non-coercing: the err value is
   returned unchanged, so the enclosing fn's error type must match.

## Scratch + binding locals

`match` and `?` need scratch slots: `$tmp_local()` bumps `$nlocal` and returns the
new slot (unnamed). Binding patterns add a *named* local via `$local_add`. `RESERVE`
is already backpatched to `nparam + nlocal` at fn end, so the frame sizes correctly.

## Out of scope for this slice (future increments)

Generic type params beyond the built-in `Result[T,E]`, multi-field variants,
and compiler-enforced exhaustiveness. The two target examples are exhaustive by
construction; exhaustiveness checking is a separate, type-system increment.
