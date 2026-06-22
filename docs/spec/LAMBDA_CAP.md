# lambda-cap: the Lumen core calculus

Status: draft v0.1, normative for the semantics. Hand-authored (the multi-agent proof-check pass is deferred to a follow-up; mechanization is a tracked next step). This is the small calculus from which Lumen's surface is elaborated. It exists to pin down, and eventually to prove, the three claims the whole language rests on: effects are exactly the capabilities a term uses, purity is the empty effect, and a capability cannot escape the scope that granted it.

lambda-cap is intentionally tiny. It is not Lumen; it is the kernel that Lumen desugars into for the purpose of stating and proving the metatheory. Surface features (records, traits, generics, the formatter, diagnostics) are elaboration on top of this kernel and do not change the metatheory.

## 1. Syntax

```
kinds        c          (a finite set of capability kinds, e.g. Console, Clock, Fs)
regions      l          (scope labels, introduced by handlers; not written by the user)

Types   T ::= Unit | Bool | Int | Text
            | T ->R T                  function with latent effect row R
            | Cap c @ l                a capability of kind c, scoped to region l
            | T + T                    sum
            | T * T                    product
            | Result T T

Rows    R ::= {}                       pure
            | {c}                       uses capability kind c
            | R u R                     union (rows are finite sets of kinds; idempotent, commutative)

Terms   e ::= x                        variable
            | () | true | false | n | "s"
            | \x:T. e                   abstraction
            | e e                       application
            | let x = e in e
            | use k e                   invoke the operation of capability k on argument e   (THE ONLY effectful form)
            | handle[c] e with h        install a handler for kind c over e
            | resume v                  resume a captured continuation (only inside a handler clause)
            | inl e | inr e | case e of x. e | y. e
            | (e, e) | fst e | snd e
            | ok e | err e | try e      Result intro and propagation

Handler h ::= \arg. \k_resume. e        a clause given the operation argument and a one-shot resumption

Values  v ::= () | true | false | n | "s"
            | \x:T. e
            | kap[c,l]                   a capability value of kind c at region l  (NO surface introduction form)
            | (v, v) | inl v | inr v | ok v | err v
```

The single most important syntactic fact: there is **no introduction form for a capability value** in source terms. A `kap[c,l]` only ever comes into existence by installing a handler (`handle[c]`), and it is only ever obtained by a term through a binder. Capabilities are therefore unforgeable: you cannot write one down, you can only be handed one.

`use k e` is the only term that performs an effect. Everything else is pure by construction. This is what makes the effect row derivable rather than declared.

## 2. Static semantics

Two contexts. `G` (Gamma) binds ordinary value variables. `D` (Delta) binds capability variables and is **affine**: each capability variable is used at most once along any control path (this is the Perceus/ownership discipline at the type level). The judgment is

```
G ; D  |-  e : T ! R
```

read "under value context G and affine capability context D, term e has type T and may perform at most the effects in row R."

Selected rules (the load-bearing ones):

```
(T-Var)        x:T in G
               --------------------------
               G ; .  |-  x : T ! {}

(T-Unit/Lit)   ----------------------------       (and analogously for () true false n "s")
               G ; .  |-  n : Int ! {}

(T-Abs)        G, x:T1 ; D  |-  e : T2 ! R
               -------------------------------------------
               G ; .  |-  \x:T1. e : (T1 ->R T2) ! {}          [the body's row R becomes the arrow's LATENT row; building a closure is itself pure]

(T-App)        G ; D1 |- e1 : (T1 ->R T2) ! R1     G ; D2 |- e2 : T1 ! R2
               -------------------------------------------------------------
               G ; D1,D2  |-  e1 e2 : T2 ! (R1 u R2 u R)      [calling discharges the latent row R; D1,D2 disjoint = affine split]

(T-Let)        G ; D1 |- e1 : T1 ! R1     G, x:T1 ; D2 |- e2 : T2 ! R2
               -----------------------------------------------------------
               G ; D1,D2  |-  let x=e1 in e2 : T2 ! (R1 u R2)

(T-Use)        k : Cap c @ l  in D       G ; D' |- e : Targ ! R
               --------------------------------------------------------
               G ; D - {k} , D'  |-  use k e : Tres(c) ! (R u {c})     [using a capability of kind c ADDS exactly {c} to the row; k is consumed (affine)]

(T-Handle)     G ; D, k:Cap c @ l |- e : T ! R          l NOT free in T          l fresh
               h is a well-typed clause for kind c
               ---------------------------------------------------------------------------------------
               G ; D  |-  handle[c] e with h : T ! (R - {c})          [installing a handler DISCHARGES kind c from the row and introduces a fresh region l]
```

Three consequences are exactly the design commitments, now as rules:

