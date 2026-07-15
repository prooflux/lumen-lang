// pipeline.mjs - R5: the shared native execution engine every non-oracle test/tool in this repo
// runs Lumen programs through. Retired: the wasm-backed freshInstance/compileToIR/optimizeIR/
// emitC/emitWith/runIR/buildAndRun/buildAndRunFn. Replaced with the SAME exported names and
// SAME call contracts (freshInstance() -> writeSrc(I,src) -> I.ex.compile(len) -> I.ex.run(...))
// backed by native/native_compile.mjs's one-shot native compiler + native/ir_interpreter.mjs's
// in-process interpreter - so the ~45 callers of this module (every HTTP/state/analytics kernel
// test, the perf-adjacent benches, the diff gates) needed NO changes beyond re-pointing their
// import at this rewritten file.
//
// compileToIR is NO LONGER an independent oracle (there is nothing left to be independent OF -
// see the R5 PR body's "trust anchor" discussion). Gates that used to diff native output against
// compileToIR's wasm-backed IR (native_diff.mjs, optimize_diff.mjs, rawmem_diff.mjs,
// standalone_diff.mjs) now diff against seed/corpus.mjs's frozen golden strings instead - those
// goldens were themselves proven against the wasm interpreter before it was retired, so they
// remain a faithful regression anchor.
//
// emitLlvm/buildAndRunLlvm: KNOWN, DOCUMENTED EXCEPTION - still wasm-backed. R1/R4 gave
// lumenc.lm/emit_fn.lm/optimize.lm native genesis bootstraps; emit_llvm.lm was meant to be the
// fourth (see the abandoned native/lumellvm_native.mjs attempt in git history for R5). That
// attempt hit a genuine, currently-undiagnosed lumenc.lm self-hosting bug: the native compiler
// raises 46 false E0002 ("unknown function") errors on emit_llvm.lm's local variables when they
// are used as call arguments on the same line as their `let` (e.g. `let reg2 = get_reg() ...
// num(c, reg2)`), a call-argument-parsing gap distinct from the else-if and c_block()-EOF bugs
// this same R5 branch found and fixed elsewhere. Root-causing it was judged out of time-box for
// this PR (see the R5 PR body "Known gaps" section). Consequence: seed/lumenc.wat is RETAINED
// (NOT deleted) specifically to keep this one path alive - the single deliberate, isolated wasm
// exception left in the tree, loaded LAZILY below so no other caller of this file ever touches
// wasm. The ONLY OTHER exception is emitWith's fallback for a non-emit_fn.lm CUSTOM emitter
// (native/arm64_spike_check.mjs's emit_arm64_spike.lm, an explicitly-labeled "DISPOSABLE
// SCAFFOLD, spike-only" experiment with exactly one caller) - building a native bootstrap for a
// disposable one-off spike was judged out of scope; it reuses this same lazy wasm path rather
// than a sixth bootstrap.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import wabtInit from 'wabt';
import { compileToIRNative, compileToIRNativeRaw, compileToIRNativeResident, optimizeIRNative, getNativeEmitterBin } from './native_compile.mjs';
import { runLumemitNative } from './lumemit_native.mjs';
import { buildNativeBinaryFromC } from './lumenc_native.mjs';
import { createInterpreter, CODE_BASE as INTERP_CODE_BASE } from './ir_interpreter.mjs';

const SRC_BASE = 100000;
const CODE_BASE = 11328;
const SCRATCH = 524288;            // page 9: compile-time tables only; safe to inject into after compile
export const EMIT_FN_BASE = 2000000;
export const EMIT_FN_CEIL = 2200000;

