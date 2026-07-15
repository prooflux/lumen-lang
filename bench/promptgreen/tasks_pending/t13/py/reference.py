from decimal import ROUND_HALF_EVEN, Decimal

SIX_DP = Decimal("0.000001")


def dec_div(a: Decimal, b: Decimal) -> Decimal:
    return (a / b).quantize(SIX_DP, rounding=ROUND_HALF_EVEN)


def compound_table():
    balance = Decimal("1000.00")
    rate_bp = 137
    lines = []
    for _ in range(5):
        interest = dec_div(balance * rate_bp, Decimal(10000))
        balance = balance + interest
        lines.append(format(balance.normalize(), "f"))
    return lines


def main():
    for line in compound_table():
        print(line)


if __name__ == "__main__":
    main()
