# Lumen-mu: the bootstrap subset and its IR

Status: draft v0.1. Lumen-mu is the smallest subset of Lumen that is internally complete: it is expressive enough to eventually write the Lumen compiler in, and small enough that the first executor (the WAT seed, `../../seed/ARCHITECTURE.md`) can run it. It elaborates to lambda-cap (`LAMBDA_CAP.md`), so the metatheory applies. Everything here is deliberately minimal; features are added only after the self-hosting fixpoint.

## 1. What is in Lumen-mu, and what is deliberately out

In:
- Functions (`fn`), immutable bindings (`let`), recursion.
- Types: `Int` (64-bit, checked), `Bool`, `Text`, one user sum type, one user record type.
- `if`/`else` and `match` (exhaustive).
- `Result[T, E]` and the non-coercing propagation operator `?`.
- Exactly one capability: `Console` (a single operation, `print: Text -> Unit`). It is the only effect and the only seam.
- The canonical structured Diagnostic.

Out (added after self-hosting, each with a clear later path):
- Floating point (so D9 does not touch the bootstrap path at all).
- Generics and traits (mu is monomorphic; the mu compiler is written without generics, using explicit sum types).
- `var`/mutation (mu is pure-functional plus the `Console` seam; mutation arrives with the `Resource`/Perceus layer later).
- Concurrency, the arena/`Graph` cycles, FFI, metaprogramming.
- Multi-shot handlers (mu uses only the primordial `Console` handler at the runtime root; no user handlers).

This subset is enough to write a lexer, a parser, a bidirectional type checker, a lowering to the mu IR, and a code emitter, which is exactly what the self-hosted compiler needs.

## 2. Grammar (EBNF, a strict subset of `GRAMMAR.md`)

```
program   = { item }
item      = fn-decl | type-decl
fn-decl   = "fn" ident "(" [ params ] ")" "->" type block
params    = param { "," param }
param     = ident ":" type
type-decl = "type" ident "=" ( sum-body | record-body )
sum-body  = "|" variant { "|" variant }
variant   = ident [ "(" type { "," type } ")" ]
record-body = "{" field { "," field } "}"
field     = ident ":" type
type      = "Int" | "Bool" | "Text" | "Unit" | ident
          | "Result" "[" type "," type "]"

block     = "{" { stmt } "}"
stmt      = "let" ident [ ":" type ] "=" expr
          | "return" expr
          | expr

expr      = "if" expr block "else" block
          | "match" expr "{" { arm } "}"
          | or-expr
arm       = pattern "->" ( expr | block )
pattern   = "_" | int-lit | ident | ident "(" [ pattern { "," pattern } ] ")"

or-expr   = and-expr { "or" and-expr }
and-expr  = cmp-expr { "and" cmp-expr }
cmp-expr  = add-expr [ ("==" | "!=" | "<" | "<=" | ">" | ">=") add-expr ]   # non-associative, single compare
add-expr  = mul-expr { ("+" | "-") mul-expr }
mul-expr  = post-expr { ("*" | "/" | "%") post-expr }
post-expr = primary { call | field-access | try }
call      = "(" [ expr { "," expr } ] ")"
field-access = "." ident
try       = "?"
primary   = ident | int-lit | text-lit | "true" | "false" | "(" expr ")"
          | "ok" "(" expr ")" | "err" "(" expr ")"
```

This grammar is left-factored and parses with one token of lookahead at each decision point plus the documented postfix layer (`call`/`field-access`/`try`), exactly as the synthesis requires. Cross-class operator mixing (for example `a + b * c`) is parsed by the precedence ladder above, and the formatter inserts the clarifying parens; same-class chains are bare. A single comparison is allowed; chained comparison `a < b < c` is sugar for `a < b and b < c` (defined, not an error).

## 3. Type checking (bidirectional, local)

Two modes, no global inference:
- **Check** `G |- e <= T` : check that `e` has the expected type `T`.
- **Synthesize** `G |- e => T` : infer `e`'s type from its structure.

Boundaries (`fn` parameter and return types, `let` with an annotation, public fields) are annotated, so checking is always local and every error is co-located with an annotation. Key rules (abbreviated):

```
(syn-var)   x:T in G              =>  x : T
(syn-lit)   n                      =>  Int        ;  "s" => Text ; true/false => Bool
(chk-if)    G|- c <= Bool   G|- e1 <= T   G|- e2 <= T   =>  if c {e1} else {e2} <= T
(chk-match) scrutinee => S (a sum type)   every variant of S has exactly one arm   each arm body <= T
              ----------------------------------------------------------------------------------------
              match ... <= T              [exhaustiveness is checked here; a missing variant is E0210]
(syn-call)  f => (T1,..,Tn) -> R    each arg_i <= T_i      =>  f(args) : R
(chk-ok)    G|- e <= T              =>  ok(e) <= Result[T, _]
(syn-try)   e => Result[T, E]   enclosing fn returns Result[_, E]   =>  e? : T   [non-coercing: E must match]
(use-print) console : Console in G   G|- e <= Text   =>  console.print(e) : Unit ! {Console}
```