// --- native-backed freshInstance/writeSrc/compileToIR: the workhorse for every non-LLVM caller ---
//
// freshInstance()'s contract (unchanged from the wasm era): callers do
//   const I = await freshInstance()
//   const len = writeSrc(I, src)
//   I.ex.compile(len)              // or I.ex.compile_and_run for the couple of scripts that used it
//   ... optionally poke I.ex.mem.buffer directly (raw-memory kernel tests inject request bytes
//       at high scratch addresses AFTER compile, exactly as before - the interpreter's memory is
//       the same 8MB linear address space at the same offsets) ...
//   I.ex.run(I.ex.dbg_main())
//   I.getOut()
// Internally: compile() now calls the native one-shot compiler (compileToIRNativeRaw) on the
// staged source, then stages the resulting IR + string literals into a fresh JS interpreter
// instance (ir_interpreter.mjs) so run() executes it in-process, zero wasm, zero per-run spawn.
export async function freshInstance() {
  const interp = createInterpreter();
  let stagedSrc = '';
  let last = { nerr: 0, main: 0, words: new Int32Array(0), tokens: [], symbols: [] };
  const ex = {
    get mem() { return { buffer: interp.mem }; },
    compile(len) {
      const src = stagedSrc.slice(0, len);
      last = compileToIRNativeRaw(src);
      interp.writeCode(last.words);
      interp.seedStrings(last.strings);
      return last.words.length;
    },
    compile_and_run(len) {
      const n = ex.compile(len);
      if (last.nerr === 0) interp.run(last.main);
      return n;
    },
    run(entry) { return interp.run(entry); },
    set_fuel_max(v) { interp.set_fuel_max(v); },
    set_prof(on) { interp.set_prof(on); },
    prof_count(e) { return interp.prof_count(e); },
    get_last_steps() { return interp.get_last_steps(); },
    dbg_nerr() { return last.nerr; },
    dbg_main() { return last.main; },
    dbg_emit() { return last.words.length; },
    dbg_ntok() { return last.tokens.length; },
  };
  return { ex, getOut: () => interp.getOut(), resetOut: () => interp.resetOut(), _stage: (s) => { stagedSrc = s; } };
}

export function writeSrc(I, src) {
  const b = Buffer.from(src, 'utf8');
  if (b.length > 70000) throw new Error(`source ${b.length}B exceeds SRC capacity`);   // D4: matches seed/lumenc.wat's widened SRC region [100000,170000)
  I._stage(src);
  return b.length;
}

// compile user source -> { words, main, irWords, strings }. No longer an "oracle" (see header);
// a thin native-backed convenience wrapper other functions in this file build on.
export async function compileToIR(src) {
  const r = compileToIRNative(src);
  return { words: r.words, main: r.main, irWords: r.words.length, strings: r.strings };
}

// R3-era name, kept for callers (seed/lumen_mcp.mjs) that already import it: the resident-server
// compile path, async, warm (no per-call process spawn once warm) - the fast path for MCP tool
// calls. Same return shape as compileToIR. There is no fallback to select between anymore (R3's
// "auto" meant native-vs-wat; today there is only native), the name is kept for call-site
// stability rather than renamed to avoid churn in an already-large diff.
export async function compileToIRAuto(src) {
  const r = await compileToIRNativeResident(src);
  return { words: r.words, main: r.main, irWords: r.words.length, strings: r.strings };
}

// Structural self-check retained verbatim from R3 (native_check.mjs still imports this).
export function validateNativeIR(words, main) {
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) { pc = pc + 3 + words[pc + 1]; continue; }
    let oplen = 0;
    if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) oplen = 1;
    else if (op === 8 || op === 29 || op === 64) oplen = 2;   // Dec (D2): DPUSH is 2-operand, like FPUSH
    pc = pc + 1 + oplen;
  }
  if (pc !== words.length) return `opcode walk ended at pc=${pc}, expected ${words.length}`;
  if (main < 0 || main > words.length) return `main=${main} out of bounds for ${words.length} words`;
  return null;
}

// run emit_fn.lm's compiled-and-cached native binary over an injected IR snapshot -> emitted C.
// `strings` optional (v1-era callers that never had text literals pass none).
export async function emitC(words, main, strings = []) {
  const bin = getNativeEmitterBin();
  return runLumemitNative(bin, words, main, strings);
}

const EMIT_FN_SRC_TEXT = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');

