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

const SRC_BASE = 20000;
const CODE_BASE = 11328;
const SCRATCH = 524288;            // page 9: compile-time tables only; safe to inject into after compile

const wabt = await wabtInit();
const wat = fs.readFileSync(new URL('../seed/lumenc.wat', import.meta.url), 'utf8');
const binary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
const EMIT_SRC = fs.readFileSync(new URL('./emit.lm', import.meta.url), 'utf8');
const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const OPT_SRC = fs.readFileSync(new URL('./optimize.lm', import.meta.url), 'utf8');

async function freshInstance() {
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  return { ex: instance.exports, getOut: () => out, resetOut: () => { out = ''; } };
}

function writeSrc(I, src) {
  const b = Buffer.from(src, 'utf8');
  if (b.length > 10000) throw new Error(`source ${b.length}B exceeds SRC capacity`);
  new Uint8Array(I.ex.mem.buffer, SRC_BASE, b.length).set(b);
  return b.length;
}

// compile user source -> { words: Int32Array (copy), main, irWords }
export async function compileToIR(src) {
  const I = await freshInstance();
  const len = writeSrc(I, src);
  const irWords = I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`user compile: ${I.ex.dbg_nerr()} error(s)`);
  const main = I.ex.dbg_main();
  const words = Int32Array.from(new Int32Array(I.ex.mem.buffer, CODE_BASE, irWords));
  return { words, main, irWords };
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
async function emitWith(emitterSrc, words, main) {
  const I = await freshInstance();
  const len = writeSrc(I, emitterSrc);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`emitter compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[SCRATCH / 4] = words.length;
  m32[SCRATCH / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[SCRATCH / 4 + 2 + i] = words[i];
  I.resetOut();
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  return I.getOut();
}

// v2 per-function emitter (emit_fn.lm) - the "beat C" lowering
export async function buildAndRunFn(src, opt = '-O2') {
  const { words, main } = await compileToIR(src);
  const csrc = await emitWith(EMIT_FN_SRC, words, main);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-fn-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  try { execFileSync('clang', [opt, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`); }
  let stdout = '', exit = 0;
  try { stdout = execFileSync(bin, { encoding: 'utf8' }); }
  catch (e) { stdout = e.stdout ? e.stdout.toString() : ''; exit = typeof e.status === 'number' ? e.status : 1; }
  return { stdout, exit, csrc };
}

// run optimize.lm (Lumen) over an injected IR snapshot -> { words: optimized IR (copy), changed }
export async function optimizeIR(words, main) {
  const I = await freshInstance();
  const len = writeSrc(I, OPT_SRC);
  I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`optimize.lm compile: ${I.ex.dbg_nerr()} error(s)`);
  const m32 = new Int32Array(I.ex.mem.buffer);
  m32[SCRATCH / 4] = words.length;
  m32[SCRATCH / 4 + 1] = main;
  for (let i = 0; i < words.length; i++) m32[SCRATCH / 4 + 2 + i] = words[i];
  if (I.ex.set_fuel_max) I.ex.set_fuel_max(4000000000n);
  I.ex.run(I.ex.dbg_main());
  const out = new Int32Array(words.length);
  for (let i = 0; i < words.length; i++) out[i] = m32[SCRATCH / 4 + 2 + i];
  const changed = m32[SCRATCH / 4 + 1];   // optimize.lm wrote the threaded-jump count here
  return { words: out, changed };
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
  const { words, main } = await compileToIR(src);
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
