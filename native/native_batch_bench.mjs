import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAndRunFn } from './pipeline.mjs';

const FLAGS = ['-ffp-contract=fast', '-fno-fast-math', '-O3'];
const N = 2000000;

// Increase array heap capacity for the test run by injecting it
export const bsBatchLumen = `
fn norm_cdf(x: Float) -> Float {
  if x < 0.0 {
    return 1.0 - norm_cdf(-x)
  }
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
  let n = ${N}
  let vols = array(n)
  let prices = array(n)
  
  var i = 0
  while i < n {
    let vol = 0.2 + to_float(i) * 0.00000001
    aset(vols, i, vol)
    i = i + 1
  }
  
  var j = 0
  while j < n {
    let price = bs_call(100.0, 100.0, 0.05, 1.0, aget(vols, j))
    aset(prices, j, price)
    j = j + 1
  }
  
  var k = 0
  var acc = 0.0
  while k < n {
    acc = acc + aget(prices, k)
    k = k + 1
  }
  c.print_int(round(acc * 100.0))
}
`;

const handCBatch = `#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>
#include <string.h>

static double norm_cdf(double x){
  if(x<0.0) return 1.0-norm_cdf(-x);
  double k=1.0/(1.0+0.2316419*x);
  double poly=k*(0.319381530+k*(-0.356563782+k*(1.781477937+k*(-1.821255978+k*1.330274429))));
  double pdf=(1.0/sqrt(2.0*3.14159265358979))*exp(-(x*x)/2.0);
  return 1.0-pdf*poly;
}

static double bs_call(double s,double k,double r,double t,double vol){
  double d1=(log(s/k)+(r+vol*vol/2.0)*t)/(vol*sqrt(t));
  double d2=d1-vol*sqrt(t);
  return s*norm_cdf(d1)-k*exp(-r*t)*norm_cdf(d2);
}

int main(void){
  int n = ${N};
  double* vols = malloc(n * sizeof(double));
  double* prices = malloc(n * sizeof(double));
  if (!vols || !prices) return 1;
  
  for(int i=0; i<n; i++){
    vols[i] = 0.2 + (double)i * 0.00000001;
  }
  
  for(int i=0; i<n; i++){
    prices[i] = bs_call(100.0, 100.0, 0.05, 1.0, vols[i]);
  }
  
  double acc = 0.0;
  for(int i=0; i<n; i++){
    acc += prices[i];
  }
  printf("%lld\\n", (long long)llround(acc*100.0));
  
  free(vols);
  free(prices);
  return 0;
}
`;

