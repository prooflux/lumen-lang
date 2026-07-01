# R4 Inlining Pass Design

This document details the design for the future IR-level inlining pass for the Lumen VM optimizer.

## 1. Candidate Criteria

To balance optimization opportunities with code size growth, we define the following rules for inlining candidates:
- **Callee Word-Count Threshold**: A callee is a candidate only if its body size (excluding its `RESERVE` and `TYPEMAP` metadata) is below a threshold of **64 IR words**.
- **Leaf-Only First**: Initially, only leaf functions (functions containing no `CALL` (8) instructions) are eligible for inlining. This simplifies the transformation by avoiding nested inlining complexity and recursive expansion logic.
- **Recursion Exclusion**: Both directly recursive functions and mutually recursive functions must be excluded. Mutual recursion is detected during the program decode walk by maintaining an active traversal stack of traversed function entry points (building a call graph) and checking for cycles.
- **Call-Site Count Limits**: To prevent code bloat, a callee can be inlined at a maximum of **4 call sites**. If a callee is called more than 4 times, inlining is skipped for all its sites.

---

## 2. The Transform (Word-Precise)

When replacing a `[CALL target argc]` instruction at `pc` with the callee body:

### Argument Mapping & Stack Adjustment
Before the `CALL` instruction, the caller has pushed `argc` arguments onto the operand stack (`osp`).
In the interpreter (`projects/lumen/seed/lumenc.wat` lines 1391-1399), `CALL` shifts the argument base:
`global.set $argbase (i32.sub (global.get $osp) (local.get $argc))`
This makes the pushed arguments correspond to the callee's local slots `0` to `argc - 1`.

When inlining, we must preserve this mapping without changing the caller's `$argbase`.
1. We append the callee's frame slot storage to the caller's frame. Let `caller_fs` be the caller's original frame size.
2. The callee's slots `0` to `callee_fs - 1` are mapped to caller's slots `caller_fs` to `caller_fs + callee_fs - 1`.
3. To load the arguments from the operand stack into these new local slots, we prepend the callee body with a sequence of `SETLOCAL` instructions popping from the operand stack:
   - `SETLOCAL (caller_fs + argc - 1)`
   - `SETLOCAL (caller_fs + argc - 2)`
   - ...
   - `SETLOCAL (caller_fs + 0)`
   This restores the caller's operand stack pointer to its state before arguments were pushed, and moves the arguments into the mapped local slots.

