# ARM64 Codegen Spike Findings (lane l3-arm64, Arc 1 90-day item 4)

STATUS: demo landed. mu/examples/add.lm compiles IR -> AArch64 assembly text -> as -> ld
-> a native binary that prints "42\n", byte-identical to the interpreter oracle. No C
and no clang anywhere in the translation path; clang's `as`/`ld` act as assembler and
linker only, exactly as the brief scopes them for this spike.

## Section list

1. Scope and starting point
2. IR-to-arm64 mapping table
3. Mach-O / linking facts learned
4. What breaks at the next IR tier
5. Recommendation and effort estimate for the real emit_arm64.lm
6. Dead ends hit

## 1. Scope and starting point

docs/R3B_ARM64_NOTES.md (read cover to cover first, per the brief) already answered the
two hardest toolchain questions: macOS requires linking against libSystem.dylib (no
fully static binaries), and both raw `svc`-syscall and `bl _write`/`bl _exit` libSystem
paths work. That memo's register plan targets full AAPCS64 register allocation (a real
calling convention with x0-x7 args, x19-x28 callee-saved locals). This spike did NOT
build that: it mirrors emit.lm's existing C translation almost exactly, keeping Lumen's
value stack (S[]), frame-base (ab), and manual call-return arrays (RA[]/AB[], csp) in
.bss memory instead of hardware registers, and only uses real AArch64 instructions to
read/write that memory. This is a deliberate, documented scope-narrowing (see Section 5)
that let the spike land in well under the 2-hour post-first-success budget; it is NOT
the design R3B recommends for the production emit_arm64.lm and should not be read as a
counter-proposal to it.

Actual IR dumped for mu/examples/add.lm (irWords=33, main=17), via compileToIR from
native/pipeline.mjs (dump script written to inspect this, then deleted; not committed):

```
0  op 13 [3]        RESERVE 3         (fn add prologue)
2  op 2  [0]        GETLOCAL 0
4  op 2  [1]        GETLOCAL 1
6  op 3  []         ADD
7  op 9  []         RET
8  TYPEMAP skip 3 0
14 op 1  [0]        PUSH 0            (unrelated fn, never called by main; dead code
16 op 9  []         RET                for this program, still translated faithfully)
17 op 13 [2]        RESERVE 2         (fn main prologue; main entry = pc 17)
19 op 1  [20]       PUSH 20
21 op 1  [22]       PUSH 22
23 op 8  [0, 2]     CALL target=0 argc=2
26 op 10 []         PRINTINT
27 TYPEMAP skip 2 0
32 op 0  []         HALT
```

Exactly the opcode set the brief named: RESERVE(13), PUSH(1), GETARG/GETLOCAL(2),
ADD(3), CALL(8), RET(9), PRINTINT(10), HALT(0), TYPEMAP(57, skip). SETLOCAL(14) does
not appear in add.lm's own IR but was implemented anyway (mirrors emit.lm's op 14
exactly) since the brief lists it as in-scope and it costs nothing extra to include
faithfully.

## 2. IR-to-arm64 mapping table

Runtime state, all in `.bss` (no registers hold VM state across opcodes):

