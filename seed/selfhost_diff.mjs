// selfhost_diff.mjs - the self-hosting conformance census.
//
// R5: this used to prove TWO INDEPENDENT implementations agree - the hand-written wasm seed's
// own compile(), and lumenc.lm (the self-hosted compiler, written IN Lumen) running INTERPRETED
// atop that same wasm VM, reached via a hand-crafted CALL stub (inject lumenc.lm's compiled IR,
// inject a test source, synthesize a tiny driver that PUSHes the source length and CALLs
// lex_compile directly). Now there is only ONE compiler left: lumenc.lm IS the native compiler
// (native/lumenc.bootstrap.c is lumenc.lm translated to C - see native/lumenc_native.mjs's
// header comment), so "compile via the seed" and "compile via lumenc.lm" are no longer two
// things to diff against each other.
//
// This file's remaining, still-valuable job: a regression net over main's dual-oracle census
// composition (31 cases: seed/corpus.mjs's 34 minus the four added after that census was drawn,
// plus click_events.lm, which only this file exercises) or native/native_fixpoint_test.mjs's
// corpus (16 cases) - and is the natural home for future language-feature census entries. It
// compiles and
// RUNS each program via the native compiler (native/native_compile.mjs) + the in-process JS
// interpreter (native/ir_interpreter.mjs), and checks stdout against a FROZEN golden captured
// once and verified correct (click_events.lm and bools.lm's goldens were captured from the wasm
// seed before it was retired, exactly like every other frozen golden in this repo - see
// seed/corpus.mjs's header comment, which makes the same trust argument). This is a regression
// gate (catches an unintentional future change to lumenc.lm), not an independent-oracle proof;
// that proof now lives in native/native_fixpoint_test.mjs (generation-2 compiler vs generation-1,
// both built from the native pipeline's own output, no wasm anywhere in the loop) and in the
// cross-backend agreement between the C emitter (native/native_diff.mjs et al.) and the LLVM
// emitter (native/llvm_diff.mjs) on the same IR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileToIRNativeRaw } from '../native/native_compile.mjs';
import { createInterpreter } from '../native/ir_interpreter.mjs';
import { CASES as CORPUS_CASES } from './corpus.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Main's dual-oracle CONFORMANCE_LIST composition (31 entries: every seed/corpus.mjs case
// EXCEPT the four added after the original census was drawn - native/test_load32.lm,
// vol_surface_heston.lm, vol_surface_models.lm, bs_greeks.lm - PLUS click_events.lm, which only
// this census exercises). R5: there is only ONE compiler left (see header comment above), so
// this no longer diffs two wasm instances against each other; it runs each program through
// YOUR branch's engine (native/native_compile.mjs + native/ir_interpreter.mjs) and checks
// stdout against a frozen golden, the same "bit-identical" contract as seed/corpus.mjs's cases
// (the census count/composition is main's; the engine underneath is R5's).
const EXCLUDED_FROM_CENSUS = new Set([
  'native/test_load32.lm',
  '../examples/finance/vol_surface_heston.lm',
  '../examples/finance/vol_surface_models.lm',
  '../examples/finance/bs_greeks.lm',
]);
const CENSUS = [
  ...CORPUS_CASES.filter(([relPath]) => !EXCLUDED_FROM_CENSUS.has(relPath)),
  ['../examples/analytics/click_events.lm', ''],   // driven by injected events elsewhere (native/analytics_events_test.mjs); standalone run produces no output
];

function compileAndRun(src) {
  const { nerr, words, main, strings } = compileToIRNativeRaw(src);
  if (nerr > 0) return { ok: false, nerr, stdout: '' };
  const interp = createInterpreter();
  interp.writeCode(words);
  interp.seedStrings(strings);
  interp.set_fuel_max(4000000000n);
  try { interp.run(main); return { ok: true, nerr, stdout: interp.getOut() }; }
  catch (e) { return { ok: true, nerr, stdout: interp.getOut(), crash: String(e.message || e) }; }
}

let matchCount = 0, diffCount = 0, errorCount = 0;
console.log('--- THE CENSUS ---');
for (const [relPath, expected] of CENSUS) {
  const progName = path.basename(relPath);
  const src = fs.readFileSync(path.join(__dirname, relPath), 'utf8');
  const r = compileAndRun(src);
  if (!r.ok) {
    console.log(`${progName}: COMPILE-ERROR (nerr: ${r.nerr})`);
    errorCount++;
    console.error(`Error: Program ${relPath} was expected to MATCH but got COMPILE-ERROR.`);
    process.exit(1);
  } else if (r.stdout === expected && !r.crash) {
    console.log(`${progName}: MATCH`);
    matchCount++;
  } else {
    console.log(`${progName}: DIFF (expected ${JSON.stringify(expected)}, got ${JSON.stringify(r.stdout)}${r.crash ? `, crash: ${r.crash}` : ''})`);
    diffCount++;
    console.error(`Error: Program ${relPath} was expected to MATCH but got DIFF.`);
    process.exit(1);
  }
}

const summary = `${matchCount}/${CENSUS.length} bit-identical, ${diffCount} diff, ${errorCount} error`;
console.log(`\nSummary: ${summary}`);
process.exit(diffCount === 0 && errorCount === 0 ? 0 : 1);
