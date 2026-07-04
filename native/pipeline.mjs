// pipeline.mjs - the DISPOSABLE bootstrap driver for the Lumen-owned native backend.
//
// It does NO translation. The translation is emit.lm (a Lumen program). This host only:
//   1. compiles the user .lm to IR with the seed,
//   2. snapshots the IR words out of memory,
//   3. injects them into a fresh emitter instance's page-9 scratch,
//   4. runs emit.lm (Lumen) to produce C on stdout,
//   5. invokes clang (the scoped assistant) to assemble the native binary,
//   6. runs it and captures stdout + exit.
// Same status as lumen.mjs/run.mjs: re-derived in Lumen at the self-hosting fixpoint.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import wabtInit from 'wabt';

const SRC_BASE = 100000;
const CODE_BASE = 11328;
const SCRATCH = 524288;            // page 9: compile-time tables only; safe to inject into after compile
// emit_fn.lm injects here instead of page 9: its per-number int_to_text allocations grow the
// seed VM's Text heap (from 488000) well past page 9 on a compiler-sized program, so the IR
// must sit above the heap's max reach. MUST equal emit_fn.lm hdr(); CEIL is arity_base() (the
// next emit-scratch region), the ceiling the injected IR + string sidecar must not cross.
export const EMIT_FN_BASE = 2000000;
export const EMIT_FN_CEIL = 2200000;

const wabt = await wabtInit();
const wat = fs.readFileSync(new URL('../seed/lumenc.wat', import.meta.url), 'utf8');
const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
const EMIT_SRC = fs.readFileSync(new URL('./emit.lm', import.meta.url), 'utf8');
const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const OPT_SRC = fs.readFileSync(new URL('./optimize.lm', import.meta.url), 'utf8');
const EMIT_LLVM_SRC = fs.readFileSync(new URL('./emit_llvm.lm', import.meta.url), 'utf8');


export async function freshInstance() {
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  return { ex: instance.exports, getOut: () => out, resetOut: () => { out = ''; } };
}

export function writeSrc(I, src) {
  const b = Buffer.from(src, 'utf8');
  if (b.length > 50000) throw new Error(`source ${b.length}B exceeds SRC capacity`);
  new Uint8Array(I.ex.mem.buffer, SRC_BASE, b.length).set(b);
  return b.length;
}

// compile user source -> { words: Int32Array (copy), main, irWords, strings }
export async function compileToIR(src) {
  const I = await freshInstance();
  const len = writeSrc(I, src);
  const irWords = I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`user compile: ${I.ex.dbg_nerr()} error(s)`);
  const main = I.ex.dbg_main();
  const words = Int32Array.from(new Int32Array(I.ex.mem.buffer, CODE_BASE, irWords));

  // Extract strings sidecar
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) {
      pc = pc + 3 + words[pc + 1];
    } else {
      if (op === 15) {
        ptrs.push(words[pc + 1]);
      }
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) {
        oplen = 1;
      } else if (op === 8 || op === 29) {
        oplen = 2;
      }
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const view = new DataView(I.ex.mem.buffer);
  const mem8 = new Uint8Array(I.ex.mem.buffer);
  const strings = uniquePtrs.map(ptr => {
    const len = view.getInt32(ptr, true);
    const bytes = mem8.slice(ptr + 4, ptr + 4 + len);
    return { ptr, len, bytes };
  });

  return { words, main, irWords, strings };
}

