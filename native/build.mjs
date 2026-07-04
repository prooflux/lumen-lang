// build.mjs - ahead-of-time compiler driver for Lumen to produce standalone executables
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { compileToIR, optimizeIR, freshInstance, writeSrc, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from './pipeline.mjs';

const SRC_BASE = 100000;

function printUsageAndExit() {
  console.error("Usage: node build.mjs <input.lm> -o <output-exe> [--opt -O2|-O3] [--fast]");
  process.exit(1);
}

// Argument parsing
const args = process.argv.slice(2);
if (args.length === 0) {
  printUsageAndExit();
}

let inputPath = null;
let outputPath = null;
let optLevel = '-O2';
let fast = false;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-o') {
    if (i + 1 >= args.length) {
      console.error("Error: -o option requires an argument");
      printUsageAndExit();
    }
    outputPath = args[++i];
  } else if (arg === '--opt') {
    if (i + 1 >= args.length) {
      console.error("Error: --opt option requires an argument (-O2 or -O3)");
      printUsageAndExit();
    }
    optLevel = args[++i];
    if (optLevel !== '-O2' && optLevel !== '-O3') {
      console.error(`Error: invalid optimization level ${optLevel}, must be -O2 or -O3`);
      printUsageAndExit();
    }
  } else if (arg === '--fast') {
    fast = true;
  } else if (arg.startsWith('-')) {
    console.error(`Error: unknown option ${arg}`);
    printUsageAndExit();
  } else {
    if (inputPath !== null) {
      console.error(`Error: multiple input files specified (${inputPath} and ${arg})`);
      printUsageAndExit();
    }
    inputPath = arg;
  }
}

if (!inputPath) {
  console.error("Error: no input file specified");
  printUsageAndExit();
}

if (!outputPath) {
  outputPath = path.basename(inputPath, '.lm');
}

if (fast) {
  console.log("Warning: --fast option enabled. Bit-reproducibility vs the interpreter is voided.");
}

// emitWith is imported from pipeline.mjs (shared, parameterized by injection base). build.mjs
// only emits via emit_fn.lm, whose IR reads from EMIT_FN_BASE (the 2MB high block above the
// seed VM heap); see the fixpoint heap-collision fix. emit_fn emits a complete translation
// unit (its own C runtime header) - no JS-side prepends.

async function main() {
  let src;
  try {
    src = fs.readFileSync(inputPath, 'utf8');
  } catch (e) {
    console.error(`Error reading input file: ${e.message}`);
    process.exit(1);
  }

  // compileToIR
  let ir;
  try {
    ir = await compileToIR(src);
  } catch (e) {
    // Re-run compilation to access diagnostics
    const I = await freshInstance();
    const len = writeSrc(I, src);
    I.ex.compile(len);
    const nerr = I.ex.dbg_nerr();
    const m32 = new Int32Array(I.ex.mem.buffer);
    for (let i = 0; i < Math.min(10, nerr); i++) {
      const dbase = 286000 + i * 12;
      const code = m32[dbase / 4];
      const off = m32[dbase / 4 + 1];
      const elen = m32[dbase / 4 + 2];
      const tstr = Buffer.from(I.ex.mem.buffer, off, elen).toString();
      console.error(`Error code ${code} at '${tstr}' (byte ${off - SRC_BASE})`);
    }
    process.exit(1);
  }

  // optimizeIR
  let optimized;
  try {
    optimized = await optimizeIR(ir.words, ir.main);
  } catch (e) {
    console.error(`Error during optimization: ${e.message}`);
    process.exit(1);
  }

  const { words, main: irMain } = optimized;

  // Find all MKTEXT operands in the optimized words
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) {
      pc = pc + 3 + words[pc + 1];
    } else {
      if (op === 15) {
        ptrs.push(words[pc + 1]);
      }
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) {
        oplen = 1;
      } else if (op === 8 || op === 29) {
        oplen = 2;
      }
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(ir.strings.map(s => [s.ptr, s]));
  const strings = uniquePtrs.map(ptr => {
    const s = stringsMap.get(ptr);
    if (!s) throw new Error(`Internal error: string pointer ${ptr} not found in compile-time strings`);
    return s;
  });

  const EMIT_FN_SRC = fs.readFileSync(new URL('./emit_fn.lm', import.meta.url), 'utf8');
  let csrc;
  try {
    csrc = await emitWith(EMIT_FN_SRC, words, irMain, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  } catch (e) {
    console.error(`Error during C emission: ${e.message}`);
    process.exit(1);
  }

  // Write C source to a temp file and compile using clang
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-build-'));
  const cfile = path.join(dir, 'p.c');
  fs.writeFileSync(cfile, csrc);

  const clangFlags = [];
  if (fast) {
    clangFlags.push('-ffp-contract=fast', '-ffast-math');
  } else {
    clangFlags.push('-ffp-contract=off', '-fno-fast-math');
  }
  clangFlags.push(optLevel, '-o', outputPath, cfile);

  try {
    execFileSync('clang', clangFlags, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    console.error(`clang failed: ${String(e.stderr || e.message).slice(0, 300)}`);
    process.exit(1);
  } finally {
    // Clean up temporary files
    try {
      fs.unlinkSync(cfile);
      fs.rmdirSync(dir);
    } catch (_) {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
