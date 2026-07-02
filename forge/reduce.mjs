#!/usr/bin/env node
// reduce.mjs - delta-minimizer for forge.mjs divergence repros.
//
// CLI: node reduce.mjs <seed> <class>
//
// Regenerates the seed program, confirms the divergence class reproduces via
// forge.mjs's own path functions, then greedily deletes/simplifies source
// text while re-checking ONLY the paths needed for that one class, keeping
// each edit iff the SAME class still reproduces and the program still
// compiles clean (path a / INTERP succeeds) on the seed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runInterp,
  compileSelfhost,
  compareIR,
  optimizeIR,
  runIR,
  buildAndRunFn,
  buildAndRunLlvm,
} from './forge.mjs';
import { generate } from './genprog.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = path.join(__dirname, 'forge_corpus');
const PENDING_DIR = path.join(CORPUS_DIR, 'pending');

const CLASSES = new Set(['IR_DIFF', 'OPT_DIFF', 'C_DIFF', 'LLVM_DIFF', 'HARNESS_ERROR']);
const ATTEMPT_CAP = 300;

// ---------- single-class divergence check ----------
// Runs ONLY the paths involved in `cls` and reports whether that exact class
// reproduces, plus whether the program compiled clean (path a succeeded).
async function checkClass(program, cls, forceFault) {
  let refInterp;
  try {
    refInterp = await runInterp(program);
  } catch (e) {
    return { same: cls === 'HARNESS_ERROR', cleanCompile: false, detail: `path a threw: ${String(e.message || e)}` };
  }

  if (cls === 'IR_DIFF') {
    try {
      const sh = await compileSelfhost(program);
      if (sh.nerr !== 0) return { same: false, cleanCompile: true };
      const diff = compareIR(refInterp.words, sh.emittedIR);
      return {
        same: !diff.ok,
        cleanCompile: true,
        detail: diff.ok ? '' : `diverge at word index ${diff.index}: seed=${diff.seedWord} selfhost=${diff.shWord}`,
      };
    } catch (e) {
      return { same: false, cleanCompile: true };
    }
  }

  if (cls === 'OPT_DIFF') {
    try {
      const { words, main } = await optimizeIR(refInterp.words, refInterp.main);
      const optOut = await runIR(words, main);
      return {
        same: optOut !== refInterp.stdout,
        cleanCompile: true,
        detail: `stdout mismatch: opt=${JSON.stringify(optOut)} ref=${JSON.stringify(refInterp.stdout)}`,
      };
    } catch (e) {
      return { same: false, cleanCompile: true };
    }
  }

  if (cls === 'C_DIFF') {
    try {
      const cand = await buildAndRunFn(program);
      let exit = cand.exit;
      if (forceFault) exit = exit + 1;
      const ok = cand.stdout === refInterp.stdout && exit === refInterp.exit;
      return {
        same: !ok,
        cleanCompile: true,
        detail: `stdout=${JSON.stringify(cand.stdout)} exit=${exit} ref_stdout=${JSON.stringify(refInterp.stdout)} ref_exit=${refInterp.exit}`,
      };
    } catch (e) {
      return { same: false, cleanCompile: true };
    }
  }

  if (cls === 'LLVM_DIFF') {
    try {
      const cand = await buildAndRunLlvm(program);
      const ok = cand.stdout === refInterp.stdout && cand.exit === refInterp.exit;
      return {
        same: !ok,
        cleanCompile: true,
        detail: `stdout=${JSON.stringify(cand.stdout)} exit=${cand.exit} ref_stdout=${JSON.stringify(refInterp.stdout)} ref_exit=${refInterp.exit}`,
      };
    } catch (e) {
      return { same: false, cleanCompile: true };
    }
  }

  // HARNESS_ERROR: path a already succeeded above (didn't throw), so it does not reproduce here.
  return { same: false, cleanCompile: true };
}

// ---------- text-level candidate edits ----------

// splits a program into top-level blank-line-separated blocks (each a `fn ...` def)
function splitFns(src) {
  return src.split(/\n\n+/).filter((b) => b.trim().length > 0);
}

function fnName(block) {
  const m = block.match(/^fn\s+(\w+)\s*\(/);
  return m ? m[1] : null;
}

// one greedy pass: try removing each non-main function block whose name is not
// referenced (textually) anywhere else in the remaining source.
async function tryRemoveFunctions(src, cls, forceFault, state) {
  let changed = false;
  const blocks = splitFns(src);
  for (let i = 0; i < blocks.length; i++) {
    if (state.attempts >= ATTEMPT_CAP) return { src, changed };
    const name = fnName(blocks[i]);
    if (!name || name === 'main') continue;
    const rest = blocks.slice(0, i).concat(blocks.slice(i + 1));
    const restSrc = rest.join('\n\n') + '\n';
    // referenced elsewhere (as a call)?
    if (rest.some((b) => new RegExp(`\\b${name}\\s*\\(`).test(b))) continue;

    state.attempts++;
    const result = await checkClass(restSrc, cls, forceFault);
    if (result.same) {
      blocks.splice(i, 1);
      changed = true;
      i--; // re-check this index since array shifted
    }
  }
  return { src: blocks.join('\n\n') + '\n', changed };
}

// one greedy pass: try deleting each source line; keep if it still compiles
// clean and the class still reproduces.
async function tryRemoveLines(src, cls, forceFault, state) {
  let lines = src.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (state.attempts >= ATTEMPT_CAP) break;
    if (lines[i].trim().length === 0) continue;
    const candidate = lines.slice(0, i).concat(lines.slice(i + 1));
    const candidateSrc = candidate.join('\n');

    state.attempts++;
    const result = await checkClass(candidateSrc, cls, forceFault);
    if (result.same && result.cleanCompile) {
      lines = candidate;
      changed = true;
      i--; // re-check this index since array shifted
    }
  }
  return { src: lines.join('\n'), changed };
}

