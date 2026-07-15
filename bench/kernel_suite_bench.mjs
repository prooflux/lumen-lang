#!/usr/bin/env node
// kernel_suite_bench.mjs (W6/S2) - runtime speed of real finance kernels, Lumen-native (the C
// backend, emit_fn.lm via native/pipeline.mjs) vs an honest hand-written C twin. Joins the LOCAL
// Law-P (RULES.md Rule 6: "Any change, fix, or refactor must measure at least as fast and at
// least as accurate as what it replaces") perf-check list alongside native/native_bench.mjs and
// bench/honesty_gate.mjs's G3 ratchet - local/nightly only, never a CI gate: wall-clock
// comparisons on shared runners are flaky (the same reason native_bench.mjs is excluded from
// gate.yml - see that file's own header comment). Only this file's PURE functions (median,
// spawn-cost subtraction, table rendering, the AUTO-block splice) are gated, via
// bench/kernel_suite_selftest.mjs, deterministically, with no timing assertions.
//
// Kernels: examples/finance/bs_greeks.lm (transcendental-heavy, all 13 Greeks), vol_surface_
// heston.lm (a 4-point IV grid), bond_price.lm (a discounting loop), swap_rate.lm (array-based,
// no reusable function - the whole program IS the kernel), implied_vol.lm (50-iteration Newton-
// Raphson), plus fib(32) as the one integer kernel (recursion, no Float/transcendentals at all -
// deliberately the opposite shape from the other five). Every one of examples/finance/*.lm was,
// before this file, wired into NO benchmark anywhere in this repo (confirmed by a repo-wide grep
// during W6 research) - this is what closes that gap.
//
// Honesty rules (non-negotiable, per the brief):
//   - Identical algorithms both sides. Every C twin below is a direct line-by-line port of its
//     .lm source (same formula, same operand order, no vectorization, no algorithmic shortcut
//     either way) - verified independently before this file was written: both sides were built
//     standalone and their outputs compared byte-for-byte against the actual `lumen run` output
//     of the real .lm files, not just against the files' own header-comment claims.
//   - Pinned flags, stated in the output: clang -O2 -ffp-contract=off -fno-fast-math, both sides,
//     no exceptions (-fno-fast-math/-ffp-contract=off applied symmetrically, not just on the
//     Lumen side that structurally needs it - see the CLANG_FLAGS comment below). The hand-C twin
//     additionally links -lm (a linker requirement for <math.h>, not a codegen difference: emit_fn
//     -emitted C carries its own transcendental routines and links no external math library).
//   - No lopsided kernels: every kernel here has a real C twin; the "no C twin yet" label (see
//     KERNELS below) exists for future entries where writing a fair twin was not yet done, and is
//     printed literally rather than inventing a comparison.
//   - Spawn-cost subtracted: every measurement is (median wall-time of the built binary) minus
//     (median wall-time of a shared, once-built `int main(void){return 0;}` binary), floored at
//     zero. A kernel whose true cost is smaller than process-spawn noise is reported as such
//     ("below spawn-noise floor"), never as a fabricated sub-zero or wildly noisy ratio.
//
// Run:  node bench/kernel_suite_bench.mjs
// Self-test (deterministic, no timing): node bench/kernel_suite_selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileToIR, optimizeIR, emitWith, EMIT_FN_BASE, EMIT_FN_CEIL } from '../native/pipeline.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DASHBOARD_PATH = path.join(REPO_ROOT, 'bench', 'DASHBOARD.md');
const EMIT_FN_SRC = fs.readFileSync(path.join(REPO_ROOT, 'native', 'emit_fn.lm'), 'utf8');

// Pinned, both sides, stated in the output (honesty rule 2). -ffp-contract=off -fno-fast-math
// matches native/pipeline.mjs's own buildAndRunFn: emit_fn.lm's transcribed f_exp/f_ln/f_pow only
// reproduce the interpreter's bits with FMA contraction off and default (ties-to-even) rounding -
// see that function's comment. Applied symmetrically to the hand-C twin too (not just the Lumen
// side), so neither side gets an FMA-contraction speed advantage the other is denied. Never -Ofast
// either side.
const CLANG_FLAGS = ['-O2', '-ffp-contract=off', '-fno-fast-math'];
const WARMUP_RUNS = 1;
const TIMED_RUNS = 5;          // median-of-5, per the brief

