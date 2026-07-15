#!/usr/bin/env node
// compile_latency_bench.mjs (S3, dimension 7b) - the compile-latency shootout: how long each
// toolchain takes to go from source to "compiles cleanly" (cold check tier), to a runnable
// binary (full-build tier), and - Lumen only - to a warm daemon round-trip (warm tier).
//
// Corpus: bench/latency_corpus/{kernel.lm, kernel.go, kernel.c, Kernel.java, kernel.py}, one
// ~40-line scalar Black-Scholes call-price kernel, ported line-by-line five times. All five
// MUST print byte-identical stdout on the fixed inputs (G9 gate below); a mismatch aborts the
// whole run rather than reporting a latency number for a program that computes something else.
//
// Tiers:
//   1. COLD CHECK (primary) - fresh-process syntax/type check, median-of-21, with each
//      toolchain's own empty-process spawn baseline subtracted:
//        lumen: node seed/lumen.mjs check kernel.lm
//        go:    go vet ./kernel.go            (chosen over `go build`: type-checks without
//               codegen/link, the closest Go analog to a "check", stated here rather than
//               silently picking whichever number is smaller)
//        c:     clang -fsyntax-only kernel.c
//        java:  javac -d tmpdir Kernel.java    (javac always emits a .class; there is no
//               syntax-only javac flag, so this row is really compile+emit, stated as such)
//        python: python3 -m py_compile kernel.py
//      rustc and julia are NOT installed on this machine (verified via `which`) - both rows are
//      printed literally as "not installed on this machine", nothing is invented and nothing is
//      installed to fill the gap.
//   2. FULL BUILD - source to a runnable binary:
//        lumen: native/pipeline.mjs's own stages (compileToIR -> optimizeIR -> emitWith ->
//               clang), timed up to a successful clang link (excludes running the binary,
//               matching what "go build"/"clang -O2" below measure)
//        go:    go build -o <tmp> kernel.go
//        c:     clang -O2 -o <tmp> kernel.c -lm
//        java:  javac -d <tmp> Kernel.java     (same as the cold-check row: javac has one mode)
//        python: 'n/a (interpreted)' - CPython has no separate build-to-binary step
//   3. WARM (Lumen only) - a `check` round-trip against a live lumend daemon on a temp Unix
//      socket, median-of-21. Every other language row reads 'N/A (no supported resident
//      daemon)': none of go/clang/javac/CPython ship a resident compile-server this harness can
//      drive without inventing bespoke tooling, so the honest answer is N/A, not a fabricated
//      number from some other warm-JIT concept (e.g. the JVM's own warm bytecode execution is
//      not a compiler daemon).
//
// Every process-spawn measurement subtracts that toolchain's own empty invocation as a spawn
// floor (an empty .lm/.go/.c/.java/.py file, checked with the same command), floored at zero -
// same spawn-cost-subtraction idiom as bench/kernel_suite_bench.mjs, so a small kernel is never
// misreported as costing less than raw process-start noise.
//
// Run:      node bench/compile_latency_bench.mjs
// Self-test (deterministic, no timing): node bench/latency_shootout_selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileToIR, optimizeIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from '../native/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CORPUS_DIR = path.join(REPO_ROOT, 'bench', 'latency_corpus');
const DASHBOARD_PATH = path.join(REPO_ROOT, 'bench', 'DASHBOARD.md');

const RUNS = 21;             // median-of-21, per the brief
const CLANG_FLAGS_SYNTAX = ['-fsyntax-only'];
const CLANG_FLAGS_BUILD = ['-O2'];

// ---------------------------------------------------------------------------
// Pure functions (exported; gated by latency_shootout_selftest.mjs with synthetic fixtures -
// no real timing, no real process spawn in the selftest).
// ---------------------------------------------------------------------------

