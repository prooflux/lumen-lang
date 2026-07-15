// native_compile_test.mjs - gate for the native lumenc binary (Stone 3).
//
// Corpus: the mu/examples/*.lm programs used by seed/test.mjs / seed/selfhost_diff.mjs's
// CONFORMANCE_LIST, plus lumenc.lm compiling ITSELF. For each program, the native binary's
// stdout (nerr, emit count, IR words) is compared byte-for-byte against the seed's own
// compileToIR on the same source. safe_div.lm and propagate.lm (sum-type syntax: type decls,
// match, ok/err constructors, the ? operator) joined the scored corpus once lumenc.lm's lexer
// gained that syntax (selfhost_diff.mjs's EXPECTED_MATCH floor moved the same day, 16->18).
// seed/test.mjs also exercises native/test_load32.lm and ../examples/black_scholes.lm; those
// are outside the mu/examples set this corpus covers and are not included here, logged
// explicitly rather than silently dropped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { compileToIR } from './pipeline.mjs';
import { buildLumencNative, SRC_CAP } from './lumenc_native.mjs';
import { createCompiler } from '../seed/compiler_core.mjs';

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
  '../mu/examples/safe_div.lm',
  '../mu/examples/propagate.lm',
  '../mu/examples/bools.lm',
  '../mu/examples/floats.lm',
  '../examples/analytics/click_events.lm',
  '../examples/black_scholes.lm',
  '../examples/finance/black_scholes.lm',
  '../examples/finance/implied_vol.lm',
];
const OUT_OF_SCOPE_LOGGED = ['native/test_load32.lm'];
// Trap-hardening probe: black_scholes.lm graduated INTO the corpus when lumenc.lm learned the
// Float front-end (the same trajectory safe_div/propagate took when it learned sum types), so
// the probe is now a STRUCTURALLY invalid input that no language growth can ever legalize: a
// source larger than the compiler's live SRC window (SRC_CAP, imported from lumenc_native.mjs).
// The overrun drives a wild memory access, which the hardened preamble must convert to the
// controlled exit 70 + "lumen: memory trap" + empty stdout. If a future change turns this
// into a clean diagnostic instead, this check fails loudly and the fixture gets rethought
// deliberately - it must never silently degrade to a no-op.
// Capacity-derived: always exceed the live SRC region so this probe can never go stale
// against a capacity bump (it did once: a hardcoded 60000 fell inside the 70000 region).
function oversizedSource() {
  const filler = 'fn f0() -> Int { return 1 }\n';
  let big = '';
  while (big.length < SRC_CAP + 10000) big += filler;
  return big + 'fn main(c: Console) -> Unit { c.print_int(1) return () }\n';
}
const TRAP_PROBE = [{ name: 'oversized-source-beyond-SRC_CAP', src: oversizedSource() }];

function readSrc(rel) {
  return fs.readFileSync(path.join(__dirname, rel), 'utf8');
}

// Extended native output format (all little-endian): [nerr:i32][count:i32][words:count*i32]
// [main_entry:i32][literal_heap: LIT_HEAP_BYTES bytes]. See lumenc_native.mjs's
// patchMainToCompileDriver for the exact contract.
const LIT_HEAP_BYTES = 524288 - 488000;   // 36288

// Run the native binary, feeding src on stdin. Never throws: a crash (SIGBUS/SIGSEGV from
// lumenc.lm's own unhandled-syntax paths) is reported as a status, not an exception.
function runNative(bin, src) {
  try {
    const out = execFileSync(bin, { input: Buffer.from(src, 'utf8'), maxBuffer: 64 * 1024 * 1024 });
    if (out.length < 8) return { crashed: true, signal: null, bytes: out.length };
    const nerr = out.readInt32LE(0);
    const emitCount = out.readInt32LE(4);
    const words = new Int32Array(emitCount);
    for (let i = 0; i < emitCount; i++) words[i] = out.readInt32LE(8 + i * 4);
    const mainOff = 8 + emitCount * 4;
    if (out.length < mainOff + 4 + LIT_HEAP_BYTES) {
      return { crashed: true, signal: null, bytes: out.length, reason: 'truncated-extended-output' };
    }
    const mainEntry = out.readInt32LE(mainOff);
    const literalHeap = out.subarray(mainOff + 4, mainOff + 4 + LIT_HEAP_BYTES);
    return { crashed: false, nerr, emitCount, words, mainEntry, literalHeap };
  } catch (e) {
    return { crashed: true, signal: e.signal || null, status: e.status ?? null };
  }
}

function compareWords(a, b) {
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    if (a[i] !== b[i]) return { ok: false, index: i, seedWord: a[i], nativeWord: b[i] };
  }
  return { ok: true };
}