| Lumen VM state | Storage | Notes |
|---|---|---|
| S[] (value stack) | `_S: .space 8388608` | int64 x 1,048,576 entries, same capacity as emit.lm's C array |
| sp (stack pointer) | `_spvar: .space 8` | int64 scalar |
| ab (frame base) | `_abvar: .space 8` | int64 scalar |
| csp (call depth) | `_cspvar: .space 8` | int64 scalar |
| RA[] (return addrs) | `_RA: .space 1600000` | int64 x 200,000, holds real code addresses via `adr` |
| AB[] (saved frame bases) | `_AB: .space 800000` | int32 x 200,000 (matches emit.lm's `int AB[]`) |

Every opcode block reloads sp/ab/csp from memory and writes them back before falling
through to the next label; nothing is assumed live in a register across an opcode
boundary. `x28` is a private "address of a bss variable" scratch register inside the
load/store helpers (load_sp/store_sp/load_ab/store_ab/load_csp/store_csp/addrS/addrRA/
addrAB in emit_arm64_spike.lm); it never carries a value meant to survive past the next
instruction, so no cross-opcode register-allocation problem exists in this design.
`x9`-`x17` are opcode-local scratch, freely reused block to block.

| IR opcode | Semantics (from emit.lm, C reference) | arm64 translation |
|---|---|---|
| 0 HALT | `return 0;` | `mov x0, #0` / `bl _exit` |
| 1 PUSH n | `S[sp]=n; sp=sp+1;` | load sp -> x9; addr(S) -> x11; `mov x10,#n`; `str x10,[x11,x9,lsl #3]`; `add x9,x9,#1`; store sp |
| 2 GETLOCAL n | `S[sp]=S[ab+n]; sp=sp+1;` | load ab -> x9; `add x9,x9,#n`; addr(S)->x11; `ldr x10,[x11,x9,lsl #3]`; load sp->x12; `str x10,[x11,x12,lsl #3]`; `add x12,x12,#1`; store sp |
| 3 ADD | `sp=sp-1; S[sp-1]=S[sp-1]+S[sp];` | load sp(old)->x9; idx_a=x9-2, idx_b=x9-1; add S[idx_a]+S[idx_b] -> S[idx_a]; store sp=idx_b |
| 8 CALL(target,argc) | `RA[csp]=&(pc+3); AB[csp]=ab; csp++; ab=sp-argc; goto target;` | store `adr` of the post-call label into RA[csp] (old csp), AB[csp]=ab (old ab), csp+=1, sp->x14, ab=sp-argc, `b Ltarget` (direct branch: target is compile-time known, no jump table needed in asm, unlike emit.lm's C computed-goto) |
| 9 RET | `r=S[sp-1]; sp=ab; S[sp]=r; sp++; csp--; ab=AB[csp]; goto RA[csp];` | pop r, write to S[ab], sp=ab+1, csp-=1, reload ab=AB[csp], load RA[csp] into x17, `br x17` (indirect: this is the one place a real indirect branch is required) |
| 10 PRINTINT | `sp=sp-1; pic(S[sp]);` | pop into x0, `bl _pic` (hand-rolled int64-to-decimal + `write(2)`, see below) |
| 13 RESERVE n | `while(sp<ab+n){S[sp]=0; sp++;}` | small local loop with `LR<pc>_loop`/`LR<pc>_end` labels |
| 14 SETLOCAL n | `sp=sp-1; S[ab+n]=S[sp];` | pop value, store to S[ab+n] |
| 57 TYPEMAP | skipped entirely by the driver's word-walk | no code emitted (identical to emit.lm) |

Key simplification versus emit.lm's C output: emit.lm needs a runtime `Ltab[]` array of
label addresses because C's `goto *Ltab[pc]` requires the jump table to exist before any
branch can be taken (even direct, compile-time-known targets go through the table in the
C version). In real assembly, a direct branch to a compile-time-known target is just
`b Llabel` resolved by the assembler; no runtime table is needed at all. The *only* place
a true indirect branch is needed is RET, where the target genuinely varies by call site
(`br x17`, loaded from RA[csp]). This cuts real complexity versus the C model, not more of
it, once ported to a native ISA that has both direct labeled branches and indirect
register branches.

`_pic` (int64 -> decimal ASCII + '\n', printed via `write(2)`): builds digits into a
24-byte on-stack scratch buffer from the tail backward (buffer index 23 down to 0),
handles zero and negative specially, computes the final length and start offset, then
does a single `mov x0,#1 / bl _write` with `x1`=buffer address, `x2`=length. The zero path
is reachable and gated (a committed `print_int(0)` program matches the oracle). CAVEAT: the
negative-number path is NOT reachable by any program this spike's opcode subset can emit,
because a negative value requires SUB (op 4), which `emit_arm64_spike.lm` does not implement
and traps on. The negative branch was checked only by hand-tracing and against a prototype
(`proto2.s`) that was not committed, so do not cite this memo as end-to-end proof that
negative-number printing works; that proof waits for the real emitter with SUB.

## 3. Mach-O / linking facts learned (spike-specific additions to R3B's notes)

- `adrp`/`add ...@PAGEOFF` addressing works identically for `.bss`-section symbols as it
  does for `.data`/`.text` on this toolchain (Apple clang 21 / ld64-530, same versions
  R3B recorded). No special relocation handling was needed for `.bss` globals; page-
  relative addressing Just Works the same way documented in R3B section 3.
- The `mov` alias (`mov xN, #imm`) auto-expands to `movz`/`movn` for immediates up to
  16-bit magnitude (tested down to -65535..65535) but does NOT auto-expand a 64-bit
  immediate outside that range: `mov x9, #123456789012345` fails to assemble with
  `expected compatible register or logical immediate`. This spike never needed a larger
  immediate (add.lm's constants are 20, 22, 0) so it side-stepped the issue; the real
  emitter needs an explicit `movz`/`movk` four-instruction sequence for arbitrary 64-bit
  int literals (see Section 4).
- Confirmed again (same as R3B Section 7): `as -o p.o p.s` then
  `ld -o p p.o -lSystem -syslibroot $(xcrun --show-sdk-path)` is the minimum viable
  assemble+link invocation. No `-e _main` or extra flags needed; `_main` as the global
  entry symbol is sufficient.
- `str`/`ldr` with a 32-bit register alias (`w12`) into/out of an `int32`-typed `.bss`
  array (`_AB`) and scaled-index addressing (`lsl #2` for 4-byte elements, `lsl #3` for
  8-byte elements) both worked exactly as expected on the first attempt; no surprises
  there worth flagging beyond "it matches the AArch64 reference manual."

## 4. What breaks at the next IR tier

- **Calls with more than a handful of args, or any real interop with the C ABI /
  external functions**: this spike's CALL/RET pair is Lumen-internal only (a private
  calling convention living entirely in `.bss`, never touching `x0-x7` or the real
  hardware call stack). The moment `emit_arm64.lm` needs to call an external helper
  (memory allocation, string ops, anything from Section 5's option (b) `runtime.s`), it
  must also speak real AAPCS64: args in `x0-x7`, `bl`, return in `x0`, and preserve
  `sp` 16-byte alignment around the call. None of that exists in this spike yet; the two
  calling conventions (VM-internal vs. real AAPCS64) will need to coexist and the
  boundary between them is exactly where R3B's Section 2 "Hybrid Frame Model" applies,
  not to the VM-internal calls this spike handles.
- **Floats.** Zero float handling exists here. R3B Section 4's FMA-contraction hazard
  (`fmadd` vs. separate `fmul`+`fadd`) is real and unaddressed; the spike's opcode set
  has no float opcodes in it at all. `f_exp`/`f_ln`/`f_pow` transcription from
  `lumenc.wat` (R3B Section 4) is unstarted.
- **Large integer immediates.** As found in Section 3: PUSH of a literal outside
  ±65535 needs a `movz x, #(imm & 0xffff)` + up to three `movk x, #chunk, lsl #N`
  instructions, computed from the compile-time-known constant. Lumen's own operator set
  (`/`, `%`) is sufficient to compute the four 16-bit chunks of a 64-bit value without
  needing native bitwise shift/and (already used elsewhere in emit_fn.lm for similar
  byte-splitting, e.g. its length-prefix emission), so this is mechanical, not blocked.
- **String/text opcodes, heap allocation, records/arrays.** All of emit_fn.lm's much
  larger opcode surface (~30+ opcodes vs. this spike's 8) is untouched. Every one of
  those needs either a hand-written arm64 runtime helper (R3B Section 5's option (b)) or
  an in-line instruction sequence per opcode; some (concat, int_to_text, heap bump-alloc)
  are non-trivial enough that hand-writing them in assembly is a real week of work, not
  an afternoon.
- **Recursion depth / real stack safety.** `_S`, `_RA`, `_AB` are fixed-size static
  arrays sized to match emit.lm's C arrays; there is no overflow check anywhere (also
  true of emit.lm today), so this is not a new regression, but it is not solved either.

## 5. Recommendation and effort estimate for the real emit_arm64.lm

Recommendation: do NOT extend this spike's "everything lives in .bss, walk the C model
literally" design into the production emitter. It proved the toolchain and the direct-
branch simplification cheaply, but R3B's register-based Hybrid Frame Model (Section 1-2
of that memo) is the right target for a real backend: keeping hot values in registers
(`x9`-`x15` scratch, `x19`-`x28` callee-saved locals per R3B Section 1) instead of round-
tripping every single value through memory on every opcode is where the real performance
(and the whole point of dropping C) comes from. This spike's value is the mapping table
above (Section 2), the confirmed toolchain facts (Section 3), and a working proof that
the direct-branch simplification versus emit.lm's runtime jump table is real and safe.

Effort estimate for a first real `emit_arm64.lm` covering emit_fn.lm's full opcode
surface (scalar + control + calls + floats, no arrays/heap yet), built on the R3B
register model:
- Scalar/control/int-call opcodes (this spike's set, redone with register allocation
  instead of all-memory): 1-2 days, low risk, this spike de-risked the hard parts.
  Recommend porting these to register-resident sp/ab tracking incrementally.
- 64-bit immediate movz/movk helper: half a day, mechanical (Section 4).
- Float opcodes with the FMA-non-contraction discipline (R3B Section 4) plus
  transcribing `f_exp`/`f_ln`/`f_pow`: 3-5 days, the highest-risk item, because bit-
  identity with the WASM oracle is the hard constraint and float bugs are silent until
  `native_diff.mjs`-style byte comparison catches them.
- Runtime helpers (`lm_alloc_bytes`, `lm_concat`, `lm_int2text`, `lm_texteq`) as a
  hand-written `runtime.s` per R3B Section 5 option (b): 3-5 days, mostly `lm_int2text`
  and `lm_concat` complexity; `lm_alloc_bytes` is a simple bump allocator.
- End-to-end wiring + a native_diff.mjs-equivalent arm64 conformance harness covering
  the full 18-program suite emit_fn.lm already passes: 1-2 days.

Total: roughly 2-3 weeks of focused work for parity with emit_fn.lm's current C-backed
conformance suite, before any register-allocator optimization pass (R4, out of scope
per R3B Section 6). This is consistent with the ROADMAP_2036 Arc 1 framing of this as a
90-day item, not a next-sprint item.

## 6. Dead ends hit

- First attempt at the int-to-decimal print routine (`_pic`) tried to compute the
  final write length inline in the same instruction sequence as computing the buffer
  start offset, and got the offset/length arithmetic tangled (an early draft, never
  assembled, abandoned before running `as` on it). Rewriting it as "commit to a fixed
  24-byte tail-anchored buffer, decrement a write-index as digits are produced, compute
  length as `24 - final_index` only once at the very end" removed the confusion. Kept
  the corrected version as `proto2.s` during development (validated against 42, -7, 0)
  before porting it into `emit_arm64_spike.lm`'s `_pic` label, verbatim.
- Confirmed (not really a dead end, but worth recording precisely) that `mov` cannot
  take a full 64-bit arbitrary immediate in one instruction on this assembler; see
  Section 3/4. Did not attempt a workaround since add.lm's constants did not need one;
  flagged as next-tier work instead of solving it here (stop rule discipline: the brief
  scopes this spike to add.lm's needs only).
- No failed assemble/link attempts on the committed `emit_arm64_spike.lm` output itself:
  the first full `node arm64_spike_check.mjs` run assembled, linked, ran, and matched the
  interpreter oracle byte for byte. The 3-consecutive-failure stop rule was never
  triggered.

## Honest notes (what I would do differently for the real emitter)

Start with register-resident sp/ab from the beginning rather than an all-memory model,
even for the smallest possible opcode set. The all-memory model made THIS spike easier
to write and prove correct with less risk of a register-allocation bug in a first
attempt, but it is a design dead end for the production backend: the entire motivation
for dropping C is speed, and reloading sp/ab/csp from `.bss` on every single opcode
throws that away. I would treat this spike's mapping table as the semantic reference and
its all-memory code as scratch, and write the real `emit_arm64.lm` opcode-by-opcode
against R3B's register model directly, using this spike only to check semantics (build a
plan pair: this spike's block for opcode N gives the "obviously correct" answer, then
find the register-resident equivalent and diff behavior on the same test programs before
trusting it).
