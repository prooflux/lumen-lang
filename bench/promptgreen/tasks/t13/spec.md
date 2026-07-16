# t13: compound interest table

Write a program that computes a compounding balance over 5 periods and prints
the balance after each period, one per line.

Rules:

- Start with an exact decimal principal of `1000.00`.
- The interest rate is given in basis points (1 basis point = 0.0001, i.e.
  1/100 of a percent) as a whole number: `137` (that is, 1.37% per period).
- Each period, compute the interest as `balance * rate_bp / 10000`, using
  exact decimal arithmetic (never floating point), and add it to the balance.
- After computing each period's new balance, print it as exact decimal text
  (trim to the minimal exact representation, at least one fractional digit,
  no unnecessary trailing zeros beyond that), then a newline.
- Repeat for exactly 5 periods, in order.
- Print nothing else (no headers, no extra lines).
- All arithmetic must be exact decimal arithmetic; a solution using
  floating-point arithmetic that merely approximates the result is not
  acceptable, because the expected output is pinned to the exact decimal
  values, including cases where a division does not terminate cleanly and a
  rounding rule (round-half-to-even, applied at 6 fractional digits) matters.

Expected output (5 lines):

```
1013.7
1027.58769
1041.665641
1055.93646
1070.40279
```