// ---------------------------------------------------------------------------
// Pure functions (exported; gated by kernel_suite_selftest.mjs with synthetic fixtures - no
// real timing here, no real I/O beyond what the caller already resolved).
// ---------------------------------------------------------------------------

// Odd-length median (TIMED_RUNS is always odd here, so no averaging-of-two ambiguity).
export function median(xs) {
  if (xs.length === 0) throw new Error('median() of an empty array');
  return xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

// Never negative: a kernel whose measured cost is below the spawn-noise floor reads as 0, not a
// nonsensical negative number.
export function subtractSpawnCost(rawMs, spawnMs) {
  return Math.max(0, rawMs - spawnMs);
}

// null (not a number, not a string) when either side is at/below the noise floor - the caller
// decides how to print that ("n/a", "below spawn-noise floor", whatever fits the context) rather
// than this function inventing wording.
export function computeRatio(lumenMs, cMs) {
  if (lumenMs <= 0 || cMs <= 0) return null;
  return lumenMs / cMs;
}

export function formatRow({ date, kernel, lumenMs, cMs, ratio, flags }) {
  const fmt = (v) => (v === null ? 'below-noise-floor' : `${v.toFixed(3)}ms`);
  const ratioStr = ratio === null ? 'n/a' : `${ratio.toFixed(2)}x`;
  return `| ${date} | ${kernel} | ${fmt(lumenMs)} | ${cMs === null ? 'no C twin yet' : fmt(cMs)} | ${ratioStr} | ${flags} |`;
}

export function renderTable(rows) {
  const header = '| Date | Kernel | Lumen-native | Hand-C | Ratio (lumen/C) | clang flags |\n' +
                 '|------|--------|--------------|--------|-----------------|-------------|';
  return [header, ...rows.map(formatRow)].join('\n');
}

// AUTO-marker splice, the same idiom tools/scoreboard_gate.mjs's own spliceBlock uses (that
// function is module-private there, not exported, so this is a deliberate re-implementation of
// the same pattern, not an import - see this file's own report for that judgment call).
// ADDITIVE, not idempotent-by-replacement: existing rows (any line starting "| " inside the
// block, skipping the header/separator) are preserved and the new rows are appended after them,
// so repeated nightly runs accumulate a dated history rather than overwriting the last one.
// Re-splicing the SAME already-spliced text with an EMPTY newRows list is a true no-op (that
// specific idempotence is what kernel_suite_selftest.mjs checks) - it is not claimed to be a
// no-op when newRows is non-empty, by design.
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
  const allRows = [...existingRows, ...newRows.map(formatRow)];
  const body = renderTableFromFormattedRows(allRows);
  if (m) return text.replace(marker, `$1\n${body}\n$3`);
  const withMarkers = `${text.replace(/\n*$/, '\n')}\n` +
    '## Kernel suite (auto-appended, dated snapshots)\n\n' +
    'Rendered from `bench/kernel_suite_bench.mjs`. Do not hand-edit the block between the ' +
    'markers below; edit the bench script and re-run instead.\n\n' +
    `<!-- AUTO:${blockName} -->\n${body}\n<!-- /AUTO:${blockName} -->\n`;
  return withMarkers;
}

function renderTableFromFormattedRows(formattedRows) {
  const header = '| Date | Kernel | Lumen-native | Hand-C | Ratio (lumen/C) | clang flags |\n' +
                 '|------|--------|--------------|--------|-----------------|-------------|';
  return [header, ...formattedRows].join('\n');
}

// ---------------------------------------------------------------------------
// Build + timing helpers (impure: fs, clang, process spawn). Not selftested directly - the pure
// functions above are what the selftest gates; these are thin glue, same philosophy as
// scoreboard_gate.mjs's own git-facing functions staying untested.
// ---------------------------------------------------------------------------