const handC_NEON_Batch = `#include <stdio.h>
#include <stdlib.h>
#include <math.h>
#include <stdint.h>
#include <string.h>
#include <arm_neon.h>

static double l2d(int64_t b){double d; memcpy(&d,&b,8); return d;}
static int64_t d2l(double d){int64_t b; memcpy(&b,&d,8); return b;}
static int64_t f2i_sat(double x){if(isnan(x))return 0; if(x>=9223372036854775808.0)return INT64_MAX; if(x< -9223372036854775808.0)return INT64_MIN; return (int64_t)x;}

static double f_exp(double x){int64_t k=f2i_sat(rint(x*1.44269504088896340736)); double C1=6.93147180559945286227e-01; double C2=2.31904681384629955842e-17; double r=(x-(double)k*C1)-(double)k*C2; double sum=2.51100376059637769300e-08; sum=sum*r+2.76326396390410286239e-07; sum=sum*r+2.75572409185789696473e-06; sum=sum*r+2.48014854823284938896e-05; sum=sum*r+1.98412698900471130793e-04; sum=sum*r+1.38888889523147750563e-03; sum=sum*r+8.33333333331960114665e-03; sum=sum*r+4.16666666664880988580e-02; sum=sum*r+1.66666666666666796193e-01; sum=sum*r+5.00000000000001887379e-01; sum=sum*r+1.00000000000000000000e+00; sum=sum*r+1.00000000000000000000e+00; return sum*l2d((int64_t)(((uint64_t)(k+1023))<<52));}
static double f_ln(double x){if(x<=0.0)return 0.0; int64_t bits=d2l(x); int64_t e=(int64_t)(((uint64_t)bits>>52)&0x7FF)-1023; double m=l2d((bits&0xFFFFFFFFFFFFFLL)|((int64_t)1023<<52)); if(m>1.4142135623730951){m=m*0.5; e=e+1;} double s=(m-1.0)/(m+1.0); double w=s*s; double sum=1.48097103606552760180e-01; sum=sum*w+1.53125281483641906277e-01; sum=sum*w+1.81836316802293285200e-01; sum=sum*w+2.22221970567260479479e-01; sum=sum*w+2.85714287606416816878e-01; sum=sum*w+3.99999999993023380718e-01; sum=sum*w+6.66666666666667651064e-01; sum=sum*w+2.00000000000000000000e+00; double LN2_C1=6.93147180559945286227e-01; double LN2_C2=2.31904681384629955842e-17; return (double)e*LN2_C1+((double)e*LN2_C2+s*sum);}

static double norm_cdf(double p0){
  double a = fabs(p0);
  double k = 1.0 / (1.0 + 0.2316419 * a);
  double poly = k * (0.319381530 + k * (-0.356563782 + k * (1.781477937 + k * (-1.821255978 + k * 1.330274429))));
  double pdf = 0.3989422804014327 * exp(-0.5 * a * a);
  return p0 < 0.0 ? (pdf * poly) : (1.0 - pdf * poly);
}

static inline float64x2_t neon_exp(float64x2_t x) {
  float64x2_t inv_ln2 = vdupq_n_f64(1.44269504088896340736);
  float64x2_t x_inv_ln2 = vmulq_f64(x, inv_ln2);
  float64x2_t k_f = vrndnq_f64(x_inv_ln2);
  float64x2_t C1 = vdupq_n_f64(6.93147180559945286227e-01);
  float64x2_t C2 = vdupq_n_f64(2.31904681384629955842e-17);
  float64x2_t r = vsubq_f64(x, vmulq_f64(k_f, C1));
  r = vsubq_f64(r, vmulq_f64(k_f, C2));
  float64x2_t sum = vdupq_n_f64(2.51100376059637769300e-08);
  sum = vfmaq_f64(vdupq_n_f64(2.76326396390410286239e-07), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(2.75572409185789696473e-06), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(2.48014854823284938896e-05), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(1.98412698900471130793e-04), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(1.38888889523147750563e-03), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(8.33333333331960114665e-03), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(4.16666666664880988580e-02), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(1.66666666666666796193e-01), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(5.00000000000001887379e-01), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(1.00000000000000000000e+00), sum, r);
  sum = vfmaq_f64(vdupq_n_f64(1.00000000000000000000e+00), sum, r);
  int64x2_t k_i = vcvtq_s64_f64(k_f);
  int64x2_t exp_bits = vaddq_s64(k_i, vdupq_n_s64(1023));
  int64x2_t factor_bits = vshlq_n_s64(exp_bits, 52);
  float64x2_t factor = vreinterpretq_f64_s64(factor_bits);
  return vmulq_f64(sum, factor);
}

static inline float64x2_t neon_norm_cdf(float64x2_t x) {
  float64x2_t a = vabsq_f64(x);
  float64x2_t k = vdivq_f64(vdupq_n_f64(1.0), vfmaq_f64(vdupq_n_f64(1.0), vdupq_n_f64(0.2316419), a));
  float64x2_t poly = vdupq_n_f64(1.330274429);
  poly = vfmaq_f64(vdupq_n_f64(-1.821255978), k, poly);
  poly = vfmaq_f64(vdupq_n_f64(1.781477937), k, poly);
  poly = vfmaq_f64(vdupq_n_f64(-0.356563782), k, poly);
  poly = vfmaq_f64(vdupq_n_f64(0.319381530), k, poly);
  poly = vmulq_f64(k, poly);
  
  float64x2_t minus_half_a2 = vmulq_f64(vdupq_n_f64(-0.5), vmulq_f64(a, a));
  float64x2_t pdf = vmulq_f64(vdupq_n_f64(0.3989422804014327), neon_exp(minus_half_a2));
  float64x2_t val = vfmaq_f64(vdupq_n_f64(0.5), vnegq_f64(pdf), poly);
  
  uint64x2_t mask = vcltq_f64(x, vdupq_n_f64(0.0));
  float64x2_t signed_val = vbslq_f64(mask, vnegq_f64(val), val);
  return vaddq_f64(vdupq_n_f64(0.5), signed_val);
}

static inline float64x2_t neon_ln(float64x2_t x) {
  int64x2_t bits = vreinterpretq_s64_f64(x);
  int64x2_t e_i = vsubq_s64(vandq_s64(vshrq_n_s64(bits, 52), vdupq_n_s64(0x7FF)), vdupq_n_s64(1023));
  int64x2_t m_bits = vorrq_s64(vandq_s64(bits, vdupq_n_s64(0xFFFFFFFFFFFFFLL)), vdupq_n_s64(1023LL << 52));
  float64x2_t m = vreinterpretq_f64_s64(m_bits);
  uint64x2_t mask = vcgtq_f64(m, vdupq_n_f64(1.4142135623730951));
  m = vbslq_f64(mask, vmulq_f64(m, vdupq_n_f64(0.5)), m);
  e_i = vsubq_s64(e_i, vreinterpretq_s64_u64(mask));
  float64x2_t s = vdivq_f64(vsubq_f64(m, vdupq_n_f64(1.0)), vaddq_f64(m, vdupq_n_f64(1.0)));
  float64x2_t w = vmulq_f64(s, s);
  float64x2_t sum = vdupq_n_f64(1.48097103606552760180e-01);
  sum = vfmaq_f64(vdupq_n_f64(1.53125281483641906277e-01), sum, w);
  sum = vfmaq_f64(vdupq_n_f64(1.81836316802293285200e-01), sum, w);
  sum = vfmaq_f64(vdupq_n_f64(2.22221970567260479479e-01), sum, w);
  sum = vfmaq_f64(vdupq_n_f64(2.85714287606416816878e-01), sum, w);
  sum = vfmaq_f64(vdupq_n_f64(3.99999999993023380718e-01), sum, w);
  sum = vfmaq_f64(vdupq_n_f64(6.66666666666667651064e-01), sum, w);
  sum = vfmaq_f64(vdupq_n_f64(2.00000000000000000000e+00), sum, w);
  float64x2_t e_f = vcvtq_f64_s64(e_i);
  float64x2_t LN2_C1 = vdupq_n_f64(6.93147180559945286227e-01);
  float64x2_t LN2_C2 = vdupq_n_f64(2.31904681384629955842e-17);
  float64x2_t temp = vfmaq_f64(vmulq_f64(e_f, LN2_C2), s, sum);
  return vfmaq_f64(temp, e_f, LN2_C1);
}

static void bs_call_neon2(double *prices, const double *vols, int n) {
  float64x2_t s = vdupq_n_f64(100.0);
  float64x2_t k = vdupq_n_f64(100.0);
  float64x2_t r = vdupq_n_f64(0.05);
  float64x2_t t = vdupq_n_f64(1.0);
  float64x2_t half = vdupq_n_f64(0.5);
  float64x2_t log_s_k = neon_ln(vdivq_f64(s, k));
  float64x2_t sqrt_t = vsqrtq_f64(t);
  
  float64x2_t exp_rt = neon_exp(vmulq_f64(vdupq_n_f64(-0.05), t));
  double exp_rt_val = vgetq_lane_f64(exp_rt, 0);
  float64x2_t k_exp_rt = vdupq_n_f64(100.0 * exp_rt_val);
  
  for (int i = 0; i < n; i += 2) {
    float64x2_t vol = vld1q_f64(&vols[i]);
    float64x2_t vol_sqrt_t = vmulq_f64(vol, sqrt_t);
    float64x2_t vol2 = vmulq_f64(vol, vol);
    float64x2_t r_half_vol2 = vfmaq_f64(r, half, vol2);
    float64x2_t num = vfmaq_f64(log_s_k, r_half_vol2, t);
    float64x2_t d1 = vdivq_f64(num, vol_sqrt_t);
    float64x2_t d2 = vsubq_f64(d1, vol_sqrt_t);
    
    float64x2_t n1 = neon_norm_cdf(d1);
    float64x2_t n2 = neon_norm_cdf(d2);
    
    float64x2_t p = vfmaq_f64(vmulq_f64(s, n1), vnegq_f64(k_exp_rt), n2);
    p = vmaxq_f64(p, vdupq_n_f64(0.0));
    
    vst1q_f64(&prices[i], p);
  }
}

int main(void){
  int n = ${N};
  double* vols = malloc(n * sizeof(double));
  double* prices = malloc(n * sizeof(double));
  if (!vols || !prices) return 1;
  
  for(int i=0; i<n; i++){
    vols[i] = 0.2 + (double)i * 0.00000001;
  }
  
  bs_call_neon2(prices, vols, n);
  
  double acc = 0.0;
  for(int i=0; i<n; i++){
    acc += prices[i];
  }
  printf("%lld\\n", (long long)llround(acc*100.0));
  
  free(vols);
  free(prices);
  return 0;
}
`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-bs-batch-'));
const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timeRun = (bin) => { 
  const t = process.hrtime.bigint(); 
  execFileSync(bin, { encoding: 'utf8' }); 
  return Number(process.hrtime.bigint() - t) / 1e6; 
};

