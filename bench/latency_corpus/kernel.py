"""kernel.py - hand-written Python twin of kernel.lm, line-by-line, same formula/operand order.
Must print byte-identical stdout to the Lumen twin (G9 gate)."""

import math


def norm_cdf(x):
    ax = abs(x)
    t = 1.0 / (1.0 + 0.2316419 * ax)
    poly = t * (
        0.319381530
        + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))
    )
    pdf = math.exp(-(ax * ax) / 2.0) / math.sqrt(2.0 * 3.14159265358979)
    upper = 1.0 - pdf * poly
    if x < 0.0:
        return 1.0 - upper
    return upper


def bs_call(s, k, r, t, vol):
    sqt = vol * math.sqrt(t)
    d1 = (math.log(s / k) + (r + 0.5 * vol * vol) * t) / sqt
    d2 = d1 - sqt
    return s * norm_cdf(d1) - k * math.exp(-(r * t)) * norm_cdf(d2)


def show(p):
    print("%.0f" % round(p * 10000.0))
    print()


def main():
    show(bs_call(100.0, 100.0, 0.05, 1.0, 0.2))
    show(bs_call(100.0, 110.0, 0.05, 1.0, 0.2))
    show(bs_call(100.0, 90.0, 0.05, 0.5, 0.3))
    show(bs_call(50.0, 50.0, 0.02, 2.0, 0.25))


if __name__ == "__main__":
    main()
