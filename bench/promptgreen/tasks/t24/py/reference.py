def main():
    start = 27
    n = start
    steps = 0
    peak = start

    while n != 1:
        if n % 2 == 0:
            n = n // 2
        else:
            n = 3 * n + 1
        steps += 1
        if n > peak:
            peak = n

    print(steps)
    print(peak)


if __name__ == "__main__":
    main()
