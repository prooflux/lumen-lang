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
import { execFileSync, spawn } from 'node:child_process';
import { buildNativeBinaryFromC, SRC_CAP } from './lumenc_native.mjs';
import { runLumemitNative } from './lumemit_native.mjs';
import { runLumoptNative } from './lumopt_native.mjs';

export { SRC_CAP };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP_C_PATH = path.join(__dirname, 'lumenc.bootstrap.c');
const EMIT_FN_BOOTSTRAP_C_PATH = path.join(__dirname, 'emit_fn.bootstrap.c');
const OPTIMIZE_BOOTSTRAP_C_PATH = path.join(__dirname, 'optimize.bootstrap.c');
// NOTE: there is no lumellvm.bootstrap.c. emit_llvm.lm cannot be pushed through the R1/R4
// bootstrap pattern yet - the native compiler rejects it (46 false E0002 errors, a genuine
// call-argument-parsing gap in lumenc.lm's self-hosted parser, not a wiring issue). See
// pipeline.mjs's header comment on emitLlvm/buildAndRunLlvm for the full explanation; that path
// remains wasm-backed via seed/lumenc.wat, which R5 therefore retains rather than deletes.

// Matches lumenc_native.mjs's patchMainToCompileDriver output layout exactly.
export const LIT_HEAP_BASE = 488000;
export const LIT_HEAP_CEIL = 524288;
export const LIT_HEAP_BYTES = LIT_HEAP_CEIL - LIT_HEAP_BASE;   // 36288
export const SRC_BASE = 100000;   // matches seed/compiler_core.mjs SRC_BASE; used to turn a
                                   // resident diagnostic record's name_off back into a byte
                                   // offset into the request source (see ResidentCompiler below)

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

// Same reproducible-genesis pattern as getNativeCompilerBin above, but for the R4 emitter and
// optimizer bootstraps (native/emit_fn.bootstrap.c, native/optimize.bootstrap.c): `clang
// <bootstrap>.c -o <bin>` is the entire dependency chain, zero wasm. Cached once per process.
let cachedEmitBin = null;
export function getNativeEmitterBin() {
  if (cachedEmitBin && fs.existsSync(cachedEmitBin)) return cachedEmitBin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumemit0-'));
  const bin = path.join(dir, 'lumemit0');
  try {
    execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, EMIT_FN_BOOTSTRAP_C_PATH],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed building native emitter from emit_fn.bootstrap.c: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  cachedEmitBin = bin;
  return bin;
}

let cachedOptBin = null;
export function getNativeOptimizerBin() {
  if (cachedOptBin && fs.existsSync(cachedOptBin)) return cachedOptBin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumopt0-'));
  const bin = path.join(dir, 'lumopt0');
  try {
    execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, OPTIMIZE_BOOTSTRAP_C_PATH],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed building native optimizer from optimize.bootstrap.c: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  cachedOptBin = bin;
  return bin;
}

// Parse the [ntok:i32][tokens:ntok*12][nsym:i32][symtab:nsym*12] trailer lumenc_native.mjs's
// patchMainToCompileDriver appends (R5), starting at byte offset `off` in `buf`. Returns
// {tokens, symbols, nextOff} - tokens/symbols in the same shape seed/lumen_mcp.mjs's
// tokensFromSource/symbolsFromSource already expect from a direct wasm-memory read, so those
// call sites only need a new SOURCE for the data, not a new shape.
export function parseSymTrailer(buf, off, srcBytes) {
  const ntok = buf.readInt32LE(off); off += 4;
  const tokens = [];
  for (let i = 0; i < ntok; i++) {
    const kind = buf.readInt32LE(off), a = buf.readInt32LE(off + 4), b = buf.readInt32LE(off + 8);
    off += 12;
    const t = { i: tokens.length, kind, a, b };
    if (a >= SRC_BASE && b > 0 && a - SRC_BASE + b <= srcBytes.length) t.lexeme = srcBytes.subarray(a - SRC_BASE, a - SRC_BASE + b).toString('utf8');
    tokens.push(t);
  }
  const nsym = buf.readInt32LE(off); off += 4;
  const symbols = [];
  for (let i = 0; i < nsym; i++) {
    const name_off = buf.readInt32LE(off), name_len = buf.readInt32LE(off + 4), entry = buf.readInt32LE(off + 8);
    off += 12;
    const name = (name_off >= SRC_BASE && name_len > 0 && name_off - SRC_BASE + name_len <= srcBytes.length)
      ? srcBytes.subarray(name_off - SRC_BASE, name_off - SRC_BASE + name_len).toString('utf8') : '';
    symbols.push({ name_off, name_len, entry, name });
  }
  return { tokens, symbols, nextOff: off };
}

