# matmul.py - Python twin of matmul.c / matmul.lm / matmul.rs, same structure, same fixed
# N=38, same deterministic fill formulas and checksum. Must print byte-identical stdout.
# Uses a flat Python list (not a nested list) to mirror the other twins' flat array layout.
# Run via CPython (interpreted, no compile step): python3 matmul.py


def idx(n, i, j):
    return i * n + j


def fill(n, arr, is_a):
    for i in range(n):
        for j in range(n):
            if is_a:
                arr[idx(n, i, j)] = float((i * 7 + j * 3) % 13)
            else:
                arr[idx(n, i, j)] = float((i * 5 + j * 11) % 17)


def matmul(n, a, b, c):
    for i in range(n):
        for j in range(n):
            total = 0.0
            for k in range(n):
                total += a[idx(n, i, k)] * b[idx(n, k, j)]
            c[idx(n, i, j)] = total


def checksum(n, c):
    total = 0.0
    for i in range(n * n):
        total += c[i]
    return total


def main():
    n = 38
    a = [0.0] * (n * n)
    b = [0.0] * (n * n)
    c = [0.0] * (n * n)
    fill(n, a, True)
    fill(n, b, False)
    matmul(n, a, b, c)
    # round-half-away-from-zero to match C's round() (Python's round() is banker's rounding,
    # but both twins' checksum values land far from a .5 boundary in practice; match C's libm
    # round() semantics explicitly so this is correct even at a tie).
    import math

    print(f"{math.floor(checksum(n, c) + 0.5):.0f}")


if __name__ == "__main__":
    main()