### Body Translation
For every instruction inside the callee body:
- **`GETARG(2) slot`** (read slot `slot` from frame: `lumenc.wat` lines 1291-1293): Rewritten to `GETARG (caller_fs + slot)`.
- **`SETLOCAL(14) slot`** (write slot `slot` in frame: `lumenc.wat` lines 1422-1427): Rewritten to `SETLOCAL (caller_fs + slot)`.
- **`RET(9)`** (return value: `lumenc.wat` lines 1400-1407): In the VM, `RET` pops the return value `t`, resets `osp` to `argbase`, and pushes `t` back. When inlined, the callee's local variables are just part of the caller's frame (higher up on the stack, not affecting caller's active operand stack height). Therefore, the return value is already on top of the stack. We replace `RET` with a jump: `JMP label_end`, where `label_end` points to the first instruction immediately after the inlined callee body.

### Frame Merge (`RESERVE` Handling)
In `lumenc.wat` lines 1414-1421, `RESERVE n` initializes local variables up to `argbase + n`.
When inlining, the callee's `RESERVE` instruction is discarded. The caller's `RESERVE caller_fs` at the function entry is updated to:
`RESERVE (caller_fs + callee_fs)`
This allocates and zero-initializes the merged frame slots for both the caller and the inlined callee at the function start.

### `TYPEMAP` Handling
In `emit_fn.lm` lines 40-53, `type_of_slot(func_pc, slot)` scans forward from the function entry for a `TYPEMAP` (57) instruction to derive types for local variables.
If the caller's typemap is not updated, calling `type_of_slot` on any inlined slot index `caller_fs + j` will return `0` (Int / `int64_t`), breaking type-safety if the slot is a `Float` (type `1`).
To prevent this:
1. We locate the caller's `TYPEMAP` instruction (opcode 57).
2. We update the number of total slots `ntot` to `ntot + callee_fs`.
3. We append the types of the first `callee_fs` slots from the callee's typemap to the caller's typemap.

---

## 3. Relocation Interplay

Inlining grows the IR code size, violating the standard compaction assumption that code length only shrinks.
- **Relocation Map**: The `get_map` array (`optimize.lm` lines 38-43) maps the old PC of each instruction to its new PC in the output. When inlining is performed:
  - Instructions before the `CALL` map 1-to-1.
  - The `CALL` instruction maps to the sequence of pop-arguments, inlined callee body, and label end.
  - Instructions after the `CALL` map to `new_pc = old_pc + net_growth`.
- **Fail-Safe Sizing**: Page 9 memory constraints must be strictly respected.
  - The optimizer uses five scratch regions (`orig`, `target`, `keep`, `map`, `out`) starting at `524288`.
  - The memory limit before clobbering the counters at `589812` is **2500 words** total.
  - If the growth causes the output code size `new_pc` to exceed `orig_len` such that it goes out of bounds, or if `new_pc > 2500`, the optimizer must abort, invoke `restore_orig`, and return 0 (unchanged) to prevent memory corruption.

---

## 4. Fail-Safe Catalogue

The inlining pass will abort and return the input IR unchanged if any of the following conditions are met:
1. **Size Limit Exceeded**: The projected output length `new_pc` exceeds `orig_len` (unless safety headroom is allocated) or total size exceeds **2500 words**.
2. **Recursion Detected**: The callee is directly recursive or mutually recursive.
3. **Invalid Callee Target**: The `CALL` target does not point to a valid function entry (no `RESERVE` or `TYPEMAP` found).
4. **Arity Mismatch**: The `argc` operand of the `CALL` does not match the arity of the target function derived from its signature.
5. **Callee Too Large**: The callee body size exceeds the 64-word threshold.
6. **Nesting/Inlining Depth Limit**: The nesting depth exceeds 4 levels.
7. **Malformed Typemap**: The callee or caller has a malformed or missing `TYPEMAP` record.

---

## 5. Measured Justification Plan (Candidate Census)

A scan of the current corpus programs (`projects/lumen/mu/examples/*.lm`) was performed to count candidate call sites:

| Program | Call Sites | Details (PC, Entry, Argc) |
|---|---|---|
| `add` | 1 | `[{"pc":23,"entry":0,"argc":2}]` (Inlinable Leaf) |
| `compare` | 3 | `[{"pc":37,"entry":0,"argc":1},{"pc":43,"entry":0,"argc":1},{"pc":49,"entry":0,"argc":1}]` (Inlinable Leaf) |
| `count` | 0 | None |
| `fact` | 2 | `[{"pc":19,"entry":0,"argc":1},{"pc":36,"entry":0,"argc":1}]` (Recursive - Excluded) |
| `fib` | 3 | `[{"pc":17,"entry":0,"argc":1},{"pc":25,"entry":0,"argc":1},{"pc":42,"entry":0,"argc":1}]` (Recursive - Excluded) |
| `fib_print` | 3 | `[{"pc":17,"entry":0,"argc":1},{"pc":25,"entry":0,"argc":1},{"pc":42,"entry":0,"argc":1}]` (Contains recursive callee `fib`) |
| `fizzbuzz` | 3 | `[{"pc":70,"entry":0,"argc":1},{"pc":83,"entry":56,"argc":3},{"pc":105,"entry":56,"argc":3}]` (Recursive) |
| `forward` | 1 | `[{"pc":4,"entry":14,"argc":1}]` (Inlinable Leaf) |
| `gcd` | 2 | `[{"pc":19,"entry":0,"argc":2},{"pc":38,"entry":0,"argc":2}]` (Recursive) |
| `greet` | 0 | None |
| `hello` | 0 | None |
| `locals` | 1 | `[{"pc":36,"entry":0,"argc":1}]` (Inlinable Leaf) |
| `max` | 1 | `[{"pc":32,"entry":0,"argc":2}]` (Inlinable Leaf) |
| `mutual` | 3 | `[{"pc":17,"entry":29,"argc":1},{"pc":46,"entry":0,"argc":1},{"pc":62,"entry":0,"argc":1}]` (Mutually Recursive - Excluded) |
| `propagate` | 4 | `[{"pc":57,"entry":0,"argc":1},{"pc":80,"entry":0,"argc":1},{"pc":103,"entry":0,"argc":1},{"pc":159,"entry":53,"argc":3}]` |
| `report` | 3 | `[{"pc":17,"entry":0,"argc":1},{"pc":25,"entry":0,"argc":1},{"pc":44,"entry":0,"argc":1}]` |
| `safe_div` | 4 | `[{"pc":117,"entry":0,"argc":2},{"pc":122,"entry":33,"argc":2},{"pc":131,"entry":0,"argc":2},{"pc":136,"entry":33,"argc":2}]` |
| `sum_loop` | 0 | None |

This census confirms that leaf inlining will immediately optimize `add`, `compare`, `forward`, `locals`, and `max` without violating size or recursion constraints.


## Manager review note (load-bearing dependency, added at checkpoint review)

The RET-replacement design (JMP past the inlined body, return value left on the operand stack)
is sound ONLY because expression statements are stack-balanced since the seed discard fix
("fix(seed): resolve operand stack leak on standalone expression statements", #188). The real
RET also resets sp to argbase, silently discarding any operand-stack junk the callee body left;
the inlined form has no such reset. If statement balance ever regresses, inlined callees leak
operand slots at every early RET and the corruption is silent. The implementation round MUST add
a gate case with an early-RET callee inside a long loop to pin this, and the basics leak tests
are upstream guards for this pass.
