// ir_interpreter.mjs - R5: a pure-JS, zero-WebAssembly, in-process bytecode interpreter for
// Lumen-mu IR. A byte-for-byte port of seed/lumenc.wat's $run function and its runtime helpers
// (opush/opop/getarg/codew/halloc/int2text/concat/texteq/streq/print_i64/f_exp/f_ln/f_pow).
//
// WHY THIS EXISTS: retiring wasm naively would route every `run()` (compile+execute, capture
// stdout) through compile -> emit C -> clang -> exec. Measured empirically (native/_probe_timing,
// see the R5 PR body): clang alone costs 130-250ms/call regardless of -O0/-O2, i.e. 150-500x
// slower than the wasm interpreter's sub-millisecond hot path. That is not a wiring change, it is
// a severe regression of a property this codebase repeatedly documents as a core invariant
// ("Compile is sub-millisecond", ARCHITECTURE.md's "never slower"). This module restores that
// property with zero WebAssembly: a flat ArrayBuffer stands in for wasm linear memory, and a
// switch-dispatched loop stands in for $run's if-chain, using the EXACT SAME memory map, opcode
// numbering, and (for floats) the exact same hand-rolled algorithms (not Math.exp/Math.log,
// which are NOT bit-identical to lumenc.wat's Taylor-series f_exp/f_ln) so program output is
// bit-for-bit identical to the retired wasm oracle. Gated by native/ir_interpreter_test.mjs
// against every corpus.mjs golden AND (while wasm still existed in this repo, before it was
// deleted) against the live wasm interpreter directly, program by program.
//
// Memory map (bytes) - identical to seed/lumenc.wat's documented layout:
//   [1024 .. 9216)     operand stack (i64 slots, 8 bytes each; 1024 frames deep)
//   [9216 .. 11264)    call stack (i32 pairs: return_pc, prev_argbase; 256 deep)
//   [11264 .. 11328)   itoa scratch buffer (print_i64; anchor byte 11326)
//   [11328 .. 100000)  CODE (emitted IR words, written by the caller before run())
//   [488000 .. 524288) HEAP: Text/array/sum objects, bump-allocated via `hp`
// Total size: 128 "pages" x 65536 = 8388608 bytes, matching lumenc.wat's `(memory 128)` so any
// raw load32/store32/load8/store8 address a compiled program computes (e.g. self-hosting code
// peeking at its own frame slots) lands in the same address space the wasm/native backends use.

export const MEM_BYTES = 128 * 65536;
export const OSTACK_BASE = 1024;
export const CSTACK_BASE = 9216;
export const ITOA_ANCHOR = 11326;
export const CODE_BASE = 11328;
export const HEAP_BASE = 488000;
export const HEAP_CEIL = 524288;

const LN2 = 0.6931471805599453;
const SQRT2 = 1.4142135623730951;
const U64_MASK = (1n << 64n) - 1n;
const I64_MIN = -9223372036854775808n;

function wrapS64(v) { return BigInt.asIntN(64, v); }
function asU64(v) { return v & U64_MASK; }

