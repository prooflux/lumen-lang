// lumenc_native.mjs - builds lumenc.lm (the self-hosted compiler) into a standalone native
// binary that reads Lumen source on stdin and writes compiled IR on stdout.
//
// Ships the RAW (unoptimized) IR variant, not the optimize.lm-passed one. Reason: emit_fn.lm
// names each emitted C function f<pc>, where pc is the function's op-13 (RESERVE) word index
// in the IR it was given. The lex_compile entry point is located by scanning the compiler's
// own symbol table (12-byte records at [150000,157000): name_off, name_len, entry), the same
// technique selfhost_diff.mjs uses to redirect stale CALLs. That symbol table is populated
// during compilation and its entry values are pcs into the RAW IR the compile pass produced.
// optimize.lm's passes (dead-code elimination, thread-jump folding, ...) can move function
// bodies to different pcs (verified: lumenc.lm raw is 9319 words, optimized is 9222 - a 97-word
// shrink), and optimizeIR returns no old-pc -> new-pc relocation map. Mapping the symbol
// table's pc through that shrink is not cleanly derivable from the public pipeline.mjs surface,
// so this builder compiles once, extracts words/main/strings/symbol-table together from the
// SAME instance (guaranteeing the entry pc matches the IR verbatim, no cross-instance
// assumption), and emits from the RAW words. fixpoint_emit_test.mjs already gates lumenc/raw
// as clang-clean, so this loses nothing: correctness is bit-identical IR OUTPUT by the program
// lumenc.lm computes, not the optimization level of the binary computing it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { freshInstance, writeSrc, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const CODE_BASE = 11328;      // emitted IR words (matches seed/compiler_core.mjs CODE_BASE)
const SRC_BASE = 100000;      // SRC() in the seed's memory map
const SRC_CAP = 50000;        // SRC region is [100000,150000); matches compiler_core SRC_CAPACITY
const SYMTAB_BASE = 150000;
const SYMTAB_CEIL = 157000;   // same scan window selfhost_diff.mjs uses
const OUT_EMIT_COUNT_ADDR = 0;
const OUT_NERR_ADDR = 28;
const OUT_IR_BASE = 211328;
const LIT_HEAP_BASE = 488000;    // seed/lumenc.wat $hp start; matches compiler_core's Text heap
const LIT_HEAP_CEIL = 524288;    // page-9 boundary; heap is bump-allocated, never exceeds this
const LIT_HEAP_BYTES = LIT_HEAP_CEIL - LIT_HEAP_BASE;   // 36288

const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const LUMENC_SRC = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url), 'utf8');

// Compile lumenc.lm with the seed once, returning the RAW IR (words/main/strings) plus the
// lex_compile entry pc, all read from the one instance that produced them.
async function compileLumencRaw() {
  const I = await freshInstance();
  const len = writeSrc(I, LUMENC_SRC);
  const irWords = I.ex.compile(len);
  if (I.ex.dbg_nerr() > 0) throw new Error(`lumenc.lm compile: ${I.ex.dbg_nerr()} error(s)`);
  const main = I.ex.dbg_main();
  const words = Int32Array.from(new Int32Array(I.ex.mem.buffer, CODE_BASE, irWords));

  // strings sidecar - identical walk to compileToIR in pipeline.mjs
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
  const view = new DataView(I.ex.mem.buffer);
  const mem8 = new Uint8Array(I.ex.mem.buffer);
  const strings = uniquePtrs.map(ptr => {
    const slen = view.getInt32(ptr, true);
    const bytes = mem8.slice(ptr + 4, ptr + 4 + slen);
    return { ptr, len: slen, bytes };
  });

  // symbol table scan - same region/stride/technique as seed/selfhost_diff.mjs
  let lexCompileEntry = -1;
  for (let addr = SYMTAB_BASE; addr < SYMTAB_CEIL; addr += 12) {
    const name_off = view.getInt32(addr, true);
    const name_len = view.getInt32(addr + 4, true);
    const entry = view.getInt32(addr + 8, true);
    if (name_off >= SRC_BASE && name_off < SYMTAB_BASE && name_len > 0) {
      const name = Buffer.from(mem8.slice(name_off, name_off + name_len)).toString('utf8');
      if (name === 'lex_compile') lexCompileEntry = entry;
    }
  }
  if (lexCompileEntry === -1) throw new Error('lex_compile entry not found in lumenc.lm symbol table');

  return { words, main, strings, lexCompileEntry };
}

