def main():
    data = [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0, 10.0, 3.0]

    n = 0
    mean = 0.0
    m2 = 0.0
    for x in data:
        n += 1
        delta = x - mean
        mean += delta / n
        delta2 = x - mean
        m2 += delta * delta2

    variance = m2 / n

    print(round(mean * 10000.0))
    print(round(variance * 10000.0))


if __name__ == "__main__":
    main()
