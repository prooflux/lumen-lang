# t17: bisection root finder

Write a program that finds a root of `x*x*x + x - target = 0` using bisection
search on a given bracket `[lo, hi]`, iterating a fixed number of times (at
least enough to reach 1e-6 precision on the bracket widths below), and prints
`round(root * 1000000)` as an integer, one line per case.

The function `x*x*x + x - target` is strictly increasing in `x`, so bisection
is well defined: at each step evaluate the function at the midpoint of the
current bracket; if it is negative, the root lies in the upper half (raise
the low end to the midpoint); otherwise the root lies in the lower half or is
the midpoint (lower the high end to the midpoint). After enough iterations,
return the midpoint of the final bracket as the root.

Print exactly 3 lines, one integer per line, for these three cases in order:

1. `target = 30`, bracket `[0, 5]`
2. `target = 0`, bracket `[-5, 5]`
3. `target = 2`, bracket `[0, 2]`

Print nothing else.
