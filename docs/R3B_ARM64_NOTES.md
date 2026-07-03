# R3b Groundwork Memo - ARM64/AAPCS64 Mapping for the Lumen IR

This document outlines the architectural blueprint and toolchain specifications for the native ARM64 backend (`emit_arm64.lm`), targeting the Apple Silicon (AAPCS64/Mach-O) platform under Rung R3b.

---

## 1. Register Plan under AAPCS64

The AAPCS64 standard defines the usage of the 31 64-bit general-purpose registers (`x0`–`x30`) and 32 128-bit vector/floating-point registers (`v0`–`v31` / `d0`–`d31`).

### General Purpose Registers (GPR)
- **Frame Pointer (`x29` / FP)**: Serves as the frame base pointer. Every non-leaf function must maintain a standard frame record here.
- **Link Register (`x30` / LR)**: Stores the return address for function calls.
- **Stack Pointer (`sp`)**: Must remain 16-byte aligned at all times when memory is allocated on the stack or when subroutine calls are executed.
- **Zero Register (`xzr` / `wzr`)**: Used for zero-valued operations.
- **Argument & Return Registers (`x0`–`x7`)**: Used for integer/pointer parameter passing and return values. These are caller-saved.
- **Scratch / Temporary Registers (`x9`–`x15`)**: Used for transient operations (mapping the expression stack slots `s0`, `s1`, etc. from `emit_fn.lm`). These are caller-saved.
- **Intra-Procedure-call Scratch (`x16`–`x17` / IP0-IP1)**: Reserved for assembler-internal code generation (e.g. loading 64-bit immediate values, jump tables, dynamic linking stubs). Not for general allocation.
- **Platform Register (`x18`)**: Reserved by the platform/OS. Not used by the compiler.
- **Callee-saved Registers (`x19`–`x28`)**: Used for long-lived variables (mapping the function local/constant slots `F0`, `F1`, etc. from `emit_fn.lm`).

### Floating-Point Registers (FPR)
- **Argument & Return (`d0`–`d7`)**: Parameter passing and return values for `double` floats. Caller-saved.
- **Callee-saved (`d8`–`d15`)**: Preserved across function calls. Used for long-lived float local slots.
- **Temporary (`d16`–`d31`)**: Temporary float evaluations. Caller-saved.

### FP/LR x29/x30 Discipline
Every function prologue must establish a valid frame record. This ensures stack unwinders and debuggers work correctly:
```assembly
stp x29, x30, [sp, #-16]!   ; Push FP and LR, decrement SP by 16 (16-byte aligned)
mov x29, sp                 ; FP points to new frame record
```
Before returning, the stack frame must be torn down:
```assembly
ldp x29, x30, [sp], #16     ; Pop FP and LR, restore SP
ret                         ; Return to LR
```

---

## 2. Calling Convention for Lumen Functions vs. AAPCS64

Lumen IR models parameters and local variables as indexed slots `F0`, `F1`, etc. The native compiler must map these to the physical calling convention.

### Recommendation for v1 (Hybrid Frame Model)
We recommend keeping the IR's frame layout in memory or callee-saved registers during v1, and copying parameters at function entry:
1. **Argument Passing**: The first 8 integer/pointer arguments are passed in `x0`–`x7`. The first 8 floating-point arguments are passed in `d0`–`d7`. Additional arguments (if any) are passed on the stack.
2. **Prologue copy**: At the start of a function, copy the argument registers into the designated local slot locations (registers `x19`–`x28` or stack-allocated slots). For example:
   ```assembly
   str x0, [x29, #F0_offset]
   str x1, [x29, #F1_offset]
   ```
3. **Rationale**: This decoupled model keeps the v1 backend robust, easy to debug, and simple. It allows the function body codegen to remain independent of register allocation.
4. **R4 Promotion**: Under R4, the register allocator will perform lifetime analysis and color the local slots, optimizing away the entry copies by keeping the values in `x0`–`x7` or coloring them directly into callee-saved registers when necessary.

---

## 3. Label/Relocation Scheme

### Local Control Flow (JZ/JMP)
- **Labels**: Every instruction label in `emit_fn.lm` is generated as `L<pc>`. In the assembly backend, these are emitted as local labels (e.g. `L<pc>` or `.L<pc>`).
- **Jumps**: Emitted as direct branch instructions:
  - `JMP <target>` $\rightarrow$ `b L<target>`
  - `JZ <cond_slot>, <target>` $\rightarrow$ `cbz x_cond, L<target>` or `cmp/b.eq L<target>`
