// optimize_diff.mjs - the gate for the Lumen optimizer (point 2).
// Correctness (RULES rule 5): for every program, interpret(optimize(IR)) === interpret(IR),
// byte-for-byte. The optimizer is enabled only when this holds. The measured "changed" count
// is the justification (it must do something on programs with jump chains). Scalar/control/calls
// subset (runIR executes raw IR without a heap-init pass).
import fs from 'node:fs';
import { createCompiler } from '../seed/compiler_core.mjs';
import { compileToIR, optimizeIR, runIR } from './pipeline.mjs';

const SCALAR = ['fib_print', 'add', 'max', 'fact', 'locals', 'forward', 'mutual', 'compare', 'gcd', 'count', 'sum_loop'];
const lumen = await createCompiler();
let pass = 0, fail = 0, totalChanged = 0, totalWordsRemoved = 0, totalFolds = 0;

for (const name of SCALAR) {
  const src = fs.readFileSync(new URL(`../mu/examples/${name}.lm`, import.meta.url), 'utf8');
  const ref = lumen.run(src);
  if (!ref.ok) { console.log(`SKIP  ${name}`); continue; }
  const { words, main } = await compileToIR(src);
  const { words: opt, main: optMain, changed, folded } = await optimizeIR(words, main);
  totalChanged += changed;
  totalFolds += (folded || 0);
  totalWordsRemoved += (words.length - opt.length);
  // property: length never grows
  const lenOk = opt.length <= words.length;
  const out = await runIR(opt, optMain);
  const ok = out === ref.stdout && lenOk;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(10)} changed=${changed}  out=${JSON.stringify(out)}  ref=${JSON.stringify(ref.stdout)}${lenOk ? '' : '  LENGTH-GREW!'}`);
  if (ok) pass++; else fail++;
}

// existing synthetic jump-chain: PUSH 7; JMP L4; L4: JMP L6; L6: PRINTINT; HALT  -> threads JMP@2 to L6
// words:  0:PUSH 7 | 2:JMP 4 | 4:JMP 6 | 6:PRINTINT | 7:HALT
const chain = Int32Array.from([1, 7, 7, 4, 7, 6, 10, 0]);
const before = await runIR(Int32Array.from(chain), 0);
const { words: opt, main: optMain, changed, folded } = await optimizeIR(Int32Array.from(chain), 0);
const after = await runIR(opt, optMain);
const threadedRight = opt[3] === 4;            // JMP@2's target rewritten to 4 (the chain terminus after compaction)
totalChanged += changed;
totalFolds += (folded || 0);
totalWordsRemoved += (chain.length - opt.length);
const synthOk = before === '7\n' && after === '7\n' && changed >= 1 && threadedRight && opt.length <= chain.length;
console.log(`${synthOk ? 'PASS' : 'FAIL'}  synthetic-jump-chain  changed=${changed}  JMP@2 target ${chain[3]}->${opt[3]}  out=${JSON.stringify(after)}`);
if (synthOk) pass++; else fail++;

// 1. fold: [1,2, 1,3, 3, 10, 0] (PUSH2;PUSH3;ADD;PRINT;HALT) -> out "5\n", folded to length 4, word[1]==5.
const synthFold = Int32Array.from([1, 2, 1, 3, 3, 10, 0]);
const beforeFold = await runIR(synthFold, 0);
const { words: optFold, main: mainFold, changed: changedFold, folded: foldedFold } = await optimizeIR(synthFold, 0);
const afterFold = await runIR(optFold, mainFold);
const okFold = beforeFold === "5\n" && afterFold === "5\n" && optFold.length === 4 && optFold[1] === 5 && (foldedFold || 0) === 1;
console.log(`${okFold ? 'PASS' : 'FAIL'}  synth-fold  changed=${changedFold}  folded=${foldedFold}  out=${JSON.stringify(afterFold)}`);
if (okFold) {
  pass++;
  totalChanged += changedFold;
  totalFolds += (foldedFold || 0);
  totalWordsRemoved += (synthFold.length - optFold.length);
} else {
  fail++;
}

// 2. fold blocked: same triple but with a preceding JZ whose target is the SECOND PUSH's index -> must NOT fold; output identical to unoptimized.
const synthBlocked = Int32Array.from([6, 4, 1, 2, 1, 3, 3, 10, 0]);
const beforeBlocked = await runIR(synthBlocked, 0);
const { words: optBlocked, main: mainBlocked, changed: changedBlocked, folded: foldedBlocked } = await optimizeIR(synthBlocked, 0);
const afterBlocked = await runIR(optBlocked, mainBlocked);
const okBlocked = beforeBlocked === afterBlocked && optBlocked.length === synthBlocked.length && optBlocked.every((v, i) => v === synthBlocked[i]) && changedBlocked === 0;
console.log(`${okBlocked ? 'PASS' : 'FAIL'}  synth-fold-blocked  changed=${changedBlocked}  folded=${foldedBlocked}  out=${JSON.stringify(afterBlocked)}`);
if (okBlocked) {
  pass++;
  totalChanged += changedBlocked;
  totalFolds += (foldedBlocked || 0);
  totalWordsRemoved += (synthBlocked.length - optBlocked.length);
} else {
  fail++;
}

// 3. overflow guard: PUSH 2000000000; PUSH 2000000000; ADD; PRINT; HALT -> NOT folded (4e9 > i32); output identical ("4000000000\n").
const synthOverflow = Int32Array.from([1, 2000000000, 1, 2000000000, 3, 10, 0]);
const beforeOverflow = await runIR(synthOverflow, 0);
const { words: optOverflow, main: mainOverflow, changed: changedOverflow, folded: foldedOverflow } = await optimizeIR(synthOverflow, 0);
const afterOverflow = await runIR(optOverflow, mainOverflow);
const okOverflow = beforeOverflow === "4000000000\n" && afterOverflow === "4000000000\n" && optOverflow.length === synthOverflow.length && changedOverflow === 0;
console.log(`${okOverflow ? 'PASS' : 'FAIL'}  synth-overflow-guard  changed=${changedOverflow}  folded=${foldedOverflow}  out=${JSON.stringify(afterOverflow)}`);
if (okOverflow) {
  pass++;
  totalChanged += changedOverflow;
  totalFolds += (foldedOverflow || 0);
  totalWordsRemoved += (synthOverflow.length - optOverflow.length);
} else {
  fail++;
}

// 4. DCE: dead instructions after HALT that are not jump targets -> removed; output identical.
const synthDce = Int32Array.from([1, 7, 10, 0, 1, 42, 10]);
const beforeDce = await runIR(synthDce, 0);
const { words: optDce, main: mainDce, changed: changedDce, folded: foldedDce } = await optimizeIR(synthDce, 0);
const afterDce = await runIR(optDce, mainDce);
const okDce = beforeDce === "7\n" && afterDce === "7\n" && optDce.length === 4 && changedDce > 0;
console.log(`${okDce ? 'PASS' : 'FAIL'}  synth-dce  changed=${changedDce}  folded=${foldedDce}  out=${JSON.stringify(afterDce)}`);
if (okDce) {
  pass++;
  totalChanged += changedDce;
  totalFolds += (foldedDce || 0);
  totalWordsRemoved += (synthDce.length - optDce.length);
} else {
  fail++;
}

// 5. no DIV/MOD fold: PUSH 7; PUSH 0; DIV(12) present -> optimizer must leave it untouched (assert words unchanged around it).
const synthNoDiv = Int32Array.from([1, 7, 1, 0, 12, 1, 7, 1, 0, 24, 0]);
const { words: optNoDiv, main: mainNoDiv, changed: changedNoDiv, folded: foldedNoDiv } = await optimizeIR(synthNoDiv, 0);
const okNoDiv = optNoDiv.length === synthNoDiv.length && optNoDiv.every((v, i) => v === synthNoDiv[i]) && changedNoDiv === 0;
console.log(`${okNoDiv ? 'PASS' : 'FAIL'}  synth-no-div-mod-fold  changed=${changedNoDiv}  folded=${foldedNoDiv}`);
if (okNoDiv) {
  pass++;
  totalChanged += changedNoDiv;
  totalFolds += (foldedNoDiv || 0);
  totalWordsRemoved += (synthNoDiv.length - optNoDiv.length);
} else {
  fail++;
}

// 6. CALL + relocation: a program where folding shrinks code BEFORE a CALL target -> assert the callee target was remapped and output is identical
const srcCall = `
fn add(x: Int, y: Int) -> Int {
  return x + y
}
fn main(c: Console) -> Unit {
  let r = add(2 + 3, 4)
  c.print_int(r)
}
`;
const beforeCall = await compileToIR(srcCall);
const refCall = await runIR(beforeCall.words, beforeCall.main);
const { words: optCall, main: mainCall, changed: changedCall, folded: foldedCall } = await optimizeIR(beforeCall.words, beforeCall.main);
const afterCall = await runIR(optCall, mainCall);
const okCall = refCall === "9\n" && afterCall === "9\n" && optCall.length < beforeCall.words.length && changedCall > 0;
console.log(`${okCall ? 'PASS' : 'FAIL'}  synth-call-relocation  changed=${changedCall}  folded=${foldedCall}  out=${JSON.stringify(afterCall)}`);
if (okCall) {
  pass++;
  totalChanged += changedCall;
  totalFolds += (foldedCall || 0);
  totalWordsRemoved += (beforeCall.words.length - optCall.length);
} else {
  fail++;
}

// 7. size fail-safe: a program past the 24000-word cap must come back BYTE-IDENTICAL with changed=0
// (regression: the early-exit path once called restore_orig before the backup existed, corrupting the IR).
// Layout: PUSH 7; PRINT; HALT, then dead padding to 24004 words. A running optimizer would DCE the
// padding (length 4); the fail-safe must instead return the input untouched.
const big = new Int32Array(24004);
big[0] = 1; big[1] = 7; big[2] = 10; big[3] = 0;   // padding words stay 0 (HALT), unreachable, untargeted
const beforeBig = await runIR(Int32Array.from(big), 0);
const { words: optBig, main: mainBig, changed: changedBig } = await optimizeIR(Int32Array.from(big), 0);
const afterBig = await runIR(optBig, mainBig);
const okBig = beforeBig === "7\n" && afterBig === "7\n" && changedBig === 0
  && optBig.length === big.length && optBig.every((v, i) => v === big[i]) && mainBig === 0;
console.log(`${okBig ? 'PASS' : 'FAIL'}  synth-size-failsafe  changed=${changedBig}  len=${optBig.length}  out=${JSON.stringify(afterBig)}`);
if (okBig) pass++; else fail++;

// 7b. unknown-opcode fail-safe: restore_orig must read back exactly the words set_orig wrote.
// is_known_op covers 0-63 only, so an out-of-range opcode word (99) trips decode_ok=0 mid-scan,
// which returns via restore_orig(orig_len, orig_main) instead of continuing to relocate/compact.
// Regression: restore_orig once read from 524288 + 8 + orig_len*4 + i*4 (a region set_orig never
// wrote), so this path "restored" zeroed/garbage memory instead of the real original IR. Assert
// the fail-safe truly restores: output words identical to input, changed=0, main unchanged.
const synthUnknownOp = Int32Array.from([1, 7, 99, 10, 0]);
const { words: optUnknownOp, main: mainUnknownOp, changed: changedUnknownOp } =
  await optimizeIR(Int32Array.from(synthUnknownOp), 0);
const okUnknownOp = changedUnknownOp === 0 && mainUnknownOp === 0
  && optUnknownOp.length === synthUnknownOp.length
  && optUnknownOp.every((v, i) => v === synthUnknownOp[i]);
console.log(`${okUnknownOp ? 'PASS' : 'FAIL'}  synth-unknown-opcode-failsafe  changed=${changedUnknownOp}  words=[${[...optUnknownOp]}]`);
if (okUnknownOp) pass++; else fail++;

// 8. TYPEMAP keep-root: typemap records (op 57) are emitter metadata, usually sitting
// control-flow-unreachable after a RET. The interpreter nop-skips them, so runIR-based checks
// stay green even when DCE eats them - but emit_fn.lm derives slot/return types from them, and
// stripping them silently degrades (or for nonzero type codes, MISCOMPILES) the native build.
// Regression: pre-barrier the optimizer deleted them (this synthetic came back 4 words; the BS
// float program lost all 27 typemap words). Dead code BEFORE a typemap must still be removed;
// the typemap span itself must survive verbatim.
const synT = Int32Array.from([1, 7, 10, 0, 1, 99, 57, 1, 0, 0]); // PUSH7 PRINT HALT | dead PUSH99 | TYPEMAP(ntot=1)
const beforeT = await runIR(Int32Array.from(synT), 0);
const { words: optT, main: mainT, changed: changedT } = await optimizeIR(Int32Array.from(synT), 0);
const afterT = await runIR(optT, mainT);
const tailT = [...optT.slice(4)];
const okT = beforeT === "7\n" && afterT === "7\n" && optT.length === 8 && changedT === 2
  && tailT.join(",") === "57,1,0,0";
console.log(`${okT ? 'PASS' : 'FAIL'}  synth-typemap-keeproot  changed=${changedT}  len=${optT.length}  tail=[${tailT}]  out=${JSON.stringify(afterT)}`);
if (okT) { pass++; totalWordsRemoved += (synT.length - optT.length); } else fail++;

// 9. TYPEMAP count preserved on a real compiled float program (typemaps come from the front-end).
const srcFloat = `
fn scale(x: Float) -> Float {
  return x * 2.0
}
fn main(c: Console) -> Unit {
  c.print_int(round(scale(21.0)))
}
`;
const irF = await compileToIR(srcFloat);
const count57 = (ws) => { let n = 0, pc = 0; while (pc < ws.length) { const op = ws[pc]; if (op === 57) { n++; pc += 3 + ws[pc + 1]; } else { const one = [1,2,6,7,13,14,15,25].includes(op), two = [8,29].includes(op); pc += 1 + (one ? 1 : two ? 2 : 0); } } return n; };
const { words: optF, changed: changedF } = await optimizeIR(irF.words, irF.main);
const okF = count57(optF) === count57(irF.words) && count57(irF.words) > 0;
console.log(`${okF ? 'PASS' : 'FAIL'}  synth-typemap-count-preserved  typemaps=${count57(irF.words)}->${count57(optF)}  changed=${changedF}`);
if (okF) pass++; else fail++;

const INLINE_ENABLED = false;

if (INLINE_ENABLED) {
  // Test 1: Simple leaf function inlining.
  // Input words (26 words total):
  //   [13, 2, 2, 0, 1, 1, 3, 9, 57, 2, 0, 0, 0, 13, 1, 1, 5, 8, 0, 1, 10, 0, 57, 1, 0, 0]
  //   Callee:
  //     0: RESERVE 2 (13, 2)
  //     2: GETARG 0 (2, 0)
  //     4: PUSH 1 (1, 1)
  //     6: ADD (3)
  //     7: RET (9)
  //     8: TYPEMAP ntot=2, ret=0, type=[0, 0] (57, 2, 0, 0, 0)
  //   Caller:
  //     13: RESERVE 1 (13, 1)
  //     15: PUSH 5 (1, 5)
  //     17: CALL target=0, argc=1 (8, 0, 1)
  //     20: PRINTINT (10)
  //     21: HALT (0)
  //     22: TYPEMAP ntot=1, ret=0, type=[0] (57, 1, 0, 0)
  //
  // Expected output words (19 words total, if dead callee is stripped):
  //   [13, 3, 1, 5, 14, 1, 2, 1, 1, 1, 3, 10, 0, 57, 3, 0, 0, 0, 0]
  //   Caller (inlined):
  //     0: RESERVE 3 (13, 3)  <-- Merged frame sizes (1 + 2 = 3)
  //     2: PUSH 5 (1, 5)
  //     4: SETLOCAL 1 (14, 1) <-- Pop argument to inlined slot 1 (caller_fs + 0)
  //     6: GETARG 1 (2, 1)   <-- Read from slot 1
  //     8: PUSH 1 (1, 1)
  //     10: ADD (3)
  //     11: PRINTINT (10)
  //     12: HALT (0)
  //     13: TYPEMAP ntot=3, ret=0, type=[0, 0, 0] (57, 3, 0, 0, 0, 0) <-- Merged typemap
  const synthInline = Int32Array.from([13, 2, 2, 0, 1, 1, 3, 9, 57, 2, 0, 0, 0, 13, 1, 1, 5, 8, 0, 1, 10, 0, 57, 1, 0, 0]);
  const expectedInline = Int32Array.from([13, 3, 1, 5, 14, 1, 2, 1, 1, 1, 3, 10, 0, 57, 3, 0, 0, 0, 0]);
  const { words: optInline, main: mainInline } = await optimizeIR(synthInline, 13);
  console.log("optInline:", optInline);
} else {
  console.log("SKIP  synth-inlining (INLINE_ENABLED = false)");
}

if (INLINE_ENABLED) {
  // Test 2: Recursive function inlining blocked.
  // Input words:
  //   [13, 2, 2, 0, 8, 0, 1, 9, 57, 2, 0, 0, 0]
  //   Callee (directly recursive):
  //     0: RESERVE 2 (13, 2)
  //     2: GETARG 0 (2, 0)
  //     4: CALL target=0, argc=1 (8, 0, 1)
  //     7: RET (9)
  //     8: TYPEMAP ntot=2, ret=0, type=[0, 0] (57, 2, 0, 0, 0)
  //
  // Expected output words: identical to input (inlining blocked due to recursion).
  const synthRecInline = Int32Array.from([13, 2, 2, 0, 8, 0, 1, 9, 57, 2, 0, 0, 0]);
  const { words: optRecInline } = await optimizeIR(synthRecInline, 0);
  console.log("optRecInline:", optRecInline);
} else {
  console.log("SKIP  synth-recursive-inlining-blocked (INLINE_ENABLED = false)");
}

// optimize-the-compiler: the hardest real program there is. The optimized lumenc.lm must
// itself compile a corpus program to IR byte-identical to the seed's output (semantic
// fidelity proven end-to-end on an 8,700+-word input; enabled by the 24000-word capacity).
{
  const wabtInit = (await import('../seed/node_modules/wabt/index.js')).default;
  const lmSrc = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url), 'utf8');
  const { words: lmWords } = await compileToIR(lmSrc);
  // fresh instance running the OPTIMIZED compiler (selfhost_diff instance-C pattern)
  const wabt = await wabtInit();
  const watText = fs.readFileSync(new URL('../seed/lumenc.wat', import.meta.url), 'utf8');
  const module = await WebAssembly.compile(wabt.parseWat('w', watText).toBinary({}).buffer);
  const fibSrc = fs.readFileSync(new URL('../mu/examples/fib_print.lm', import.meta.url), 'utf8');
  const refFib = await compileToIR(fibSrc);
  // locate lex_compile via the seed symbol table after compiling lumenc.lm on a scratch instance
  const probe = await createCompiler();
  probe.compile(lmSrc);
  const dv = new DataView(probe.exports.mem.buffer); const u8 = new Uint8Array(probe.exports.mem.buffer);
  let lce = -1;
  for (let a = 150000; a < 157000; a += 12) {
    const off = dv.getInt32(a, true), len = dv.getInt32(a + 4, true), e = dv.getInt32(a + 8, true);
    if (off >= 100000 && off < 150000 && len > 0 &&
        Buffer.from(u8.slice(off, off + len)).toString() === 'lex_compile') lce = e;
  }
  // optimize with lex_compile as the entry so its address rides the pc remap (a compacted
  // IR shifts every pc; calling the OLD entry lands mid-function and emits nothing).
  const { words: lmOpt, main: lmOptLce } = await optimizeIR(lmWords, lce);
  const capOk = lmWords.length <= 24000 && lmOpt.length <= lmWords.length;
  const inst = await WebAssembly.instantiate(module, { lumen: { console_print: () => {} } });
  const ex = inst.exports;
  new Int32Array(ex.mem.buffer, 11328, lmOpt.length).set(lmOpt);
  const sb = Buffer.from(fibSrc, 'utf8');
  new Uint8Array(ex.mem.buffer, 100000, sb.length).set(sb);
  new Uint8Array(ex.mem.buffer, 0, 1024).fill(0);
  const code = new Int32Array(ex.mem.buffer, 11328, lmOpt.length + 10);
  const s0 = lmOpt.length;
  code[s0] = 1; code[s0 + 1] = sb.length; code[s0 + 2] = 8; code[s0 + 3] = lmOptLce; code[s0 + 4] = 1; code[s0 + 5] = 0;
  ex.set_fuel_max(50000000n);
  ex.run(s0);
  const emitN = new DataView(ex.mem.buffer).getInt32(0, true);
  const got = new Int32Array(ex.mem.buffer, 211328, emitN);
  let identical = emitN === refFib.words.length && lce >= 0 && capOk;
  if (identical) for (let i = 0; i < emitN; i++) if (got[i] !== refFib.words[i]) { identical = false; break; }
  console.log(`${identical ? 'PASS' : 'FAIL'}  optimize-the-compiler  lumenc.lm IR ${lmWords.length} -> ${lmOpt.length} words; optimized compiler emits fib_print ${identical ? 'bit-identical' : 'DIVERGENT'}`);
  if (identical) pass++; else fail++;
}

// dead-function full-span elimination: when a zero-caller function's op-13 header is dropped,
// its ENTIRE body must go with it, not just the header+arity(+one CALL word) prefix. Regression
// (found on seed/lumenc.lm, raw pc 9293, fs=3): only the prefix was removed, leaving ~19 orphaned
// body words glued onto the end of the previous function, referencing a field slot (F2) beyond
// the surviving function's declared frame size (fs). Walk the optimized IR with the standard
// variable-length decode and assert no function body references a field/local index >= its own
// header's declared fs. Before the fix this found exactly 1 violation on lumenc.lm; must be 0.
{
  const lmSrc = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url), 'utf8');
  const { words: rawWords, main: rawMain } = await compileToIR(lmSrc);
  const { words: optWords } = await optimizeIR(rawWords, rawMain);
  const oplenStd = (ws, pc, op) => {
    if ([1, 2, 6, 7, 13, 14, 15, 25].includes(op)) return 1;
    if ([8, 29].includes(op)) return 2;
    if (op === 57) return ws[pc + 1] + 2;
    return 0;
  };
  let violations = 0;
  let curFs = -1;
  let pc = 0;
  while (pc < optWords.length) {
    const op = optWords[pc];
    if (op === 13) curFs = optWords[pc + 1];
    if ((op === 2 || op === 14) && curFs >= 0) {
      if (optWords[pc + 1] >= curFs) violations++;
    }
    pc = pc + 1 + oplenStd(optWords, pc, op);
  }
  const okDeadFn = violations === 0;
  console.log(`${okDeadFn ? 'PASS' : 'FAIL'}  dead-function-full-span  lumenc.lm IR ${rawWords.length} -> ${optWords.length} words; field-slot violations=${violations}`);
  if (okDeadFn) pass++; else fail++;
}

console.log(`\n${pass}/${SCALAR.length + 13} checks: optimize.lm (Lumen) is output-identical to the interpreter; size delta: -${totalWordsRemoved} words, total folds: ${totalFolds} (fail ${fail})`);
process.exit(fail === 0 ? 0 : 1);
