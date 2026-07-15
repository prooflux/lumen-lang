from decimal import ROUND_HALF_EVEN, Decimal, getcontext


def dec_div(a: Decimal, b: Decimal) -> Decimal:
    # exact division rounded to 6 fractional digits, round-half-to-even
    getcontext().prec = 50
    q = a / b
    return q.quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN)


def net_amount() -> Decimal:
    total = Decimal("50.00") + Decimal("45.00") + Decimal("35.00")
    rate = dec_div(Decimal("1.00"), Decimal("0.008192"))
    return total - rate


def main():
    net = net_amount()
    # trim trailing zeros like the reference printer, keep at least one digit
    text = format(net.normalize(), "f")
    if "." not in text:
        text += ".0"
    print(text)


if __name__ == "__main__":
    main()
