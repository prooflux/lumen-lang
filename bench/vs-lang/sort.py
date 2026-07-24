# sort.py - Python twin of sort.c / sort.lm / sort.rs, same insertion-sort structure, same
# fixed N=1600, same deterministic fill and position-weighted checksum. Must print
# byte-identical stdout. Run via CPython (interpreted, no compile step): python3 sort.py

import math


def fill(n, a):
    for i in range(n):
        a[i] = float((i * 2654435761 + 17) % 100003)


def insertion_sort(n, a):
    for i in range(1, n):
        key = a[i]
        j = i - 1
        while j >= 0 and a[j] > key:
            a[j + 1] = a[j]
            j -= 1
        a[j + 1] = key


def checksum(n, a):
    total = 0.0
    for i in range(n):
        total += a[i] * float(i + 1)
    return total


def main():
    n = 1600
    a = [0.0] * n
    fill(n, a)
    insertion_sort(n, a)
    print(f"{math.floor(checksum(n, a) + 0.5):.0f}")


if __name__ == "__main__":
    main()
