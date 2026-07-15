from decimal import ROUND_HALF_EVEN, Decimal


def dec_div(a, b):
    a = Decimal(a)
    b = Decimal(b)
    return (a / b).quantize(Decimal("0.000001"), rounding=ROUND_HALF_EVEN)


def installment(principal, rate_bps, months):
    principal = Decimal(principal)
    repay = dec_div(principal, months)
    annual_rate = dec_div(rate_bps, 10000)
    monthly_rate = dec_div(annual_rate, 12)
    interest = principal * monthly_rate
    return repay + interest


def fmt(d):
    # trim trailing zeros but keep at least one fractional digit
    s = format(d, "f")
    if "." in s:
        s = s.rstrip("0")
        if s.endswith("."):
            s += "0"
    else:
        s += ".0"
    return s


def main():
    print(fmt(installment("12000.00", 600, 12)))
    print(fmt(installment("1000.00", 0, 3)))


if __name__ == "__main__":
    main()
