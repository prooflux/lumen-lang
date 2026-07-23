// lumenc_native.mjs - builds lumenc.lm (the self-hosted compiler) into a standalone native
// binary that reads Lumen source on stdin and writes compiled IR on stdout.
//
// Ships the RAW (unoptimized) IR variant, not the optimize.lm-passed one. Reason: emit_fn.lm
// names each emitted C function f<pc>, where pc is the function's op-13 (RESERVE) word index
// in the IR it was given. The lex_compile entry point is located by scanning the compiler's
// own symbol table (12-byte records at [170000,177000): name_off, name_len, entry), the same
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
import { emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';
import { compileToIRNativeRaw } from './native_compile.mjs';
import { ccInvocation } from './cc_wrapper.mjs';

const CODE_BASE = 11328;      // emitted IR words (matches seed/compiler_core.mjs CODE_BASE)
const SRC_BASE = 100000;      // SRC() in the seed's memory map
export const SRC_CAP = 70000; // SRC region is [100000,170000); matches compiler_core SRC_CAPACITY
const SYMTAB_BASE = 170000;
const SYMTAB_CEIL = 177000;   // same scan window selfhost_diff.mjs uses
const OUT_EMIT_COUNT_ADDR = 0;
const OUT_NERR_ADDR = 28;
const OUT_IR_BASE = 211328;
const LIT_HEAP_BASE = 488000;    // seed/lumenc.wat $hp start; matches compiler_core's Text heap
const LIT_HEAP_CEIL = 524288;    // page-9 boundary; heap is bump-allocated, never exceeds this
export const LIT_HEAP_BYTES = LIT_HEAP_CEIL - LIT_HEAP_BASE;   // 36288
// NOT 286000 (that is seed/compiler_core.mjs's DIAG_BASE, the WAT-NATIVE bootstrap compiler's
// OWN internal diagnostic-record address for compiling arbitrary source directly). This driver
// runs lumenc.lm SELF-HOSTED - a separate Lumen program interpreted/compiled atop that wat VM,
// with its own memory layout. lumenc.lm's own err_add (seed/lumenc.lm) writes records at
// 297000 + nerr*12; the ceiling is TOKENS() = 299000 (seed/lumenc.lm), the next region
// lumenc.lm's own memory map documents. (GAP-A fix, native/selfcompile_diff.mjs: DIAG/TOKENS
// moved here from 390000/396000 to reclaim slack from CODE()'s over-provisioned reserve for
// TOKENS' capacity -- see seed/lumenc.lm's header comment for the full accounting.) Verified
// empirically against seed/compiler_core.mjs's readRawDiags() output for the same source
// (native/native_resident_test.mjs).
const DIAG_BASE = 297000;
const DIAG_CEIL = 299000;
const DIAG_RECORD_CAP = Math.floor((DIAG_CEIL - DIAG_BASE) / 12);   // 500 (code,name_off,name_len) triples
// TOKENS() = 299000 (seed/lumenc.lm) - immediately after DIAG_CEIL, per the D4/#87 repack. The
// two trailer-dump sites below still read the PRE-#87 address (396000) inherited from this
// branch's pre-rebase state; that stale offset silently reads zeroed memory, so lumen_tokens
// always returned an all-zero token stream (loop_test.mjs's "lumen_tokens returns the token
// stream with lexemes" - caught post-rebase, fixed here to match main's #87 repack).
const TOKENS_BASE = 299000;

const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
const LUMENC_SRC = fs.readFileSync(new URL('../seed/lumenc.lm', import.meta.url), 'utf8');

// Compile lumenc.lm with the native compiler once, returning the RAW IR (words/main/strings)
// plus the lex_compile entry pc, all from the SAME compileToIRNativeRaw call that produced
// them (R5: this used to re-derive strings/symbols by scanning a wasm instance's own memory;
// compileToIRNativeRaw now returns all three directly - see native/native_compile.mjs's R5
// symbol-table trailer - so this is simpler than the wasm-era version, not just wasm-free).
async function compileLumencRaw() {
  const r = compileToIRNativeRaw(LUMENC_SRC);
  if (r.nerr > 0) throw new Error(`lumenc.lm compile: ${r.nerr} error(s)`);
  const sym = r.symbols.find((s) => s.name === 'lex_compile');
  if (!sym) throw new Error('lex_compile entry not found in lumenc.lm symbol table');
  return { words: r.words, main: r.main, strings: r.strings, lexCompileEntry: sym.entry };
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
// [170000,177000), names in [100000,170000)) for the 4-byte name "main", the same region/stride
// selfhost_diff.mjs and compileLumencRaw already scan for lex_compile.
//
// R3 addition: the binary also accepts one CLI flag, `--resident`, which switches `main` to a
// long-lived request loop instead of the one-shot behavior above. With no argv (the case every
// existing caller uses - runNativeCompiler, native_compile_test.mjs, bootstrap_test.mjs, the
// parity gates), the driver's behavior and byte-for-byte output are UNCHANGED: the original
// one-shot body below is reproduced verbatim inside main's default branch, not just
// behaviorally reimplemented, so every gate that depends on that exact format keeps working
// unmodified. `--resident` is additive.
//
// Resident wire protocol (both directions length-framed, 4-byte little-endian byte count then
// payload - the same convention native/lumen_serve_native.mjs already uses for its serve loop):
//   request:  [reqlen:u32][source bytes, reqlen of them]
//   response: [payloadlen:u32][nerr:i32][count:i32][words:count*i32][main_entry:i32]
//             [literal_heap:LIT_HEAP_BYTES bytes][ndiag:i32][diag: ndiag*3*i32 (code,name_off,name_len)]
// The response payload's first part (nerr..literal_heap) is byte-for-byte the one-shot format
// above; a reader that already understands that format only needs to additionally consume the
// outer 4-byte length and the trailing diagnostic-record block. Diagnostic records come from
// lumenc.lm's OWN err_add region (DIAG_BASE=390000, see the constant's comment above - NOT
// compiler_core.mjs's 286000, a different program's internal address), 12 bytes/record,
// code/name_off/name_len, the same field order seed/compiler_core.mjs's readRawDiags() exposes,
// so a client can reconstruct the same {code, byteOff, byteLen, name} shape the wasm daemon
// already returns - name text itself is NOT resent (name_off - SRC_BASE is a byte offset into
// the request source the client already has, exactly how readRawDiags() resolves it from the
// SAME buffer it wrote SRC into).
//
// State reset: between requests, main resets the compiler's ENTIRE mutable state (LMEM, AHEAP,
// AHP, LM_HP - by inspection, the complete set of file-scope mutable statics in this translation
// unit; every other top-level `static` here is a function or a const table) to the same
// all-zero values a freshly-started process starts with. This is a full-process-equivalent
// reset by construction (not a partial/optimized one), so it does not rely on lex_compile
// happening to zero its own bookkeeping - it doesn't need to. native/native_resident_test.mjs
// proves the result: compiling the corpus twice through one resident process reproduces both a
// fresh one-shot process's output and the wasm seed's output, byte-for-byte, for every program.
//
// A source longer than the SRC_CAP-byte SRC window is capped to SRC_CAP bytes for compilation
// (matching the one-shot path's fread cap) and any remaining declared bytes are drained (read
// and discarded) so a request that describes more bytes than the window holds cannot desync the
// next request's length header on the same pipe.
export function patchMainToCompileDriver(csrc, lexCompileEntry) {
  // S1b: setvbuf's mode/size args are matched generically (not hardcoded to _IONBF,0) because
  // native/emit_fn.lm's emitted preamble now buffers stdout (_IOFBF,65536) instead of leaving it
  // unbuffered - this regex runs against C emitted by that same preamble via self-application, so
  // it must tolerate whichever buffering mode emit_fn.lm currently emits.
  const m = csrc.match(/int main\(void\)\{setvbuf\(stdout,0,[A-Za-z_]+,\d+\);f\d+\(\);return 0;\}/);
  if (!m) throw new Error('could not find the emitted main entry to patch');
  const driver = `static uint32_t lm_compile_rd4(void){
  unsigned char h[4];
  if(fread(h,1,4,stdin)!=4)return 0xffffffffu;
  return (uint32_t)h[0]|((uint32_t)h[1]<<8)|((uint32_t)h[2]<<16)|((uint32_t)h[3]<<24);
}
static void lm_compile_wr4(uint32_t v){
  unsigned char h[4]={(unsigned char)v,(unsigned char)(v>>8),(unsigned char)(v>>16),(unsigned char)(v>>24)};
  fwrite(h,1,4,stdout);
}
static void lm_compile_reset(void){
  memset(LMEM,0,sizeof(LMEM));
  memset(AHEAP,0,sizeof(AHEAP));
  AHP=0;
  LM_HP=0;
}
static void lm_resident_loop(void){
  for(;;){
    uint32_t n=lm_compile_rd4();
    if(n==0xffffffffu)break;
    uint32_t want=n;
    if(want>${SRC_CAP}u)want=${SRC_CAP}u;
    size_t got=want?fread(LMEM+${SRC_BASE},1,want,stdin):0;
    if(want && got!=want)break;
    if(n>want){
      uint32_t remaining=n-want;
      unsigned char discard[4096];
      while(remaining>0){
        uint32_t chunk=remaining<(uint32_t)sizeof(discard)?remaining:(uint32_t)sizeof(discard);
        if(fread(discard,1,chunk,stdin)!=chunk)break;
        remaining-=chunk;
      }
    }
    f${lexCompileEntry}((int64_t)got);
    int32_t nerr=*(int32_t*)(LMEM+${OUT_NERR_ADDR});
    int32_t emitc=*(int32_t*)(LMEM+${OUT_EMIT_COUNT_ADDR});
    int32_t mainentry=0;
    for(int32_t addr=170000;addr<177000;addr+=12){
      int32_t name_off=*(int32_t*)(LMEM+addr);
      int32_t name_len=*(int32_t*)(LMEM+addr+4);
      int32_t entry=*(int32_t*)(LMEM+addr+8);
      if(name_len==4 && name_off>=100000 && name_off<170000
         && LMEM[name_off]=='m' && LMEM[name_off+1]=='a' && LMEM[name_off+2]=='i' && LMEM[name_off+3]=='n'){
        mainentry=entry;
      }
    }
    int32_t ndiag=nerr;
    if(ndiag<0)ndiag=0;
    if(ndiag>${DIAG_RECORD_CAP})ndiag=${DIAG_RECORD_CAP};
    // R5: symbol-table (lumenc.lm's SYMBOLS()=170000, count at load32(12)) and token-stream
    // (TOKENS()=299000, count at load32(8)) trailers, appended after the diagnostics block, so
    // the MCP introspection tools (lumen_symbols/lumen_tokens/lumen_profile) can retire their
    // wasm-instance memory peek without losing any capability - lumenc.lm tracks both at the
    // SAME addresses the wasm seed does (see seed/lumenc.lm's own header comment), so this is a
    // faithful mirror, not a new invention. Only the OCCUPIED prefix of each region is sent
    // (nsym*12 / ntok*12 bytes), not the whole fixed window, so a small program pays a small cost.
    int32_t ntok=*(int32_t*)(LMEM+8);
    if(ntok<0)ntok=0;
    if(ntok>16000)ntok=16000;
    int32_t nsym=*(int32_t*)(LMEM+12);
    if(nsym<0)nsym=0;
    if(nsym>583)nsym=583;
    uint32_t payload_len=(uint32_t)(4+4+(emitc>0?(uint32_t)emitc*4u:0u)+4+${LIT_HEAP_BYTES}u+4+(uint32_t)ndiag*12u
      +4+(uint32_t)ntok*12u+4+(uint32_t)nsym*12u);
    lm_compile_wr4(payload_len);
    unsigned char h1[4]={(unsigned char)nerr,(unsigned char)(nerr>>8),(unsigned char)(nerr>>16),(unsigned char)(nerr>>24)};
    unsigned char h2[4]={(unsigned char)emitc,(unsigned char)(emitc>>8),(unsigned char)(emitc>>16),(unsigned char)(emitc>>24)};
    unsigned char h3[4]={(unsigned char)mainentry,(unsigned char)(mainentry>>8),(unsigned char)(mainentry>>16),(unsigned char)(mainentry>>24)};
    unsigned char h4[4]={(unsigned char)ndiag,(unsigned char)(ndiag>>8),(unsigned char)(ndiag>>16),(unsigned char)(ndiag>>24)};
    unsigned char h5[4]={(unsigned char)ntok,(unsigned char)(ntok>>8),(unsigned char)(ntok>>16),(unsigned char)(ntok>>24)};
    unsigned char h6[4]={(unsigned char)nsym,(unsigned char)(nsym>>8),(unsigned char)(nsym>>16),(unsigned char)(nsym>>24)};
    fwrite(h1,1,4,stdout);
    fwrite(h2,1,4,stdout);
    if(emitc>0)fwrite(LMEM+${OUT_IR_BASE},1,(size_t)emitc*4,stdout);
    fwrite(h3,1,4,stdout);
    fwrite(LMEM+${LIT_HEAP_BASE},1,${LIT_HEAP_BYTES},stdout);
    fwrite(h4,1,4,stdout);
    if(ndiag>0)fwrite(LMEM+${DIAG_BASE},1,(size_t)ndiag*12,stdout);
    fwrite(h5,1,4,stdout);
    if(ntok>0)fwrite(LMEM+${TOKENS_BASE},1,(size_t)ntok*12,stdout);
    fwrite(h6,1,4,stdout);
    if(nsym>0)fwrite(LMEM+170000,1,(size_t)nsym*12,stdout);
    fflush(stdout);
    lm_compile_reset();
  }
}
int main(int argc,char**argv){
  setvbuf(stdout,0,_IONBF,0);
  if(argc>1 && strcmp(argv[1],"--resident")==0){
    lm_resident_loop();
    return 0;
  }
  size_t srclen=fread(LMEM+${SRC_BASE},1,${SRC_CAP},stdin);
  if(srclen==(size_t)${SRC_CAP}u && fgetc(stdin)!=EOF){
    fprintf(stderr,"lumen: memory trap: source exceeds the %u-byte SRC window\\n",(unsigned)${SRC_CAP}u);
    return 70;
  }
  f${lexCompileEntry}((int64_t)srclen);
  int32_t nerr=*(int32_t*)(LMEM+${OUT_NERR_ADDR});
  int32_t emitc=*(int32_t*)(LMEM+${OUT_EMIT_COUNT_ADDR});
  int32_t mainentry=0;   // matches lumenc.wat's $main_entry default (i32.const 0): if no
                         // function literally named "main" exists in the compiled input, the
                         // seed's dbg_main() reports this same uninitialized default, not a
                         // sentinel - mirror that convention exactly rather than inventing one.
  for(int32_t addr=170000;addr<177000;addr+=12){
    int32_t name_off=*(int32_t*)(LMEM+addr);
    int32_t name_len=*(int32_t*)(LMEM+addr+4);
    int32_t entry=*(int32_t*)(LMEM+addr+8);
    if(name_len==4 && name_off>=100000 && name_off<170000
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
  // R5: diagnostic-record trailer, matching the resident loop's [ndiag][diag] block exactly
  // (same lumenc.lm err_add region, DIAG_BASE=390000 - see the constant's header comment above).
  // The one-shot driver previously omitted this entirely; seed/compiler_core.mjs's compile()
  // needs it for rawDiags (E0001..E0004 codes, byte offsets, names), the same as checkNativeResident.
  int32_t ndiag=nerr;
  if(ndiag<0)ndiag=0;
  if(ndiag>${DIAG_RECORD_CAP})ndiag=${DIAG_RECORD_CAP};
  unsigned char h4[4]={(unsigned char)ndiag,(unsigned char)(ndiag>>8),(unsigned char)(ndiag>>16),(unsigned char)(ndiag>>24)};
  fwrite(h4,1,4,stdout);
  if(ndiag>0)fwrite(LMEM+${DIAG_BASE},1,(size_t)ndiag*12,stdout);
  // R5: symbol-table + token-stream trailers (see the resident loop's matching comment above;
  // same lumenc.lm addresses, same occupied-prefix-only convention).
  int32_t ntok=*(int32_t*)(LMEM+8);
  if(ntok<0)ntok=0;
  if(ntok>16000)ntok=16000;
  int32_t nsym=*(int32_t*)(LMEM+12);
  if(nsym<0)nsym=0;
  if(nsym>583)nsym=583;
  unsigned char h5[4]={(unsigned char)ntok,(unsigned char)(ntok>>8),(unsigned char)(ntok>>16),(unsigned char)(ntok>>24)};
  unsigned char h6[4]={(unsigned char)nsym,(unsigned char)(nsym>>8),(unsigned char)(nsym>>16),(unsigned char)(nsym>>24)};
  fwrite(h5,1,4,stdout);
  if(ntok>0)fwrite(LMEM+${TOKENS_BASE},1,(size_t)ntok*12,stdout);
  fwrite(h6,1,4,stdout);
  if(nsym>0)fwrite(LMEM+170000,1,(size_t)nsym*12,stdout);
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
    const { cmd, args } = ccInvocation(['-ffp-contract=off', '-fno-fast-math', opt, '-o', bin, cfile]);
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    throw new Error(`clang failed: ${String(e.stderr || e.message).slice(0, 500)}`);
  }
  return bin;
}

// Build the native lumenc binary. Returns { bin, variant, entry }: the binary path, the IR
// variant it was built from ('raw'), and the lex_compile entry pc used to name the driven fn.
// Produce the self-contained C source of the native lumenc compiler (emitted functions +
// runtime + the stdin-reading compile driver), the exact text buildLumencNative clangs. This
// is the reproducible-genesis artifact: `clang <this> -o lumenc0` yields the native compiler
// with zero wasm/wabt/node. Generating it still runs the seed once (compileLumencRaw + emit_fn);
// it is generated once, checked in as native/lumenc.bootstrap.c, and the bootstrap gate
// re-emits + diffs it so it cannot rot.
export async function emitLumencBootstrapC() {
  const { words, main, strings, lexCompileEntry } = await compileLumencRaw();
  const csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  return { csrc: patchMainToCompileDriver(csrc, lexCompileEntry), entry: lexCompileEntry };
}

export async function buildLumencNative(opt = '-O2') {
  const { csrc, entry } = await emitLumencBootstrapC();
  const bin = buildNativeBinaryFromC(csrc, { opt, tag: 'lumenc-native', name: 'lumenc' });
  return { bin, variant: 'raw', entry };
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