- **Effects are derived, not declared.** No rule lets the author write a row onto a term. A row only grows through `(T-Use)` and only shrinks through `(T-Handle)`. The arrow's latent `R` in `(T-Abs)` is read off the body, not annotated. (At surface boundaries Lumen requires the function type, including its row, to be written; that is a checking convenience, and `(T-Abs)` is the source of truth the annotation must agree with.)
- **Purity is the empty row.** A closed term typeable as `T ! {}` uses no capability, so by `(T-Use)` being the only effectful rule, it performs no effect. This is Theorem 2 below.
- **Capabilities cannot escape.** `(T-Handle)` requires the fresh region `l` to not appear free in the result type `T`. Since a capability handed out at this scope has type `Cap c @ l`, it cannot be part of the result (returned, stored in a returned pair, or closed over in a returned function), because that would force `l` into `T`. This is the runST/region trick, and it is Theorem 3 below.

The affinity of `D` (each capability variable consumed at most once, the `D1,D2` splits being disjoint) is the type-level shadow of Perceus ownership: a capability is an owned resource. `(T-Use)` consumes `k`. A capability that is never consumed on a path is dropped at the end of its scope (Section 4).

## 3. Operational semantics

Call-by-value, left-to-right, deterministic. Evaluation contexts:

```
E ::= []
    | E e | v E
    | let x = E in e
    | use k E | use E e          [the capability position also evaluates; in practice k is a value]
    | handle[c] E with h
    | inl E | inr E | case E of ... | (E,e) | (v,E) | fst E | snd E | ok E | err E | try E
```

Core reductions (the interesting ones are `use`/`handle`/`try`):

```
(R-App)     (\x:T. e) v            -->   e[v/x]
(R-Let)     let x = v in e         -->   e[v/x]
(R-Case-L)  case (inl v) of x.e1|y.e2  -->  e1[v/x]            (R-Case-R analogous)
(R-Fst)     fst (v1,v2)            -->   v1                    (R-Snd analogous)
(R-Try-Ok)  try (ok v)             -->   v
(R-Try-Err) try (err v)            -->   propagate(err v)      [unwinds to the nearest enclosing function boundary, yielding err v there; the non-coercing propagation: the error value is carried unchanged]

(R-Handle-Val)  handle[c] v with h   -->   v                  [no operation occurred; the handler is discarded]

(R-Use)     handle[c] E[ use kap[c,l] v ] with h
              -->   h v (\r. handle[c] E[r] with h)
            provided kap[c,l] is the capability installed by THIS handler and there is no nearer handle[c] inside E
```

`(R-Use)` is the effect-handler reduction: invoking the operation runs the handler clause `h` with the argument `v` and a resumption that plugs the result back into the evaluation context under the same handler. The resumption `\r. handle[c] E[r] with h` is the captured continuation.

**One-shot by default.** The resumption value passed to `h` is affine: the type of `resume` makes it usable at most once. A handler that needs to resume more than once must be typed as multi-shot, which taints the effect row with a `Multi` marker (so multi-shot is visible and the optimizer/debugger can account for it). The default `(R-Use)` above is sound for one-shot resumption; multi-shot requires the continuation to be copyable, which interacts with Perceus and is the riskiest lemma (Section 5).

**The trace (seam log).** Define a trace `t` as the sequence of `(c, v_arg, v_result)` triples recorded at each `(R-Use)` step against a *primordial* handler (one installed by the runtime root, not by user code). User-level handlers are pure rewrites and are not seams. With the trace fixed, the whole configuration is a deterministic rewrite system: this is Theorem 4.

## 4. Ownership (Perceus) and drop

Capabilities, and Lumen values generally, are owned. The ownership judgment inserts `dup`/`drop` so that reference counts are exact and reclamation is deterministic. At the calculus level we state the discipline; the full Perceus algorithm is the implementation of it.

- Each binding is consumed (moved) at its last use along each control path. `(T-Use)` consuming `k` is an instance.
- If a binding is not consumed on a path, a `drop` is inserted at the end of its scope on that path. Drop placement is defined over real control flow: reverse order of last use within a basic block; struct fields in declaration order; for branches, drops are pushed to the earliest point dominating all subsequent non-uses (dominator-aware), so a value live in only one arm is dropped in the other arm, not after the join.
- When a value is uniquely owned (refcount provably 1) and about to be overwritten, its allocation is reused in place. This is the optimization that makes functional update fast and is why no `clone()` appears in source.
- The `Resource` layer (files, sockets, capabilities held as resources) is linear-on-request: a `Resource` must be consumed exactly once on every exit path, including the error path of `try`. `(R-Try-Err)` therefore runs the pending drops/closes for resources in scope before propagating. This is the bracket/with guarantee, and it is what makes "forgot to close" a compile error rather than a leak.

## 5. Metatheory

The four theorems the calculus exists to support. Proofs here are on-paper sketches; the obligations a mechanized proof must discharge are listed. Honesty: the interaction in Theorem 3 with multi-shot resumption (Section 3) is the riskiest and is not yet fully discharged.