- **Relocations**: No external relocations are required for local branches. The relative offset is encoded directly in the instruction by the assembler at build time (PC-relative offsets support a range of ±128MB).

### Function Calls (CALL)
- **Internal Calls**: Calls to other Lumen functions (`bl f<target_pc>`) are resolved locally by the linker within the same binary.
- **Runtime Helpers**: Calls to external helpers (e.g. `bl _lm_alloc`) are linked dynamically. The assembler creates undefined symbols, and the linker generates PLT/stub stubs. The compiler relies entirely on standard assembler/linker relocation mechanisms.

---

## 4. Float Strategy & Determinism

Double-precision floats (`f64` in WASM) are mapped directly to 64-bit `d` registers.

### Taylor Series Transcription
The float helper functions `f_exp`, `f_ln`, and `f_pow` must be transcribed line-by-line from their pure-WAT implementation in `lumenc.wat` to equivalent ARM64 assembly loops using double precision instructions (`fadd`, `fsub`, `fmul`, `fdiv`).

### Determinism Hazard: FMA Contraction
- **The Hazard**: ARM64 features a Fused Multiply-Add instruction `fmadd dD, dN, dM, dA` which computes `(dN * dM) + dA` with a single rounding step. A separate `fmul` followed by `fadd` performs two roundings. These two implementations can yield different bits in the least-significant position of the mantissa.
- **The Rule**: Since the WASM interpreter does not use fused multiply-add operations (WASM 1.0 does not specify a contracted FMA opcode), the native backend **MUST NOT** contract separate `fmul` and `fadd` sequences into `fmadd`/`fmsub` instructions. All multiplications and additions must be performed as separate operations to ensure byte-for-byte bit-identity with the reference oracle.
- **Assembly Level**:
  ```assembly
  fmul d2, d0, d1    ; Correct: Separate multiply with rounding
  fadd d3, d2, d4    ; Correct: Separate add with rounding
  ; DO NOT USE: fmadd d3, d0, d1, d4 (violates the determinism contract)
  ```

---

## 5. Runtime-Helper Tradeoffs & Decision

The Lumen compiler requires runtime helpers for memory allocation (`lm_alloc_bytes`, `lm_alloc_sum`), string operations (`lm_concat`, `lm_int2text`, `lm_texteq`), and print output (`lm_printtext`).

### Tradeoffs

| Approach | Pros | Cons |
|---|---|---|
| **(a) Emit helpers as asm dynamically from `emit_arm64.lm`** | 100% self-contained compiler; no auxiliary source files. | Increases code emitter size and complexity; hard to maintain assembly templates. |
| **(b) One hand-written static `.s` file assembled alongside** | Keeps compiler clean; helpers can be written, tested, and optimized directly in asm. | Requires carrying one extra source file (`runtime.s`) in the compiler pipeline. |
| **(c) Keep C helpers compiled via Clang** | No need to write assembly versions of complex functions (like `lm_int2text`). | Violates the clang-removal goal; keeps clang/LLVM in the codegen path. |

### Recommendation
We strongly recommend **Option (b) (one hand-written static `.s` file)**. It satisfies the LLVM/clang-free execution constraint while keeping the compiler codebase modular and simple.

---

## 6. Constraints R4's Register Allocator Must Satisfy

The register allocator (R4) must operate under the following physical target constraints:
1. **Register Classes**:
   - Integer/Pointer variables must map to General Purpose Registers (`x0`–`x15`, `x19`–`x28`).
   - Float variables must map to Floating Point Registers (`d0`–`d7`, `d16`–`d31` or `d8`–`d15`).
2. **Spill Slots**:
   - When active variables exceed available registers, the allocator must spill values to the stack.
   - Spill offsets must be multiples of 8 bytes and relative to FP (`x29`).
   - The final stack allocation must maintain a 16-byte alignment of the stack pointer `sp` at all times.
3. **Register Clobbering**:
   - A function call (`bl`) clobbers all caller-saved registers (`x0`–`x15`, `d0`–`d7`, `d16`–`d31`). Any active variables in these registers must be spilled or moved to callee-saved registers before the call.

---

## 7. Verified Toolchain Facts on this Machine

The following toolchain characteristics and requirements were verified by running tests on this macOS host.

