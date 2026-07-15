def interp(years, levels, q):
    for i in range(len(years) - 1):
        y0, y1 = years[i], years[i + 1]
        if q == y0:
            return levels[i]
        if y0 < q <= y1:
            l0, l1 = levels[i], levels[i + 1]
            frac = (q - y0) / (y1 - y0)
            return l0 + frac * (l1 - l0)
    return levels[0]


def main():
    years = [1.0, 2.0, 3.0, 5.0, 10.0]
    levels = [0.99, 0.97, 0.94, 0.90, 0.80]
    queries = [3.0, 4.0, 7.0]
    for q in queries:
        result = interp(years, levels, q)
        print(round(result * 1000000.0))


if __name__ == "__main__":
    main()