// run emit.lm (Lumen) over an injected IR snapshot -> emitted C source text
export async function emitC(words, main) {
  const I = await freshInstance();
  const len = writeSrc(I, EMIT_SRC);
  I.ex.compile(len);                                  // compile emit.lm (writes its own page-9 tables)
  if (I.ex.dbg_nerr() > 0) throw new Error(`emit.lm compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);        // inject AFTER compile so page-9 writes don't clobber
  m32[SCRATCH / 4] = words.length;                    // ir_len
  m32[SCRATCH / 4 + 1] = main;                        // main_entry
  for (let i = 0; i < words.length; i++) m32[SCRATCH / 4 + 2 + i] = words[i];
  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}

// run a chosen emitter .lm (Lumen) over an injected IR snapshot -> emitted C source text
// run a chosen emitter .lm (Lumen) over an injected IR snapshot -> emitted C source text
// base/ceil select the injection region. emit.lm (v1) injects into page 9 (base=SCRATCH,
// ceil=589824). emit_fn.lm injects into the 2MB high block (base=EMIT_FN_BASE) so the seed
// VM's Text heap (bump-allocated from 488000 by emit_fn's per-number int_to_text, never
// freed) cannot climb into the un-read IR mid-emit and desync the walk. Its hdr()/scratch
// bases in emit_fn.lm MUST match EMIT_FN_BASE and the emit-scratch layout below.
export async function emitWith(emitterSrc, words, main, strings = [], base = SCRATCH, ceil = 589824) {
  const I = await freshInstance();
  const len = writeSrc(I, emitterSrc);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`emitter compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[base / 4] = words.length;
  m32[base / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[base / 4 + 2 + i] = words[i];

  // Inject the strings sidecar
  const offset_words = 2 + words.length;
  const dir_word_count = 3 * strings.length;
  m32[base / 4 + offset_words] = dir_word_count;

  let current_byte_offset = base + (offset_words + 1 + dir_word_count) * 4;

  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const triple_idx = base / 4 + offset_words + 1 + 3 * i;
    m32[triple_idx] = s.ptr;
    m32[triple_idx + 1] = s.len;
    m32[triple_idx + 2] = current_byte_offset;

    // Copy bytes to current_byte_offset
    const m8 = new Uint8Array(I.ex.mem.buffer);
    m8.set(s.bytes, current_byte_offset);

    current_byte_offset += s.len;
  }

  if (current_byte_offset > ceil) {
    throw new Error(`IR + sidecar exceed injection capacity (size ${current_byte_offset - base}B, ceil ${ceil})`);
  }

  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}

// v2 per-function emitter (emit_fn.lm) - the "beat C" lowering
export async function buildAndRunFn(src, opt = '-O2') {
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);

  // Find all MKTEXT operands in the optimized words
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) {
      pc = pc + 3 + words[pc + 1];
    } else {
      if (op === 15) {
        ptrs.push(words[pc + 1]);
      }
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) {
        oplen = 1;
      } else if (op === 8 || op === 29) {
        oplen = 2;
      }
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(ir.strings.map(s => [s.ptr, s]));
  const strings = uniquePtrs.map(ptr => {
    const s = stringsMap.get(ptr);
    if (!s) throw new Error(`Internal error: string pointer ${ptr} not found in compile-time strings`);
    return s;
  });

  let csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  
  // All CDF optimization and vectorization are performed directly by the Lumen compiler (emit_fn.lm).

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fn-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  // -ffp-contract=off -fno-fast-math: the transcribed f_exp/f_ln/f_pow reproduce the interpreter's
  // bits only with no FMA contraction and default (ties-to-even) rounding. Never -Ofast.
  // (=fast was a #177 leftover contradicting this comment; measured 2026-07-01 the =off cost is
  // within bench noise, 133-137% of libm-C either way, so determinism-by-default costs nothing.)
  try { execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
  let stdout = '', exit = 0;
  try { stdout = execFileSync(bin, { encoding: 'utf8' }); }
  catch (e) { stdout = e.stdout ? e.stdout.toString() : ''; exit = typeof e.status === 'number' ? e.status : 1; }
  return { stdout, exit, csrc };
}

