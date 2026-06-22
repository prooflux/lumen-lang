# Lumen Grammar (draft, v0.1 core)

Status: draft. This is the lexical structure and an EBNF grammar for the minimal v0.1 core that the bootstrap compiler will target first. It is intentionally small. Features beyond this core (traits with generics bounds, contracts, the full standard prelude) are layered on by RFC.

Design constraint: the grammar must be unambiguous and parseable with bounded lookahead (target: LL(k) for small k, or a PEG with no ordered-choice surprises). No dangling-else. No significant whitespace. No automatic semicolon insertion. There is exactly one way to write each construct.

---

## 1. Lexical structure

### 1.1 Encoding and whitespace

- Source is UTF-8.
- Whitespace is space, tab, and newline. Whitespace separates tokens and is otherwise insignificant, except that a newline terminates a statement inside a block (see 3.1).
- There is no line-continuation character. The grammar is structured so a statement's continuation is always unambiguous from an open delimiter.

### 1.2 Comments

```
comment      = "#" { any-char-except-newline }
```

There is one comment form. Documentation comments are `#:` and attach to the following item; they are captured by the documentation generator.

### 1.3 Identifiers and keywords

```
ident        = ident-start { ident-continue }
ident-start  = letter | "_"
ident-continue = letter | digit | "_"
```

Keywords (target set, about 25): `fn`, `let`, `var`, `type`, `trait`, `impl`, `match`, `if`, `else`, `for`, `in`, `while`, `return`, `break`, `continue`, `true`, `false`, `and`, `or`, `not`, `requires`, `ensures`, `import`, `as`, `pub`.

Booleans use full words `true`/`false`. Logical operators are the words `and`, `or`, `not`, not symbols, for readability and to avoid the `&&` / `&` family of typo-prone near-misses.

### 1.4 Literals

```
int-lit      = digit { digit | "_" }                    # 1_000_000 allowed
float-lit    = digit { digit | "_" } "." digit { digit | "_" }
text-lit     = '"' { text-char | escape } '"'
escape       = "\\" ( "n" | "t" | "\"" | "\\" | "u{" hex+ "}" )
bool-lit     = "true" | "false"
```

There is one string form (double-quoted, UTF-8). String interpolation is a single explicit form `"value is \(expr)"` and nothing else.

### 1.5 Operators and punctuation

```
+  -  *  /  %        arithmetic
==  !=  <  <=  >  >=  comparison
=                    assignment / binding
->                   function return type, match arm
=>                   (reserved, unused in v0.1)
?                    error propagation (postfix)
.                    field / method access
,  :  ;  ( )  { }  [ ]  |   delimiters
```

There is no operator overloading by users in v0.1. Operators have fixed meaning and fixed precedence (table in section 4).

---

## 2. Top-level structure

```
program      = { item }
item         = import | type-decl | trait-decl | impl-decl | fn-decl
visibility   = [ "pub" ]

import       = "import" path [ "as" ident ]
path         = ident { "." ident }
```

`pub` marks an item exported from its module. Absence means module-private. There is one visibility modifier; there are no finer-grained levels in v0.1.

---

## 3. Declarations

### 3.1 Functions

```
fn-decl      = visibility "fn" ident [ generics ] "(" [ params ] ")"
               [ "->" type ]
               { contract }
               block
params       = param { "," param }
param        = ident ":" type
generics     = "<" ident { "," ident } ">"
contract     = ("requires" | "ensures") expr
block        = "{" { statement } "}"
```

A function with no `->` returns `Unit`. Parameter types are mandatory. Capability parameters are ordinary parameters whose type is a capability type (`FileSystem`, `Clock`, and so on); there is no special syntax for them, which keeps the surface minimal.

Statement termination inside a block: a statement ends at a newline, unless an unclosed delimiter (`(`, `[`, `{`) is open, in which case the statement continues. This rule is unambiguous and requires no semicolons. Semicolons are accepted only as an explicit empty-statement separator and are never required.

### 3.2 Types (declarations)

```
type-decl    = visibility "type" ident [ generics ] "=" type-body
type-body    = record-body | sum-body | type
record-body  = "{" field { "," field } "}"
field        = ident ":" type
sum-body     = { "|" variant }+                     # one or more variants
variant      = ident [ "(" variant-fields ")" ]
variant-fields = field { "," field } | type { "," type }
```

