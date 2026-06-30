// native_float_test.mjs - gate + speed for emit_fn.lm v3 (float ops 29-48, array ops 49-52).
// Diff: every float/array/record program is byte-identical across golden == interpreter == native
// (floats match by the SHARED truncated f_exp/f_ln/f_pow series, NOT libm). Speed: a looped
// Black-Scholes pricer, native (emit_fn.lm) vs hand-written C, two honest baselines:
//   (1) hand-C with libm exp/log  -> the "beats real C" headline (caveat: native runs a truncated series)
//   (2) hand-C with the SAME truncated series -> apples-to-apples, proves the per-function lowering matches C.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createCompiler } from '../seed/compiler_core.mjs';
import { buildAndRunFn } from './pipeline.mjs';

const FLAGS = ['-ffp-contract=off', '-fno-fast-math', '-O3'];
const lumen = await createCompiler();
const corpus = JSON.parse(fs.readFileSync(new URL('./float_corpus.json', import.meta.url), 'utf8'));

// ---- 1. diff gate: golden == interpreter == native, byte-for-byte ----
console.log('== diff: v3 float/array/record vs interpreter oracle (byte-for-byte) ==');
let pass = 0, fail = 0;
for (const t of corpus) {
  const ref = lumen.run(t.source).stdout;
  let cand;
  try { cand = (await buildAndRunFn(t.source, '-O3')).stdout; }
  catch (e) { console.log(`FAIL  ${t.name}: ${e.message.slice(0, 110)}`); fail++; continue; }
  const ok = cand === ref && ref === t.goldenStdout;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${t.name.padEnd(28)} native=${JSON.stringify(cand)} ref=${JSON.stringify(ref)} gold=${JSON.stringify(t.goldenStdout)}`);
  if (ok) pass++; else fail++;
}
console.log(`${pass}/${corpus.length} float/array/record programs: golden==interpreter==native (fail ${fail})\n`);

// ---- 2. Black-Scholes bench: native vs hand-C ----
const N = 2000000;
// vol perturbed by i so clang cannot hoist the pure call out of the loop; same pattern on both sides.
const bsLumen = `
fn norm_cdf(x: Float) -> Float {
  if x < 0.0 { return 1.0 - norm_cdf(-x) }
  let k: Float = 1.0 / (1.0 + 0.2316419 * x)
  let poly: Float = k * (0.319381530 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))))
  let pdf: Float = (1.0 / sqrt(2.0 * 3.14159265358979)) * exp(-(x * x) / 2.0)
  return 1.0 - pdf * poly
}
fn bs_call(s: Float, k: Float, r: Float, t: Float, vol: Float) -> Float {
  let d1: Float = (ln(s / k) + (r + vol * vol / 2.0) * t) / (vol * sqrt(t))
  let d2: Float = d1 - vol * sqrt(t)
  return s * norm_cdf(d1) - k * exp(-r * t) * norm_cdf(d2)
}
fn main(c: Console) -> Unit {
  var acc: Float = 0.0
  var i: Int = 0
  while i < ${N} {
    let vol: Float = 0.2 + to_float(i) * 0.00000001
    acc = acc + bs_call(100.0, 100.0, 0.05, 1.0, vol)
    i = i + 1
  }
  c.print_int(round(acc * 100.0))
}
`;
// hand-C, parameterised by the transcendental source (libm vs the transcribed series)
const handC = (exp, log) => `#include <stdio.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
${exp === 'f_exp' ? `
static double l2d(int64_t b){double d; memcpy(&d,&b,8); return d;}
static int64_t d2l(double d){int64_t b; memcpy(&b,&d,8); return b;}
static int64_t f2i_sat(double x){if(isnan(x))return 0; if(x>=9223372036854775808.0)return INT64_MAX; if(x< -9223372036854775808.0)return INT64_MIN; return (int64_t)x;}
static double f_exp(double x){int64_t k=f2i_sat(rint(x/0.6931471805599453)); double r=x-(double)k*0.6931471805599453; double sum=1.0,term=1.0; for(int i=1;i<=16;i++){term=term*r/(double)i; sum=sum+term;} return sum*l2d((int64_t)(((uint64_t)(k+1023))<<52));}
static double f_ln(double x){if(x<=0.0)return 0.0; int64_t bits=d2l(x); int64_t e=(int64_t)(((uint64_t)bits>>52)&0x7FF)-1023; double m=l2d((bits&0xFFFFFFFFFFFFFLL)|((int64_t)1023<<52)); if(m>1.4142135623730951){m=m*0.5; e=e+1;} double s=(m-1.0)/(m+1.0),s2=s*s,term=s,sum=s; for(int i=3;i<=31;i+=2){term=term*s2; sum=sum+term/(double)i;} return (double)e*0.6931471805599453+2.0*sum;}
` : ''}
static double norm_cdf(double x){
  if(x<0.0) return 1.0-norm_cdf(-x);
  double k=1.0/(1.0+0.2316419*x);
  double poly=k*(0.319381530+k*(-0.356563782+k*(1.781477937+k*(-1.821255978+k*1.330274429))));
  double pdf=(1.0/sqrt(2.0*3.14159265358979))*${exp}(-(x*x)/2.0);
  return 1.0-pdf*poly;
}
static double bs_call(double s,double k,double r,double t,double vol){
  double d1=(${log}(s/k)+(r+vol*vol/2.0)*t)/(vol*sqrt(t));
  double d2=d1-vol*sqrt(t);
  return s*norm_cdf(d1)-k*${exp}(-r*t)*norm_cdf(d2);
}
int main(void){
  double acc=0.0;
  for(long i=0;i<${N};i++){ double vol=0.2+(double)i*0.00000001; acc=acc+bs_call(100.0,100.0,0.05,1.0,vol); }
  printf("%lld\\n",(long long)f2i_round(acc*100.0));
  return 0;
}
`.replace('f2i_round', 'llround'); // round-half-away matches Lumen FROUND floor(x+0.5) for positive acc

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bs-'));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeRun = (bin) => { const t = process.hrtime.bigint(); execFileSync(bin, { encoding: 'utf8' }); return Number(process.hrtime.bigint() - t) / 1e6; };
fs.writeFileSync(path.join(dir, 'noop.c'), 'int main(void){return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'noop'), path.join(dir, 'noop.c')]);
const spawn = median(Array.from({ length: 7 }, () => timeRun(path.join(dir, 'noop'))));

function buildC(name, src) {
  fs.writeFileSync(path.join(dir, name + '.c'), src);
  execFileSync('clang', [...FLAGS, '-o', path.join(dir, name), path.join(dir, name + '.c')]);
  return path.join(dir, name);
}
const rate = (bin) => N / (Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(bin))) - spawn) / 1000);

// native: emit_fn.lm over the looped BS source
const nat = await buildAndRunFn(bsLumen, '-O3');
fs.writeFileSync(path.join(dir, 'nat.c'), nat.csrc);
execFileSync('clang', [...FLAGS, '-o', path.join(dir, 'nat'), path.join(dir, 'nat.c')]);
const natBin = path.join(dir, 'nat');
const cLibm = buildC('clibm', handC('exp', 'log'));
const cTrunc = buildC('ctrunc', handC('f_exp', 'f_ln'));

const natRate = rate(natBin), libmRate = rate(cLibm), truncRate = rate(cTrunc);
const M = (r) => (r / 1e6).toFixed(1) + 'M prices/sec';
console.log('== speed: Black-Scholes pricer, ' + N.toLocaleString() + ' evals (clang -O3 -ffp-contract=off -fno-fast-math) ==');
console.log(`  native (emit_fn.lm, truncated series): ${M(natRate)}`);
console.log(`  hand-C, libm exp/log                 : ${M(libmRate)}   (native = ${(natRate / libmRate * 100).toFixed(0)}% of it)`);
console.log(`  hand-C, SAME truncated series        : ${M(truncRate)}   (native = ${(natRate / truncRate * 100).toFixed(0)}% of it)`);
console.log(`  native BS output: ${JSON.stringify(execFileSync(natBin, { encoding: 'utf8' }))}  truncated-C: ${JSON.stringify(execFileSync(cTrunc, { encoding: 'utf8' }))}`);
console.log(natRate >= libmRate
  ? '\n>>> v3 float pricing BEATS hand-C-with-libm (caveat: truncated series, see SPEC_FLOAT.md §5) <<<'
  : `\n>>> v3 BS is ${(natRate / libmRate * 100).toFixed(0)}% of hand-C-with-libm <<<`);
console.log(natRate >= truncRate * 0.95
  ? '>>> and MATCHES hand-C at the identical algorithm (lowering is as fast as C) <<<'
  : `>>> apples-to-apples: ${(natRate / truncRate * 100).toFixed(0)}% of identical-algorithm C <<<`);

process.exit(fail === 0 ? 0 : 1);
