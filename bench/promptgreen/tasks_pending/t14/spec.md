# t14: progressive tax brackets

Write a program that computes progressive-tax amounts for a fixed income
using exact decimal arithmetic (never floating point), and prints the tax
owed per bracket followed by the total tax, one exact decimal value per line.

Rules:

- Income is an exact decimal constant: `10000.00`.
- There are exactly 3 brackets, applied progressively (each rate applies
  only to the slice of income that falls within that bracket, not to the
  whole income):
  - Bracket 1: the portion of income from `0` up to `10000` (inclusive of
    `10000`), taxed at `10%`.
  - Bracket 2: the portion of income above `10000` up to `30000`, taxed at
    `20%`.
  - Bracket 3: the portion of income above `30000`, taxed at `30%`.
- A bracket with zero taxable income in it owes exactly `0` tax for that
  bracket (it must still be printed).
- Compute each bracket's tax as `taxable_slice * rate / 100`, using exact
  decimal arithmetic.
- Print, in order, one line each for: bracket 1 tax, bracket 2 tax,
  bracket 3 tax, then the total tax (sum of all three), as exact decimal
  text (minimal representation, at least one fractional digit).
- Print nothing else.
- The income in this task sits exactly on the boundary between bracket 1
  and bracket 2 (`10000.00`), so a correct implementation must treat that
  boundary income as fully taxed at the bracket-1 rate, leaving bracket 2
  and bracket 3 at exactly `0`. An implementation that puts any of the
  boundary income into bracket 2 will produce the wrong numbers.

Expected output (4 lines):

```
1000.0
0.0
0.0
1000.0
```