// Parse the [ndiag:i32][diag:ndiag*3*i32 (code,name_off,name_len)] block both the one-shot and
// resident drivers emit (R5: the one-shot path used to omit this; see lumenc_native.mjs's
// header comment on why it now matches the resident loop). Returns raw {code, name_off,
// name_len} records - rawDiagsFromRecords below turns them into byteOff/name against a
// specific request's source bytes.
export function parseDiagRecords(buf, off) {
  const ndiag = buf.readInt32LE(off); off += 4;
  const records = [];
  for (let i = 0; i < ndiag; i++) {
    records.push({ code: buf.readInt32LE(off), name_off: buf.readInt32LE(off + 4), name_len: buf.readInt32LE(off + 8) });
    off += 12;
  }
  return { records, nextOff: off };
}

// Run the native compiler binary over a .lm source string and parse its extended stdout
// (see lumenc_native.mjs's patchMainToCompileDriver comment for the exact byte layout):
//   [nerr:i32][count:i32][words: count*i32][main_entry:i32][literal_heap: LIT_HEAP_BYTES bytes]
//   [ndiag:i32][diag:ndiag*12][ntok:i32][tokens:ntok*12][nsym:i32][symtab:nsym*12]  (R5 trailer)
// Returns the raw pieces; does not throw on nerr > 0 (caller decides), so callers that want the
// diagnostic count without an exception can use this directly.
export function runNativeCompiler(bin, src) {
  const srcBytes = Buffer.from(src, 'utf8');
  const out = execFileSync(bin, { input: srcBytes, maxBuffer: 64 * 1024 * 1024 });
  const nerr = out.readInt32LE(0);
  const count = out.readInt32LE(4);
  const words = new Int32Array(count);
  for (let i = 0; i < count; i++) words[i] = out.readInt32LE(8 + i * 4);
  const mainOff = 8 + count * 4;
  const main = out.readInt32LE(mainOff);
  const litHeapOff = mainOff + 4;
  const literalHeap = out.subarray(litHeapOff, litHeapOff + LIT_HEAP_BYTES);
  const { records, nextOff: diagEnd } = parseDiagRecords(out, litHeapOff + LIT_HEAP_BYTES);
  const rawDiags = rawDiagsFromRecords(records, srcBytes);
  const { tokens, symbols, nextOff } = parseSymTrailer(out, diagEnd, srcBytes);
  if (nextOff !== out.length) {
    throw new Error(`native compiler stdout has unexpected length: got ${out.length}B, `
      + `expected ${nextOff}B (nerr=${nerr}, count=${count})`);
  }
  return { nerr, words, main, literalHeap, rawDiags, tokens, symbols };
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
// anywhere in this call. Mirrors pipeline.mjs's (retired) compileToIR return shape ({ words,
// main, strings }) plus rawDiags (R5: the one-shot driver now carries diagnostics, matching the
// resident path). Throws on compile errors (nerr > 0); rawDiags is populated on the ERROR path
// too via compileToIRNativeRaw below for callers that want diagnostics without a try/catch.
export function compileToIRNativeRaw(src) {
  const bin = getNativeCompilerBin();
  const { nerr, words, main, literalHeap, rawDiags, tokens, symbols } = runNativeCompiler(bin, src);
  const strings = stringsFromLiteralHeap(words, literalHeap);
  return { words, main, strings, nerr, rawDiags, tokens, symbols };
}
export function compileToIRNative(src) {
  const r = compileToIRNativeRaw(src);
  if (r.nerr > 0) throw new Error(`native compile: ${r.nerr} error(s)`);
  return { words: r.words, main: r.main, strings: r.strings, nerr: r.nerr };
}

// Optimize already-compiled IR via the R4 checked-in optimizer bootstrap (native/optimize.bootstrap.c,
// clang-built, zero wasm). Mirrors pipeline.mjs's (retired) optimizeIR return shape exactly:
// { words, main, changed, folded, threaded }.
export function optimizeIRNative(words, main) {
  const bin = getNativeOptimizerBin();
  return runLumoptNative(bin, words, main);
}

// Emit C for already-compiled (optionally optimized) IR via the R4 checked-in emitter bootstrap
// (native/emit_fn.bootstrap.c, clang-built, zero wasm), then build+run it. No compile step here -
// this is the direct replacement for pipeline.mjs's (retired) runIR/emitC when the caller already
// has IR in hand (native/optimize_diff.mjs's hand-crafted synthetic arrays, for instance).
export function runIRNative(words, main, strings = [], opt = '-O2') {
  const emitBin = getNativeEmitterBin();
  const csrc = runLumemitNative(emitBin, words, main, strings);
  const bin = buildNativeBinaryFromC(csrc, { opt, tag: 'lumen-run-ir-native', name: 'p' });
  let stdout = '', exit = 0;
  try { stdout = execFileSync(bin, { encoding: 'utf8' }); }
  catch (e) { stdout = e.stdout ? e.stdout.toString() : ''; exit = typeof e.status === 'number' ? e.status : 1; }
  return { stdout, exit, csrc };
}

// Full native-compile -> native-emit -> native-run pipeline for a .lm source string, WITHOUT the
// optimizer (raw IR straight to the emitter). Zero wasm at every stage: compile
// (compileToIRNative), emit (runIRNative on the checked-in emitter bootstrap), run (clang + exec).
// Used by native/parity_corpus_test.mjs as the "does the raw pipeline still work" proof.
export async function runFnNativeFull(src, opt = '-O2') {
  const { words, main, strings } = compileToIRNative(src);
  const { stdout, exit, csrc } = runIRNative(words, main, strings, opt);
  return { stdout, exit, csrc, words, main };
}

// Full native-compile -> native-optimize -> native-emit -> native-run pipeline: the WITH-optimizer
// counterpart to runFnNativeFull above, and the direct zero-wasm replacement for pipeline.mjs's
// (retired) buildAndRunFn (which optimized via the wasm-interpreted optimize.lm). Used by
// native/native_diff.mjs, native/rawmem_diff.mjs, native/standalone_diff.mjs as the "cand" side.
export async function runFnNativeOptimized(src, opt = '-O2') {
  const { words, main, strings } = compileToIRNative(src);
  const optResult = optimizeIRNative(words, main);
  // MKTEXT operands are unaffected by optimization (folding/threading/DCE never rewrites a text
  // pointer), so the ORIGINAL strings sidecar remains valid against the optimized words - the
  // same assumption native/optimize_diff.mjs's synth-typemap tests already rely on.
  const { stdout, exit, csrc } = runIRNative(optResult.words, optResult.main, strings, opt);
  return { stdout, exit, csrc, words: optResult.words, main: optResult.main };
}

// --- R3: the resident native compiler server -----------------------------------------------
//
// compileToIRNative above pays a process spawn per compile (execFileSync). Measured in
// native_compile_test.mjs: that spawn, not the compile itself, dominates the wall time for
// small programs. This section instead launches the SAME checked-in lumenc.bootstrap.c binary
// ONCE, in `--resident` mode (see lumenc_native.mjs's patchMainToCompileDriver), and pipes many
// compiles through its stdin/stdout over its lifetime - the fork/exec cost is paid once, not
// per compile.
//
// Wire protocol (both directions length-framed: 4-byte little-endian byte count + payload; the
// convention native/lumen_serve_native.mjs's serve loop already uses):
//   request:  [reqlen:u32][source bytes]
//   response: [payloadlen:u32][nerr:i32][count:i32][words:count*i32][main_entry:i32]
//             [literal_heap:LIT_HEAP_BYTES bytes][ndiag:i32][diag:ndiag*3*i32]
//
// Correctness: the resident binary fully resets its mutable state (memset, not a partial
// bump-pointer rollback) between requests, so request N+1 starts from the same all-zero memory
// a freshly-spawned process would. native/native_resident_test.mjs proves this empirically:
// compiling the full corpus twice through ONE resident process reproduces both a fresh one-shot
// process's output and the wasm seed's output, byte-for-byte, for every program.
//
// Failure mode: a wild-memory-access trap inside the compiled compiler (see
// native_compile_test.mjs's TRAP HARDENING section - some malformed/unhandled-syntax inputs hit
// this, by design, in BOTH the one-shot and resident binaries) calls _exit(70) unconditionally,
// which kills the WHOLE resident process, not just the one request that triggered it. This
// class treats an unexpected child exit as fatal to every request still pending on it and marks
// itself dead; getResidentCompiler() below spawns a fresh instance on the next call after that.
class ResidentCompiler {
  constructor(bin) {
    this.bin = bin;
    this.child = null;
    this.buf = Buffer.alloc(0);
    this.pending = [];   // FIFO of {resolve, reject} - the resident loop answers requests in order
    this.dead = null;    // set to an Error once the child has exited/errored unexpectedly
  }

  ensureStarted() {
    if (this.child || this.dead) return;
    const child = spawn(this.bin, ['--resident'], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    this.buf = Buffer.alloc(0);
    child.stdout.on('data', (chunk) => this._onData(chunk));
    const fail = (err) => {
      if (this.dead) return;
      this.dead = err;
      this.child = null;
      const pending = this.pending.splice(0);
      for (const p of pending) p.reject(err);
    };
    child.on('exit', (code, signal) => fail(new Error(`native resident compiler exited unexpectedly (code=${code}, signal=${signal})`)));
    child.on('error', fail);
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const payload = Buffer.from(this.buf.subarray(4, 4 + len));   // copy: buf is about to move
      this.buf = this.buf.subarray(4 + len);
      const next = this.pending.shift();
      if (next) next.resolve(payload);
    }
  }

  // Send one compile request, resolve with the raw response payload (see parseResidentPayload).
  compile(src) {
    this.ensureStarted();
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject });
      const srcBuf = Buffer.from(src, 'utf8');
      const header = Buffer.alloc(4);
      header.writeUInt32LE(srcBuf.length, 0);
      this.child.stdin.write(Buffer.concat([header, srcBuf]));
    });
  }

  stop() {
    if (this.child) { try { this.child.stdin.end(); } catch { /* already closing */ } }
    this.child = null;
  }
}