// emitWith(emitterSrc, ...): historically ran an ARBITRARY emitter .lm source interpretively
// (self-application, to bootstrap NEW native binaries or run one-off experimental emitters like
// emit_arm64_spike.lm). Now: when the caller asks for the shipped emit_fn.lm specifically (the
// overwhelmingly common case - every core caller does), this is native end to end via emitC's
// checked-in R4 bootstrap. For any OTHER emitter source (native/arm64_spike_check.mjs's
// DISPOSABLE-SCAFFOLD-labeled emit_arm64_spike.lm is the only such caller in this repo), there is
// no native bootstrap to run it from, so this falls back to the SAME isolated wasm path
// buildAndRunLlvm/emitLlvm use below (see that section's header comment) - a small, deliberately
// scoped exception for a one-off experimental backend, not a new general capability.
export async function emitWith(emitterSrc, words, main, strings = [], base = SCRATCH, ceil = 589824) {
  if (emitterSrc === EMIT_FN_SRC_TEXT) return emitC(words, main, strings);
  return _emitWithWasm(emitterSrc, words, main, strings, base, ceil);
}

// v2 per-function emitter (emit_fn.lm) - the "beat C" lowering. Native end to end.
export async function buildAndRunFn(src, opt = '-O2') {
  const { words, main, strings } = compileToIRNative(src);
  const optResult = optimizeIRNative(words, main);
  const csrc = await emitC(optResult.words, optResult.main, strings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fn-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  try { execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
  let stdout = '', exit = 0;
  try { stdout = execFileSync(bin, { encoding: 'utf8' }); }
  catch (e) { stdout = e.stdout ? e.stdout.toString() : ''; exit = typeof e.status === 'number' ? e.status : 1; }
  return { stdout, exit, csrc };
}

// run optimize.lm's compiled-and-cached native binary over an injected IR snapshot.
export async function optimizeIR(words, main) {
  return optimizeIRNative(words, main);
}

// execute a raw IR word array directly, no recompile - the in-process JS interpreter, same as
// the retired wasm path (handles hand-crafted/synthetic IR that has no "function shape", unlike
// the emit+clang route, which needs real compiled programs - see native/optimize_diff.mjs).
export async function runIR(words, main) {
  const interp = createInterpreter();
  interp.writeCode(Int32Array.from(words));
  interp.set_fuel_max(4000000000n);
  interp.run(main);
  return interp.getOut();
}

// full pipeline: user .lm -> optimized native C -> clang -> native binary -> { stdout, exit, csrc }
export async function buildAndRun(src, opt = '-O2') {
  return buildAndRunFn(src, opt);   // v1 (emit.lm) is retired along with wasm; v2 (emit_fn.lm) is a strict superset (native_diff.mjs's own header confirms this)
}

// --- the one remaining wasm touch in this repo: emit_llvm.lm has no native bootstrap (see the
// header comment at the top of this file for why). Isolated to these functions; callers are
// exactly native/llvm_diff.mjs, native/llvm_float_test.mjs, native/arm64_spike_check.mjs, and
// seed/lumen_mcp.mjs's lumen_emit_llvm tool - all named in the R5 PR body as the
// deliberately-scoped remainder. LAZY: nothing here runs at module load, so the ~45 other callers
// of this file that never touch LLVM never read seed/lumenc.wat and never pay the wabt init cost
// (this was a real bug pre-fix: a top-level readFileSync+await here meant ANY importer of this
// module - nearly everything - crashed on ENOENT the moment lumenc.wat was briefly removed). ---
let _wasmBinaryPromise = null;
function _loadWasmBinary() {
  if (_wasmBinaryPromise) return _wasmBinaryPromise;
  _wasmBinaryPromise = (async () => {
    const wat = fs.readFileSync(new URL('../seed/lumenc.wat', import.meta.url), 'utf8');
    const wabt = await wabtInit();
    return wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
  })();
  return _wasmBinaryPromise;
}
const EMIT_LLVM_SRC = fs.readFileSync(new URL('./emit_llvm.lm', import.meta.url), 'utf8');

async function _wasmFreshInstance() {
  const binary = await _loadWasmBinary();
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  return { ex: instance.exports, getOut: () => out, resetOut: () => { out = ''; } };
}

// Generic (any emitter source) wasm-interpreted emitWith, byte-for-byte the original R1-era
// implementation - the fallback path for a non-emit_fn.lm emitter (see emitWith above).
async function _emitWithWasm(emitterSrc, words, main, strings = [], base = SCRATCH, ceil = 589824) {
  const I = await _wasmFreshInstance();
  const b = Buffer.from(emitterSrc, 'utf8');
  new Uint8Array(I.ex.mem.buffer, SRC_BASE, b.length).set(b);
  I.ex.compile(b.length);
  if (I.ex.dbg_nerr() > 0) throw new Error(`emitter compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[base / 4] = words.length;
  m32[base / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[base / 4 + 2 + i] = words[i];
  const offset_words = 2 + words.length;
  const dir_word_count = 3 * strings.length;
  m32[base / 4 + offset_words] = dir_word_count;
  let current_byte_offset = base + (offset_words + 1 + dir_word_count) * 4;
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const triple_idx = base / 4 + offset_words + 1 + 3 * i;
    m32[triple_idx] = s.ptr; m32[triple_idx + 1] = s.len; m32[triple_idx + 2] = current_byte_offset;
    new Uint8Array(I.ex.mem.buffer).set(s.bytes, current_byte_offset);
    current_byte_offset += s.len;
  }
  if (current_byte_offset > ceil) throw new Error(`IR + sidecar exceed injection capacity (size ${current_byte_offset - base}B, ceil ${ceil})`);
  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}
async function emitLlvmWith(emitterSrc, words, main, strings = []) {
  const I = await _wasmFreshInstance();
  const b = Buffer.from(emitterSrc, 'utf8');
  new Uint8Array(I.ex.mem.buffer, SRC_BASE, b.length).set(b);
  I.ex.compile(b.length);
  if (I.ex.dbg_nerr() > 0) throw new Error(`emitter compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[SCRATCH / 4] = words.length;
  m32[SCRATCH / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[SCRATCH / 4 + 2 + i] = words[i];
  const offset_words = 2 + words.length;
  const dir_word_count = 3 * strings.length;
  m32[SCRATCH / 4 + offset_words] = dir_word_count;
  let current_byte_offset = SCRATCH + (offset_words + 1 + dir_word_count) * 4;
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const triple_idx = SCRATCH / 4 + offset_words + 1 + 3 * i;
    m32[triple_idx] = s.ptr; m32[triple_idx + 1] = s.len; m32[triple_idx + 2] = current_byte_offset;
    new Uint8Array(I.ex.mem.buffer).set(s.bytes, current_byte_offset);
    current_byte_offset += s.len;
  }
  if (current_byte_offset > 589824) throw new Error(`IR + sidecar exceed Page-9 capacity (size ${current_byte_offset - SCRATCH}B exceeds 65536B)`);
  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}
// emit LLVM IR text for a source (compile -> optimize-free IR -> emit_llvm.lm). Compile/strings
// extraction stays native (compileToIRNative); only the LLVM emission itself touches wasm.
export async function emitLlvm(src) {
  const { words, main, strings } = compileToIRNative(src);
  return await emitLlvmWith(EMIT_LLVM_SRC, words, main, strings);
}
export async function buildAndRunLlvm(src, opt = '-O3') {
  const { words, main, strings } = compileToIRNative(src);
  const optResult = optimizeIRNative(words, main);
  const ll_src = await emitLlvmWith(EMIT_LLVM_SRC, optResult.words, optResult.main, strings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-llvm-'));
  const llfile = path.join(dir, 'p.ll'), bin = path.join(dir, 'p');
  fs.writeFileSync(llfile, ll_src);
  try {
    const runtimeFile = new URL('./runtime_llvm.c', import.meta.url).pathname;
    execFileSync('clang', [opt, '-o', bin, llfile, runtimeFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) { throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
  let stdout = '', exit = 0;
  try { stdout = execFileSync(bin, { encoding: 'utf8' }); }
  catch (e) { stdout = e.stdout ? e.stdout.toString() : ''; exit = typeof e.status === 'number' ? e.status : 1; }
  return { stdout, exit, ll_src };
}
