// native_pipeline_test.mjs - Stone 4 gate: native emitter (Part B/C) and native optimizer
// (Part D, bounded).
//
// PART B: for each corpus program (RAW/unoptimized IR, matching how stone 3 ships), the seed-side
// reference C (emitWith(EMIT_FN_SRC, ...)) must be byte-identical to the native lumemit binary's
// output over the SAME (words, main, strings). lumenc.lm itself is REQUIRED by the brief; it is
// attempted and its result reported honestly - see the documented blocker below if it diverges.
//
// PART C: the fully native-chained pipeline. The native lumenc binary compiles lumenc.lm's own
// source; its extended stdout (nerr, count, main, IR words, literal-heap blob) is parsed, a
// strings sidecar is rebuilt from the blob via the op-15 walk (disposable host glue - the LOGIC
// of compiling and emitting is entirely in the two native Lumen binaries), and that is fed to the
// native lumemit binary. The result must be byte-identical to the seed-path C for lumenc.lm raw.
// TIMING: the emit stage measured two ways - interpreted (emitWith, warm) vs native lumemit
// (spawn included), plus a measured spawn floor.
//
// PART D (bounded): native lumopt (optimize.lm self-compiled to native). Gated against
// optimizeIR word-for-word for 4 corpus programs + lumenc.lm. optimize.lm has two known latent
// bugs (restore_orig scratch address, dead-function body orphaning) that are NOT to be fixed
// here. If the native path is blocked before those bugs are even reachable, that blocker is
// reported precisely instead of worked around.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compileToIR, emitWith, optimizeIR, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';
import { buildLumencNative } from './lumenc_native.mjs';
import { buildLumemitNative, runLumemitNative, stagePayload, frame } from './lumemit_native.mjs';
import { buildLumoptNative, runLumoptNative } from './lumopt_native.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EMIT_FN_SRC = fs.readFileSync(path.join(__dirname, 'emit_fn.lm'), 'utf8');

const CORPUS = [
  '../mu/examples/fib_print.lm',
  '../mu/examples/add.lm',
  '../mu/examples/max.lm',
  '../mu/examples/fact.lm',
  '../mu/examples/locals.lm',
  '../mu/examples/forward.lm',
  '../mu/examples/mutual.lm',
  '../mu/examples/hello.lm',
  '../mu/examples/greet.lm',
  '../mu/examples/report.lm',
  '../mu/examples/compare.lm',
  '../mu/examples/gcd.lm',
  '../mu/examples/fizzbuzz.lm',
  '../mu/examples/count.lm',
  '../mu/examples/sum_loop.lm',
  '../mu/examples/bitwise.lm',
];
const LIT_HEAP_BASE = 488000, LIT_HEAP_CEIL = 524288, LIT_HEAP_BYTES = LIT_HEAP_CEIL - LIT_HEAP_BASE;

function readSrc(rel) { return fs.readFileSync(path.join(__dirname, rel), 'utf8'); }

function firstDiverge(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

function reportDivergence(label, a, b) {
  const i = firstDiverge(a, b);
  console.log(`FAIL  ${label}: diverge at byte ${i} (ref len ${a.length}, native len ${b.length})`);
  console.log(`  ref  context: ${JSON.stringify(a.slice(Math.max(0, i - 40), i + 40))}`);
  console.log(`  nat  context: ${JSON.stringify(b.slice(Math.max(0, i - 40), i + 40))}`);
}

// Extended native-lumenc output parser (matches lumenc_native.mjs's patchMainToCompileDriver).
function runNativeLumenc(bin, src) {
  const out = execFileSync(bin, { input: Buffer.from(src, 'utf8'), maxBuffer: 64 * 1024 * 1024 });
  const nerr = out.readInt32LE(0);
  const emitc = out.readInt32LE(4);
  const words = new Int32Array(emitc);
  for (let i = 0; i < emitc; i++) words[i] = out.readInt32LE(8 + i * 4);
  const mainOff = 8 + emitc * 4;
  const main = out.readInt32LE(mainOff);
  const literalHeap = out.subarray(mainOff + 4, mainOff + 4 + LIT_HEAP_BYTES);
  return { nerr, words, main, literalHeap };
}

// Rebuild the strings sidecar from the raw literal-heap blob via the same op-15 walk
// compileToIR/compileLumencRaw use: find MKTEXT operand pointers in the words, then read
// [len:i32][bytes] at (ptr - LIT_HEAP_BASE) inside the blob.
function stringsFromBlob(words, blob) {
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
    const len = blob.readInt32LE(off);
    const bytes = blob.subarray(off + 4, off + 4 + len);
    return { ptr, len, bytes };
  });
}

