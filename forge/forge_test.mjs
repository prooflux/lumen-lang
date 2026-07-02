// forge_test.mjs - self-test for forge.mjs (the 5-path differential runner).
//
// Asserts: the harness completes on seeds 1..40 (--native-every 10), is deterministic
// across two independent runs, and FORGE_FAULT=10 produces exactly one C_DIFF finding
// for seed 10. Any real findings surfaced without FORGE_FAULT set are discoveries, not
// test failures - printed clearly and left in the output.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FORGE = path.join(__dirname, 'forge.mjs');

function runForge(outFile, extraEnv = {}) {
  const out = execFileSync('node', [FORGE, '--from', '1', '--to', '40', '--native-every', '10', '--out', outFile], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    cwd: __dirname,
  });
  return out.trim();
}

function readFindings(outFile) {
  const text = fs.readFileSync(outFile, 'utf8');
  return text.trim().length ? text.trim().split('\n').map(l => JSON.parse(l)) : [];
}

let pass = 0, fail = 0;

// 1. Run 1: baseline, no fault injection.
const out1File = path.join(__dirname, '.forge_test_run1.jsonl');
let summary1;
try {
  summary1 = runForge(out1File);
  console.log(`PASS  run-1-completes  ${summary1}`);
  pass++;
} catch (e) {
  console.log(`FAIL  run-1-completes  ${String(e.message || e).slice(0, 300)}`);
  fail++;
}
const findings1 = fs.existsSync(out1File) ? readFindings(out1File) : [];

if (findings1.length > 0) {
  console.log(`\nDISCOVERY: forge surfaced ${findings1.length} real finding(s) on seeds 1..40 (native-every 10):`);
  for (const f of findings1) {
    console.log(`  seed=${f.seed} class=${f.class} detail=${f.detail}`);
  }
  console.log('');
}

// 2. Run 2: repeat, assert determinism (same findings, byte for byte).
const out2File = path.join(__dirname, '.forge_test_run2.jsonl');
try {
  const summary2 = runForge(out2File);
  const raw1 = fs.readFileSync(out1File, 'utf8');
  const raw2 = fs.readFileSync(out2File, 'utf8');
  const ok = raw1 === raw2 && summary1 === summary2;
  console.log(`${ok ? 'PASS' : 'FAIL'}  run-2-deterministic  ${ok ? 'identical findings + summary across two runs' : 'MISMATCH between run 1 and run 2'}`);
  if (ok) pass++; else fail++;
} catch (e) {
  console.log(`FAIL  run-2-deterministic  ${String(e.message || e).slice(0, 300)}`);
  fail++;
}

// 3. Fault injection: FORGE_FAULT=10 must produce exactly one C_DIFF finding for seed 10.
const outFaultFile = path.join(__dirname, '.forge_test_fault.jsonl');
try {
  runForge(outFaultFile, { FORGE_FAULT: '10' });
  const findingsFault = readFindings(outFaultFile);
  const cdiffsSeed10 = findingsFault.filter(f => f.seed === 10 && f.class === 'C_DIFF');
  const ok = cdiffsSeed10.length === 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  fault-injection-seed-10  found ${cdiffsSeed10.length} C_DIFF finding(s) for seed 10 (total findings: ${findingsFault.length})`);
  if (ok) pass++; else fail++;
} catch (e) {
  console.log(`FAIL  fault-injection-seed-10  ${String(e.message || e).slice(0, 300)}`);
  fail++;
}

// cleanup scratch files
for (const f of [out1File, out2File, outFaultFile]) {
  try { fs.unlinkSync(f); } catch {}
}

console.log(`\n${pass}/${pass + fail} forge self-test checks passed`);
process.exit(fail === 0 ? 0 : 1);