// run optimize.lm (Lumen) over an injected IR snapshot -> { words: optimized IR (copy), main, changed, folded, threaded }
export async function optimizeIR(words, main) {
  const I = await freshInstance();
  const len = writeSrc(I, OPT_SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) {
    const n = I.ex.dbg_nerr();
    const recs = new Int32Array(I.ex.mem.buffer, 286000, n * 3);
    const m = new Uint8Array(I.ex.mem.buffer);
    const ds = [];
    for (let k = 0; k < n; k++) {
      const code = recs[k*3], off = recs[k*3+1], len = recs[k*3+2];
      const name = (off >= SRC_BASE && len > 0) ? Buffer.from(m.slice(off, off+len)).toString('utf8') : '';
      ds.push({ code, byteOff: off - SRC_BASE, byteLen: len, name });
    }
    console.error("Compile Errors:", JSON.stringify(ds, null, 2));
    throw new Error(`optimize.lm compile: ${I.ex.dbg_nerr()} error(s)`);
  }
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[SCRATCH / 4] = words.length;
  m32[SCRATCH / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[SCRATCH / 4 + 2 + i] = words[i];
  m32[589812 / 4] = 0;
  m32[589816 / 4] = 0;
  m32[589820 / 4] = 0;
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  const newLen = m32[SCRATCH / 4];
  const newMain = m32[SCRATCH / 4 + 1];
  const changed = m32[589820 / 4];
  const folded = m32[589816 / 4];
  const threaded = m32[589812 / 4];
  const out = new Int32Array(newLen);
  for (let i = 0; i < newLen; i++) out[i] = m32[SCRATCH / 4 + 2 + i];
  return { words: out, main: newMain, changed, folded, threaded };
}

// execute a raw IR word array directly through the interpreter (no recompile) -> stdout
// (scalar/control/calls only: the heap pointer is not initialized without a compile pass)
export async function runIR(words, main) {
  const I = await freshInstance();
  new Int32Array(I.ex.mem.buffer, CODE_BASE, words.length).set(words);
  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(main);
  return I.getOut();
}

// full pipeline: user .lm -> Lumen-emitted C -> clang -> native binary -> { stdout, exit, csrc }
export async function buildAndRun(src, opt = '-O2') {
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);
  const csrc = await emitC(words, main);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-native-'));
  const cfile = path.join(dir, 'p.c');
  const bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  try {
    execFileSync('clang', [opt, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync(bin, { encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    exit = typeof e.status === 'number' ? e.status : 1;
  }
  return { stdout, exit, csrc };
}

async function emitLlvmWith(emitterSrc, words, main, strings = []) {
  const I = await freshInstance();
  const len = writeSrc(I, emitterSrc);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`emitter compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[SCRATCH / 4] = words.length;
  m32[SCRATCH / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[SCRATCH / 4 + 2 + i] = words[i];

  // Inject the strings sidecar
  const offset_words = 2 + words.length;
  const dir_word_count = 3 * strings.length;
  m32[SCRATCH / 4 + offset_words] = dir_word_count;

  let current_byte_offset = SCRATCH + (offset_words + 1 + dir_word_count) * 4;

  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const triple_idx = SCRATCH / 4 + offset_words + 1 + 3 * i;
    m32[triple_idx] = s.ptr;
    m32[triple_idx + 1] = s.len;
    m32[triple_idx + 2] = current_byte_offset;

    // Copy bytes to current_byte_offset
    const m8 = new Uint8Array(I.ex.mem.buffer);
    m8.set(s.bytes, current_byte_offset);

    current_byte_offset += s.len;
  }

  if (current_byte_offset > 589824) {
    throw new Error(`IR + sidecar exceed Page-9 capacity (size ${current_byte_offset - SCRATCH}B exceeds 65536B)`);
  }

  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}

// emit LLVM IR text for a source (compile -> optimize-free IR -> emit_llvm.lm). Read-only:
// the same Lumen emitter buildAndRunLlvm uses, but returns the .ll text instead of building.
export async function emitLlvm(src) {
  const ir = await compileToIR(src);
  return await emitLlvmWith(EMIT_LLVM_SRC, ir.words, ir.main, ir.strings);
}

export async function buildAndRunLlvm(src, opt = '-O3') {
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);
  const ll_src = await emitLlvmWith(EMIT_LLVM_SRC, words, main, ir.strings);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-llvm-'));
  const llfile = path.join(dir, 'p.ll'), bin = path.join(dir, 'p');
  fs.writeFileSync(llfile, ll_src);
  try {
    const runtimeFile = new URL('./runtime_llvm.c', import.meta.url).pathname;
    execFileSync('clang', [opt, '-o', bin, llfile, runtimeFile], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`);
  }
  let stdout = '', exit = 0;
  try {
    stdout = execFileSync(bin, { encoding: 'utf8' });
  } catch (e) {
    stdout = e.stdout ? e.stdout.toString() : '';
    exit = typeof e.status === 'number' ? e.status : 1;
  }
  return { stdout, exit, ll_src };
}