async function main() {
  let fail = 0, pass = 0;

  // ============================== PART B: native lumemit ==============================
  console.log('== Part B: native lumemit (emit_fn.lm self-compiled) vs seed-path C ==');
  const { bin: emitBin } = await buildLumemitNative();
  console.log(`built ${emitBin}`);

  for (const rel of CORPUS) {
    const src = readSrc(rel);
    const name = path.basename(rel);
    const ir = await compileToIR(src);
    const refC = await emitWith(EMIT_FN_SRC, ir.words, ir.main, ir.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
    const natC = runLumemitNative(emitBin, ir.words, ir.main, ir.strings);
    if (refC === natC) { console.log(`PASS  ${name}: ${refC.length}B, bit-identical`); pass++; }
    else { reportDivergence(name, refC, natC); fail++; }
  }

  console.log('\n-- lumenc.lm itself (required by the brief) --');
  {
    const src = readSrc('../seed/lumenc.lm');
    const ir = await compileToIR(src);
    const refC = await emitWith(EMIT_FN_SRC, ir.words, ir.main, ir.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
    const natC = runLumemitNative(emitBin, ir.words, ir.main, ir.strings);
    if (refC === natC) {
      console.log(`PASS  SELF(lumenc.lm): ${refC.length}B, bit-identical`);
      pass++;
    } else {
      reportDivergence('SELF(lumenc.lm)', refC, natC);
      fail++;
    }
  }

  // ============================== PART C: native-chained pipeline ==============================
  console.log('\n== Part C: natively-chained pipeline (native lumenc -> native lumemit) ==');
  const { bin: lumencBin } = await buildLumencNative();
  console.log(`built ${lumencBin}`);

  console.log('\n-- corpus (chain machinery validation, small programs) --');
  for (const rel of CORPUS) {
    const src = readSrc(rel);
    const name = path.basename(rel);
    const nc = runNativeLumenc(lumencBin, src);
    if (nc.nerr !== 0) { console.log(`FAIL  ${name}: native lumenc nerr=${nc.nerr}`); fail++; continue; }
    const strings = stringsFromBlob(nc.words, nc.literalHeap);
    const chainedC = runLumemitNative(emitBin, nc.words, nc.main, strings);
    const ir = await compileToIR(src);
    const refC = await emitWith(EMIT_FN_SRC, ir.words, ir.main, ir.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
    if (chainedC === refC) { console.log(`PASS  ${name}: natively-chained C bit-identical (${chainedC.length}B)`); pass++; }
    else { reportDivergence(`chain(${name})`, refC, chainedC); fail++; }
  }

  console.log('\n-- lumenc.lm end-to-end (native lumenc compiling lumenc.lm, native lumemit emitting it) --');
  {
    const src = readSrc('../seed/lumenc.lm');
    const nc = runNativeLumenc(lumencBin, src);
    console.log(`native lumenc(lumenc.lm): nerr=${nc.nerr}, ${nc.words.length} words, main=f${nc.main}`);
    if (nc.nerr === 0) {
      const strings = stringsFromBlob(nc.words, nc.literalHeap);
      const refIR = await compileToIR(src);
      const refC = await emitWith(EMIT_FN_SRC, refIR.words, refIR.main, refIR.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
      try {
        const chainedC = runLumemitNative(emitBin, nc.words, nc.main, strings);
        if (chainedC === refC) { console.log(`PASS  SELF chain: bit-identical (${chainedC.length}B)`); pass++; }
        else {
          reportDivergence('SELF chain', refC, chainedC);
          fail++;
        }
      } catch (e) {
        console.log(`FAIL  SELF chain: native lumemit invocation error: ${e.message.slice(0, 200)}`);
        fail++;
      }
    } else {
      console.log('FAIL  SELF chain: native lumenc could not compile lumenc.lm');
      fail++;
    }
  }

  // ============================== TIMING ==============================
  console.log('\n== Timing: emit stage, interpreted vs native ==');
  {
    const src = readSrc('../seed/lumenc.lm');
    const ir = await compileToIR(src);
    // Interpreted: emitWith on a warm wasm instance is freshly instantiated per call (that is
    // emitWith's own contract - see pipeline.mjs), so "warm" here means the wasm MODULE bytes
    // are already parsed once at import time (top-level await in pipeline.mjs); each call still
    // pays one WebAssembly.instantiate. Timed as the interpreted-path unit of work this pipeline
    // actually performs per emission.
    const N = 5;
    const interpStart = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await emitWith(EMIT_FN_SRC, ir.words, ir.main, ir.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
    const interpMs = Number(process.hrtime.bigint() - interpStart) / 1e6 / N;

    // Native: spawn included (one-shot binary, reads one framed input, exits).
    const nativeStart = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      runLumemitNative(emitBin, ir.words, ir.main, ir.strings);
    }
    const nativeMs = Number(process.hrtime.bigint() - nativeStart) / 1e6 / N;

    const FLOOR_N = 50;
    const floorStart = process.hrtime.bigint();
    for (let i = 0; i < FLOOR_N; i++) execFileSync('/usr/bin/true', []);
    const floorMs = Number(process.hrtime.bigint() - floorStart) / 1e6 / FLOOR_N;

    console.log(`interpreted (emitWith on lumenc.lm-sized IR, ${N} runs): ${interpMs.toFixed(2)}ms/run`);
    console.log(`native lumemit (spawn included, ${N} runs, complete emission now that the shared`);
    console.log(`  heap's physical storage covers lumenc.lm-sized output): ${nativeMs.toFixed(2)}ms/run`);
    console.log(`spawn floor (/usr/bin/true): ${floorMs.toFixed(3)}ms/call`);
    console.log(`native minus spawn floor: ~${(nativeMs - floorMs).toFixed(2)}ms/run`);
    console.log(`ratio (native/interpreted, as measured): ${(nativeMs / interpMs).toFixed(2)}x`);
    console.log('For reference, the same comparison on the largest corpus program (fizzbuzz.lm,');
    console.log('116 IR words):');
    {
      const src2 = readSrc('../mu/examples/fizzbuzz.lm');
      const ir2 = await compileToIR(src2);
      const interpStart2 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) await emitWith(EMIT_FN_SRC, ir2.words, ir2.main, ir2.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
      const interpMs2 = Number(process.hrtime.bigint() - interpStart2) / 1e6 / N;
      const nativeStart2 = process.hrtime.bigint();
      for (let i = 0; i < N; i++) runLumemitNative(emitBin, ir2.words, ir2.main, ir2.strings);
      const nativeMs2 = Number(process.hrtime.bigint() - nativeStart2) / 1e6 / N;
      console.log(`  fizzbuzz.lm: interpreted ${interpMs2.toFixed(2)}ms/run, native (spawn-included) ${nativeMs2.toFixed(2)}ms/run,`);
      console.log(`  native minus spawn floor ~${(nativeMs2 - floorMs).toFixed(2)}ms/run, ratio ${(nativeMs2 / interpMs2).toFixed(2)}x`);
    }
  }

  // ============================== PART D: native lumopt (bounded) ==============================
  console.log('\n== Part D (bounded): native lumopt (optimize.lm self-compiled) ==');
  try {
    const { bin: optBin } = await buildLumoptNative();
    console.log(`built ${optBin}`);
    const optCorpus = ['../mu/examples/fib_print.lm', '../mu/examples/fizzbuzz.lm',
      '../mu/examples/mutual.lm', '../mu/examples/gcd.lm'];
    let blocked = false;
    for (const rel of optCorpus) {
      const src = readSrc(rel);
      const name = path.basename(rel);
      const ir = await compileToIR(src);
      const ref = await optimizeIR(ir.words, ir.main);
      const nat = runLumoptNative(optBin, ir.words, ir.main);
      const match = nat.main === ref.main && nat.words.length === ref.words.length
        && nat.words.every((w, i) => w === ref.words[i]);
      if (match) { console.log(`PASS  ${name}: ${nat.words.length} words, main=f${nat.main}, word-identical`); pass++; }
      else {
        console.log(`FAIL  ${name}: ref ${ref.words.length}w/main=f${ref.main} vs native ${nat.words.length}w/main=f${nat.main}`);
        blocked = true;
        fail++;
      }
    }
    if (blocked) {
      console.log('\nSTOPPING Part D per the bounded instruction: the native path above diverges');
      console.log('before either of the two already-ticketed optimize.lm bugs (restore_orig scratch');
      console.log('address, dead-function body orphaning) would even be exercised meaningfully.');
      console.log('Reported, not worked around; no edits to optimize.lm made.');
    } else {
      const src = readSrc('../seed/lumenc.lm');
      const ir = await compileToIR(src);
      const ref = await optimizeIR(ir.words, ir.main);
      const nat = runLumoptNative(optBin, ir.words, ir.main);
      const match = nat.main === ref.main && nat.words.length === ref.words.length
        && nat.words.every((w, i) => w === ref.words[i]);
      if (match) { console.log(`PASS  SELF(lumenc.lm): ${nat.words.length} words, word-identical`); pass++; }
      else {
        console.log(`FAIL  SELF(lumenc.lm): ref ${ref.words.length}w vs native ${nat.words.length}w`);
        fail++;
      }
    }
  } catch (e) {
    console.log(`BLOCKED building/running native lumopt: ${e.message}`);
    console.log('STOPPING Part D per the bounded instruction (report, do not sink time).');
  }

  console.log(`\nSummary: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
