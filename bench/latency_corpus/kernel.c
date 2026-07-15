/* kernel.c - hand-written C twin of kernel.lm, line-by-line, same formula/operand order.
 * Must print byte-identical stdout to the Lumen twin (G9 gate in compile_latency_bench.mjs):
 * "104506\n\n60401\n\n154860\n\n79020\n\n" (Lumen's print_int + print("\n") = 2 newlines/case). */
#include <stdio.h>
#include <math.h>

static double norm_cdf(double x) {
  double ax = fabs(x);
  double t = 1.0 / (1.0 + 0.2316419 * ax);
  double poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  double pdf = exp(-(ax * ax) / 2.0) / sqrt(2.0 * 3.14159265358979);
  double upper = 1.0 - pdf * poly;
  if (x < 0.0) {
    return 1.0 - upper;
  }
  return upper;
}

static double bs_call(double s, double k, double r, double t, double vol) {
  double sqt = vol * sqrt(t);
  double d1 = (log(s / k) + (r + 0.5 * vol * vol) * t) / sqt;
  double d2 = d1 - sqt;
  return s * norm_cdf(d1) - k * exp(-(r * t)) * norm_cdf(d2);
}

static void show(double p) {
  printf("%.0f\n", round(p * 10000.0));
  printf("\n");
}

int main(void) {
  show(bs_call(100.0, 100.0, 0.05, 1.0, 0.2));
  show(bs_call(100.0, 110.0, 0.05, 1.0, 0.2));
  show(bs_call(100.0, 90.0, 0.05, 0.5, 0.3));
  show(bs_call(50.0, 50.0, 0.02, 2.0, 0.25));
  return 0;
}
