// forge_corpus_test.mjs - regression floor.
//
// Every .lm file in forge_corpus/fixed/ is a minimized repro of a bug that has
// since been FIXED; this test asserts NONE of the 5 forge paths diverge on it
// anymore. A failure here means a fix regressed.
//
// forge_corpus/pending/ holds minimized repros of bugs NOT yet fixed; those
// are only reported (seed/class/sizes), never asserted, so this test stays
// green while known issues are queued for work.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInterp, compileSelfhost, compareIR, optimizeIR, runIR, buildAndRunFn, buildAndRunLlvm } from './forge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXED_DIR = path.join(__dirname, 'forge_corpus', 'fixed');
const PENDING_DIR = path.join(__dirname, 'forge_corpus', 'pending');

function listLm(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.lm')).sort();
}

// runs all 5 paths on one program, returns array of divergence class strings found
async function allDivergences(program) {
  const found = [];
  let refInterp;
  try {
    refInterp = await runInterp(program);
  } catch (e) {
    found.push(`HARNESS_ERROR(a): ${String(e.message || e)}`);
    return found;
  }

  try {
    const sh = await compileSelfhost(program);
    if (sh.nerr === 0) {
      const diff = compareIR(refInterp.words, sh.emittedIR);
      if (!diff.ok) found.push(`IR_DIFF: index ${diff.index} seed=${diff.seedWord} selfhost=${diff.shWord}`);
    }
  } catch (e) {
    found.push(`HARNESS_ERROR(b): ${String(e.message || e)}`);
  }

  try {
    const { words, main } = await optimizeIR(refInterp.words, refInterp.main);
    const optOut = await runIR(words, main);
    if (optOut !== refInterp.stdout) found.push(`OPT_DIFF: opt=${JSON.stringify(optOut)} ref=${JSON.stringify(refInterp.stdout)}`);
  } catch (e) {
    found.push(`HARNESS_ERROR(c): ${String(e.message || e)}`);
  }

  try {
    const cand = await buildAndRunFn(program);
    const ok = cand.stdout === refInterp.stdout && cand.exit === refInterp.exit;
    if (!ok) found.push(`C_DIFF: stdout=${JSON.stringify(cand.stdout)} exit=${cand.exit} ref_stdout=${JSON.stringify(refInterp.stdout)} ref_exit=${refInterp.exit}`);
  } catch (e) {
    found.push(`HARNESS_ERROR(d): ${String(e.message || e)}`);
  }

  try {
    const cand = await buildAndRunLlvm(program);
    const ok = cand.stdout === refInterp.stdout && cand.exit === refInterp.exit;
    if (!ok) found.push(`LLVM_DIFF: stdout=${JSON.stringify(cand.stdout)} exit=${cand.exit} ref_stdout=${JSON.stringify(refInterp.stdout)} ref_exit=${refInterp.exit}`);
  } catch (e) {
    found.push(`HARNESS_ERROR(e): ${String(e.message || e)}`);
  }

  return found;
}

async function main() {
  let pass = 0;
  let fail = 0;

  const fixedFiles = listLm(FIXED_DIR);
  if (fixedFiles.length === 0) {
    console.log('forge_corpus_test: forge_corpus/fixed/ is empty (no regression repros committed yet) - OK');
  }
  for (const f of fixedFiles) {
    const p = path.join(FIXED_DIR, f);
    const program = fs.readFileSync(p, 'utf8');
    let diverged;
    try {
      diverged = await allDivergences(program);
    } catch (e) {
      diverged = [`unexpected throw: ${String(e.message || e)}`];
    }
    if (diverged.length === 0) {
      console.log(`PASS  fixed/${f}`);
      pass++;
    } else {
      console.log(`FAIL  fixed/${f}  ${diverged.join(' | ')}`);
      fail++;
    }
  }

  const pendingFiles = listLm(PENDING_DIR);
  if (pendingFiles.length) {
    console.log(`\nPENDING (${pendingFiles.length}, not asserted - known open repros):`);
    for (const f of pendingFiles) {
      const jsonPath = path.join(PENDING_DIR, f.replace(/\.lm$/, '.json'));
      if (fs.existsSync(jsonPath)) {
        const meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        console.log(`  ${f}  seed=${meta.seed} class=${meta.class} size=${meta.reducedSize}B (was ${meta.originalSize}B)`);
      } else {
        console.log(`  ${f}  (no sidecar json)`);
      }
    }
  }

  console.log(`\n${pass}/${pass + fail} fixed-corpus regression checks passed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
