MOD = 1000000007


def fib_mod(n, m):
    a = 0
    b = 1
    i = 2
    while i <= n:
        nxt = (a + b) % m
        a = b
        b = nxt
        i = i + 1
    if n == 0:
        return a
    else:
        return b


def main():
    print(fib_mod(90, MOD))


if __name__ == "__main__":
    main()