### Theorem 1 (Type soundness: progress + preservation)
If `. ; . |- e : T ! R` then either `e` is a value, or `e --> e'` with `. ; . |- e' : T ! R' ` and `R' subset of R`. Effects only shrink or stay as evaluation proceeds (a step never introduces a capability kind the type did not already permit).

Sketch: standard progress/preservation by induction on the typing derivation, with the extra effect-row obligation. The only non-standard cases are `(R-Use)` and `(R-Handle-*)`. For `(R-Use)`, the handler clause `h` is well typed for kind `c`, the resumption is typed at the result type, and the row after the step drops `{c}` for the handled extent, giving `R' subset of R`.

Obligations to mechanize: the substitution lemma must carry the affine context split correctly; the evaluation-context typing (a standard "decomposition" lemma) must preserve rows; the handler clause typing must compose with the resumption type.

### Theorem 2 (Purity soundness)
If `. ; . |- e : T ! {}` then the evaluation of `e` performs no `use` against a primordial handler, i.e. its trace is empty.

Sketch: by `(T-Use)` being the only rule that adds a kind to the row, an empty row means no `use` is reachable in a typing-derivation-respecting reduction; by preservation (Theorem 1) the row stays empty, so no seam is ever recorded.

Obligation: a "well-typed terms do not get stuck on a use they cannot type" corollary of progress; formalize "trace" as an instrumented small-step relation and show the instrumentation never fires when `R = {}`.

### Theorem 3 (Capability non-escape)
If `. ; . |- e : T ! R` and `T` is a "first-order observable" type (no `Cap` anywhere in `T`, which the top-level requires), then no capability value `kap[c,l]` granted by a `handle[c]` inside `e` appears in the final value of `e`, nor is any such capability reachable from it.

Sketch: the `(T-Handle)` side condition `l not free in T` plus preservation. A capability granted at region `l` has a type mentioning `l`; for it to appear in (or be reachable from) the result, the result type would have to mention `l`, which `(T-Handle)` forbids and preservation maintains. Closures capturing a capability carry `l` in their type (the arrow's latent row references `c` and the closed-over `Cap c @ l`), so a returned closure that hoarded a capability would also force `l` into `T`.

Obligations to mechanize, and the RISK: this is clean for one-shot handlers. For multi-shot resumption the continuation is copied, and the proof that no copy smuggles a capability past `l` requires that the resumption's type also be region-closed. This lemma (region closure of multi-shot continuations) is the single most likely place the metatheory breaks and is the first thing to mechanize. Until it is discharged, multi-shot handlers are gated behind an explicit marker and treated as not-yet-proven.

### Theorem 4 (Determinism / replay)
For a closed `e` and a fixed primordial trace `t`, the reduction relation is a partial function: `e` reduces to a unique normal form. Equivalently, the only source of choice in the rewrite system is the result returned by a primordial `use`, and fixing `t` removes it.

Sketch: the reduction relation is deterministic up to the choice of redex, and the evaluation contexts pin a unique redex (left-to-right, call-by-value), so the only branching is the value returned at a primordial seam, which `t` fixes. This is the calculus-level statement of the Determinism Contract.

Obligation: a unique-decomposition lemma for evaluation contexts; a confluence-is-trivial argument (the relation is already a function once `t` is fixed). Connect to the implementation: the floating-point and allocation determinism clauses of `spec/DETERMINISM_CONTRACT.md` are the side conditions that make the implementation's primitive steps match the calculus's deterministic primitive steps.

## 6. From lambda-cap to Lumen

Lumen surface elaborates to lambda-cap: records and ADTs to sums/products, traits to dictionary passing (a dictionary is an ordinary value), generics by monomorphization or dictionary passing, `Result`/`?` to `ok`/`err`/`try`, capabilities-as-parameters directly to `Cap c @ l` binders, `with`/handler blocks to `handle[c]`. The formatter, the diagnostics, the query interfaces, and the IR all operate on the elaborated kernel or on surface forms that have a known elaboration. Nothing in the surface adds expressive power beyond the kernel, so the four theorems lift to the full language modulo the elaboration being type- and effect-preserving (itself a proof obligation, the "elaboration soundness" lemma).

## 7. Status and next step

This is a credible on-paper calculus, sufficient to start implementing Lumen-mu (the executable subset, `LUMEN_MU.md`) against a clear semantics. It is not yet mechanized. The first formal task is to mechanize Theorems 1 to 4 in a proof assistant (the assistant is a verification meta-tool, like the WASM engine in the bootstrap trusted computing base, not a Lumen runtime dependency; the choice of assistant is an open item), with Theorem 3 under multi-shot resumption as the priority lemma. The riskiest design assumption in the whole language lives in that lemma.
