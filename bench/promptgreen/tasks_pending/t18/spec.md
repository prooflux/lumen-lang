# t18: Horner polynomial evaluation

Write a program that evaluates a cubic polynomial given by its coefficients,
using Horner's method, at three given points.

The coefficients are stored so that coefficient at position `i` (0-indexed)
is the coefficient of `x^i`. Use the coefficients `[2, -3, 0, 1]`, meaning the
polynomial is `p(x) = 1*x^3 + 0*x^2 - 3*x + 2`.

For each evaluation point, print `round(p(point) * 10000)` as an integer, one
line per point, in this order:

1. `point = 2`
2. `point = -2`
3. `point = 0`

Print exactly 3 lines, one integer per line, and nothing else.
