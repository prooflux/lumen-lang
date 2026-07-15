// native_fixpoint_test.mjs - the fixpoint gate: a generation-2 native compiler, built entirely
// from the native pipeline's OWN output (no seed emitWith in the loop), must behave
// bit-identically to generation 1 and to the seed.
//
// GENERATION 1: buildLumencNative() builds the native lumenc binary. Its C source comes from
// pipeline.mjs's compileToIR(lumenc.lm) -> emitWith (both native post-R5; pre-R5 this was the
// wasm seed's own compile+emit, hence "gen-1" - the name predates the retirement and is kept for
// continuity), i.e. the same reference path native_pipeline_test.mjs already gates as
// byte-identical.
//
// EMIT FIXPOINT: run gen-1 lumenc on lumenc.lm's own source. Its extended stdout (nerr, count,
// main, words, literal blob) is parsed (runNativeLumenc), a strings sidecar is rebuilt from the
// literal-heap blob (stringsFromBlob) - both reused from native_pipeline_test.mjs rather than
// duplicated - and fed to the native lumemit binary, producing C_pipe. C_pipe must be
// byte-identical to gen-1's own build C (emitWith on the seed's compileToIR(lumenc.lm)): the
// native pipe's IR-to-C emission is a fixpoint of the seed's emission for the same input.
//
// GENERATION 2: patch C_pipe with lumenc_native.mjs's own driver patch (reused, not
// re-implemented) and clang it. This is a compiler built from the native pipeline's OWN output,
// with no seed emitWith anywhere in its build.
//
// THE FIXPOINT ASSERTION: L2, run on lumenc.lm's own source, must produce output byte-identical
// to gen-1's output on the same input (nerr, count, main, words, literal blob, all of it). Also:
// across the 16-program corpus, L2's compiled words must be bit-identical to the seed's
// compileToIR words for each program.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compileToIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';
import { buildLumencNative, patchMainToCompileDriver, buildNativeBinaryFromC } from './lumenc_native.mjs';
import { buildLumemitNative, runLumemitNative } from './lumemit_native.mjs';
import {
  runNativeLumenc, stringsFromBlob, firstDiverge, reportDivergence, LIT_HEAP_BASE,
} from './native_pipeline_test.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

function readSrc(rel) { return fs.readFileSync(path.join(__dirname, rel), 'utf8'); }

// Byte-compare the full extended native-lumenc output: nerr, word count, main entry, the IR
// words themselves, and the literal-heap blob. Returns null if identical, or a short mismatch
// description otherwise.
function compareExtendedOutput(a, b) {
  if (a.nerr !== b.nerr) return `nerr differs: ${a.nerr} vs ${b.nerr}`;
  if (a.main !== b.main) return `main differs: f${a.main} vs f${b.main}`;
  if (a.words.length !== b.words.length) return `word count differs: ${a.words.length} vs ${b.words.length}`;
  for (let i = 0; i < a.words.length; i++) {
    if (a.words[i] !== b.words[i]) return `words[${i}] differs: ${a.words[i]} vs ${b.words[i]}`;
  }
  if (!a.literalHeap.equals(b.literalHeap)) {
    for (let i = 0; i < a.literalHeap.length; i++) {
      if (a.literalHeap[i] !== b.literalHeap[i]) {
        return `literal heap byte ${i} (LMEM addr ${LIT_HEAP_BASE + i}) differs: ${a.literalHeap[i]} vs ${b.literalHeap[i]}`;
      }
    }
    return 'literal heap length differs';
  }
  return null;
}

