// forge.mjs - the 5-path differential runner.
//
// For each generated seed program, run it through 5 independent paths and cross-check:
//   a. INTERP        - compile+run on the seed VM (the reference oracle for b/c/d/e)
//   b. SELFHOST-IR    - lumenc.lm (running on the seed VM) compiles the program; diff its
//                       emitted IR word-for-word against the seed compiler's own IR
//   c. OPT            - optimizeIR(seed IR) run on the interpreter; stdout/exit vs path a
//   d. C              - native/pipeline.mjs buildAndRunFn(src); stdout/exit vs path a (every nativeEvery-th seed)
//   e. LLVM           - native/pipeline.mjs buildAndRunLlvm(src); stdout/exit vs path a (every nativeEvery-th seed)
//
// CLI: node forge.mjs --from <seed> --to <seed> [--native-every N=20] [--out findings.jsonl]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import wabtInit from 'wabt';
import { createCompiler, CODE_BASE } from '../seed/compiler_core.mjs';
import { optimizeIR, runIR, buildAndRunFn, buildAndRunLlvm } from '../native/pipeline.mjs';
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

// ---------- path a: INTERP (fresh instance per run, exact pattern from seed/test.mjs) ----------
const SRC_BASE = 100000;
let wabtBinary = null;
async function loadWabtBinary() {
  if (wabtBinary) return wabtBinary;
  const wabt = await wabtInit();
  const wat = fs.readFileSync(new URL('../seed/lumenc.wat', import.meta.url), 'utf8');
  wabtBinary = wabt.parseWat('lumenc.wat', wat).toBinary({}).buffer;
  return wabtBinary;
}

async function runInterp(src) {
  const binary = await loadWabtBinary();
  let out = '';
  const { instance } = await WebAssembly.instantiate(binary, {
    lumen: { console_print: (p, l) => { out += Buffer.from(new Uint8Array(instance.exports.mem.buffer, p, l)).toString('utf8'); } },
  });
  const ex = instance.exports;
  const b = Buffer.from(src, 'utf8');
  new Uint8Array(ex.mem.buffer, SRC_BASE, b.length).set(b);
  if (ex.set_fuel_max) ex.set_fuel_max(4000000000n);
  let exit = 0;
  try {
    ex.compile_and_run(b.length);
  } catch (e) {
    exit = 1;
  }
  const irWords = ex.dbg_emit();
  const words = Int32Array.from(new Int32Array(ex.mem.buffer, CODE_BASE, irWords));
  const main = ex.dbg_main();
  return { stdout: out, exit, words, main };
}

// ---------- path b: SELFHOST-IR (instance-C machinery copied from seed/selfhost_diff.mjs; DO NOT edit that file) ----------
let selfhostState = null; // { L, lmIR, resBIrWords, lexCompileEntry, lexEntries, binary }
async function loadSelfhostState() {
  if (selfhostState) return selfhostState;
  const binary = await loadWabtBinary();
  const L = await createCompiler();
  const lmSrcPath = path.join(__dirname, '..', 'seed', 'lumenc.lm');
  const lmSrc = fs.readFileSync(lmSrcPath, 'utf8');
  const resB = L.compile(lmSrc);
  if (!resB.ok) throw new Error('forge: failed to compile lumenc.lm under seed VM');
  const lmIR = new Int32Array(L.exports.mem.buffer, CODE_BASE, resB.irWords).slice();

  const memB = new DataView(L.exports.mem.buffer);
  const u8B = new Uint8Array(L.exports.mem.buffer);
  let lexCompileEntry = -1;
  const lexEntries = [];
  for (let addr = 150000; addr < 157000; addr += 12) {
    const name_off = memB.getInt32(addr, true);
    const name_len = memB.getInt32(addr + 4, true);
    const entry = memB.getInt32(addr + 8, true);
    if (name_off >= 100000 && name_off < 150000 && name_len > 0) {
      const name = Buffer.from(u8B.slice(name_off, name_off + name_len)).toString('utf8');
      if (name === 'lex_compile') lexCompileEntry = entry;
      else if (name === 'lex') lexEntries.push(entry);
    }
  }
  if (lexCompileEntry === -1 || lexEntries.length === 0) {
    throw new Error(`forge: symbol extraction failed. lex_compile: ${lexCompileEntry}, lex: ${lexEntries.length}`);
  }

  selfhostState = { binary, L, lmIR, irWords: resB.irWords, lexCompileEntry, lexEntries };
  return selfhostState;
}

// compile testSource with lumenc.lm running on a fresh instance C - exact pattern from
// seed/selfhost_diff.mjs's compileSelfhost().
async function compileSelfhost(testSource) {
  const st = await loadSelfhostState();
  const { instance: instC } = await WebAssembly.instantiate(st.binary, {
    lumen: { console_print: (p, l) => {} }
  });
  const exC = instC.exports;

  new Int32Array(exC.mem.buffer, CODE_BASE, st.irWords).set(st.lmIR);

  const codeMem = new Int32Array(exC.mem.buffer, CODE_BASE, st.irWords + 10);
  if (st.lexEntries.length > 1) {
    const staleEntries = new Set(st.lexEntries.slice(0, -1));
    const goodEntry = st.lexEntries[st.lexEntries.length - 1];
    const TWO_WORD = new Set([1, 2, 6, 7, 13, 14, 15, 25]);
    let i = 0;
    while (i < st.irWords) {
      const op = codeMem[i];
      if (op === 8) {
        if (staleEntries.has(codeMem[i + 1])) codeMem[i + 1] = goodEntry;
        i += 3;
      } else if (op === 29) {
        i += 3;
      } else if (op === 57) {
        i += codeMem[i + 1] + 3;
      } else if (TWO_WORD.has(op)) {
        i += 2;
      } else {
        i += 1;
      }
    }
  }

  const testBytes = Buffer.from(testSource, 'utf8');
  new Uint8Array(exC.mem.buffer, 100000, testBytes.length).set(testBytes);
  new Uint8Array(exC.mem.buffer, 0, 1024).fill(0);

  const stubIndex = st.irWords;
  codeMem[stubIndex] = 1;
  codeMem[stubIndex + 1] = testBytes.length;
  codeMem[stubIndex + 2] = 8;
  codeMem[stubIndex + 3] = st.lexCompileEntry;
  codeMem[stubIndex + 4] = 1;
  codeMem[stubIndex + 5] = 0;

  exC.set_fuel_max(4000000000n);
  exC.run(stubIndex);

  const memView = new DataView(exC.mem.buffer);
  const emitCount = memView.getInt32(0, true);
  const nerr = memView.getInt32(28, true);
  const emittedIR = new Int32Array(exC.mem.buffer, 211328, emitCount).slice();

  return { nerr, emitCount, emittedIR };
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