### A. Toolchain Versions
The local compiler tools report the following versions:
```bash
$ as -v </dev/null
Apple clang version 21.0.0 (clang-2100.1.1.101)
Target: arm64-apple-darwin25.5.0
Thread model: posix
InstalledDir: /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin
 "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang" -cc1as -triple arm64-apple-macosx26.0.0 -target-sdk-version=26.5 -filetype obj -main-file-name - -target-cpu apple-m1 -target-feature +v8.5a -target-feature +aes -target-feature +altnzcv -target-feature +ccdp -target-feature +ccpp -target-feature +complxnum -target-feature +crc -target-feature +dotprod -target-feature +flagm -target-feature +fp-armv8 -target-feature +fp16fml -target-feature +fptoint -target-feature +fullfp16 -target-feature +jsconv -target-feature +lse -target-feature +neon -target-feature +pauth -target-feature +perfmon -target-feature +predres -target-feature +ras -target-feature +rcpc -target-feature +rdm -target-feature +sb -target-feature +sha2 -target-feature +sha3 -target-feature +specrestrict -target-feature +ssbs -fdebug-compilation-dir=QUANTS-Working-Trees/lumen-r3b-memo -dwarf-debug-producer "Apple clang version 21.0.0 (clang-2100.1.1.101)" -dwarf-version=5 -mrelocation-model pic -o a.out -

$ ld -v
@(#)PROGRAM:ld  PROJECT:ld64-530
BUILD 07:38:32 Sep  7 2022
configured to support archs: armv6 armv7 armv7s arm64 arm64e arm64_32 i386 x86_64 x86_64h armv6m armv7k armv7m armv7em (tvOS)
LTO support using: LLVM version 14.0.6 (static support for 29, runtime is 29)
TAPI support using: TAPI version 11.0.0 (tapi-1100.0.11)
```

### B. Mach-O Linker Requirements
When compiling pure assembly on macOS ARM64:
1. **Dynamic Linker Constraint**: macOS `ld` prohibits producing completely static user-space binaries. All binaries must link against `libSystem.dylib`.
   - Attempting to link without `libSystem`:
     ```bash
     $ ld -o /tmp/hello_syscall /tmp/hello_syscall.o -syslibroot $(xcrun --show-sdk-path)
     ld: dynamic main executables must link with libSystem.dylib for architecture arm64
     ```
2. **Dynamic Entry Point**: The dynamic binary must link against `libSystem.dylib` using `-lSystem`.

### C. Working Assembly Experiments
The following two implementation paths were successfully compiled, linked, and executed on this machine.

#### Experiment 1: Raw Syscalls (Linked with libSystem)
On macOS ARM64, raw syscall numbers have a `0x2000000` class offset. Syscall ID 4 is `sys_write` (`0x2000004`), and Syscall ID 1 is `sys_exit` (`0x2000001`).
```assembly
; File: /tmp/hello_syscall.s
.global _main
.align 4
_main:
    mov x0, #1          ; stdout file descriptor
    adr x1, msg
    mov x2, #14         ; string length
    mov x16, #4         ; sys_write syscall ID (0x2000004)
    svc #0x80           ; trap to kernel

    mov x0, #0          ; exit status 0
    mov x16, #1         ; sys_exit syscall ID (0x2000001)
    svc #0x80           ; trap to kernel

msg:
    .ascii "Hello, syscall\n"
```
*Build and Run Command*:
```bash
$ as -o /tmp/hello_syscall.o /tmp/hello_syscall.s
$ ld -o /tmp/hello_syscall /tmp/hello_syscall.o -lSystem -syslibroot $(xcrun --show-sdk-path)
$ /tmp/hello_syscall
Hello, syscall
```

#### Experiment 2: Dynamic Helper Calls (Via libSystem wrapper functions)
This method calls the re-exported Unix-layer helper functions `_write` and `_exit` from `libSystem.dylib`.
```assembly
; File: /tmp/hello_libsys.s
.global _main
.align 4
_main:
    stp x29, x30, [sp, #-16]!
    mov x29, sp

    mov x0, #1          ; stdout
    adr x1, msg
    mov x2, #14         ; length
    bl _write           ; branch-link to dynamic helper function

    mov x0, #0          ; status
    bl _exit            ; branch-link to exit

msg:
    .ascii "Hello, libsys\n"
```
*Build and Run Command*:
```bash
$ as -o /tmp/hello_libsys.o /tmp/hello_libsys.s
$ ld -o /tmp/hello_libsys /tmp/hello_libsys.o -lSystem -syslibroot $(xcrun --show-sdk-path)
$ /tmp/hello_libsys
Hello, libsys
```
Both methods successfully output the expected strings, proving that both direct raw kernel traps and standard dynamic library calling structures are operational under `-lSystem` on macOS.