// Spawn overhead
fs.writeFileSync(path.join(dir, 'noop.c'), 'int main(void){return 0;}\n');
execFileSync('clang', ['-O3', '-o', path.join(dir, 'noop'), path.join(dir, 'noop.c')]);
const spawn = median(Array.from({ length: 7 }, () => timeRun(path.join(dir, 'noop'))));

async function run() {
  console.log("Compiling Lumen batch pricer...");
  const nat = await buildAndRunFn(bsBatchLumen, '-O3');
  
  // Replace heap size to 1<<24 inside emitted C code
  let csrc = nat.csrc.replace("#define AHEAP_CAP (1<<20)", "#define AHEAP_CAP (1<<24)");
  
  const natCFile = path.join(dir, 'nat.c');
  const natBin = path.join(dir, 'nat');
  fs.writeFileSync(natCFile, csrc);
  execFileSync('clang', [...FLAGS, '-o', natBin, natCFile]);
  
  console.log("Compiling C batch reference...");
  const cFile = path.join(dir, 'c_ref.c');
  const cBin = path.join(dir, 'c_ref');
  fs.writeFileSync(cFile, handCBatch);
  execFileSync('clang', [...FLAGS, '-o', cBin, cFile]);
  
  console.log("Compiling C NEON batch pricer...");
  const neonCFile = path.join(dir, 'c_neon.c');
  const neonBin = path.join(dir, 'c_neon');
  fs.writeFileSync(neonCFile, handC_NEON_Batch);
  execFileSync('clang', [...FLAGS, '-o', neonBin, neonCFile]);
  
  // Measure runs
  console.log("Running benchmarks...");
  const rate = (bin) => N / (Math.max(0.001, median(Array.from({ length: 5 }, () => timeRun(bin))) - spawn) / 1000);
  
  const natRate = rate(natBin);
  const cRate = rate(cBin);
  const neonRate = rate(neonBin);
  
  const M = (r) => (r / 1e6).toFixed(1) + 'M prices/sec';
  
  console.log(`\n=================== BATCH BENCHMARK REPORT ===================`);
  console.log(`Batch Size: ${N.toLocaleString()}`);
  console.log(`Lumen Batch Native  : ${M(natRate)}`);
  console.log(`Honest C Batch      : ${M(cRate)} (Lumen = ${(natRate / cRate * 100).toFixed(0)}% of C)`);
  console.log(`C NEON SIMD Batch   : ${M(neonRate)} (NEON = ${(neonRate / cRate * 100).toFixed(0)}% of C, ${(neonRate / natRate * 100).toFixed(0)}% of Lumen)`);
  console.log(`Lumen Output        : ${execFileSync(natBin, { encoding: 'utf8' }).trim()}`);
  console.log(`C Reference Output  : ${execFileSync(cBin, { encoding: 'utf8' }).trim()}`);
  console.log(`C NEON Output       : ${execFileSync(neonBin, { encoding: 'utf8' }).trim()}`);
  console.log(`==============================================================\n`);
  
  fs.rmSync(dir, { recursive: true, force: true });
}

const isMain = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }   // argv[1] may not be a real file (node -, stdin scripts); an importer must never crash here
})();
if (isMain) {
  run().catch(console.error);
}

