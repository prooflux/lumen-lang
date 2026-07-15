// native_compile.mjs - R2: a source -> IR compile backend that never touches WebAssembly.
//
// Every compile in this repo has gone through the wat seed (freshInstance() in pipeline.mjs,
// see compileToIR). The native lumenc binary built from the checked-in, reproducible
// native/lumenc.bootstrap.c (see lumenc_native.mjs's header comment and bootstrap_test.mjs,
// which gates that clang-ing it alone reproduces the compiler byte-for-byte) already compiles
// arbitrary Lumen source natively - it is just never used for that here. This module wires it
// up as a drop-in replacement for compileToIR, plus a compile+run convenience function.
//
// Zero wasm in this file: getNativeCompilerBin() clangs the CHECKED-IN lumenc.bootstrap.c
// directly (no call into lumenc_native.mjs's buildLumencNative(), which rebuilds that same
// binary by round-tripping through the wat seed at build time - correct for proving the
// bootstrap file is not stale, but not what a zero-wasm compile path should depend on here).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';
import { buildNativeBinaryFromC } from './lumenc_native.mjs';
import { buildLumemitNative, runLumemitNative } from './lumemit_native.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_C_PATH = path.join(__dirname, 'lumenc.bootstrap.c');
const EMIT_FN_SRC = fs.readFileSync(path.join(__dirname, 'emit_fn.lm'), 'utf8');

// Matches lumenc_native.mjs's patchMainToCompileDriver output layout exactly.
export const LIT_HEAP_BASE = 488000;
export const LIT_HEAP_CEIL = 524288;
export const LIT_HEAP_BYTES = LIT_HEAP_CEIL - LIT_HEAP_BASE;   // 36288

// In-process cache: build the native compiler binary from the checked-in C exactly once per
// process, regardless of how many times compileToIRNative/runFnNative are called.
let cachedBin = null;

// Build (once, cached) the native compiler binary straight from the checked-in
// native/lumenc.bootstrap.c via clang. This is the reproducible genesis from R1: the checked-in
// C file was generated once by the wasm-path build and is gated against drift by
// bootstrap_test.mjs, but BUILDING FROM IT never touches wasm - `clang lumenc.bootstrap.c -o
// lumenc0` is the entire dependency chain.
export function getNativeCompilerBin() {
  if (cachedBin && fs.existsSync(cachedBin)) return cachedBin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumenc0-'));
  const bin = path.join(dir, 'lumenc0');
  try {
    execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, BOOTSTRAP_C_PATH],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed building native compiler from lumenc.bootstrap.c: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  cachedBin = bin;
  return bin;
}

// Run the native compiler binary over a .lm source string and parse its extended stdout
// (see lumenc_native.mjs's patchMainToCompileDriver comment for the exact byte layout):
//   [nerr:i32][count:i32][words: count*i32][main_entry:i32][literal_heap: LIT_HEAP_BYTES bytes]
// Returns the raw pieces; does not throw on nerr > 0 (caller decides), so callers that want the
// diagnostic count without an exception can use this directly.
export function runNativeCompiler(bin, src) {
  const out = execFileSync(bin, { input: Buffer.from(src, 'utf8'), maxBuffer: 64 * 1024 * 1024 });
  const nerr = out.readInt32LE(0);
  const count = out.readInt32LE(4);
  const words = new Int32Array(count);
  for (let i = 0; i < count; i++) words[i] = out.readInt32LE(8 + i * 4);
  const mainOff = 8 + count * 4;
  const main = out.readInt32LE(mainOff);
  const litHeapOff = mainOff + 4;
  const literalHeap = out.subarray(litHeapOff, litHeapOff + LIT_HEAP_BYTES);
  if (litHeapOff + LIT_HEAP_BYTES !== out.length) {
    throw new Error(`native compiler stdout has unexpected length: got ${out.length}B, `
      + `expected ${litHeapOff + LIT_HEAP_BYTES}B (nerr=${nerr}, count=${count})`);
  }
  return { nerr, words, main, literalHeap };
}

// Rebuild the strings sidecar from the raw literal-heap blob: walk `words` for MKTEXT (op 15)
// operands - the identical walk compileToIR (pipeline.mjs) and compileLumencRaw
// (lumenc_native.mjs) use - then read [len:i32][utf8 bytes] at (ptr - LIT_HEAP_BASE) inside the
// blob, mirroring how the wasm side reads the same layout straight out of LMEM.
export function stringsFromLiteralHeap(words, blob) {
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) { pc = pc + 3 + words[pc + 1]; continue; }
    if (op === 15) ptrs.push(words[pc + 1]);
    let oplen = 0;
    if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) oplen = 1;
    else if (op === 8 || op === 29) oplen = 2;
    pc = pc + 1 + oplen;
  }
  const uniquePtrs = [...new Set(ptrs)];
  return uniquePtrs.map((ptr) => {
    const off = ptr - LIT_HEAP_BASE;
    if (off < 0 || off + 4 > blob.length) {
      throw new Error(`literal pointer ${ptr} out of literal-heap range [${LIT_HEAP_BASE},${LIT_HEAP_CEIL})`);
    }
    const len = blob.readInt32LE(off);
    const bytes = blob.subarray(off + 4, off + 4 + len);
    return { ptr, len, bytes };
  });
}

