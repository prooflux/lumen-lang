def f(x, target):
    return x * x * x + x - target


def bisect(lo, hi, target):
    a, b = lo, hi
    for _ in range(100):
        mid = (a + b) / 2.0
        if f(mid, target) < 0.0:
            a = mid
        else:
            b = mid
    return (a + b) / 2.0


def main():
    r1 = bisect(0.0, 5.0, 30.0)
    print(round(r1 * 1000000.0))
    r2 = bisect(-5.0, 5.0, 0.0)
    print(round(r2 * 1000000.0))
    r3 = bisect(0.0, 2.0, 2.0)
    print(round(r3 * 1000000.0))


if __name__ == "__main__":
    main()
