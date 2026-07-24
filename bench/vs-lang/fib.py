# fib.py - Python twin of fib.c / fib.lm / fib.rs, same recursive structure.
# Must print byte-identical stdout to the other twins: "2178309\n".
# Run via CPython (interpreted, no compile step): python3 fib.py


def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)


def main():
    print(fib(32))


if __name__ == "__main__":
    main()
