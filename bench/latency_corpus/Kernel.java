// Kernel.java - hand-written Java twin of kernel.lm, line-by-line, same formula/operand order.
// Must print byte-identical stdout to the Lumen twin (G9 gate).
public class Kernel {
  static double normCdf(double x) {
    double ax = Math.abs(x);
    double t = 1.0 / (1.0 + 0.2316419 * ax);
    double poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    double pdf = Math.exp(-(ax * ax) / 2.0) / Math.sqrt(2.0 * 3.14159265358979);
    double upper = 1.0 - pdf * poly;
    if (x < 0.0) {
      return 1.0 - upper;
    }
    return upper;
  }

  static double bsCall(double s, double k, double r, double t, double vol) {
    double sqt = vol * Math.sqrt(t);
    double d1 = (Math.log(s / k) + (r + 0.5 * vol * vol) * t) / sqt;
    double d2 = d1 - sqt;
    return s * normCdf(d1) - k * Math.exp(-(r * t)) * normCdf(d2);
  }

  static void show(double p) {
    System.out.printf("%.0f%n", Math.round(p * 10000.0) * 1.0);
    System.out.print("\n");
  }

  public static void main(String[] args) {
    show(bsCall(100.0, 100.0, 0.05, 1.0, 0.2));
    show(bsCall(100.0, 110.0, 0.05, 1.0, 0.2));
    show(bsCall(100.0, 90.0, 0.05, 0.5, 0.3));
    show(bsCall(50.0, 50.0, 0.02, 2.0, 0.25));
  }
}
