from decimal import Decimal


def fmt(d):
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0")
        if s.endswith("."):
            s += "0"
    else:
        s += ".0"
    return s


def print_shares(amount, n):
    cents = round(float(Decimal(amount)) * 100.0)
    cents = int(cents)
    base = cents // n
    rem = cents % n
    for i in range(1, n + 1):
        share = base
        if i <= rem:
            share = base + 1
        print(fmt(Decimal(share) / Decimal(100)))


def main():
    print_shares("100.07", 3)
    print_shares("90.00", 3)


if __name__ == "__main__":
    main()