// one greedy pass: for lines that assign/return/print an expression, try
// collapsing the expression down to a plain literal.
const LITERAL_CANDIDATES = ['0', '0.0', '""'];

function exprLineRegexes() {
  return [
    /^(\s*(?:let|var)\s+\w+\s*=\s*)(.+)$/,
    /^(\s*\w+\s*=\s*)(.+)$/,
    /^(\s*return\s+)(.+)$/,
    /^(\s*console\.print_int\()(.+)(\)\s*)$/,
    /^(\s*console\.print\()(.+)(\)\s*)$/,
  ];
}

async function trySimplifyExprs(src, cls, forceFault, state) {
  const lines = src.split('\n');
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (state.attempts >= ATTEMPT_CAP) break;
    const line = lines[i];
    for (const re of exprLineRegexes()) {
      const m = line.match(re);
      if (!m) continue;
      const prefix = m[1];
      const suffix = m[3] !== undefined ? m[3] : '';
      const currentExpr = m[2];
      let best = null;
      for (const lit of LITERAL_CANDIDATES) {
        if (lit === currentExpr) continue;
        if (lit.length >= currentExpr.length) continue; // only accept strict shrink
        const candidateLine = `${prefix}${lit}${suffix}`;
        const candidateSrc = lines.slice(0, i).concat([candidateLine], lines.slice(i + 1)).join('\n');
        state.attempts++;
        const result = await checkClass(candidateSrc, cls, forceFault);
        if (result.same && result.cleanCompile) {
          best = candidateLine;
          break;
        }
        if (state.attempts >= ATTEMPT_CAP) break;
      }
      if (best) {
        lines[i] = best;
        changed = true;
      }
      break; // only one regex should match per line
    }
  }
  return { src: lines.join('\n'), changed };
}

// ---------- fixpoint driver ----------
async function reduce(seed, cls, forceFault) {
  let src = generate(seed);
  const originalSize = src.length;
  const state = { attempts: 0 };

  let progressed = true;
  while (progressed && state.attempts < ATTEMPT_CAP) {
    progressed = false;

    const r1 = await tryRemoveFunctions(src, cls, forceFault, state);
    if (r1.changed) { src = r1.src; progressed = true; }
    if (state.attempts >= ATTEMPT_CAP) break;

    const r2 = await tryRemoveLines(src, cls, forceFault, state);
    if (r2.changed) { src = r2.src; progressed = true; }
    if (state.attempts >= ATTEMPT_CAP) break;

    const r3 = await trySimplifyExprs(src, cls, forceFault, state);
    if (r3.changed) { src = r3.src; progressed = true; }
  }

  return { src, originalSize, reducedSize: src.length, attempts: state.attempts };
}

// ---------- CLI ----------
async function main() {
  const [seedArg, clsArg] = process.argv.slice(2);
  if (seedArg === undefined || clsArg === undefined) {
    process.stderr.write('usage: node reduce.mjs <seed> <class>\n');
    process.exit(1);
  }
  const seed = Number(seedArg);
  const cls = clsArg;
  if (!CLASSES.has(cls)) {
    process.stderr.write(`unknown class ${cls}; expected one of ${[...CLASSES].join(', ')}\n`);
    process.exit(1);
  }

  const forceFaultSeed = process.env.FORGE_FAULT !== undefined ? Number(process.env.FORGE_FAULT) : null;
  const forceFault = forceFaultSeed !== null && forceFaultSeed === seed;

  const original = generate(seed);
  const originalCheck = await checkClass(original, cls, forceFault);
  if (!originalCheck.same) {
    process.stderr.write(`reduce: seed ${seed} does not reproduce class ${cls} (nothing to minimize)\n`);
    process.exit(1);
  }

  const result = await reduce(seed, cls, forceFault);
  const finalCheck = await checkClass(result.src, cls, forceFault);

  fs.mkdirSync(PENDING_DIR, { recursive: true });
  const base = `${cls}-seed${seed}`;
  const lmPath = path.join(PENDING_DIR, `${base}.lm`);
  const jsonPath = path.join(PENDING_DIR, `${base}.json`);
  fs.writeFileSync(lmPath, result.src);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        seed,
        class: cls,
        detail: finalCheck.detail || originalCheck.detail || '',
        originalSize: result.originalSize,
        reducedSize: result.reducedSize,
      },
      null,
      2
    ) + '\n'
  );

  console.log(`reduce: seed=${seed} class=${cls} attempts=${result.attempts}`);
  console.log(`reduce: originalSize=${result.originalSize} reducedSize=${result.reducedSize}`);
  console.log(`reduce: wrote ${lmPath}`);
  console.log(`reduce: wrote ${jsonPath}`);

  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { reduce, checkClass };
