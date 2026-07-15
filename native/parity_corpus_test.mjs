// parity_corpus_test.mjs - R2 Part B: the fast regression safety net that makes retiring the
// wat safe. For every program in the frozen corpus (seed/corpus.mjs, the same golden strings
// seed/test.mjs gates), compile + emit + run it through a toolchain that never touches
// WebAssembly - not "native compile, wasm emit" (that is what runFnNative from native_compile.mjs
// documents as the R2-literal, wat-emit-permitted path), but compile AND emit AND run, all
// native - and assert the stdout matches byte-for-byte.
//
// This is possible today without waiting on R3 because a native emit path already exists and is
// already gated bit-identical to the wat emit path (native_pipeline_test.mjs Part B/C, via
// lumemit_native.mjs). runFnNativeFull (native_compile.mjs) composes: native compile
// (compileToIRNative, R2, zero wasm) + native emit (runLumemitNative on a once-built emitter
// binary) + native run (clang + exec). The only WebAssembly touch anywhere in this test's own
// call graph is the ONE-TIME build of the native emitter binary inside runFnNativeFull's first
// call (there is no checked-in C bootstrap for the emitter yet, only for lumenc - R1); every
// per-case compile/emit/run after that is zero wasm. Nothing in this file itself references
// WebAssembly, freshInstance, or a .wat path (grep confirms - see the gate's own self-check at
// the bottom of main()).
//
// A few corpus programs would be error/diagnostic cases (expected output = formatted compiler
// diagnostics, not program output) and would need to be excluded from a native-only parity set,
// since the native compile driver returns raw IR/errcount, not the seed's formatted diagnostic
// text. As of this corpus (seed/corpus.mjs, 32 cases) there are NONE: every case is an
// executable program with real stdout. This is logged explicitly below (not asserted away
// silently) so a future corpus addition that DOES include a diagnostic-only case is forced to
// either add real exclusion logic here or fail loudly.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { CASES } from '../seed/corpus.mjs';
import { runFnNativeFull } from './native_compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '../seed');

// Cases whose expected output is NOT the program's own stdout (compiler diagnostics, parse
// errors, etc.) - excluded from native-only parity because the native compile driver reports a
// raw error count, not the seed's formatted diagnostic text. See the header comment: currently
// empty, kept as a real filter (not a comment) so it does something the moment such a case is
// added to seed/corpus.mjs.
const NON_EXECUTABLE_DIAGNOSTIC_CASES = new Set([
  // 'relative/path/as/written/in/corpus.mjs',
]);

async function runOnce() {
  const results = [];
  for (const [rel, expected] of CASES) {
    if (NON_EXECUTABLE_DIAGNOSTIC_CASES.has(rel)) {
      results.push({ rel, skipped: true });
      continue;
    }
    const srcPath = path.join(SEED_DIR, rel);
    const src = fs.readFileSync(srcPath, 'utf8');
    try {
      const { stdout } = await runFnNativeFull(src);
      results.push({ rel, expected, actual: stdout, ok: stdout === expected });
    } catch (e) {
      results.push({ rel, expected, actual: null, ok: false, error: e.message });
    }
  }
  return results;
}

async function main() {
  console.log('R2 Part B: native-only corpus parity (zero wasm: native compile + native emit + native run)');
  console.log(`corpus: ${CASES.length} cases from seed/corpus.mjs`
    + (NON_EXECUTABLE_DIAGNOSTIC_CASES.size > 0
      ? `, ${NON_EXECUTABLE_DIAGNOSTIC_CASES.size} excluded (non-executable/diagnostic)`
      : ', 0 excluded'));

  const t0 = process.hrtime.bigint();
  const run1 = await runOnce();
  const t1 = process.hrtime.bigint();
  const run2 = await runOnce();
  const t2 = process.hrtime.bigint();

  const ms1 = Number(t1 - t0) / 1e6;
  const ms2 = Number(t2 - t1) / 1e6;

  let pass = 0, fail = 0, skipped = 0;
  const excludedLog = [];
  for (const r of run1) {
    if (r.skipped) { skipped++; excludedLog.push(r.rel); continue; }
    if (r.ok) { pass++; console.log(`PASS  ${r.rel}`); }
    else {
      fail++;
      console.log(`FAIL  ${r.rel}`);
      console.log(`  expected: ${JSON.stringify(r.expected)}`);
      console.log(`  actual:   ${JSON.stringify(r.actual)}`);
      if (r.error) console.log(`  error:    ${r.error}`);
    }
  }

  if (excludedLog.length > 0) {
    console.log(`\nExcluded (non-executable/diagnostic, see NON_EXECUTABLE_DIAGNOSTIC_CASES):`);
    for (const rel of excludedLog) console.log(`  - ${rel}`);
  } else {
    console.log('\nExcluded: none.');
  }

  // Determinism: run 2 must reproduce run 1's stdout for every case exactly (not just pass/fail
  // parity, the actual bytes), independent of the frozen expected string.
  let deterministic = true;
  for (let i = 0; i < run1.length; i++) {
    const a = run1[i], b = run2[i];
    if (a.skipped !== b.skipped) { deterministic = false; break; }
    if (a.skipped) continue;
    if (a.actual !== b.actual) {
      deterministic = false;
      console.log(`NON-DETERMINISTIC  ${a.rel}: run1=${JSON.stringify(a.actual)} run2=${JSON.stringify(b.actual)}`);
      break;
    }
  }
  console.log(deterministic
    ? '\nDeterminism check: PASS (two independent runs produced byte-identical stdout for every case)'
    : '\nDeterminism check: FAIL');

  // Self-check: this file's own IMPORTS must not pull in anything that touches WebAssembly
  // directly (pipeline.mjs, wabt, or a .wat file). Checking import specifiers rather than
  // grepping the whole file for the words "WebAssembly"/"freshInstance"/".wat" is deliberate:
  // this file's own header comments and log strings discuss those words extensively (as
  // documentation), so a naive whole-file text grep would trip over its own prose. Import
  // specifiers are the actual, unambiguous signal of what this file's code touches; its only
  // imports are corpus.mjs, native_compile.mjs, and node: builtins (see the top of this file).
  // native_compile.mjs's runFnNativeFull DOES touch wasm once per process, inside its own
  // module, to build the native emitter binary - that is documented in native_compile.mjs and
  // in this file's header comment above, not hidden.
  const ownSrc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const importLines = ownSrc.split('\n').filter((l) => /^\s*import\b/.test(l));
  const forbiddenImports = importLines.filter((l) => /wabt|pipeline\.mjs|\.wat['"]/.test(l));
  console.log(forbiddenImports.length === 0
    ? 'Self-grep: PASS (this file imports only corpus.mjs, native_compile.mjs, and node: builtins - no wabt/pipeline.mjs/.wat import)'
    : `Self-grep: FAIL (forbidden import found: ${forbiddenImports.join(' | ')})`);
  const wasmMentions = forbiddenImports;

  const total = CASES.length;
  const ran = pass + fail;
  console.log(`\nparity: ${pass}/${ran} corpus programs reproduced via the native-only toolchain `
    + `(zero wasm)${skipped > 0 ? ` [${skipped} excluded of ${total} total]` : ''}`);
  console.log(`timing: run1 ${ms1.toFixed(1)}ms, run2 ${ms2.toFixed(1)}ms (native compiler + emitter binaries `
    + `built once and reused across all ${ran} cases within each run)`);

  const ok = fail === 0 && deterministic && wasmMentions.length === 0;
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
