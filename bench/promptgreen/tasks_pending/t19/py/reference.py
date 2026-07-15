def max_drawdown(prices, n):
    peak = prices[0]
    maxdd = 0.0
    i = 0
    while i < n:
        p = prices[i]
        if p > peak:
            peak = p
        dd = (peak - p) / peak
        if dd > maxdd:
            maxdd = dd
        i = i + 1
    return maxdd


def main():
    a = [100.0, 105.0, 102.0, 110.0, 90.0, 95.0, 80.0, 85.0, 88.0, 120.0, 118.0, 130.0]
    print(round(max_drawdown(a, 12) * 1000000.0))

    b = [
        100.0,
        101.0,
        102.0,
        103.0,
        104.0,
        105.0,
        106.0,
        107.0,
        108.0,
        109.0,
        110.0,
        111.0,
    ]
    print(round(max_drawdown(b, 12) * 1000000.0))


if __name__ == "__main__":
    main()