A `type` declaration introduces either a record (named fields), a sum type (variants), or an alias.

### 3.3 Traits and impls

```
trait-decl   = visibility "trait" ident [ generics ] "{" { method-sig } "}"
method-sig   = "fn" ident "(" [ params ] ")" [ "->" type ]
impl-decl    = "impl" ident "for" type "{" { fn-decl } "}"
```

Trait implementation is explicit (`impl Trait for Type`). There is no structural conformance.

### 3.4 Type references

```
type         = ident [ "<" type { "," type } ">" ]      # named, optionally generic
             | "(" [ type { "," type } ] ")"            # tuple / unit
             | "[" type "]"                             # List sugar: [Int] = List<Int>
```

---

## 4. Expressions and statements

```
statement    = let-stmt | var-stmt | assign-stmt | return-stmt
             | if-stmt | for-stmt | while-stmt | break-stmt | continue-stmt
             | expr-stmt

let-stmt     = "let" ident [ ":" type ] "=" expr
var-stmt     = "var" ident [ ":" type ] "=" expr
assign-stmt  = lvalue "=" expr
return-stmt  = "return" [ expr ]
break-stmt   = "break"
continue-stmt= "continue"
expr-stmt    = expr

if-stmt      = "if" expr block [ "else" ( if-stmt | block ) ]
for-stmt     = "for" pattern "in" expr block
while-stmt   = "while" expr block

lvalue       = ident { ("." ident) | ("[" expr "]") }
```

There is one conditional construct (`if`/`else`), one bounded-iteration construct (`for ... in`), and one general loop (`while`). There is no `do/while`, no `loop`, no ternary, no `switch` distinct from `match`.

### 4.1 Expressions

```
expr         = match-expr | binary-expr
match-expr   = "match" expr "{" { match-arm } "}"
match-arm    = pattern "->" ( expr | block )
pattern      = "_" 
             | literal
             | ident                                   # binding
             | ident "(" [ pattern { "," pattern } ] ")"   # variant destructure
             | "(" pattern { "," pattern } ")"             # tuple

binary-expr  = unary-expr { binop unary-expr }          # precedence-climbing, table below
unary-expr   = [ "not" | "-" ] postfix-expr
postfix-expr = primary { call | index | field | try }
call         = "(" [ args ] ")"
index        = "[" expr "]"
field        = "." ident
try          = "?"
args         = expr { "," expr }
primary      = literal | ident | "(" expr ")" | list-lit | record-lit
list-lit     = "[" [ expr { "," expr } ] "]"
record-lit   = ident "{" field-init { "," field-init } "}"
field-init   = ident ":" expr
```

Operator precedence, lowest to highest:

| Level | Operators            | Associativity |
|-------|----------------------|---------------|
| 1     | `or`                 | left          |
| 2     | `and`                | left          |
| 3     | `== != < <= > >=`    | non-assoc     |
| 4     | `+ -`                | left          |
| 5     | `* / %`              | left          |
| 6     | unary `not` `-`      | prefix        |
| 7     | postfix `. () [] ?`  | left          |

Comparison is non-associative: `a < b < c` is a compile error (E0150), not a silent boolean comparison. This removes a classic foot-gun.

---

## 5. What is deliberately absent

- No `null` / `nil` literal. Use `None`.
- No implicit type conversion syntax. Conversions are named function calls.
- No increment/decrement operators (`++`, `--`).
- No comma operator, no chained assignment (`a = b = c`).
- No multiple inheritance, no inheritance at all.
- No exception throw/catch syntax. Errors are `Result` and `?`.
- No preprocessor, no macros (v0.1).

Every omission above removes a way to be subtly wrong or a second way to express something that already has a canonical form.

---

## 6. Worked example against this grammar

```lumen
type Tree<T> =
  | Leaf
  | Node(left: Tree<T>, value: T, right: Tree<T>)

fn size<T>(t: Tree<T>) -> Int {
  match t {
    Leaf                 -> 0
    Node(l, _, r)        -> 1 + size(l) + size(r)
  }
}
```

This program is in the v0.1 core: a generic sum type, a generic function, an exhaustive match with a wildcard, recursion, and arithmetic. The conformance suite will include programs like this with their expected outputs and, for the negative cases, their expected diagnostic codes.