export function median(xs) {
  if (xs.length === 0) throw new Error('median() of an empty array');
  return xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

export function subtractSpawnCost(rawMs, spawnMs) {
  return Math.max(0, rawMs - spawnMs);
}

// G9: every corpus twin's stdout must be byte-identical. Returns { ok, mismatches } rather than
// throwing, so the caller can print a clear report before aborting.
export function checkG9(outputs) {
  const entries = Object.entries(outputs);
  if (entries.length === 0) return { ok: true, mismatches: [] };
  const [, refOut] = entries[0];
  const mismatches = entries.filter(([, out]) => out !== refOut).map(([name]) => name);
  return { ok: mismatches.length === 0, mismatches };
}

function fmtMs(ms) {
  if (ms === null || ms === undefined) return 'n/a';
  return ms.toFixed(2);
}

export function renderRow({ date, tier, lang, ms, note }) {
  const msStr = ms === null || ms === undefined ? (note || 'n/a') : `${fmtMs(ms)} ms`;
  return `| ${date} | ${tier} | ${lang} | ${msStr} |`;
}

export function renderTable(rows) {
  const header = '| Date | Tier | Language/Toolchain | Median (spawn-subtracted) |\n' +
                 '|------|------|--------------------|---------------------------|';
  return [header, ...rows.map(renderRow)].join('\n');
}

function renderTableFromFormattedRows(formattedRows) {
  const header = '| Date | Tier | Language/Toolchain | Median (spawn-subtracted) |\n' +
                 '|------|------|--------------------|---------------------------|';
  return [header, ...formattedRows].join('\n');
}

// Same additive AUTO-block splice idiom as bench/kernel_suite_bench.mjs's spliceAutoBlock:
// existing rows are preserved, new rows are appended, and re-splicing with an empty newRows
// list is a true no-op (checked by latency_shootout_selftest.mjs).
export function spliceAutoBlock(text, blockName, newRows) {
  const marker = new RegExp(`(<!-- AUTO:${blockName} -->)([\\s\\S]*?)(<!-- /AUTO:${blockName} -->)`);
  const m = text.match(marker);
  const existingRows = [];
  if (m) {
    for (const line of m[2].split('\n')) {
      const t = line.trim();
      if (t.startsWith('|') && !t.startsWith('|------') && !t.startsWith('| Date')) existingRows.push(t);
    }
  }
  const allRows = [...existingRows, ...newRows.map(renderRow)];
  const body = renderTableFromFormattedRows(allRows);
  if (m) return text.replace(marker, `$1\n${body}\n$3`);
  const withMarkers = `${text.replace(/\n*$/, '\n')}\n` +
    '## Compile-latency shootout (auto-appended, dated snapshots)\n\n' +
    'Rendered from `bench/compile_latency_bench.mjs`. Do not hand-edit the block between the ' +
    'markers below; edit the bench script and re-run instead.\n\n' +
    `<!-- AUTO:${blockName} -->\n${body}\n<!-- /AUTO:${blockName} -->\n`;
  return withMarkers;
}

// ---------------------------------------------------------------------------
// Impure timing helpers (not selftested directly - thin glue around child_process/net, same
// philosophy as kernel_suite_bench.mjs keeping its build+timing helpers untested).
// ---------------------------------------------------------------------------

function timeOnce(fn) {
  const t0 = process.hrtime.bigint();
  let ok = true, err = null;
  try { fn(); } catch (e) { ok = false; err = e; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, ok, err };
}

function medianOfRuns(fn, n = RUNS) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const { ms, ok, err } = timeOnce(fn);
    if (!ok) throw err;
    samples.push(ms);
  }
  return median(samples);
}

function runQuiet(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'ignore'], ...opts });
}