async function main() {
  let pass = 0, fail = 0;

  console.log('== Generation 1: native lumenc (built from the seed-path emitWith) ==');
  const { bin: lumencBin, entry: lexCompileEntry } = await buildLumencNative();
  console.log(`built ${lumencBin} (lex_compile entry f${lexCompileEntry})`);
  const { bin: emitBin } = await buildLumemitNative();
  console.log(`built ${emitBin}`);

  const lumencSrc = readSrc('../seed/lumenc.lm');

  // ============================== EMIT FIXPOINT ==============================
  console.log('\n== Emit fixpoint: native pipe (gen-1 lumenc -> native lumemit) vs gen-1 build C ==');
  const gen1Out = runNativeLumenc(lumencBin, lumencSrc);
  if (gen1Out.nerr !== 0) {
    console.log(`FAIL  gen-1 lumenc could not compile lumenc.lm: nerr=${gen1Out.nerr}`);
    fail++;
  } else {
    console.log(`gen-1 lumenc(lumenc.lm): nerr=0, ${gen1Out.words.length} words, main=f${gen1Out.main}`);
    const pipeStrings = stringsFromBlob(gen1Out.words, gen1Out.literalHeap);
    const cPipe = runLumemitNative(emitBin, gen1Out.words, gen1Out.main, pipeStrings);

    const refIR = await compileToIR(lumencSrc);
    const gen1BuildC = await emitWith(
      fs.readFileSync(path.join(__dirname, 'emit_fn.lm'), 'utf8'),
      refIR.words, refIR.main, refIR.strings, EMIT_FN_BASE, EMIT_FN_CEIL,
    );

    if (cPipe === gen1BuildC) {
      console.log(`PASS  emit fixpoint: C_pipe bit-identical to gen-1 build C (${cPipe.length}B)`);
      pass++;
    } else {
      reportDivergence('emit fixpoint', gen1BuildC, cPipe);
      fail++;
    }

    // ============================== GENERATION 2 ==============================
    console.log('\n== Generation 2: clang(patch(C_pipe)) - built from the native pipeline\'s own output ==');
    const gen2Patched = patchMainToCompileDriver(cPipe, lexCompileEntry);
    const l2Bin = buildNativeBinaryFromC(gen2Patched, { opt: '-O2', tag: 'l2-native', name: 'l2' });
    console.log(`built ${l2Bin}`);

    // ============================== THE FIXPOINT ASSERTION ==============================
    console.log('\n== Fixpoint assertion: L2(lumenc.lm) vs gen-1(lumenc.lm) ==');
    const gen2Out = runNativeLumenc(l2Bin, lumencSrc);
    const mismatch = compareExtendedOutput(gen1Out, gen2Out);
    if (mismatch === null) {
      console.log(`PASS  L2 output byte-identical to gen-1 output (nerr=0, ${gen2Out.words.length} words, main=f${gen2Out.main}, ${gen2Out.literalHeap.length}B literal heap)`);
      pass++;
    } else {
      console.log(`FAIL  L2 vs gen-1 divergence: ${mismatch}`);
      fail++;
    }

    // ============================== CORPUS: L2 vs pipeline.mjs compileToIR ==============================
    console.log('\n== Corpus: L2 compiled words vs pipeline.mjs compileToIR, per program ==');
    for (const rel of CORPUS) {
      const src = readSrc(rel);
      const name = path.basename(rel);
      const refOut = await compileToIR(src);
      const l2Out = runNativeLumenc(l2Bin, src);
      let ok = l2Out.nerr === 0 && l2Out.main === refOut.main && l2Out.words.length === refOut.words.length;
      if (ok) {
        for (let i = 0; i < refOut.words.length; i++) {
          if (refOut.words[i] !== l2Out.words[i]) { ok = false; break; }
        }
      }
      if (ok) { console.log(`PASS  ${name}: ${l2Out.words.length} words, bit-identical (L2 vs pipeline.mjs compileToIR)`); pass++; }
      else {
        console.log(`FAIL  ${name}: L2 nerr=${l2Out.nerr}, main=f${l2Out.main}, ${l2Out.words.length} words vs ref main=f${refOut.main}, ${refOut.words.length} words`);
        fail++;
      }
    }

    // ============================== END-TO-END TIMING ==============================
    console.log('\n== End-to-end timing: pipeline.mjs one-shot path vs the direct gen-1/gen-2 native pipe ==');
    console.log('Methodology (post-R5, both sides are native; this compares two DIFFERENT native call');
    console.log('paths, not native-vs-wasm): (a) = pipeline.mjs\'s compileToIR + emitWith, the same');
    console.log('entry points every other file in this repo calls (compileToIR internally builds/caches');
    console.log('its own native compiler binary via native_compile.mjs; emitWith does the same for the');
    console.log('emitter via emitC). (b) = this file\'s OWN gen-1 lumenc binary (buildLumencNative, a');
    console.log('separately-built binary from the same bootstrap C) spawned directly + native lumemit');
    console.log('spawned directly, wall-clock, spawn included, and again with a measured spawn floor');
    console.log('subtracted from each side. Both measure real subprocess spawns; the difference is');
    console.log('which binary-build/caching path is exercised, not a wasm/native split.');

    const N = 5;
    const emitFnSrc = fs.readFileSync(path.join(__dirname, 'emit_fn.lm'), 'utf8');

    // (a) pipeline.mjs's native compileToIR path.
    let t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await compileToIR(lumencSrc);
    const seedCompileMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

    // (a) pipeline.mjs's native emitWith path, measured directly.
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) await emitWith(emitFnSrc, refIR.words, refIR.main, refIR.strings, EMIT_FN_BASE, EMIT_FN_CEIL);
    const interpEmitMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

    // (b) native pipe: gen-1 lumenc spawn (stdin=source, stdout=extended IR) + lumemit spawn.
    t0 = process.hrtime.bigint();
    for (let i = 0; i < N; i++) {
      const nc = runNativeLumenc(lumencBin, lumencSrc);
      const strs = stringsFromBlob(nc.words, nc.literalHeap);
      runLumemitNative(emitBin, nc.words, nc.main, strs);
    }
    const nativePipeMs = Number(process.hrtime.bigint() - t0) / 1e6 / N;

    const FLOOR_N = 50;
    t0 = process.hrtime.bigint();
    for (let i = 0; i < FLOOR_N; i++) execFileSync('/usr/bin/true', []);
    const floorMs = Number(process.hrtime.bigint() - t0) / 1e6 / FLOOR_N;
    const nativePipeFloorAdjMs = nativePipeMs - 2 * floorMs; // two spawns per native-pipe iteration

    console.log(`\n(a) pipeline.mjs compileToIR (${N} runs): ${seedCompileMs.toFixed(2)}ms/run`);
    console.log(`(a) pipeline.mjs emitWith stage (${N} runs): ${interpEmitMs.toFixed(2)}ms/run`);
    console.log(`(a) pipeline.mjs total (this run, compile+emit): ${(seedCompileMs + interpEmitMs).toFixed(2)}ms/run`);
    console.log(`(b) direct gen-1/gen-2 native pipe (lumenc spawn + native lumemit spawn, spawn included, ${N} runs): ${nativePipeMs.toFixed(2)}ms/run`);
    console.log(`spawn floor (/usr/bin/true): ${floorMs.toFixed(3)}ms/call`);
    console.log(`(b) native pipe minus 2x spawn floor: ~${nativePipeFloorAdjMs.toFixed(2)}ms/run`);
    console.log(`ratio, spawn-included (b/a): ${(nativePipeMs / (seedCompileMs + interpEmitMs)).toFixed(2)}x`);
    console.log(`ratio, spawn-floor-adjusted (b/a): ${(nativePipeFloorAdjMs / (seedCompileMs + interpEmitMs)).toFixed(2)}x`);
  }

  console.log(`\nSummary: ${pass} pass, ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

if (process.argv[1] && process.argv[1].endsWith('native_fixpoint_test.mjs')) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
