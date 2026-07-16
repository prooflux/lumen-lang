def main():
    cf = [-1000.0, 300.0, 400.0, 500.0]

    def npv(r):
        total = 0.0
        for t, c in enumerate(cf):
            total += c / (1.0 + r) ** t
        return total

    lo = -0.5
    hi = 1.0

    for _ in range(60):
        mid = (lo + hi) / 2.0
        if npv(lo) * npv(mid) <= 0.0:
            hi = mid
        else:
            lo = mid

    r = (lo + hi) / 2.0
    print(round(r * 1000000.0))


if __name__ == "__main__":
    main()