function buildC(csrc, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kernel-suite-c-${tag}-`));
  const cfile = path.join(dir, 'k.c'), bin = path.join(dir, 'k');
  fs.writeFileSync(cfile, csrc);
  execFileSync('clang', [...CLANG_FLAGS, '-o', bin, cfile, '-lm'], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

// Mirrors native/pipeline.mjs's own buildAndRunFn (the C backend / emit_fn.lm path) exactly, but
// keeps the binary path instead of running it once and discarding it - buildAndRunFn does not
// expose the binary path, and this bench needs to re-run the SAME binary several times for a
// median. Does not modify pipeline.mjs.
async function buildLumenNative(src, tag) {
  const ir = await compileToIR(src);
  const { words, main } = await optimizeIR(ir.words, ir.main);
  const ptrs = [];
  let pc = 0;
  while (pc < words.length) {
    const op = words[pc];
    if (op === 57) {
      pc = pc + 3 + words[pc + 1];
    } else {
      if (op === 15) ptrs.push(words[pc + 1]);
      let oplen = 0;
      if (op === 1 || op === 2 || op === 6 || op === 7 || op === 13 || op === 14 || op === 15 || op === 25) oplen = 1;
      else if (op === 8 || op === 29 || op === 64) oplen = 2;   // DPUSH(64): none of this suite's kernels use Dec, but correct regardless
      pc = pc + 1 + oplen;
    }
  }
  const uniquePtrs = [...new Set(ptrs)];
  const stringsMap = new Map(ir.strings.map((s) => [s.ptr, s]));
  const strings = uniquePtrs.map((ptr) => {
    const s = stringsMap.get(ptr);
    if (!s) throw new Error(`kernel_suite_bench: string pointer ${ptr} not found for ${tag}`);
    return s;
  });
  const csrc = await emitWith(EMIT_FN_SRC, words, main, strings, EMIT_FN_BASE, EMIT_FN_CEIL);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `kernel-suite-lumen-${tag}-`));
  const cfile = path.join(dir, 'k.c'), bin = path.join(dir, 'k');
  fs.writeFileSync(cfile, csrc);
  execFileSync('clang', [...CLANG_FLAGS, '-o', bin, cfile], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

function medianRunMs(bin) {
  for (let i = 0; i < WARMUP_RUNS; i++) execFileSync(bin, { encoding: 'utf8' });
  const times = [];
  for (let i = 0; i < TIMED_RUNS; i++) {
    const t0 = process.hrtime.bigint();
    execFileSync(bin, { encoding: 'utf8' });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return median(times);
}

function runStdout(bin) {
  return execFileSync(bin, { encoding: 'utf8' });
}

// ---------------------------------------------------------------------------
// Kernels. Each C twin was independently verified (standalone, before this file existed) to
// reproduce the corresponding .lm file's real `lumen run` stdout byte-for-byte.
// ---------------------------------------------------------------------------

function readKernel(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
}

const FIB_N = 32;

const KERNELS = [
  {
    name: 'bs_greeks',
    lumenSrc: () => readKernel('examples/finance/bs_greeks.lm'),
    cSrc: () => C_BS_GREEKS,
  },
  {
    name: 'vol_surface_heston',
    lumenSrc: () => readKernel('examples/finance/vol_surface_heston.lm'),
    cSrc: () => C_VOL_SURFACE_HESTON,
  },
  {
    name: 'bond_price',
    lumenSrc: () => readKernel('examples/finance/bond_price.lm'),
    cSrc: () => C_BOND_PRICE,
  },
  {
    name: 'swap_rate',
    lumenSrc: () => readKernel('examples/finance/swap_rate.lm'),
    cSrc: () => C_SWAP_RATE,
  },
  {
    name: 'implied_vol',
    lumenSrc: () => readKernel('examples/finance/implied_vol.lm'),
    cSrc: () => C_IMPLIED_VOL,
  },
  {
    name: `fib(${FIB_N})`,
    lumenSrc: () => `fn fib(n: Int) -> Int { if n < 2 { return n } return fib(n - 1) + fib(n - 2) }\n` +
      `fn main(console: Console) -> Unit { console.print_int(fib(${FIB_N})) }\n`,
    cSrc: () => C_FIB.replace('__N__', String(FIB_N)),
  },
];

const C_BS_GREEKS = `#include <stdio.h>
#include <math.h>
static double ncdf(double x0) {
  double sg = 1.0;
  if (x0 < 0.0) sg = 0.0 - 1.0;
  double x = fabs(x0) / sqrt(2.0);
  double t = 1.0 / (1.0 + 0.3275911 * x);
  double y = 1.0 - (((((1.061405429 * t + (0.0 - 1.453152027)) * t) + 1.421413741) * t + (0.0 - 0.284496736)) * t + 0.254829592) * t * exp(0.0 - x * x);
  return 0.5 * (1.0 + sg * y);
}
static double npdf(double x) { return exp(0.0 - 0.5 * x * x) / sqrt(2.0 * 3.141592653589793); }
static void emit(long long v, int first) { if (first) printf("%lld", v); else printf(",%lld", v); }
int main(void) {
  double S = 100.0, K = 100.0, T = 1.0, r = 0.045, sigma = 0.21, q = 0.0; int is_call = 1;
  double sq = sqrt(T);
  double d1 = (log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / (sigma * sq);
  double d2 = d1 - sigma * sq;
  double nd1 = npdf(d1), Nd1 = ncdf(d1), Nd2 = ncdf(d2);
  double dc = exp(0.0 - r * T), dd = exp(0.0 - q * T);
  double price, delta, theta, rho, charm;
  if (is_call == 1) {
    price = S * dd * Nd1 - K * dc * Nd2;
    delta = dd * Nd1;
    theta = (0.0 - dd * S * nd1 * sigma / (2.0 * sq) + q * S * dd * Nd1 - r * K * dc * Nd2) / 365.0;
    rho = K * T * dc * Nd2 / 100.0;
    charm = 0.0 - q * dd * Nd1 + dd * nd1 * (2.0 * (r - q) * T - d2 * sigma * sq) / (2.0 * T * sigma * sq);
  } else {
    price = K * dc * ncdf(0.0 - d2) - S * dd * ncdf(0.0 - d1);
    delta = dd * (Nd1 - 1.0);
    theta = (0.0 - dd * S * nd1 * sigma / (2.0 * sq) - q * S * dd * ncdf(0.0 - d1) + r * K * dc * ncdf(0.0 - d2)) / 365.0;
    rho = (0.0 - K * T * dc * ncdf(0.0 - d2)) / 100.0;
    charm = q * dd * ncdf(0.0 - d1) + dd * nd1 * (2.0 * (r - q) * T - d2 * sigma * sq) / (2.0 * T * sigma * sq);
  }
  double gamma = dd * nd1 / (S * sigma * sq);
  double vega = S * dd * nd1 * sq / 100.0;
  double vanna = (0.0 - dd * nd1 * d2) / sigma;
  double vomma = S * dd * sq * nd1 * d1 * d2 / sigma;
  double speed = (0.0 - gamma * (d1 / (sigma * sq) + 1.0)) / S;
  double zomma = gamma * (d1 * d2 - 1.0) / sigma;
  double color = (0.0 - gamma / (2.0 * T)) * (2.0 * q * T + 1.0 + 2.0 * d1 * (r - q) * sq / sigma - d1 * d2);
  double vr = S * dd * nd1 * sq;
  double ultima = (0.0 - vr / (sigma * sigma)) * (d1 * d2 * (1.0 - d1 * d2) + d1 * d1 + d2 * d2);
  double veta = (0.0 - vr) * (q + d1 * (r - q) / (sigma * sq) - (1.0 + d1 * d2) / (2.0 * T));
  emit((long long)llround(price * 1e12), 1); emit((long long)llround(delta * 1e12), 0);
  emit((long long)llround(gamma * 1e12), 0); emit((long long)llround(theta * 1e12), 0);
  emit((long long)llround(vega * 1e12), 0); emit((long long)llround(rho * 1e12), 0);
  emit((long long)llround(vanna * 1e12), 0); emit((long long)llround(charm * 1e12), 0);
  emit((long long)llround(vomma * 1e12), 0); emit((long long)llround(speed * 1e12), 0);
  emit((long long)llround(zomma * 1e12), 0); emit((long long)llround(color * 1e12), 0);
  emit((long long)llround(ultima * 1e12), 0); emit((long long)llround(veta * 1e12), 0);
  printf("\\n");
  return 0;
}
`;

const C_VOL_SURFACE_HESTON = `#include <stdio.h>
#include <math.h>
static double heston_iv_approx(double S, double K, double T, double r, double v0, double kappa, double theta, double xi, double rho) {
  double F = S * exp(r * T);
  double k = log(K / F);
  double varAvg = v0;
  if (kappa * T > 0.000001) varAvg = theta + (v0 - theta) * (1.0 - exp(0.0 - kappa * T)) / (kappa * T);
  double sigmaATM = sqrt(varAvg);
  double skew = rho * xi / (2.0 * sigmaATM) * (1.0 - exp(0.0 - kappa * T / 2.0)) / (kappa * T / 2.0 + 0.0000000001);
  double curvature = xi * xi / (12.0 * varAvg) * (1.0 - 0.5 * exp(0.0 - kappa * T));
  double iv = sigmaATM * (1.0 + skew * k + curvature * k * k);
  if (iv < 0.01) iv = 0.01;
  return iv;
}
static void probe(const char* label, double S, double K, double T, double r, double v0, double kappa, double theta, double xi, double rho) {
  double iv = heston_iv_approx(S, K, T, r, v0, kappa, theta, xi, rho);
  printf("%s%lld\\n", label, (long long)llround(iv * 1e12));
}
int main(void) {
  probe("K70_T025=", 100.0, 70.0, 0.25, 0.045, 0.05, 2.0, 0.04, 0.2, 0.1);
  probe("K100_T10=", 100.0, 100.0, 1.0, 0.045, 0.05, 2.0, 0.04, 0.2, 0.1);
  probe("K130_T20=", 100.0, 130.0, 2.0, 0.045, 0.05, 2.0, 0.04, 0.2, 0.1);
  probe("K85_T05=", 100.0, 85.0, 0.5, 0.045, 0.05, 2.0, 0.04, 0.2, 0.1);
  return 0;
}
`;

const C_BOND_PRICE = `#include <stdio.h>
#include <math.h>
static double bond_price(double face, double coupon_rate, long years, double yield_rate) {
  double price = 0.0, disc = 1.0; long t = 1;
  while (t <= years) {
    disc = disc * (1.0 + yield_rate);
    double coupon = face * coupon_rate;
    double cashflow = coupon;
    if (t == years) cashflow = coupon + face;
    price = price + cashflow / disc;
    t = t + 1;
  }
  return price;
}
static void show(double p) { printf("%lld\\n\\n", (long long)llround(p * 10000.0)); }
int main(void) {
  show(bond_price(100.0, 0.05, 3, 0.04));
  show(bond_price(100.0, 0.06, 5, 0.05));
  show(bond_price(1000.0, 0.03, 2, 0.02));
  show(bond_price(100.0, 0.0, 4, 0.05));
  return 0;
}
`;

const C_SWAP_RATE = `#include <stdio.h>
#include <math.h>
static void show(long long p) { printf("%lld\\n\\n", p); }
int main(void) {
  double z[5] = {0.020, 0.025, 0.030, 0.032, 0.035};
  double df[5];
  for (int t = 0; t < 5; t++) df[t] = exp(0.0 - z[t] * (double)(t + 1));
  double df5 = df[4];
  show((long long)llround(df5 * 1000000.0));
  double annuity = 0.0;
  for (int i = 0; i < 5; i++) annuity += df[i];
  show((long long)llround(annuity * 10000.0));
  double annuity_3y = 0.0;
  for (int j = 0; j < 3; j++) annuity_3y += df[j];
  double par_rate_3y = (1.0 - df[2]) / annuity_3y;
  show((long long)llround(par_rate_3y * 1000000.0));
  double par_rate_5y = (1.0 - df5) / annuity;
  show((long long)llround(par_rate_5y * 1000000.0));
  return 0;
}
`;

const C_IMPLIED_VOL = `#include <stdio.h>
#include <math.h>
static double norm_cdf(double x) {
  double ax = fabs(x);
  double t = 1.0 / (1.0 + 0.2316419 * ax);
  double poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  double pdf = exp(-(ax * ax) / 2.0) / sqrt(2.0 * 3.14159265358979);
  double upper = 1.0 - pdf * poly;
  if (x < 0.0) return 1.0 - upper;
  return upper;
}
static double norm_pdf(double x) { return exp(-(x * x) / 2.0) / sqrt(2.0 * 3.14159265358979); }
static double bs_call(double s, double k, double r, double t, double vol) {
  double sqt = vol * sqrt(t);
  double d1 = (log(s / k) + (r + 0.5 * vol * vol) * t) / sqt;
  double d2 = d1 - sqt;
  return s * norm_cdf(d1) - k * exp(-(r * t)) * norm_cdf(d2);
}
static double bs_vega(double s, double k, double r, double t, double vol) {
  double d1 = (log(s / k) + (r + 0.5 * vol * vol) * t) / (vol * sqrt(t));
  return s * norm_pdf(d1) * sqrt(t);
}
static double implied_vol(double price, double s, double k, double r, double t) {
  double vol = 0.5;
  for (int i = 0; i < 50; i++) {
    double diff = bs_call(s, k, r, t, vol) - price;
    double v = bs_vega(s, k, r, t, vol);
    vol = vol - diff / v;
  }
  return vol;
}
int main(void) {
  printf("%lld\\n\\n", (long long)llround(implied_vol(10.4506, 100.0, 100.0, 0.05, 1.0) * 10000.0));
  printf("%lld\\n\\n", (long long)llround(implied_vol(6.0401, 100.0, 110.0, 0.05, 1.0) * 10000.0));
  return 0;
}
`;

const C_FIB = `#include <stdio.h>
static long long fib(long long n) { if (n < 2) return n; return fib(n - 1) + fib(n - 2); }
int main(void) { printf("%lld\\n", fib(__N__)); return 0; }
`;

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

async function main() {
  console.log(`kernel_suite_bench: clang flags ${CLANG_FLAGS.join(' ')}, ${WARMUP_RUNS} warmup + median-of-${TIMED_RUNS}, spawn-cost subtracted\n`);

  const emptyBin = buildC('int main(void){return 0;}\n', 'empty');
  const spawnMs = medianRunMs(emptyBin);
  console.log(`spawn-cost baseline (empty main(), same clang flags): ${spawnMs.toFixed(3)}ms\n`);

  // KERNEL_SUITE_DATE override exists for reproducible selftest/CI-adjacent fixtures only; a real
  // nightly run takes the actual run date.
  const today = process.env.KERNEL_SUITE_DATE || new Date().toISOString().slice(0, 10);

  const rows = [];
  for (const k of KERNELS) {
    process.stdout.write(`building ${k.name}... `);
    const lumenBin = await buildLumenNative(k.lumenSrc(), k.name.replace(/[^a-z0-9]/gi, '_'));
    const cSrc = k.cSrc ? k.cSrc() : null;
    const cBin = cSrc ? buildC(cSrc, `${k.name.replace(/[^a-z0-9]/gi, '_')}-c`) : null;
    console.log('done');

    if (cSrc) {
      const lumenOut = runStdout(lumenBin);
      const cOut = runStdout(cBin);
      if (lumenOut !== cOut) {
        console.error(`  MISMATCH: lumen and C twin disagree for ${k.name}!`);
        console.error(`    lumen: ${JSON.stringify(lumenOut)}`);
        console.error(`    C:     ${JSON.stringify(cOut)}`);
        console.error('  Refusing to report a timing ratio for a kernel whose twins disagree.');
        continue;
      }
    }

    const lumenRaw = medianRunMs(lumenBin);
    const lumenMs = subtractSpawnCost(lumenRaw, spawnMs);
    const cRaw = cBin ? medianRunMs(cBin) : null;
    const cMs = cBin ? subtractSpawnCost(cRaw, spawnMs) : null;
    const ratio = cBin ? computeRatio(lumenMs, cMs) : null;
    const row = { date: today, kernel: k.name, lumenMs, cMs, ratio, flags: CLANG_FLAGS.join(' ') };
    rows.push(row);
    console.log(`  ${formatRow(row)}`);
  }

  console.log('\n' + renderTable(rows));

  const dashboard = fs.readFileSync(DASHBOARD_PATH, 'utf8');
  const updated = spliceAutoBlock(dashboard, 'kernel-suite', rows);
  fs.writeFileSync(DASHBOARD_PATH, updated);
  console.log(`\nAppended ${rows.length} row(s) to bench/DASHBOARD.md's AUTO:kernel-suite block.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`kernel_suite_bench: FAIL - ${e.message}`); process.exit(1); });
}