// Compile a .lm source string to IR using ONLY the native compiler binary - zero WebAssembly
// anywhere in this call. Mirrors pipeline.mjs's compileToIR return shape ({ words, main,
// strings }) so the two are drop-in swappable; also returns nerr for callers that want it
// without a try/catch. Throws on compile errors (nerr > 0), same contract as compileToIR.
export function compileToIRNative(src) {
  const bin = getNativeCompilerBin();
  const { nerr, words, main, literalHeap } = runNativeCompiler(bin, src);
  if (nerr > 0) throw new Error(`native compile: ${nerr} error(s)`);
  const strings = stringsFromLiteralHeap(words, literalHeap);
  return { words, main, strings, nerr };
}

// Full native-compile -> emit -> native-run pipeline for a .lm source string.
//
// COMPILE is native: compileToIRNative above, zero wasm, full stop.
//
// EMIT still goes through pipeline.mjs's emitWith, which instantiates the wat seed to run
// emit_fn.lm interpretively. That is deliberate scope for R2 (compile only) - the emit step is
// R3's target. Note for R3: a fully-native emit path ALREADY EXISTS and is already gated
// byte-identical to this exact emitWith call, for the corpus and for lumenc.lm itself
// (native_pipeline_test.mjs Part B/C, via lumemit_native.mjs's buildLumemitNative/
// runLumemitNative). Swapping this line for that native path is wiring, not new research: build
// the emitter binary once (cached like getNativeCompilerBin above) and call runLumemitNative(bin,
// words, main, strings) in place of the awaited emitWith call below.
//
// RUN is native: buildNativeBinaryFromC (clang) + execFileSync, the same as buildAndRunFn.
export async function runFnNative(src, opt = '-O2') {
  const { words, main, strings } = compileToIRNative(src);
  const csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  const bin = buildNativeBinaryFromC(csrc, { opt, tag: 'lumen-run-native', name: 'p' });
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync(bin, { encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    exit = typeof e.status === 'number' ? e.status : 1;
  }
  return { stdout, exit, csrc, words, main };
}

// In-process cache for the native lumemit (emit_fn.lm self-compiled) binary used by
// runFnNativeFull below. Building it still touches the wat seed ONCE per process
// (buildLumemitNative -> compileToIR(emit_fn.lm) + emitWith, exactly what
// native_pipeline_test.mjs's Part B/C already do) - there is no checked-in C bootstrap for the
// emitter yet, only for lumenc (native/lumenc.bootstrap.c, R1). RUNNING the built binary
// (runLumemitNative) never touches wasm.
let cachedEmitBin = null;
async function getNativeEmitterBin() {
  if (cachedEmitBin && fs.existsSync(cachedEmitBin)) return cachedEmitBin;
  const { bin } = await buildLumemitNative();
  cachedEmitBin = bin;
  return bin;
}

// Bonus, beyond the R2 brief's literal ask: a compile+emit+run pipeline that is native at EVERY
// stage, not just compile. The brief for runFnNative above explicitly allows the emit stage to
// stay on emitWith (wat) and defers a native emit swap to R3 - but a native emit path already
// exists and is already gated bit-identical to emitWith's output for this repo's corpus and for
// lumenc.lm itself (native_pipeline_test.mjs Part B/C, via lumemit_native.mjs). Reusing it here
// costs nothing new to build and gives parity_corpus_test.mjs (R2 Part B) a per-case execution
// path that is genuinely zero-wasm, not just zero-wasm-at-the-compile-stage: compile is native
// (compileToIRNative), emit is native (runLumemitNative on the cached emitter binary), run is
// native (buildNativeBinaryFromC + execFileSync). The ONLY wasm touch anywhere in this function's
// call graph is the one-time, in-process-cached build of the emitter binary itself
// (getNativeEmitterBin, first call only) - never per-case.
export async function runFnNativeFull(src, opt = '-O2') {
  const { words, main, strings } = compileToIRNative(src);
  const emitBin = await getNativeEmitterBin();
  const csrc = runLumemitNative(emitBin, words, main, strings);
  const bin = buildNativeBinaryFromC(csrc, { opt, tag: 'lumen-run-native-full', name: 'p' });
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync(bin, { encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    exit = typeof e.status === 'number' ? e.status : 1;
  }
  return { stdout, exit, csrc, words, main };
}
