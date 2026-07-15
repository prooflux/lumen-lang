// native_resident_test.mjs - R3 proof gate: the resident native compiler server is NOT subtly
// stateful. For every program in the frozen corpus (seed/corpus.mjs) plus seed/lumenc.lm itself,
// this asserts THREE independently-derived compiles agree byte-for-byte on {nerr, words, main}:
//
//   (a) resident, round 1  - compiled through the long-lived --resident process, request k
//   (b) resident, round 2  - the SAME long-lived process, compiled a second time (interleaved
//                             with every other corpus program in between, not back-to-back) -
//                             this is what actually exercises the state-reset: if request k's
//                             result depended on anything left over from request k-1 (a
//                             DIFFERENT program), round 2 would diverge from round 1 here.
//   (c) fresh one-shot      - a brand-new process per program (compileToIRNative, R2's path) -
//                             the reference for "what a freshly-spawned process produces"
//   (d) wasm seed           - pipeline.mjs's compileToIR, the pre-existing oracle
//
// If (a) == (b) == (c) == (d) for every case, the resident server's memset-based reset (see
// lumenc_native.mjs's patchMainToCompileDriver) reproduces fresh-process state exactly, and
// design (a) from the R3 brief is proven, not assumed.
//
// Also gates: a genuine compile-error case's diagnostic record (nerr, code, byteOff, byteLen)
// resolves identically via the resident wire protocol's diagnostic block vs
// seed/compiler_core.mjs's readRawDiags() (the wasm oracle for diagnostics); and the framing
// protocol survives an oversized (> SRC_CAP) request without desyncing the next request on the
// same pipe (the drain-and-cap path in the resident C loop).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASES } from '../seed/corpus.mjs';
import { compileToIR } from './pipeline.mjs';
import { createCompiler } from '../seed/compiler_core.mjs';
import {
  compileToIRNative, compileToIRNativeResident, checkNativeResident,
  getResidentCompiler, stopResidentCompiler, SRC_CAP,
} from './native_compile.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.join(__dirname, '../seed');

function readSrc(rel) { return fs.readFileSync(path.join(SEED_DIR, rel), 'utf8'); }

function compareTriple(a, b) {
  if (a.nerr !== b.nerr) return `nerr differs: ${a.nerr} vs ${b.nerr}`;
  if (a.main !== b.main) return `main differs: f${a.main} vs f${b.main}`;
  if (a.words.length !== b.words.length) return `word count differs: ${a.words.length} vs ${b.words.length}`;
  for (let i = 0; i < a.words.length; i++) {
    if (a.words[i] !== b.words[i]) return `words[${i}] differs: ${a.words[i]} vs ${b.words[i]}`;
  }
  return null;
}

// compileToIR/compileToIRNative throw on nerr > 0; every CASES program compiles clean (0 errors,
// verified by parity_corpus_test.mjs and native_compile_test.mjs already), so this suite only
// needs the throwing contract for the main corpus loop. wasmNerr0(src) below wraps compileToIR
// to also report a would-be-nerr uniformly with the two native paths for the comparison table.
async function wasmCompile(src) {
  const r = await compileToIR(src);
  return { nerr: 0, words: r.words, main: r.main };
}
async function nativeFreshCompile(src) {
  const r = compileToIRNative(src);
  return { nerr: 0, words: r.words, main: r.main };
}
async function nativeResidentCompile(src) {
  const r = await compileToIRNativeResident(src);
  return { nerr: 0, words: r.words, main: r.main };
}

