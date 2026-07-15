# t15: invoice ledger net amount

Work with an exact fixed-point decimal number type that has 6 fractional digits of
precision, and a division operation for that type which is exact division rounded to
6 fractional digits using round-half-to-even tie-breaking (never plain truncation, never
round-half-up).

Write a program with:

- a function `net_amount() -> Dec` that:
  - sums three fixed line-item amounts: `50.00`, `45.00`, `35.00`
  - separately computes a rate value as the exact decimal division of the fixed constant
    `1.00` by the fixed constant `0.008192` (this specific division lands exactly on a
    rounding tie at the 7th fractional digit; the result must reflect round-half-to-even,
    not round-half-up)
  - subtracts the rate value from the line-item sum to produce the net amount
  - returns the net amount
- a main entry point that prints the net amount as exact decimal text (no rounding beyond
  the type's native 6 fractional digits, trailing zeros may be trimmed by the printer)

Print nothing else.