Effect rows are derived exactly as in lambda-cap: only `console.print` (which elaborates to `use`) adds `{Console}`. A `fn` with no `Console` parameter is pure, and the checker proves it. The propagation rule `(syn-try)` is non-coercing: the error type `E` must already match the enclosing function's error type; there is no implicit `From`.

Diagnostics from type checking are instances of the canonical Diagnostic (Section 5): `E0102` type mismatch, `E0210` non-exhaustive match, `E0150` chained-comparison-needs-parens (where applicable), with byte spans and typed expected/actual.

## 4. The Lumen-mu IR

A small, typed, deterministic IR in A-normal form (every intermediate result is named; every operand is a variable or a literal). This is what the WAT seed executes and what the self-hosted backend lowers from.

Value representation (boxed, tagged, in linear memory for the seed):
- `Int` : a 64-bit two's-complement integer (checked arithmetic; overflow yields a `Result` at the surface, a runtime `R####` in the IR).
- `Bool` : 0 or 1.
- `Text` : a length-prefixed UTF-8 byte sequence in linear memory.
- sum value : a tag (which variant) plus its fields.
- record value : its fields in declaration order.
- `Result` : a sum with two variants `Ok`/`Err`.
- a capability (`Console`) : an opaque handle the runtime root provides; in the seed it is the identity of the single imported host function.

Instruction set (each instruction names its result):
```
%r = const.int  N
%r = const.text "..."
%r = const.bool B
%r = add %a %b        (also sub mul div mod : checked)
%r = cmp.lt %a %b     (also le gt ge eq ne -> Bool)
%r = and %a %b        (also or, not)
%r = make.sum  TAG [%f0 %f1 ...]
%r = make.rec  [%f0 %f1 ...]
%r = proj      %v INDEX           (field/variant-field projection)
%r = tag       %v                 (the variant tag of a sum, for match dispatch)
       switch %tag [ TAG0 -> L0, TAG1 -> L1, ... ]   (exhaustive, dispatch for match)
%r = call      FN [%a0 %a1 ...]
%r = use       %cap %arg          (the ONLY seam; for Console, %arg : Text, result Unit)
       ret      %v
       br       L | br.if %c L1 L2
%r = ok %v | err %v
       try      %v -> %ok continue | %err propagate   (lowered to a tag/switch on Result)
```

Functions are basic-block graphs. The IR is deterministic: evaluation order is fixed by the A-normal-form sequence, there is no observable pointer identity (values are compared structurally), and the only seam is `use %cap`. This is the calculus's trace made concrete: the tape is the sequence of `use` results against the primordial `Console`.

### Lowering example: `fib`

Surface (`mu/examples/fib.lm`):
```
fn fib(n: Int) -> Int {
  if n < 2 { return n }
  return fib(n - 1) + fib(n - 2)
}
```
lowers to (one function, blocks elided for brevity):
```
fn fib(n):
  %c2  = const.int 2
  %lt  = cmp.lt n %c2
  br.if %lt Lbase Lrec
Lbase:
  ret n
Lrec:
  %1   = const.int 1
  %n1  = sub n %1
  %a   = call fib [%n1]
  %2   = const.int 2
  %n2  = sub n %2
  %b   = call fib [%n2]
  %s   = add %a %b
  ret %s
```

## 5. The canonical Diagnostic instance for mu

The one structure every mu tool emits (the human `message` is rendered downstream from `code` + `args`, not stored):

```
Diagnostic {
  schema_version: 1,
  code:     "E0102",                 # structural family (E01 = type) + discriminant
  severity: "error",                 # error | warning | note
  span:     { file: "x.lm", start_byte: 142, end_byte: 147,
              start: {line: 7, col: 11}, end: {line: 7, col: 16} },
  args:     { expected: {type: "Int"}, actual: {type: "Text"} },   # TYPED, not prose
  fixes:    [ { tier: "auto", title: "wrap with to_int", edits: [ {span: ..., insert: "to_int(", ...} ] } ],
  related:  [ ],                     # secondary spans
}
```

Three seed diagnostics:
- `E0102` type mismatch: `args = { expected, actual }`, auto-fix where a total conversion exists.
- `E0210` non-exhaustive match: `args = { missing: ["Triangle"] }`, auto-fix inserts the missing arm stub.
- `E0001` parse error: `args = { expected: ["fn", "type"], found: "let" }`, recovery resyncs on the delimiter stack (one diagnostic per fault).

## 6. The build order this enables

With this subset, its IR, and the seed (next), the implementation order is: (1) the WAT seed that executes the IR; (2) a Lumen-mu compiler written in Lumen-mu (lexer, bidirectional checker, lowering to the IR); (3) run that compiler on the seed to compile itself; (4) reach the byte-identical fixpoint and discard the seed. Each step has a conformance check (`../../conformance/`): the example programs and their expected outputs and diagnostics.
