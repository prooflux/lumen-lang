def call_price() -> float:
    s = 100.0
    k = 100.0
    u = 1.1
    d = 0.9
    r_growth = 1.05

    q = (r_growth - d) / (u - d)
    qc = 1.0 - q

    s3 = s * (u**3.0)
    s2 = s * (u**2.0) * d
    s1 = s * u * (d**2.0)
    s0 = s * (d**3.0)

    payoff3 = max(s3 - k, 0.0)
    payoff2 = max(s2 - k, 0.0)
    payoff1 = max(s1 - k, 0.0)
    payoff0 = max(s0 - k, 0.0)

    prob3 = q**3.0
    prob2 = 3.0 * (q**2.0) * qc
    prob1 = 3.0 * q * (qc**2.0)
    prob0 = qc**3.0

    expected = prob3 * payoff3 + prob2 * payoff2 + prob1 * payoff1 + prob0 * payoff0
    discount = r_growth**3.0

    return expected / discount


def main():
    scaled = call_price() * 10000.0
    print(round(scaled))


if __name__ == "__main__":
    main()
