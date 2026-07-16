from decimal import ROUND_HALF_EVEN, Decimal

SIX_DP = Decimal("0.000001")


def dec_div(a: Decimal, b: Decimal) -> Decimal:
    return (a / b).quantize(SIX_DP, rounding=ROUND_HALF_EVEN)


def progressive_tax():
    income = Decimal("10000.00")
    b1_top = Decimal(10000)
    b2_top = Decimal(30000)

    b1 = income if income <= b1_top else b1_top

    b2 = income - b1_top
    if b2 < 0:
        b2 = Decimal(0)
    b2_span = b2_top - b1_top
    if b2 > b2_span:
        b2 = b2_span

    b3 = income - b2_top
    if b3 < 0:
        b3 = Decimal(0)

    tax1 = dec_div(b1 * 10, Decimal(100))
    tax2 = dec_div(b2 * 20, Decimal(100))
    tax3 = dec_div(b3 * 30, Decimal(100))
    total = tax1 + tax2 + tax3

    return [trim_dec_text(v) for v in (tax1, tax2, tax3, total)]


def trim_dec_text(v: Decimal) -> str:
    # Match the target's decimal-text rule: minimal exact representation,
    # trailing zeros trimmed but at least one fractional digit kept.
    text = format(v, "f")
    if "." not in text:
        text = text + ".0"
    else:
        text = text.rstrip("0")
        if text.endswith("."):
            text = text + "0"
    return text


def main():
    for line in progressive_tax():
        print(line)


if __name__ == "__main__":
    main()
