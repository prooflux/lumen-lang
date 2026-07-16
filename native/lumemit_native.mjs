// lumemit_native.mjs - emit_fn.lm (the "beat C" per-function emitter) as a standalone native
// binary: the emitter, compiled by itself, emitting C for whatever IR it is fed.
//
// Build: emit_fn.lm is compiled to IR by the seed (compileToIR), then emitWith(EMIT_FN_SRC, ...)
// runs emit_fn.lm ITSELF through the seed interpreter to translate that IR into C - the same
// self-application lumenc_native.mjs performs for lumenc.lm. clang then assembles that C into a
// binary that computes exactly what emit_fn.lm's Lumen `main` computes: given an IR staged at
// hdr()=EMIT_FN_BASE (see emit_fn.lm's header comment and pipeline.mjs's emitWith), it prints C
// text to stdout via the ordinary Console.print path (lm_printtext -> fwrite(stdout)).
//
// Driver: the emitted one-shot `int main(void){...f<entry>();return 0;}` is replaced with a
// driver that reads ONE 4-byte little-endian length header, then that many bytes into
// LMEM[EMIT_FN_BASE, EMIT_FN_BASE+n), fully consuming stdin (fread blocks until it has all n
// bytes or hits EOF) BEFORE calling the emitter entry - so nothing but the emitted C reaches
// stdout. The payload bytes are staged in EXACTLY the layout emitWith uses (see stagePayload
// below): header [len, main, words...] at offset 0 (= address EMIT_FN_BASE), then a strings
// directory (3-word triples: orig_ptr, len, absolute byte_offset) and the string bytes
// themselves at those same absolute addresses - dir_byte_offset() readers in emit_fn.lm use
// load8(byte_off + j) with byte_off taken verbatim from the directory, so the payload's byte
// offsets must already be correct LMEM addresses, not payload-relative ones.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compileToIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');

// Build the exact byte payload emitWith would stage at `base`, as a Buffer whose index 0
// corresponds to LMEM address `base`. Throws if it would exceed `ceil`, mirroring emitWith's
// own capacity guard.
export function stagePayload(words, main, strings, base = EMIT_FN_BASE, ceil = EMIT_FN_CEIL) {
  const offsetWords = 2 + words.length;          // words position, in i32 units from base/4
  const dirWordCount = 3 * strings.length;
  const headerWords = offsetWords + 1 + dirWordCount;   // where string bytes begin, in i32 units
  const stringBytesTotal = strings.reduce((a, s) => a + s.len, 0);
  const totalBytes = headerWords * 4 + stringBytesTotal;
  if (base + totalBytes > ceil) {
    throw new Error(`IR + sidecar exceed injection capacity (size ${totalBytes}B, ceil ${ceil})`);
  }
  const buf = Buffer.alloc(totalBytes);
  buf.writeInt32LE(words.length, 0);
  buf.writeInt32LE(main, 4);
  for (let i = 0; i < words.length; i++) buf.writeInt32LE(words[i], 8 + i * 4);
  const dirOff = 8 + words.length * 4;             // buffer offset == address (base + dirOff)
  buf.writeInt32LE(dirWordCount, dirOff);
  let byteCursor = base + headerWords * 4;         // absolute LMEM address, matches emitWith
  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const tIdx = dirOff + 4 + i * 12;
    buf.writeInt32LE(s.ptr, tIdx);
    buf.writeInt32LE(s.len, tIdx + 4);
    buf.writeInt32LE(byteCursor, tIdx + 8);
    Buffer.from(s.bytes).copy(buf, byteCursor - base);
    byteCursor += s.len;
  }
  return buf;
}

// Frame a payload as [u32 len][bytes] for the native driver's stdin protocol.
export function frame(payload) {
  const h = Buffer.alloc(4);
  h.writeUInt32LE(payload.length, 0);
  return Buffer.concat([h, payload]);
}

// Replace the emitted one-shot main with the length-framed stdin driver.
function patchMainToEmitDriver(csrc, base) {
  // S1b: generic setvbuf mode/size match (not hardcoded _IONBF,0) - see the matching comment in
  // lumenc_native.mjs's patchMainToCompileDriver for why.
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,[A-Za-z_]+,\d+\);(f\d+)\(\);return 0;\}/);
  if (!m) throw new Error('could not find the emitted main entry to patch');
  const entry = m[1];
  const driver = `int main(void){
  setvbuf(stdout,0,_IONBF,0);
  unsigned char h[4];
  if(fread(h,1,4,stdin)!=4)return 1;
  uint32_t n=(uint32_t)h[0]|((uint32_t)h[1]<<8)|((uint32_t)h[2]<<16)|((uint32_t)h[3]<<24);
  if(n>0){ if(fread(LMEM+${base},1,n,stdin)!=n)return 1; }
  ${entry}();
  return 0;
}`;
  return csrc.replace(m[0], driver);
}

// Produce the self-contained C source of the native lumemit (emitter) binary: emit_fn.lm
// emitting ITSELF to C, plus the length-framed stdin driver. `clang <this> -o lumemit0` yields
// the native emitter with zero wasm. This is the emitter's R1-style reproducible genesis;
// generating it runs the seed once (author time only), the checked-in artifact is what the
// wat-free build and the trust chain consume. Gated by native/emitter_bootstrap_test.mjs.
export async function emitLumemitBootstrapC() {
  const ef = await compileToIR(EMIT_FN_SRC);
  const csrc = await emitWith(EMIT_FN_SRC, ef.words, ef.main, ef.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  return patchMainToEmitDriver(csrc, EMIT_FN_BASE);
}

// Build the native lumemit binary. Returns { bin, entry }.
export async function buildLumemitNative(opt = '-O2') {
  const patched = await emitLumemitBootstrapC();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumemit-native-'));
  const cfile = path.join(dir, 'lumemit.c'), bin = path.join(dir, 'lumemit');
  fs.writeFileSync(cfile, patched);
  try {
    execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  return { bin };
}

// Run the native lumemit binary over (words, main, strings): stages the payload, feeds it
// framed, returns the emitted C text (stdout, decoded utf8).
export function runLumemitNative(bin, words, main, strings) {
  const payload = stagePayload(words, main, strings);
  const out = execFileSync(bin, { input: frame(payload), maxBuffer: 256 * 1024 * 1024 });
  return out.toString('utf8');
}

// CLI: node lumemit_native.mjs [-o outfile] [--opt -O2|-O3]
if (process.argv[1] && process.argv[1].endsWith('lumemit_native.mjs')) {
  const args = process.argv.slice(2);
  let outfile = null, opt = '-O2';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') outfile = args[++i];
    else if (args[i] === '--opt') opt = args[++i];
  }
  const { bin } = await buildLumemitNative(opt);
  if (outfile) {
    fs.copyFileSync(bin, outfile);
    fs.chmodSync(outfile, 0o755);
    console.log(outfile);
  } else {
    console.log(bin);
  }
}
