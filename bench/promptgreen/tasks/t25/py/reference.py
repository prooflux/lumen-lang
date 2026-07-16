def digit_sum(n):
    s = 0
    x = n
    while x > 0:
        d = x - (x // 10) * 10
        s = s + d
        x = x // 10
    return s


def report(n):
    x = n
    iters = 0
    while x >= 10:
        x = digit_sum(x)
        iters = iters + 1
    print(x)
    print(iters)


def main():
    report(9875)
    report(7)
    report(0)


if __name__ == "__main__":
    main()
