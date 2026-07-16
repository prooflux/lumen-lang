// lumopt_native.mjs - optimize.lm (the Lumen-owned IR optimizer) as a standalone native binary.
//
// Build: compile optimize.lm to IR with the seed (compileToIR), then run it through emit_fn.lm
// (emitWith) to translate ITS OWN logic into C, exactly the self-application pattern
// lumemit_native.mjs uses for the emitter itself. optimize.lm's memory contract (see its header
// comment): hdr()=524288 holds [ir_len, main_entry, words...] (SCRATCH in pipeline.mjs), and the
// pass counters live at fixed addresses 1100000 (threaded) / 1100004 (folded) / 1100008
// (changed), zeroed before each run by pipeline.mjs's optimizeIR and read back after. (Moved
// 2026-07-15 from 589812/16/20, which sat INSIDE hdr's own IR-word array range and silently
// corrupted word 16379 of any IR that grew that large -- see native/optimize.lm's header.)
//
// Driver: the emitted one-shot main is replaced with a driver that reads ONE 4-byte
// little-endian length header, then that many bytes into LMEM[524288, 524288+n) (fully
// consuming stdin before running, same discipline as lumemit_native.mjs), zeroes the three
// counters, calls optimize.lm's own entry, then writes [newLen][newMain][threaded][folded]
// [changed][newLen words] to stdout, all little-endian i32.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compileToIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const OPT_SRC = fs.readFileSync(new URL('./optimize.lm', import.meta.url), 'utf8');
const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const HDR_BASE = 524288;   // matches pipeline.mjs's SCRATCH / optimize.lm's hdr()
const CNT_THREADED = 1100000, CNT_FOLDED = 1100004, CNT_CHANGED = 1100008;

// Stage the framed payload for the native driver: [len:i32][main:i32][words...].
export function stagePayload(words, main) {
  const buf = Buffer.alloc(8 + words.length * 4);
  buf.writeInt32LE(words.length, 0);
  buf.writeInt32LE(main, 4);
  for (let i = 0; i < words.length; i++) buf.writeInt32LE(words[i], 8 + i * 4);
  return buf;
}

export function frame(payload) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(payload.length, 0);
  return Buffer.concat([h, payload]);
}

function patchMainToOptimizeDriver(csrc, base) {
  // S1b: generic setvbuf mode/size match (not hardcoded _IONBF,0) - see the matching comment in
  // lumenc_native.mjs's patchMainToCompileDriver for why.
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,[A-Za-z_]+,\d+\);(f\d+)\(\);return 0;\}/);
  if (!m) throw new Error('could not find the emitted main entry to patch');
  const entry = m[1];
  // optimize.lm's own emitted main body ends in a HALT opcode, which emit_fn.lm lowers to
  // exit(0), so entry() below never returns to this driver. Register the output write as an
  // atexit handler (installed before the call) so it still runs when exit(0) fires inside
  // entry(); guard with g_written so a normal (non-exit) return path never double-writes.
  const driver = `static int32_t g_written=0;
static void write_output(void){
  if(g_written)return;
  g_written=1;
  int32_t newlen=*(int32_t*)(LMEM+${base});
  int32_t newmain=*(int32_t*)(LMEM+${base + 4});
  int32_t threaded=*(int32_t*)(LMEM+${CNT_THREADED});
  int32_t folded=*(int32_t*)(LMEM+${CNT_FOLDED});
  int32_t changed=*(int32_t*)(LMEM+${CNT_CHANGED});
  int32_t hdrs[5]={newlen,newmain,threaded,folded,changed};
  fwrite(hdrs,4,5,stdout);
  if(newlen>0)fwrite(LMEM+${base + 8},1,(size_t)newlen*4,stdout);
  fflush(stdout);
}
int main(void){
  setvbuf(stdout,0,_IONBF,0);
  unsigned char h[4];
  if(fread(h,1,4,stdin)!=4)return 1;
  uint32_t n=(uint32_t)h[0]|((uint32_t)h[1]<<8)|((uint32_t)h[2]<<16)|((uint32_t)h[3]<<24);
  if(n>0){ if(fread(LMEM+${base},1,n,stdin)!=n)return 1; }
  *(int32_t*)(LMEM+${CNT_THREADED})=0;
  *(int32_t*)(LMEM+${CNT_FOLDED})=0;
  *(int32_t*)(LMEM+${CNT_CHANGED})=0;
  atexit(write_output);
  ${entry}();
  write_output();
  return 0;
}`;
  return csrc.replace(m[0], driver);
}

// Produce the self-contained C source of the native lumopt (optimizer) binary: optimize.lm
// translated to C by emit_fn.lm, plus the length-framed stdin driver. `clang <this> -o lumopt0`
// yields the native optimizer with zero wasm. The optimizer's R1-style reproducible genesis;
// generating it runs the seed once (author time only). Gated by native/emitter_bootstrap_test.mjs.
export async function emitLumoptBootstrapC() {
  const ir = await compileToIR(OPT_SRC);
  const csrc = await emitWith(EMIT_FN_SRC, ir.words, ir.main, ir.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  return patchMainToOptimizeDriver(csrc, HDR_BASE);
}

// Build the native lumopt binary. Returns { bin }.
export async function buildLumoptNative(opt = '-O2') {
  const patched = await emitLumoptBootstrapC();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumopt-native-'));
  const cfile = path.join(dir, 'lumopt.c'), bin = path.join(dir, 'lumopt');
  fs.writeFileSync(cfile, patched);
  try {
    execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  return { bin };
}

// Run the native lumopt binary over (words, main). Returns { words, main, threaded, folded, changed }.
export function runLumoptNative(bin, words, main) {
  const payload = stagePayload(words, main);
  const out = execFileSync(bin, { input: frame(payload), maxBuffer: 256 * 1024 * 1024 });
  if (out.length < 20) {
    throw new Error(`native lumopt produced ${out.length} bytes (need >=20 for the fixed header) - `
      + `optimize.lm's own emitted main exits before writing any output (see the emitted `
      + `C: its self-compiled main body calls exit(0) immediately after invoking `
      + `optimize_passes, before this driver's post-call header write runs)`);
  }
  const newlen = out.readInt32LE(0);
  const newmain = out.readInt32LE(4);
  const threaded = out.readInt32LE(8);
  const folded = out.readInt32LE(12);
  const changed = out.readInt32LE(16);
  const outWords = new Int32Array(newlen);
  for (let i = 0; i < newlen; i++) outWords[i] = out.readInt32LE(20 + i * 4);
  return { words: outWords, main: newmain, threaded, folded, changed };
}

// CLI: node lumopt_native.mjs [-o outfile] [--opt -O2|-O3]
if (process.argv[1] && process.argv[1].endsWith('lumopt_native.mjs')) {
  const args = process.argv.slice(2);
  let outfile = null, opt = '-O2';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') outfile = args[++i];
    else if (args[i] === '--opt') opt = args[++i];
  }
  const { bin } = await buildLumoptNative(opt);
  if (outfile) {
    fs.copyFileSync(bin, outfile);
    fs.chmodSync(outfile, 0o755);
    console.log(outfile);
  } else {
    console.log(bin);
  }
}
