import math


def dot(u, v, n):
    total = 0.0
    i = 0
    while i < n:
        total = total + u[i] * v[i]
        i = i + 1
    return total


def norm(u, n):
    total = 0.0
    i = 0
    while i < n:
        x = u[i]
        total = total + x * x
        i = i + 1
    return math.sqrt(total)


def main():
    u = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]
    v = [8.0, 7.0, 6.0, 5.0, 4.0, 3.0, 2.0, 1.0]
    print(round(dot(u, v, 8) * 10000.0))
    print(round(norm(u, 8) * 10000.0))

    w = [1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0, 0.0]
    x = [0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0]
    print(round(dot(w, x, 8) * 10000.0))


if __name__ == "__main__":
    main()