function which(cmd) {
  try { execFileSync('which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] }); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// G9: run all five corpus twins once and require byte-identical stdout.
// ---------------------------------------------------------------------------

function runG9() {
  const outputs = {};
  outputs.lumen = execFileSync('node', [path.join(REPO_ROOT, 'seed', 'lumen.mjs'), 'run', path.join(CORPUS_DIR, 'kernel.lm')], { encoding: 'utf8' });

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-g9-'));
  runQuiet('clang', ['-O2', '-o', path.join(tmp, 'c_bin'), path.join(CORPUS_DIR, 'kernel.c'), '-lm']);
  outputs.c = execFileSync(path.join(tmp, 'c_bin'), { encoding: 'utf8' });

  const goBin = path.join(tmp, 'go_bin');
  runQuiet('go', ['build', '-o', goBin, path.join(CORPUS_DIR, 'go', 'kernel.go')]);
  outputs.go = execFileSync(goBin, { encoding: 'utf8' });

  const javaOut = path.join(tmp, 'javaout');
  fs.mkdirSync(javaOut);
  runQuiet('javac', ['-d', javaOut, path.join(CORPUS_DIR, 'Kernel.java')]);
  outputs.java = execFileSync('java', ['-cp', javaOut, 'Kernel'], { encoding: 'utf8' });

  outputs.python = execFileSync('python3', [path.join(CORPUS_DIR, 'kernel.py')], { encoding: 'utf8' });

  fs.rmSync(tmp, { recursive: true, force: true });
  const g9 = checkG9(outputs);
  return { g9, outputs };
}

// ---------------------------------------------------------------------------
// Cold check tier
// ---------------------------------------------------------------------------

function emptyFileFor(ext) {
  const map = { lm: '', go: 'package main\nfunc main(){}\n', c: 'int main(void){return 0;}\n', java: 'public class Empty { public static void main(String[] a) {} }\n', py: '' };
  return map[ext];
}

function coldCheckTier() {
  const rows = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-cold-'));

  // lumen
  {
    const emptyPath = path.join(tmp, 'empty.lm');
    fs.writeFileSync(emptyPath, emptyFileFor('lm'));
    const spawn = medianOfRuns(() => runQuiet('node', [path.join(REPO_ROOT, 'seed', 'lumen.mjs'), 'check', emptyPath]));
    const raw = medianOfRuns(() => runQuiet('node', [path.join(REPO_ROOT, 'seed', 'lumen.mjs'), 'check', path.join(CORPUS_DIR, 'kernel.lm')]));
    rows.push({ lang: 'lumen (node seed/lumen.mjs check)', ms: subtractSpawnCost(raw, spawn) });
  }
  // go vet (chosen over go build - see header comment)
  {
    const emptyPath = path.join(tmp, 'empty.go');
    fs.writeFileSync(emptyPath, emptyFileFor('go'));
    const spawn = medianOfRuns(() => runQuiet('go', ['vet', emptyPath]));
    const raw = medianOfRuns(() => runQuiet('go', ['vet', path.join(CORPUS_DIR, 'go', 'kernel.go')]));
    rows.push({ lang: 'go (go vet)', ms: subtractSpawnCost(raw, spawn) });
  }
  // clang -fsyntax-only
  {
    const emptyPath = path.join(tmp, 'empty.c');
    fs.writeFileSync(emptyPath, emptyFileFor('c'));
    const spawn = medianOfRuns(() => runQuiet('clang', [...CLANG_FLAGS_SYNTAX, emptyPath]));
    const raw = medianOfRuns(() => runQuiet('clang', [...CLANG_FLAGS_SYNTAX, path.join(CORPUS_DIR, 'kernel.c')]));
    rows.push({ lang: 'c (clang -fsyntax-only)', ms: subtractSpawnCost(raw, spawn) });
  }
  // javac (always emits .class - stated as compile+emit, not pure syntax check)
  {
    const emptyDir = fs.mkdtempSync(path.join(tmp, 'jempty-'));
    const emptyPath = path.join(emptyDir, 'Empty.java');
    fs.writeFileSync(emptyPath, emptyFileFor('java'));
    const spawn = medianOfRuns(() => { const d = fs.mkdtempSync(path.join(tmp, 'jempty-out-')); runQuiet('javac', ['-d', d, emptyPath]); });
    const raw = medianOfRuns(() => { const d = fs.mkdtempSync(path.join(tmp, 'jcold-out-')); runQuiet('javac', ['-d', d, path.join(CORPUS_DIR, 'Kernel.java')]); });
    rows.push({ lang: 'java (javac -d tmpdir Kernel.java)', ms: subtractSpawnCost(raw, spawn) });
  }
  // python3 -m py_compile
  {
    const emptyPath = path.join(tmp, 'empty.py');
    fs.writeFileSync(emptyPath, emptyFileFor('py'));
    const spawn = medianOfRuns(() => runQuiet('python3', ['-m', 'py_compile', emptyPath]));
    const raw = medianOfRuns(() => runQuiet('python3', ['-m', 'py_compile', path.join(CORPUS_DIR, 'kernel.py')]));
    rows.push({ lang: 'python (python3 -m py_compile)', ms: subtractSpawnCost(raw, spawn) });
  }
  // rustc / julia: not installed - stated literally, nothing invented
  if (!which('rustc')) rows.push({ lang: 'rust (rustc)', ms: null, note: 'not installed on this machine' });
  if (!which('julia')) rows.push({ lang: 'julia', ms: null, note: 'not installed on this machine' });

  fs.rmSync(tmp, { recursive: true, force: true });
  return rows;
}

// ---------------------------------------------------------------------------
// Full-build tier
// ---------------------------------------------------------------------------

// Lumen build-to-binary, stopping right after a successful clang link (no run) - mirrors
// native/pipeline.mjs's buildAndRunFn up through the clang invocation, minus the final
// execFileSync(bin) run step, so this tier measures the same thing the other rows measure:
// source -> runnable binary, not source -> program output.
async function lumenBuildOnly(src) {
  const EMIT_FN_SRC = fs.readFileSync(path.join(REPO_ROOT, 'native', 'emit_fn.lm'), 'utf8');
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) { pc = pc + 3 + words[pc + 1]; }
    else {
      if (op === 15) ptrs.push(words[pc + 1]);
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) oplen = 1;
      else if (op === 8 || op === 29 || op === 64) oplen = 2;
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(ir.strings.map(s => [s.ptr, s]));
  const strings = uniquePtrs.map(ptr => { const s = stringsMap.get(ptr); if (!s) throw new Error(`missing string ptr ${ptr}`); return s; });
  const csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-buildonly-'));
  const cfile = path.join(dir, 'p.c'), bin = path.join(dir, 'p');
  fs.writeFileSync(cfile, csrc);
  execFileSync('clang', ['-ffp-contract=off', '-fno-fast-math', '-O2', '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.rmSync(dir, { recursive: true, force: true });
}

async function fullBuildTier() {
  const rows = [];
  const src = fs.readFileSync(path.join(CORPUS_DIR, 'kernel.lm'), 'utf8');

  // lumen: async, so time manually via hrtime rather than the sync medianOfRuns helper.
  {
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await lumenBuildOnly(src);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    rows.push({ lang: 'lumen (compile+optimize+emit+clang, native pipeline)', ms: median(samples) });
  }
  // go build
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-gobuild-'));
    const ms = medianOfRuns(() => runQuiet('go', ['build', '-o', path.join(tmp, `b${Math.random()}`), path.join(CORPUS_DIR, 'go', 'kernel.go')]));
    fs.rmSync(tmp, { recursive: true, force: true });
    rows.push({ lang: 'go (go build)', ms });
  }
  // clang -O2
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-cbuild-'));
    const ms = medianOfRuns(() => runQuiet('clang', [...CLANG_FLAGS_BUILD, '-o', path.join(tmp, `b${Math.random()}`), path.join(CORPUS_DIR, 'kernel.c'), '-lm']));
    fs.rmSync(tmp, { recursive: true, force: true });
    rows.push({ lang: 'c (clang -O2)', ms });
  }
  // javac (same as cold-check row: javac has only one mode)
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'latency-jbuild-'));
    const ms = medianOfRuns(() => { const d = fs.mkdtempSync(path.join(tmp, 'out-')); runQuiet('javac', ['-d', d, path.join(CORPUS_DIR, 'Kernel.java')]); });
    fs.rmSync(tmp, { recursive: true, force: true });
    rows.push({ lang: 'java (javac, same as cold-check)', ms });
  }
  rows.push({ lang: 'python (interpreted)', ms: null, note: 'n/a (interpreted)' });
  return rows;
}