let residentCompiler = null;

// Get (spawning if needed, or re-spawning after a crash) the one process-wide resident native
// compiler. Callers do not need to know whether this is the first call or a respawn.
export function getResidentCompiler() {
  if (!residentCompiler || residentCompiler.dead) residentCompiler = new ResidentCompiler(getNativeCompilerBin());
  return residentCompiler;
}

// Kill the resident compiler (tests / graceful shutdown). A later call rebuilds it lazily.
export function stopResidentCompiler() {
  if (residentCompiler) residentCompiler.stop();
  residentCompiler = null;
}

// Parse a resident response payload (see the wire-protocol comment above) into its pieces.
// Diagnostic records are returned raw ({code, name_off, name_len}, straight off the wire) -
// turning name_off into a source-relative byte offset needs the ORIGINAL request source, which
// this function never sees; see rawDiagsFromRecords below for that step.
export function parseResidentPayload(payload, srcBytes = Buffer.alloc(0)) {
  const nerr = payload.readInt32LE(0);
  const count = payload.readInt32LE(4);
  const words = new Int32Array(count);
  for (let i = 0; i < count; i++) words[i] = payload.readInt32LE(8 + i * 4);
  const mainOff = 8 + count * 4;
  const main = payload.readInt32LE(mainOff);
  const litHeapOff = mainOff + 4;
  const literalHeap = payload.subarray(litHeapOff, litHeapOff + LIT_HEAP_BYTES);
  const ndiagOff = litHeapOff + LIT_HEAP_BYTES;
  const ndiag = payload.readInt32LE(ndiagOff);
  const records = [];
  for (let i = 0; i < ndiag; i++) {
    const o = ndiagOff + 4 + i * 12;
    records.push({ code: payload.readInt32LE(o), name_off: payload.readInt32LE(o + 4), name_len: payload.readInt32LE(o + 8) });
  }
  const trailerOff = ndiagOff + 4 + ndiag * 12;
  const { tokens, symbols, nextOff } = parseSymTrailer(payload, trailerOff, srcBytes);
  if (payload.length !== nextOff) {
    throw new Error(`resident response has unexpected length: got ${payload.length}B, expected ${nextOff}B (nerr=${nerr}, count=${count}, ndiag=${ndiag})`);
  }
  return { nerr, words, main, literalHeap, records, tokens, symbols };
}