// Replace the emitter's one-shot `int main(void){...f<main>();return 0;}` with a driver that
// reads all of stdin (capped at SRC_CAP, the SRC region size) into LMEM at SRC_BASE, calls the
// lex_compile entry directly (not lumenc.lm's own `main`, which is a self-test driver, not a
// stdin-facing compile entry point), then writes nerr, emit count, the emitted IR words, the
// program's main entry, and the raw literal (string) heap bytes to stdout, all little-endian,
// nothing else.
//
// Extended output format (all little-endian): [nerr:i32][count:i32][words:count*i32]
// [main_entry:i32][literal_heap: LIT_HEAP_BYTES bytes, verbatim LMEM[LIT_HEAP_BASE,LIT_HEAP_CEIL)].
// The literal heap is dumped wholesale, no logic in the seam: each string in it is already laid
// out as [len:i32][utf8 bytes] at the pointer an MKTEXT operand names, mirroring exactly how
// compileToIR/compileLumencRaw construct their strings sidecars by reading getInt32(ptr) then
// ptr+4..ptr+4+len (see compileToIR in pipeline.mjs and the strings walk above). The main entry
// is found by a logic-free scan of the symbol table (12-byte records name_off/name_len/entry in
// [150000,157000), names in [100000,150000)) for the 4-byte name "main", the same region/stride
// selfhost_diff.mjs and compileLumencRaw already scan for lex_compile.
export function patchMainToCompileDriver(csrc, lexCompileEntry) {
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,_IONBF,0\);f\d+\(\);return 0;\}/);
  if (!m) throw new Error('could not find the emitted main entry to patch');
  const driver = `int main(void){
  setvbuf(stdout,0,_IONBF,0);
  size_t srclen=fread(LMEM+${SRC_BASE},1,${SRC_CAP},stdin);
  f${lexCompileEntry}((int64_t)srclen);
  int32_t nerr=*(int32_t*)(LMEM+${OUT_NERR_ADDR});
  int32_t emitc=*(int32_t*)(LMEM+${OUT_EMIT_COUNT_ADDR});
  int32_t mainentry=0;   // matches lumenc.wat's $main_entry default (i32.const 0): if no
                         // function literally named "main" exists in the compiled input, the
                         // seed's dbg_main() reports this same uninitialized default, not a
                         // sentinel - mirror that convention exactly rather than inventing one.
  for(int32_t addr=150000;addr<157000;addr+=12){
    int32_t name_off=*(int32_t*)(LMEM+addr);
    int32_t name_len=*(int32_t*)(LMEM+addr+4);
    int32_t entry=*(int32_t*)(LMEM+addr+8);
    if(name_len==4 && name_off>=100000 && name_off<150000
       && LMEM[name_off]=='m' && LMEM[name_off+1]=='a' && LMEM[name_off+2]=='i' && LMEM[name_off+3]=='n'){
      mainentry=entry;
    }
  }
  unsigned char h1[4]={(unsigned char)nerr,(unsigned char)(nerr>>8),(unsigned char)(nerr>>16),(unsigned char)(nerr>>24)};
  unsigned char h2[4]={(unsigned char)emitc,(unsigned char)(emitc>>8),(unsigned char)(emitc>>16),(unsigned char)(emitc>>24)};
  unsigned char h3[4]={(unsigned char)mainentry,(unsigned char)(mainentry>>8),(unsigned char)(mainentry>>16),(unsigned char)(mainentry>>24)};
  fwrite(h1,1,4,stdout);
  fwrite(h2,1,4,stdout);
  if(emitc>0)fwrite(LMEM+${OUT_IR_BASE},1,(size_t)emitc*4,stdout);
  fwrite(h3,1,4,stdout);
  fwrite(LMEM+${LIT_HEAP_BASE},1,${LIT_HEAP_BYTES},stdout);
  return 0;
}`;
  return csrc.replace(m[0], driver);
}

// Compile a C source string to a native binary with the flags used everywhere in this pipeline
// (-ffp-contract=off -fno-fast-math, plus the requested optimization level). Returns the binary
// path (in a fresh tmp dir named with `tag`). Shared by buildLumencNative and any caller that
// needs to clang a patched C source directly (e.g. the fixpoint gate's generation-2 build).
export function buildNativeBinaryFromC(csrc, { opt = '-O2', tag = 'native', name = 'bin' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  const cfile = path.join(dir, `${name}.c`), bin = path.join(dir, name);
  fs.writeFileSync(cfile, csrc);
  try {
    execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile],
      { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  return bin;
}

// Build the native lumenc binary. Returns { bin, variant, entry }: the binary path, the IR
// variant it was built from ('raw'), and the lex_compile entry pc used to name the driven fn.
export async function buildLumencNative(opt = '-O2') {
  const { words, main, strings, lexCompileEntry } = await compileLumencRaw();
  const csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  const patched = patchMainToCompileDriver(csrc, lexCompileEntry);
  const bin = buildNativeBinaryFromC(patched, { opt, tag: 'lumenc-native', name: 'lumenc' });
  return { bin, variant: 'raw', entry: lexCompileEntry };
}

// CLI: node lumenc_native.mjs [-o outfile] [--opt -O2|-O3]
if (process.argv[1] && process.argv[1].endsWith('lumenc_native.mjs')) {
  const args = process.argv.slice(2);
  let outfile = null, opt = '-O2';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') outfile = args[++i];
    else if (args[i] === '--opt') opt = args[++i];
  }
  const { bin, variant, entry } = await buildLumencNative(opt);
  if (outfile) {
    fs.copyFileSync(bin, outfile);
    fs.chmodSync(outfile, 0o755);
    console.log(outfile);
  } else {
    console.log(bin);
  }
  console.error(`(variant: ${variant}, lex_compile entry: f${entry})`);
}