async function main() {
  console.log('== native lumenc: build ==');
  const buildStart = process.hrtime.bigint();
  const { bin, variant, entry } = await buildLumencNative();
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;
  console.log(`built ${bin} (variant: ${variant}, lex_compile entry: f${entry}, ${buildMs.toFixed(1)}ms)`);

  console.log(`\nout-of-scope (present in seed/test.mjs, not in the mu/examples floor): ${OUT_OF_SCOPE_LOGGED.join(', ')}`);

  console.log('\n== corpus: native vs seed, byte-for-byte ==');
  let fail = 0, pass = 0;
  const firstDivergence = [];

  for (const rel of CORPUS) {
    const src = readSrc(rel);
    const name = path.basename(rel);
    const seedIR = await compileToIR(src);   // throws on nerr>0; none of these are expected to error
    const native = runNative(bin, src);
    if (native.crashed) {
      console.log(`FAIL  ${name}: native binary crashed (signal=${native.signal}, status=${native.status})`);
      fail++;
      firstDivergence.push({ name, reason: 'crash' });
      continue;
    }
    if (native.nerr !== 0) {
      console.log(`FAIL  ${name}: native nerr=${native.nerr}, seed nerr=0 (disagreement)`);
      fail++;
      firstDivergence.push({ name, reason: 'nerr-mismatch' });
      continue;
    }
    const diff = compareWords(seedIR.words, native.words);
    if (!diff.ok) {
      console.log(`FAIL  ${name}: diverge at word ${diff.index} (seed ${diff.seedWord} vs native ${diff.nativeWord})`);
      fail++;
      firstDivergence.push({ name, reason: 'ir-diff', index: diff.index, seedWord: diff.seedWord, nativeWord: diff.nativeWord });
      continue;
    }
    if (native.mainEntry !== seedIR.main) {
      console.log(`FAIL  ${name}: main entry mismatch (seed ${seedIR.main} vs native ${native.mainEntry})`);
      fail++;
      firstDivergence.push({ name, reason: 'main-mismatch', seedMain: seedIR.main, nativeMain: native.mainEntry });
      continue;
    }
    console.log(`PASS  ${name}: nerr=0, ${native.emitCount} IR words, main=f${native.mainEntry}, bit-identical`);
    pass++;
  }

  console.log('\n== SELF: lumenc.lm compiling itself ==');
  const lumencSrc = readSrc('../seed/lumenc.lm');
  const seedSelfIR = await compileToIR(lumencSrc);
  const nativeSelf = runNative(bin, lumencSrc);
  let selfOk = false;
  if (nativeSelf.crashed) {
    console.log(`FAIL  SELF(lumenc.lm): native binary crashed (signal=${nativeSelf.signal}, status=${nativeSelf.status})`);
    fail++;
  } else if (nativeSelf.nerr !== 0) {
    console.log(`FAIL  SELF(lumenc.lm): native nerr=${nativeSelf.nerr}, seed nerr=0 (disagreement)`);
    fail++;
  } else {
    const diff = compareWords(seedSelfIR.words, nativeSelf.words);
    if (!diff.ok) {
      console.log(`FAIL  SELF(lumenc.lm): diverge at word ${diff.index} (seed ${diff.seedWord} vs native ${diff.nativeWord})`);
      fail++;
      firstDivergence.push({ name: 'SELF(lumenc.lm)', reason: 'ir-diff', index: diff.index, seedWord: diff.seedWord, nativeWord: diff.nativeWord });
    } else if (nativeSelf.mainEntry !== seedSelfIR.main) {
      console.log(`FAIL  SELF(lumenc.lm): main entry mismatch (seed ${seedSelfIR.main} vs native ${nativeSelf.mainEntry})`);
      fail++;
      firstDivergence.push({ name: 'SELF(lumenc.lm)', reason: 'main-mismatch', seedMain: seedSelfIR.main, nativeMain: nativeSelf.mainEntry });
    } else {
      console.log(`PASS  SELF(lumenc.lm): nerr=0, ${nativeSelf.emitCount} IR words, main=f${nativeSelf.mainEntry}, bit-identical`);
      selfOk = true;
      pass++;
    }
  }

  // ---------------------------------------------------------------------------------------
  // TRAP HARDENING: TRAP_PROBE drives the native binary's own unhandled-syntax code path
  // (Float support has no code path in lumenc.lm at all) into a wild memory access. Before the
  // signal handler installed in emit_fn.lm's preamble, this was a raw SIGBUS (exit 138) or
  // SIGSEGV (exit 139) with no diagnostic. Assert the controlled outcome instead: exit 70
  // (EX_SOFTWARE), a clean stderr message, and no bogus success frame on stdout.
  //
  // safe_div.lm/propagate.lm used to be the probes here (see git history before lumenc.lm
  // learned sum types): once the native binary could lex/parse/emit them cleanly, they
  // stopped exercising this path at all (verified: they now exit 0, nerr=0, bit-identical
  // IR - see the corpus loop above) and were promoted into CORPUS instead. TRAP_PROBE was
  // repointed at a construct with NO code path anywhere in lumenc.lm (Float) so this gate
  // keeps asserting real trap behavior instead of silently degrading to a no-op.
  // ---------------------------------------------------------------------------------------
  console.log('\n== trap hardening: wild memory access converts to a controlled exit, not a raw crash ==');
  let trapFail = 0;
  for (const { name, src } of TRAP_PROBE) {
    let status = null, stderrText = '', stdoutLen = 0, threw = null;
    try {
      const out = execFileSync(bin, { input: Buffer.from(src, 'utf8'), maxBuffer: 64 * 1024 * 1024 });
      stdoutLen = out.length;
      status = 0;
    } catch (e) {
      status = e.status ?? null;
      stderrText = e.stderr ? e.stderr.toString('utf8') : '';
      stdoutLen = e.stdout ? e.stdout.length : 0;
      threw = e.signal || null;
    }
    const okStatus = status === 70;
    const okStderr = stderrText.includes('lumen: memory trap');
    const okStdout = stdoutLen === 0;
    if (okStatus && okStderr && okStdout) {
      console.log(`PASS  ${name}: exit=70, stderr="lumen: memory trap", stdout empty (raw signal was ${threw || '(process signal masked by handler)'})`);
    } else {
      console.log(`FAIL  ${name}: exit=${status} (want 70), signal=${threw}, stderr=${JSON.stringify(stderrText)}, stdoutLen=${stdoutLen} (want 0)`);
      trapFail++;
    }
  }
  fail += trapFail;

  console.log(`\nSummary: ${pass} pass, ${fail} fail (corpus=${CORPUS.length}, SELF=1, trap-hardening=${TRAP_PROBE.length} scored)`);
  if (fail > 0) {
    console.log('\nFirst divergence(s):');
    for (const d of firstDivergence) console.log(`  ${JSON.stringify(d)}`);
  }

  // ---------------------------------------------------------------------------------------
  // TIMING: native binary vs the seed interpreter path, over the same corpus (+ SELF).
  // ---------------------------------------------------------------------------------------
  console.log('\n== timing ==');
  const timingCorpus = [...CORPUS, '../seed/lumenc.lm'];
  const timingSrcs = timingCorpus.map(readSrc);

  // (a) native binary: one process spawn per program (spawn overhead included - the driver
  // is a one-shot process, reads stdin once and exits, by design; it does not offer a
  // long-lived multi-request loop the way native/lumen_serve_native.mjs's serve binary does,
  // so a spawn-excluded number is not obtainable from this binary. Reported as spawn-included.)
  const nativeStart = process.hrtime.bigint();
  for (const src of timingSrcs) runNative(bin, src);
  const nativeMs = Number(process.hrtime.bigint() - nativeStart) / 1e6;

  // (b) seed interpreter path: one warm wasm instance (assembled once), compileToIR-equivalent
  // repeated calls - this is the throughput seed/perf.mjs measures, not pipeline.mjs's
  // freshInstance()-per-call path (which re-instantiates the wasm module every call and is
  // documented there as ~25s of pure overhead per run, not representative of the interpreter's
  // real throughput).
  const L = await createCompiler();
  const seedStart = process.hrtime.bigint();
  for (const src of timingSrcs) L.compile(src);
  const seedMs = Number(process.hrtime.bigint() - seedStart) / 1e6;

  // (c) process-spawn floor: how much of the native number is exec() itself, nothing to do
  // with lumenc.lm. Repeated spawns of a no-op binary via the same execFileSync path, so the
  // native number above can be read as floor + actual work instead of one opaque total.
  const FLOOR_N = 100;
  const floorStart = process.hrtime.bigint();
  for (let i = 0; i < FLOOR_N; i++) execFileSync('/usr/bin/true', []);
  const floorMs = Number(process.hrtime.bigint() - floorStart) / 1e6 / FLOOR_N;

  console.log(`native (native binary, ${timingCorpus.length} programs, 1 process spawn each): ${nativeMs.toFixed(2)}ms total, ${(nativeMs / timingCorpus.length).toFixed(3)}ms/program`);
  console.log(`seed   (warm wasm instance, ${timingCorpus.length} programs, in-process): ${seedMs.toFixed(2)}ms total, ${(seedMs / timingCorpus.length).toFixed(3)}ms/program`);
  console.log(`spawn floor (/usr/bin/true via the same execFileSync path): ${floorMs.toFixed(3)}ms/call`);
  console.log(`ratio: seed is ${(nativeMs / seedMs).toFixed(1)}x faster than the native-binary-per-process number above`);
  console.log(`native minus spawn floor: ~${(nativeMs / timingCorpus.length - floorMs).toFixed(3)}ms/program of actual native-binary work (startup + compile)`);
  console.log('(honest caveat: the native number is dominated by process-spawn + clang-emitted-driver startup, not compile work itself;');
  console.log(' the seed number is dominated by wasm interpretation with zero process overhead. This is a process-spawn-included');
  console.log(' comparison, not an apples-to-apples measurement of interpreted-vs-compiled compile throughput per se. The spawn floor');
  console.log(' line isolates how much of the native total is exec() itself versus the binary\'s own work.)');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