// Turn raw {code, name_off, name_len} records into seed/compiler_core.mjs's readRawDiags()
// shape: {code, byteOff, byteLen, name} - name resolved from the CLIENT's own copy of the
// request source (name_off - SRC_BASE is a byte offset into it), exactly how readRawDiags()
// resolves the same fields from the wasm instance's own SRC-region memory.
export function rawDiagsFromRecords(records, srcBytes) {
  return records.map(({ code, name_off, name_len }) => {
    const byteOff = name_off - SRC_BASE;
    const name = (name_off >= SRC_BASE && name_len > 0 && byteOff + name_len <= srcBytes.length)
      ? srcBytes.subarray(byteOff, byteOff + name_len).toString('utf8')
      : '';
    return { code, byteOff, byteLen: name_len, name };
  });
}

// Compile a .lm source string to IR via the resident native server - zero WebAssembly, and (once
// the server is warm) zero process spawn per call. Does NOT throw on nerr > 0 (a legitimate
// compile error is not an infrastructure failure); it only throws on a genuine infra problem -
// oversized source, a dead/crashed resident process, or a malformed response. This is the
// distinction pipeline.mjs's compileToIRAuto needs: a real user compile error should propagate
// as-is (falling back to wat would not change the verdict, only pay for it twice), while an
// infra failure is exactly what should trigger the wat fallback.
export async function compileToIRNativeResidentRaw(src) {
  const srcBuf = Buffer.from(src, 'utf8');
  if (srcBuf.length > SRC_CAP) throw new Error(`source ${srcBuf.length}B exceeds SRC capacity ${SRC_CAP}B`);
  const server = getResidentCompiler();
  const payload = await server.compile(src);
  const { nerr, words, main, literalHeap, tokens, symbols } = parseResidentPayload(payload, srcBuf);
  const strings = stringsFromLiteralHeap(words, literalHeap);
  return { words, main, strings, nerr, tokens, symbols };
}