// Create one interpreter instance: a fresh 8MB address space plus a console_print sink. Mirrors
// seed/compiler_core.mjs's per-instance model (one instance per compile, or reused across many
// runs the way the wasm-backed createCompiler() was reused) - callers decide instance lifetime.
export function createInterpreter() {
  const buf = new ArrayBuffer(MEM_BYTES);
  const dv = new DataView(buf);           // general (possibly-unaligned) byte-level access: the
                                           // heap and raw load32/store32/load8/store8 opcodes,
                                           // exactly mirroring wasm's alignment-agnostic memory ops
  const i32 = new Int32Array(buf);        // fast aligned access to CODE (base 11328, /4 integral)
                                           // and the call stack (base 9216, /4 integral)
  const i64 = new BigInt64Array(buf);     // fast aligned access to the operand stack (base 1024,
                                           // /8 integral) - the hot path perf.mjs's fib(30) gate measures

  // Dedicated 8-byte scratch for f64<->i64 bit-reinterpretation (i64.reinterpret_f64 /
  // f64.reinterpret_i64), kept OFF the main buffer so float bit tricks never alias real memory.
  const scratch = new ArrayBuffer(8);
  const scratchF64 = new Float64Array(scratch);
  const scratchI64 = new BigInt64Array(scratch);
  function f64ToI64(f) { scratchF64[0] = f; return scratchI64[0]; }
  function i64ToF64(i) { scratchI64[0] = wrapS64(i); return scratchF64[0]; }

  let osp = 0, csp = 0, argbase = 0, hp = HEAP_BASE;
  let emit = 0;          // CODE word count (set by the caller after compiling; exposed via dbg_emit)
  let mainEntry = 0;
  let fuelMax = 4000000000n;
  let lastSteps = 0n;
  let out = '';
  let profOn = false;
  const profCounts = new Map();   // entry pc -> call count, mirrors $prof/prof_count exactly
  const consolePrint = (ptr, len) => {
    out += Buffer.from(buf, ptr, len).toString('utf8');
  };

  function opush(v) { i64[OSTACK_BASE / 8 + osp] = wrapS64(v); osp++; }
  function opop() { osp--; return i64[OSTACK_BASE / 8 + osp]; }
  function getarg(idx) { opush(i64[OSTACK_BASE / 8 + argbase + idx]); }
  function codew(idx) { return i32[CODE_BASE / 4 + idx]; }

  function halloc(size) { const p = hp; hp += size; return p; }

  // runtime: int -> Text (decimal, with sign, no newline). Mirrors $int2text exactly.
  function int2text(v) {
    let neg = 0;
    if (v < 0n) { neg = 1; v = -v; }
    let nd = 1, tmp = v;
    while ((tmp = tmp / 10n) !== 0n) nd++;
    const len = nd + neg;
    const ptr = halloc(4 + len);
    dv.setInt32(ptr, len, true);
    let w = ptr + 4 + len;
    do {
      w -= 1;
      dv.setUint8(w, 48 + Number(v % 10n));
      v = v / 10n;
    } while (v !== 0n);
    if (neg) dv.setUint8(ptr + 4, 45);
    return ptr;
  }

  // runtime: Text concat -> new Text. Mirrors $concat exactly.
  function concat(pa, pb) {
    const la = dv.getInt32(pa, true), lb = dv.getInt32(pb, true);
    const ptr = halloc(4 + la + lb);
    dv.setInt32(ptr, la + lb, true);
    for (let i = 0; i < la; i++) dv.setUint8(ptr + 4 + i, dv.getUint8(pa + 4 + i));
    for (let i = 0; i < lb; i++) dv.setUint8(ptr + 4 + la + i, dv.getUint8(pb + 4 + i));
    return ptr;
  }

  function streq(pa, pb, len) {
    for (let i = 0; i < len; i++) if (dv.getUint8(pa + i) !== dv.getUint8(pb + i)) return 0;
    return 1;
  }
  // runtime: Text equality (len-prefixed) -> 0/1. Mirrors $texteq exactly.
  function texteq(pa, pb) {
    const la = dv.getInt32(pa, true);
    if (la !== dv.getInt32(pb, true)) return 0;
    return streq(pa + 4, pb + 4, la);
  }

  // runtime: print an i64 as decimal (with a trailing newline, matching print_int's contract)
  // straight to console_print, via the same small scratch buffer $print_i64 uses (bytes
  // [11264,11326], anchored at 11326 which holds the newline byte; digits are written
  // backwards below it). Mirrors $print_i64 exactly, including the anchor write order.
  function printI64(v) {
    dv.setUint8(ITOA_ANCHOR, 10);   // '\n', written once at the anchor before any digit
    let p = ITOA_ANCHOR, neg = 0;
    if (v < 0n) { neg = 1; v = -v; }
    if (v === 0n) { p -= 1; dv.setUint8(p, 48); }
    else {
      while (v !== 0n) { p -= 1; dv.setUint8(p, 48 + Number(v % 10n)); v = v / 10n; }
    }
    if (neg) { p -= 1; dv.setUint8(p, 45); }
    consolePrint(p, (ITOA_ANCHOR + 1) - p);
  }

  // IEEE754 roundTiesToEven (wasm's f64.nearest). NOT the same as Math.round (round-half-up):
  // they disagree exactly at .5 boundaries, which matters for bit-exact float reproduction.
  function nearestTiesToEven(x) {
    if (!Number.isFinite(x)) return x;
    const floor = Math.floor(x);
    const diff = x - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return (floor % 2 === 0) ? floor : floor + 1;
  }
  // i64.trunc_sat_f64_s: saturating float->int64 (never traps; NaN -> 0).
  function truncSatI64(x) {
    if (Number.isNaN(x)) return 0n;
    if (x <= -9223372036854775808) return I64_MIN;
    if (x >= 9223372036854775808) return 9223372036854775807n;
    return BigInt(Math.trunc(x));
  }

  // exp(x): range-reduce x = k*ln2 + r (|r| <= ln2/2), exp(x) = 2^k * exp(r), exp(r) by a
  // 16-term Taylor series. 2^k built from the f64 exponent bits. Byte-for-byte port of $f_exp.
  function f_exp(x) {
    const k = truncSatI64(nearestTiesToEven(x / LN2));
    const r = x - Number(k) * LN2;
    let sum = 1, term = 1;
    for (let i = 1; i <= 16; i++) { term = (term * r) / i; sum = sum + term; }
    const pow2k = i64ToF64((k + 1023n) << 52n);
    return sum * pow2k;
  }
  // ln(x), x>0: x = m*2^e, m in [sqrt(0.5), sqrt2); ln = e*ln2 + 2*atanh((m-1)/(m+1)).
  // x <= 0 returns 0 (documented domain guard; never traps/NaNs). Port of $f_ln.
  function f_ln(x) {
    if (x <= 0) return 0;
    const bits = f64ToI64(x);
    let e = asU64(bits >> 52n) & 0x7FFn; e = wrapS64(e) - 1023n;
    let m = i64ToF64((asU64(bits) & 0xFFFFFFFFFFFFFn) | (1023n << 52n));
    if (m > SQRT2) { m = m * 0.5; e = e + 1n; }
    const s = (m - 1) / (m + 1);
    const s2 = s * s;
    let term = s, sum = s;
    for (let i = 3; i <= 31; i += 2) { term = term * s2; sum = sum + term / i; }
    return Number(e) * LN2 + 2 * sum;
  }
  // pow(x, y) = exp(y * ln x). Port of $f_pow.
  function f_pow(x, y) { return f_exp(y * f_ln(x)); }

  // Dec (D1, ported for the R5 rebase): exact decimal, i64 scaled by 1_000_000. $mul128 /
  // $divmod128by64's 32-bit-limb decomposition in lumenc.wat exists ONLY because wasm i64 is a
  // fixed 64-bit register; JS BigInt is arbitrary-precision, so the 128-bit intermediate product
  // is just `a * b` directly - same exact result, none of the limb bookkeeping. Traps (throw,
  // matching the DIV/MOD div-by-zero throws above) on overflow or divide-by-zero, mirroring
  // $dec_mul/$dec_div's `unreachable` exactly.
  const DEC_MAX = 9223372036854775807n;
  const DFROMI_MAX = 9223372036854n, DFROMI_MIN = -9223372036854n;
  function decRoundHalfEven(q, r, d) {
    // r/d in [0,1); round q up if r*2 > d, or r*2 === d and q is currently odd (ties to even).
    const r2 = r * 2n;
    if (r2 > d) return q + 1n;
    if (r2 === d && (q & 1n) !== 0n) return q + 1n;
    return q;
  }
  function dec_mul(a, b) {
    let neg = false;
    if (a < 0n) { neg = !neg; a = -a; }
    if (b < 0n) { neg = !neg; b = -b; }
    const prod = a * b;
    let q = decRoundHalfEven(prod / 1000000n, prod % 1000000n, 1000000n);
    if (q > DEC_MAX) throw new Error('Dec overflow');
    return neg ? -q : q;
  }
  function dec_div(a, b) {
    if (b === 0n) throw new Error('Dec divide by zero');
    let neg = false;
    if (a < 0n) { neg = !neg; a = -a; }
    if (b < 0n) { neg = !neg; b = -b; }
    const prod = a * 1000000n;
    let q = decRoundHalfEven(prod / b, prod % b, b);
    if (q > DEC_MAX) throw new Error('Dec overflow');
    return neg ? -q : q;
  }
  // Dec (D1): runtime Dec (i64, scale 1e-6) -> Text, canonical form. Trailing fractional zeros
  // are trimmed but at least one fractional digit always remains ("3.0", not "3"). Port of
  // $dec2text.
  function dec2text(v) {
    let neg = 0;
    if (v < 0n) { neg = 1; v = -v; }
    let ip = v / 1000000n, fp = v % 1000000n;
    let nd = 1, tmp = ip;
    while ((tmp = tmp / 10n) !== 0n) nd++;
    let flen = 6, probe = fp;
    while (flen > 1 && probe % 10n === 0n) { probe = probe / 10n; flen--; }
    const len = neg + nd + 1 + flen;
    const ptr = halloc(4 + len);
    dv.setInt32(ptr, len, true);
    let w = ptr + 4 + len;
    for (let i = 0; i < flen; i++) { w -= 1; dv.setUint8(w, 48 + Number(probe % 10n)); probe = probe / 10n; }
    w -= 1; dv.setUint8(w, 46);   // '.'
    for (let i = 0; i < nd; i++) { w -= 1; dv.setUint8(w, 48 + Number(ip % 10n)); ip = ip / 10n; }
    if (neg) dv.setUint8(ptr + 4, 45);
    return ptr;
  }

  // The interpreter loop itself: a faithful, opcode-for-opcode port of $run. SAFETY properties
  // preserved exactly: a fuel cap guarantees termination (loop breaks, not throws); a heap-bound
  // check on MKSUM/ANEW also just halts (not throws); div-by-zero and the INT64_MIN/-1 overflow
  // DO throw (matching wasm's div_s/rem_s traps), which callers must try/catch exactly as they
  // already do around the retired ex.run(...) call. An unrecognized opcode halts silently, same
  // as $run's unconditional trailing `br $halt`.
  function run(start) {
    pcRun(start);
  }
  function pcRun(start) {
    let pc = start;
    osp = 0; csp = 0; argbase = 0;
    // PERF: fuel is a per-opcode-dispatch counter, checked on EVERY single step regardless of
    // what the opcode does - the hottest of hot paths. It is an internal safety bound only (never
    // observable to the running program's output), so unlike the i64 operand-stack arithmetic
    // below - which MUST use BigInt to reproduce wasm's exact 64-bit wraparound semantics - fuel
    // itself has no such requirement. A plain Number counter is exact up to 2^53 (every fuelMax
    // used in this repo, largest 4e9, is far below that), and V8's Number arithmetic is roughly
    // an order of magnitude faster than BigInt per operation. Found via forge.mjs's fuzzer: a
    // 40-case fault-injection run that should take seconds was taking 8+ CPU-minutes because
    // every near-fuel-cap fuzz program paid a BigInt increment+compare on every one of its
    // (up to 50,000,000) steps. fuelMax is still accepted/stored as a BigInt (set_fuel_max's call
    // sites all pass BigInt literals; unchanged), converted to a Number once per run() call here,
    // not per step. lastSteps is converted back to BigInt at each return point below so
    // get_last_steps()'s return type is unchanged for callers (verified: its one consumer,
    // seed/lumen_mcp.mjs, only calls .toString() on it, which BigInt and Number both support
    // identically for the exact integers this ever holds).
    const fuelCap = Number(fuelMax);
    let fuel = 0;
    for (;;) {
      fuel++;
      if (fuel > fuelCap) break;
      const op = codew(pc); pc++;
      switch (op) {
        case 0: lastSteps = BigInt(fuel); return; // HALT
        case 1: { opush(BigInt(codew(pc))); pc++; break; }                              // PUSH imm
        case 2: { getarg(codew(pc)); pc++; break; }                                     // GETARG
        case 3: { const b = opop(), a = opop(); opush(a + b); break; }                  // ADD
        case 4: { const b = opop(), a = opop(); opush(a - b); break; }                  // SUB
        case 5: { const b = opop(), a = opop(); opush(a < b ? 1n : 0n); break; }         // LT
        case 6: { const target = codew(pc); pc++; if (opop() === 0n) pc = target; break; } // JZ
        case 7: { pc = codew(pc); break; }                                              // JMP
        case 8: {                                                                        // CALL entry argc
          const entry = codew(pc), argc = codew(pc + 1);
          if (profOn) profCounts.set(entry, (profCounts.get(entry) || 0) + 1);           // mirrors $prof's per-entry counter
          pc += 2;
          i32[CSTACK_BASE / 4 + csp * 2] = pc;
          i32[CSTACK_BASE / 4 + csp * 2 + 1] = argbase;
          csp++;
          argbase = osp - argc;
          pc = entry;
          break;
        }
        case 9: {                                                                        // RET
          if (csp === 0) { lastSteps = BigInt(fuel); return; }   // top-level RET: halt, no underflow
          const t = opop();
          osp = argbase;
          opush(t);
          csp--;
          pc = i32[CSTACK_BASE / 4 + csp * 2];
          argbase = i32[CSTACK_BASE / 4 + csp * 2 + 1];
          break;
        }
        case 10: { printI64(opop()); break; }                                           // PRINTINT
        case 11: { const b = opop(), a = opop(); opush(a * b); break; }                 // MUL
        case 12: {                                                                       // DIV
          const b = opop(), a = opop();
          if (b === 0n) throw new Error('integer divide by zero');
          if (a === I64_MIN && b === -1n) throw new Error('integer overflow');
          opush(a / b);
          break;
        }
        case 13: {                                                                       // RESERVE n
          const target = argbase + codew(pc); pc++;
          while (osp < target) opush(0n);
          break;
        }
        case 14: {                                                                       // SETLOCAL slot
          const target = codew(pc); pc++;
          const t = opop();
          i64[OSTACK_BASE / 8 + argbase + target] = wrapS64(t);
          break;
        }
        case 15: { opush(BigInt(codew(pc)) & 0xFFFFFFFFn); pc++; break; }                // MKTEXT ptr
        case 16: {                                                                       // PRINTTEXT
          const a = opop();
          const p = Number(asU64(a) & 0xFFFFFFFFn);
          consolePrint(p + 4, dv.getInt32(p, true));
          break;
        }
        case 17: {                                                                       // CONCAT
          const b = opop(), a = opop();
          opush(BigInt(concat(Number(asU64(a) & 0xFFFFFFFFn), Number(asU64(b) & 0xFFFFFFFFn))));
          break;
        }
        case 18: { opush(BigInt(int2text(opop()))); break; }                            // INT2TEXT
        case 19: { const b = opop(), a = opop(); opush(a === b ? 1n : 0n); break; }      // EQ
        case 20: { const b = opop(), a = opop(); opush(a !== b ? 1n : 0n); break; }      // NE
        case 21: { const b = opop(), a = opop(); opush(a <= b ? 1n : 0n); break; }       // LE
        case 22: { const b = opop(), a = opop(); opush(a >= b ? 1n : 0n); break; }       // GE
        case 23: { const b = opop(), a = opop(); opush(a > b ? 1n : 0n); break; }        // GT
        case 24: {                                                                       // MOD
          const b = opop(), a = opop();
          if (b === 0n) throw new Error('integer divide by zero');
          if (a === I64_MIN && b === -1n) { opush(0n); break; }
          opush(a % b);
          break;
        }
        case 25: {                                                                       // MKSUM tag
          const target = codew(pc); pc++;
          const t = opop();
          if (hp + 16 > HEAP_CEIL) { lastSteps = BigInt(fuel); return; }   // SAFETY: heap bound -> halt
          const entry = halloc(16);
          dv.setInt32(entry, target, true);
          dv.setBigInt64(entry + 8, wrapS64(t), true);
          opush(BigInt(entry));
          break;
        }
        case 26: { opush(BigInt(dv.getInt32(Number(asU64(opop()) & 0xFFFFFFFFn), true))); break; }        // SUMTAG
        case 27: { opush(dv.getBigInt64(Number(asU64(opop()) & 0xFFFFFFFFn) + 8, true)); break; }         // SUMVAL
        case 28: {                                                                       // TEXTEQ
          const b = opop(), a = opop();
          opush(BigInt(texteq(Number(asU64(a) & 0xFFFFFFFFn), Number(asU64(b) & 0xFFFFFFFFn))));
          break;
        }
        case 29: { opush((BigInt(codew(pc) >>> 0)) | (BigInt(codew(pc + 1) >>> 0) << 32n)); pc += 2; break; } // FPUSH lo hi
        case 30: { opush(f64ToI64(Number(opop()))); break; }                            // I2F
        case 31: {                                                                       // I2FU (convert under TOS in place)
          const idx = OSTACK_BASE / 8 + osp - 2;
          i64[idx] = f64ToI64(Number(i64[idx]));
          break;
        }
        case 32: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(f64ToI64(a + b)); break; }  // FADD
        case 33: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(f64ToI64(a - b)); break; }  // FSUB
        case 34: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(f64ToI64(a * b)); break; }  // FMUL
        case 35: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(f64ToI64(a / b)); break; }  // FDIV
        case 36: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(a < b ? 1n : 0n); break; }  // FLT
        case 37: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(a <= b ? 1n : 0n); break; } // FLE
        case 38: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(a > b ? 1n : 0n); break; }  // FGT
        case 39: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(a >= b ? 1n : 0n); break; } // FGE
        case 40: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(a === b ? 1n : 0n); break; }// FEQ
        case 41: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(a !== b ? 1n : 0n); break; }// FNE
        case 42: { opush(truncSatI64(i64ToF64(opop()))); break; }                        // F2I
        case 43: { opush(truncSatI64(Math.floor(i64ToF64(opop()) + 0.5))); break; }       // FROUND
        case 44: { opush(f64ToI64(Math.sqrt(i64ToF64(opop())))); break; }                // FSQRT
        case 45: { opush(f64ToI64(Math.abs(i64ToF64(opop())))); break; }                 // FABS
        case 46: { opush(f64ToI64(f_exp(i64ToF64(opop())))); break; }                    // FEXP
        case 47: { opush(f64ToI64(f_ln(i64ToF64(opop())))); break; }                     // FLN
        case 48: { const b = i64ToF64(opop()), a = i64ToF64(opop()); opush(f64ToI64(f_pow(a, b))); break; } // FPOW
        case 49: {                                                                       // ANEW: pop n -> alloc zeroed array
          const n = opop();
          const size = 4 + Number(n) * 8;
          if (hp + size > HEAP_CEIL) { lastSteps = BigInt(fuel); return; }   // SAFETY: heap bound -> halt
          const entry = halloc(size);
          dv.setInt32(entry, Number(n), true);
          for (let i = 0; i < Number(n); i++) dv.setBigInt64(entry + 4 + i * 8, 0n, true);
          opush(BigInt(entry));
          break;
        }
        case 50: {                                                                       // AGET
          const i = opop(), a = Number(asU64(opop()) & 0xFFFFFFFFn);
          const ii = Number(i);
          if (ii >= 0 && ii < dv.getInt32(a, true)) opush(dv.getBigInt64(a + 4 + ii * 8, true));
          else opush(0n);
          break;
        }
        case 51: {                                                                       // ASET
          const v = opop(), i = opop(), a = Number(asU64(opop()) & 0xFFFFFFFFn);
          const ii = Number(i);
          if (ii >= 0 && ii < dv.getInt32(a, true)) dv.setBigInt64(a + 4 + ii * 8, wrapS64(v), true);
          break;
        }
        case 52: { opush(BigInt(dv.getInt32(Number(asU64(opop()) & 0xFFFFFFFFn), true))); break; } // ALEN
        case 53: { opush(BigInt(dv.getInt32(Number(asU64(opop()) & 0xFFFFFFFFn), true))); break; } // LOAD32 (sign-extended)
        case 54: {                                                                       // STORE32
          const v = opop(), a = Number(asU64(opop()) & 0xFFFFFFFFn);
          dv.setInt32(a, Number(BigInt.asIntN(32, v)), true);
          break;
        }
        case 55: { opush(BigInt(dv.getUint8(Number(asU64(opop()) & 0xFFFFFFFFn)))); break; }       // LOAD8
        case 56: {                                                                       // STORE8
          const v = opop(), a = Number(asU64(opop()) & 0xFFFFFFFFn);
          dv.setUint8(a, Number(v & 0xFFn));
          break;
        }
        case 57: { pc = pc + codew(pc) + 2; break; }                                     // TYPEMAP ntot rettype slot_0..slot_{ntot-1} (skip; +2 for the ntot and rettype fields themselves)
        case 58: { const b = opop(), a = opop(); opush(wrapS64(a & b)); break; }         // BAND
        case 59: { const b = opop(), a = opop(); opush(wrapS64(a | b)); break; }         // BOR
        case 60: { const b = opop(), a = opop(); opush(wrapS64(a ^ b)); break; }         // BXOR
        case 61: { const n = opop(), a = opop(); opush(wrapS64(asU64(a) << (n & 63n))); break; }      // SHL
        case 62: { const n = opop(), a = opop(); opush(wrapS64(asU64(a) >> (n & 63n))); break; }      // SHR (logical/unsigned)
        case 63: { opush(wrapS64(~opop())); break; }                                     // BNOT
        // ---- Dec (D1, ported for R5): exact decimal, i64 scaled by 1_000_000. Overflow/
        // div-by-zero throw, mirroring the Int DIV/MOD traps above (see the dec_mul/dec_div
        // helpers' header comment) ----
        case 64: { opush((BigInt(codew(pc) >>> 0)) | (BigInt(codew(pc + 1) >>> 0) << 32n)); pc += 2; break; } // DPUSH lo hi
        case 65: {                                                                       // DFROMI: TOS Int -> Dec (*1e6), overflow throws
          const a = opop();
          if (a > DFROMI_MAX || a < DFROMI_MIN) throw new Error('Dec overflow');
          opush(wrapS64(a * 1000000n)); break;
        }
        case 66: {                                                                       // DADD: exact i64 add, overflow/i64::MIN throws
          const b = opop(), a = opop(), t = a + b;
          if (t > DEC_MAX || t < -DEC_MAX) throw new Error('Dec overflow');
          opush(t); break;
        }
        case 67: {                                                                       // DSUB (a - b): exact i64 sub, overflow/i64::MIN throws
          const b = opop(), a = opop(), t = a - b;
          if (t > DEC_MAX || t < -DEC_MAX) throw new Error('Dec overflow');
          opush(t); break;
        }
        case 68: { const b = opop(), a = opop(); opush(dec_mul(a, b)); break; }          // DMUL
        case 69: { const b = opop(), a = opop(); opush(dec_div(a, b)); break; }          // DDIV
        case 70: { opush(BigInt(dec2text(opop())) & 0xFFFFFFFFn); break; }               // D2TEXT
        default: { lastSteps = BigInt(fuel); return; }   // unrecognized opcode: halt, same as $run's fallthrough
      }
    }
    lastSteps = BigInt(fuel);
  }

  return {
    // --- state the caller must set before run(): mirrors the wasm exports' contract exactly ---
    get mem() { return buf; },                 // raw ArrayBuffer, for callers that poke CODE/SRC directly (mirrors ex.mem.buffer)
    writeCode(words, atWord = 0) {             // stage IR words into CODE, matching how callers
      for (let i = 0; i < words.length; i++) i32[CODE_BASE / 4 + atWord + i] = words[i];
    },
    set emitCount(n) { emit = n; },
    get emitCount() { return emit; },
    set main(n) { mainEntry = n; },
    get main() { return mainEntry; },
    set_fuel_max(v) { fuelMax = v; },
    set_hp(v) { hp = v; },                     // reset the heap bump pointer (mirrors $hp reset in $lex_compile)
    get hp() { return hp; },
    // Seed compile-time string literals at their ORIGINAL heap addresses (the compiler's MKTEXT
    // operands are hardcoded pointers into [HEAP_BASE, HEAP_CEIL) that must dereference to a
    // valid [len:i32][utf8 bytes] object here). `strings` is the same {ptr,len,bytes}[] shape
    // native/pipeline.mjs's compileToIR / native/native_compile.mjs's compileToIRNative already
    // produce. Advances `hp` past the highest string's end so a runtime allocation (int2text,
    // concat, MKSUM, ANEW) never clobbers a compile-time literal - safe because the compiler's
    // own bump allocator is monotonic, so the last literal's end IS its hp at compile-end.
    seedStrings(strings) {
      let maxEnd = HEAP_BASE;
      for (const s of strings) {
        dv.setInt32(s.ptr, s.len, true);
        for (let i = 0; i < s.len; i++) dv.setUint8(s.ptr + 4 + i, s.bytes[i]);
        maxEnd = Math.max(maxEnd, s.ptr + 4 + s.len);
      }
      hp = maxEnd;
    },
    get_last_steps() { return lastSteps; },
    set_prof(on) { profOn = !!on; if (profOn) profCounts.clear(); },   // mirrors $set_prof (zeroes counters on enable)
    prof_count(entry) { return profCounts.get(entry) || 0; },          // mirrors $prof_count
    resetOut() { out = ''; },
    getOut() { return out; },
    run,
    // exposed for callers that want to build heap objects directly (e.g. host-side string prep)
    halloc, int2text, concat, texteq, streq, printI64,
    f_exp, f_ln, f_pow,
  };
}
