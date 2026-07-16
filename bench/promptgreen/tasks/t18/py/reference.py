def horner(coeffs, x):
    result = coeffs[-1]
    for c in reversed(coeffs[:-1]):
        result = result * x + c
    return result


def main():
    c = [2.0, -3.0, 0.0, 1.0]

    v1 = horner(c, 2.0)
    print(round(v1 * 10000.0))

    v2 = horner(c, -2.0)
    print(round(v2 * 10000.0))

    v3 = horner(c, 0.0)
    print(round(v3 * 10000.0))


if __name__ == "__main__":
    main()