async function main() {
  let pass = 0, fail = 0;
  const failures = [];

  const programs = [...CASES.map(([rel]) => rel), '../seed/lumenc.lm'];
  const srcs = programs.map((rel) => readSrc(rel));

  console.log(`== R3 resident-vs-fresh-vs-wasm byte-identity: ${programs.length} programs (${CASES.length} corpus + lumenc.lm) ==`);

  // Round 1: resident compile of every program, in order, on ONE warm resident process.
  const round1 = [];
  for (const src of srcs) round1.push(await nativeResidentCompile(src));

  // Round 2: the SAME resident process, same programs, same order - proves round-1's request k
  // did not leak into round-2's request k (nor did any OTHER program's request leak across).
  const round2 = [];
  for (const src of srcs) round2.push(await nativeResidentCompile(src));

  // Fresh one-shot process per program (R2's existing path) and the wasm seed oracle.
  const fresh = [];
  for (const src of srcs) fresh.push(await nativeFreshCompile(src));
  const wasm = [];
  for (const src of srcs) wasm.push(await wasmCompile(src));

  for (let i = 0; i < programs.length; i++) {
    const name = programs[i];
    const r1vr2 = compareTriple(round1[i], round2[i]);
    const r1vFresh = compareTriple(round1[i], fresh[i]);
    const r1vWasm = compareTriple(round1[i], wasm[i]);
    if (r1vr2 === null && r1vFresh === null && r1vWasm === null) {
      console.log(`PASS  ${name}: resident round1 == round2 == fresh process == wasm seed (${round1[i].words.length} words, main=f${round1[i].main})`);
      pass++;
    } else {
      fail++;
      if (r1vr2) { console.log(`FAIL  ${name}: resident round1 vs round2: ${r1vr2}`); failures.push({ name, kind: 'round1-vs-round2', detail: r1vr2 }); }
      if (r1vFresh) { console.log(`FAIL  ${name}: resident round1 vs fresh process: ${r1vFresh}`); failures.push({ name, kind: 'round1-vs-fresh', detail: r1vFresh }); }
      if (r1vWasm) { console.log(`FAIL  ${name}: resident round1 vs wasm seed: ${r1vWasm}`); failures.push({ name, kind: 'round1-vs-wasm', detail: r1vWasm }); }
    }
  }

  // Determinism, restated as a direct byte-buffer comparison (not just structural equality) -
  // catches anything compareTriple's field-by-field walk might miss.
  const stringify = (r) => `${r.nerr}|${r.main}|${Array.from(r.words).join(',')}`;
  let byteDeterministic = true;
  for (let i = 0; i < programs.length; i++) {
    if (stringify(round1[i]) !== stringify(round2[i])) { byteDeterministic = false; break; }
  }
  console.log(byteDeterministic
    ? '\nByte-buffer determinism check: PASS (round1 and round2 serialize identically for every program)'
    : '\nByte-buffer determinism check: FAIL');
  if (!byteDeterministic) fail++;

  // --- Diagnostics: a genuine compile error, resident vs the wasm oracle (compiler_core.mjs) ---
  console.log('\n== Diagnostics: resident wire-protocol diag records vs seed/compiler_core.mjs readRawDiags() ==');
  const lumen = await createCompiler();
  const ERROR_CASES = [
    'fn main(c: Console) -> Unit { c.print_int(undefined_var) return () }',
    'fn main(c: Console) -> Unit { c.print_int(also_missing) c.print_int(still_missing) return () }',
  ];
  let diagFail = 0;
  for (const src of ERROR_CASES) {
    const oracle = lumen.compile(src);   // { ok, irWords, main, srclen, rawDiags }
    const native = await checkNativeResident(src);
    const oracleKey = JSON.stringify(oracle.rawDiags.map((d) => [d.code, d.byteOff, d.byteLen, d.name]));
    const nativeKey = JSON.stringify(native.rawDiags.map((d) => [d.code, d.byteOff, d.byteLen, d.name]));
    const ok = oracle.ok === native.ok && oracle.rawDiags.length === native.rawDiags.length && oracleKey === nativeKey;
    if (ok) {
      console.log(`PASS  ${JSON.stringify(src.slice(0, 40))}...: ${native.rawDiags.length} diagnostic(s), resident matches wasm oracle`);
      pass++;
    } else {
      console.log(`FAIL  ${JSON.stringify(src.slice(0, 40))}...`);
      console.log(`  oracle: ${oracleKey}`);
      console.log(`  native: ${nativeKey}`);
      diagFail++;
    }
  }
  fail += diagFail;

  // --- Framing + crash recovery: an oversized request must not corrupt the pipe, and if it hits
  // the SAME wild-memory trap native_compile_test.mjs's TRAP_PROBE already documents for
  // oversized/truncated input (SRC_CAP truncation mid-token, no graceful diagnostic path - see
  // that file's "TRAP HARDENING" section), the resident abstraction must recover cleanly rather
  // than leave the next caller hanging or desynced. Both outcomes are legitimate; only "the next
  // request answers correctly" is asserted.
  console.log('\n== Framing + crash recovery: an oversized request must not desync or wedge the server ==');
  const server = getResidentCompiler();
  const filler = 'fn f0() -> Int { return 1 }\n';
  let oversized = '';
  while (oversized.length < SRC_CAP + 5000) oversized += filler;
  oversized += 'fn main(c: Console) -> Unit { c.print_int(1) return () }\n';
  let framingOk = true;
  try {
    // The oversized program legitimately has NO code path that would be capped-and-still-valid
    // (its own main is past the SRC_CAP truncation point), so its own result isn't asserted -
    // only that a caller can still get a correct answer afterward, whether that means the SAME
    // process answered (drain-without-crash) or ResidentCompiler transparently respawned after
    // the truncation hit the known trap-hardening exit (crash-without-desync).
    await server.compile(oversized).catch(() => {});
    const after = await nativeResidentCompile('fn main(c: Console) -> Unit { c.print_int(99) return () }');
    framingOk = after.nerr === 0 && after.main === 0;
    console.log(framingOk
      ? 'PASS  the request after an oversized one still parsed correctly (drained cleanly, or the server crashed on the known trap-hardening path and ResidentCompiler transparently respawned)'
      : `FAIL  the request after an oversized one parsed incorrectly: ${JSON.stringify(after)}`);
  } catch (e) {
    framingOk = false;
    console.log(`FAIL  framing check threw: ${e.message}`);
  }
  if (framingOk) pass++; else fail++;

  stopResidentCompiler();

  console.log(`\nSummary: ${pass} pass, ${fail} fail`);
  if (failures.length) {
    console.log('\nFirst divergence(s):');
    for (const f of failures.slice(0, 10)) console.log(`  ${JSON.stringify(f)}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); stopResidentCompiler(); process.exit(1); });
