// forge.mjs - the differential runner.
//
// R5: this used to be a "5-path" runner where path b (SELFHOST-IR) proved lumenc.lm self-hosted
// (running interpreted atop the wasm seed) matches the seed's OWN direct compile - two
// independent implementations, the same trust story seed/selfhost_diff.mjs's census told (see
// that file's R5 header comment for the full argument). Now there is only ONE compiler
// (lumenc.lm IS the native compiler - native/lumenc_native.mjs's header comment), so paths a and
// b necessarily agree (both call the exact same compileToIRNative underneath) - compareIR(a, b)
// is kept as a determinism check (does the SAME native compiler reproduce itself across two
// independent calls, back to back), not an independent-oracle proof; that role now belongs to
// native/native_fixpoint_test.mjs (generation-2 vs generation-1) and the cross-backend agreement
// between paths d (C) and e (LLVM) below, both still checked against path a every run.
// For each generated seed program, run it through these paths and cross-check:
//   a. INTERP         - compile+run via the native compiler + in-process JS interpreter
//                       (native/ir_interpreter.mjs) - the reference for c/d/e
//   b. SELFHOST-IR    - a second, independent native compile of the same source; diff its IR
//                       word-for-word against path a (determinism check - see above)
//   c. OPT            - optimizeIR(seed IR) run on the interpreter; stdout/exit vs path a
//   d. C              - native/pipeline.mjs buildAndRunFn(src); stdout/exit vs path a (every nativeEvery-th seed)
//   e. LLVM           - native/pipeline.mjs buildAndRunLlvm(src); stdout/exit vs path a (every nativeEvery-th seed)
//
// CLI: node forge.mjs --from <seed> --to <seed> [--native-every N=20] [--out findings.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { optimizeIR, runIR, buildAndRunFn, buildAndRunLlvm } from '../native/pipeline.mjs';
import { compileToIRNativeRaw } from '../native/native_compile.mjs';
import { createInterpreter } from '../native/ir_interpreter.mjs';
import { generate } from './genprog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- CLI args ----------
function parseArgs(argv) {
  const args = { from: undefined, to: undefined, nativeEvery: 20, out: 'findings.jsonl' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from') args.from = Number(argv[++i]);
    else if (a === '--to') args.to = Number(argv[++i]);
    else if (a === '--native-every') args.nativeEvery = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
  }
  if (args.from === undefined || args.to === undefined) {
    process.stderr.write('usage: node forge.mjs --from <seed> --to <seed> [--native-every N=20] [--out findings.jsonl]\n');
    process.exit(1);
  }
  return args;
}

// ---------- path a: INTERP (native compile + in-process JS interpreter, zero wasm) ----------
async function runInterp(src) {
  const r = compileToIRNativeRaw(src);
  const interp = createInterpreter();
  interp.writeCode(r.words);
  interp.seedStrings(r.strings);
  interp.set_fuel_max(50000000n);
  let exit = 0;
  try { if (r.nerr === 0) interp.run(r.main); }
  catch (e) { exit = 1; }
  return { stdout: interp.getOut(), exit, words: r.words, main: r.main };
}

// ---------- path b: SELFHOST-IR (R5: a second independent native compile - see header comment) ----------
async function compileSelfhost(testSource) {
  const r = compileToIRNativeRaw(testSource);
  return { nerr: r.nerr, emitCount: r.words.length, emittedIR: r.words };
}

function compareIR(seedIR, selfhostIR) {
  const maxLen = Math.max(seedIR.length, selfhostIR.length);
  for (let idx = 0; idx < maxLen; idx++) {
    const seedWord = seedIR[idx];
    const shWord = selfhostIR[idx];
    if (seedWord !== shWord) return { ok: false, index: idx, seedWord, shWord };
  }
  return { ok: true };
}