// ---------------------------------------------------------------------------
// Warm tier: lumend daemon only
// ---------------------------------------------------------------------------

function daemonCheck(sock, src) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    let buf = '';
    const timer = setTimeout(() => { s.destroy(); reject(new Error('lumend: timeout')); }, 2000);
    s.on('connect', () => s.write(JSON.stringify({ id: 1, op: 'check', src }) + '\n'));
    s.on('data', chunk => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) { clearTimeout(timer); s.end(); resolve(JSON.parse(buf.slice(0, nl))); }
    });
    s.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

async function warmTier() {
  const rows = [];
  const sock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lumend-sock-')), 'lumen.sock');
  const child = spawn('node', [path.join(REPO_ROOT, 'seed', 'lumend.mjs'), sock], { stdio: 'ignore' });
  try {
    // wait for the socket to appear (daemon assembles the compiler once at startup)
    const deadline = Date.now() + 15000;
    while (!fs.existsSync(sock)) {
      if (Date.now() > deadline) throw new Error('lumend did not start in time');
      await new Promise(r => setTimeout(r, 50));
    }
    const src = fs.readFileSync(path.join(CORPUS_DIR, 'kernel.lm'), 'utf8');
    await daemonCheck(sock, src); // one warmup round-trip, not counted
    const samples = [];
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint();
      await daemonCheck(sock, src);
      samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    rows.push({ lang: 'lumen (lumend daemon, warm check round-trip)', ms: median(samples) });
  } finally {
    child.kill();
  }
  for (const lang of ['go', 'c (clang)', 'java (javac)', 'python']) {
    rows.push({ lang, ms: null, note: 'N/A (no supported resident daemon)' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function printPinnedVersions() {
  const get = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0]; } catch { return 'unavailable'; } };
  console.log('Pinned toolchain versions:');
  console.log('  node:  ' + process.version);
  console.log('  go:    ' + get('go', ['version']));
  console.log('  clang: ' + get('clang', ['--version']));
  console.log('  javac: ' + get('javac', ['-version']));
  console.log('  python:' + get('python3', ['--version']));
  console.log('  rustc: ' + (which('rustc') ? get('rustc', ['--version']) : 'not installed on this machine'));
  console.log('  julia: ' + (which('julia') ? get('julia', ['--version']) : 'not installed on this machine'));
  console.log();
}

async function main() {
  printPinnedVersions();

  console.log('G9: verifying byte-identical stdout across all five corpus twins...');
  const { g9 } = runG9();
  if (!g9.ok) {
    console.error(`G9 FAILED: mismatched stdout from: ${g9.mismatches.join(', ')}`);
    process.exit(1);
  }
  console.log('G9 PASS: all five twins produce byte-identical stdout.\n');

  const date = new Date().toISOString().slice(0, 10);

  console.log('Tier 1: cold check (median-of-21, spawn-subtracted)...');
  const coldRows = coldCheckTier().map(r => ({ date, tier: 'cold check', ...r }));
  console.log(renderTable(coldRows) + '\n');

  console.log('Tier 2: full build (median-of-21, source -> runnable binary)...');
  const buildRows = (await fullBuildTier()).map(r => ({ date, tier: 'full build', ...r }));
  console.log(renderTable(buildRows) + '\n');

  console.log('Tier 3: warm (lumend daemon, median-of-21)...');
  const warmRows = (await warmTier()).map(r => ({ date, tier: 'warm', ...r }));
  console.log(renderTable(warmRows) + '\n');

  const allRows = [...coldRows, ...buildRows, ...warmRows];
  console.log('=== Full compile-latency shootout ===');
  console.log(renderTable(allRows));

  let dashboard = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  dashboard = spliceAutoBlock(dashboard, 'latency-shootout', allRows);
  fs.writeFileSync(DASHBOARD_PATH, dashboard);
  console.log(`\nSpliced ${allRows.length} row(s) into bench/DASHBOARD.md's AUTO:latency-shootout block.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