// Compile a .lm source string to IR via the resident native server. Same return shape and throw
// contract as compileToIRNative: { words, main, strings, nerr }, throws on nerr > 0.
export async function compileToIRNativeResident(src) {
  const r = await compileToIRNativeResidentRaw(src);
  if (r.nerr > 0) throw new Error(`native compile: ${r.nerr} error(s)`);
  return r;
}

// R5 ADDENDUM: the resident-server counterpart to compileToIRNativeRaw above, matching its
// EXACT return shape ({ words, main, strings, nerr, rawDiags, tokens, symbols }) - unlike
// compileToIRNativeResidentRaw (above), which drops the diagnostic records entirely (its callers
// never needed them). This is what native/resident_sync_worker.mjs calls on behalf of
// seed/compiler_core.mjs's compile(), so that a resident-backed compile() returns literally the
// same shape a spawn-backed one always has.
export async function compileToIRNativeResidentFullRaw(src) {
  const srcBuf = Buffer.from(src, 'utf8');
  if (srcBuf.length > SRC_CAP) throw new Error(`source ${srcBuf.length}B exceeds SRC capacity ${SRC_CAP}B`);
  const server = getResidentCompiler();
  const payload = await server.compile(src);
  const { nerr, words, main, literalHeap, records, tokens, symbols } = parseResidentPayload(payload, srcBuf);
  const strings = stringsFromLiteralHeap(words, literalHeap);
  const rawDiags = rawDiagsFromRecords(records, srcBuf);
  return { words, main, strings, nerr, rawDiags, tokens, symbols };
}

// Compile a .lm source string via the resident native server, returning seed/compiler_core.mjs's
// compile() shape: { ok, irWords, main, srclen, rawDiags }. A true drop-in for
// `lumen.compile(source)` at any call site that only needs the compile step (not run/interpret) -
// this is what seed/lumend.mjs, seed/lumen_mcp.mjs and seed/lumen.mjs's check/fix/ir paths use,
// with a wasm fallback wrapped around it (see each host for the fallback + LUMEN_COMPILE gate).
export async function checkNativeResident(src) {
  const srcBuf = Buffer.from(src, 'utf8');
  if (srcBuf.length > SRC_CAP) throw new Error(`source ${srcBuf.length}B exceeds SRC capacity ${SRC_CAP}B`);
  const server = getResidentCompiler();
  const payload = await server.compile(src);
  const { nerr, words, main, records } = parseResidentPayload(payload);
  const rawDiags = rawDiagsFromRecords(records, srcBuf);
  return { ok: nerr === 0, irWords: words.length, main, srclen: srcBuf.length, rawDiags, words };
}