// ---------- forge loop ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const forceFaultSeed = process.env.FORGE_FAULT !== undefined ? Number(process.env.FORGE_FAULT) : null;

  const findings = [];
  const classCounts = {};
  const CAP = 2000; // some genprog programs run away (near-fuel-cap loops) before trapping;
                     // cap detail strings so one pathological seed can't blow up findings.jsonl
  // clang error text embeds a random mkdtempSync() tmpdir per invocation (e.g. /tmp/lumen-fn-XXXXXX/p.c);
  // normalize it away so findings stay deterministic across runs.
  const sanitize = (s) => s.replace(/\/lumen-(fn|native|llvm)-[A-Za-z0-9]+\//g, '/lumen-$1-<tmp>/');
  const clip = (s) => (s.length > CAP ? s.slice(0, CAP) + `...[clipped, ${s.length}B total]` : s);
  const record = (seed, cls, detail, program) => {
    findings.push({ seed, class: cls, detail: clip(sanitize(detail)), program });
    classCounts[cls] = (classCounts[cls] || 0) + 1;
  };

  for (let seed = args.from; seed <= args.to; seed++) {
    const program = generate(seed);
    let refInterp;

    // a. INTERP
    try {
      refInterp = await runInterp(program);
    } catch (e) {
      record(seed, 'HARNESS_ERROR', `path a threw: ${String(e.message || e)}`, program);
      continue;
    }

    // b. SELFHOST-IR
    try {
      const sh = await compileSelfhost(program);
      if (sh.nerr === 0) {
        const diff = compareIR(refInterp.words, sh.emittedIR);
        if (!diff.ok) {
          record(seed, 'IR_DIFF', `diverge at word index ${diff.index}: seed=${diff.seedWord} selfhost=${diff.shWord}`, program);
        }
      }
      // sh.nerr > 0 (selfhost compile error on a genprog-valid program) is not itself a
      // divergence class defined for this harness; it is out of scope here.
    } catch (e) {
      record(seed, 'HARNESS_ERROR', `path b threw: ${String(e.message || e)}`, program);
    }

    // c. OPT
    try {
      const { words: optWords, main: optMain } = await optimizeIR(refInterp.words, refInterp.main);
      const optOut = await runIR(optWords, optMain);
      if (optOut !== refInterp.stdout) {
        record(seed, 'OPT_DIFF', `stdout mismatch: opt=${JSON.stringify(optOut)} ref=${JSON.stringify(refInterp.stdout)}`, program);
      }
    } catch (e) {
      record(seed, 'HARNESS_ERROR', `path c threw: ${String(e.message || e)}`, program);
    }

    // d, e: native paths, only every nativeEvery-th seed (clang cost)
    if (seed % args.nativeEvery === 0) {
      // d. C
      try {
        const cand = await buildAndRunFn(program);
        let exit = cand.exit;
        if (forceFaultSeed !== null && seed === forceFaultSeed) exit = exit + 1;
        const ok = cand.stdout === refInterp.stdout && exit === refInterp.exit;
        if (!ok) {
          record(seed, 'C_DIFF', `stdout=${JSON.stringify(cand.stdout)} exit=${exit} ref_stdout=${JSON.stringify(refInterp.stdout)} ref_exit=${refInterp.exit}`, program);
        }
      } catch (e) {
        record(seed, 'HARNESS_ERROR', `path d threw: ${String(e.message || e)}`, program);
      }

      // e. LLVM
      try {
        const cand = await buildAndRunLlvm(program);
        const ok = cand.stdout === refInterp.stdout && cand.exit === refInterp.exit;
        if (!ok) {
          record(seed, 'LLVM_DIFF', `stdout=${JSON.stringify(cand.stdout)} exit=${cand.exit} ref_stdout=${JSON.stringify(refInterp.stdout)} ref_exit=${refInterp.exit}`, program);
        }
      } catch (e) {
        record(seed, 'HARNESS_ERROR', `path e threw: ${String(e.message || e)}`, program);
      }
    }
  }

  const lines = findings.map(f => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : '');
  fs.writeFileSync(args.out, lines);

  const classSummary = Object.entries(classCounts).map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`forge: seeds ${args.from}..${args.to}, ${findings.length} findings (${classSummary})`);

  return { findings, classCounts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { main, runInterp, compileSelfhost, compareIR, optimizeIR, runIR, buildAndRunFn, buildAndRunLlvm };
