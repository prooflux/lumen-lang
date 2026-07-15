# t11: flat monthly installment

Write a program with a function that computes a fixed monthly installment for
a loan, given:

- `principal`: an exact decimal amount
- `rate_bps`: the annual interest rate expressed in basis points (an integer;
  100 basis points = 1%)
- `months`: the number of months to repay over (an integer)

The installment is the sum of two parts, each computed with exact-decimal
division, rounded half-to-even to 6 fractional digits at every division step:

1. **Repayment portion**: `principal` divided evenly across `months`.
2. **Interest portion**: `principal` multiplied by the monthly rate, where the
   monthly rate is `rate_bps` divided by `10000`, then divided by `12`. This
   product is added on top of the repayment portion (a flat, non-declining
   interest charge, not compound amortization).

Print the installment as exact-decimal text, followed by a newline.

Edge case: when `rate_bps` is `0`, the interest portion is `0` and the
installment is exactly `principal` divided evenly across `months`.

Print nothing else.
