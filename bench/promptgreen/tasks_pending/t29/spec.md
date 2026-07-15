# t29: internal rate of return by bisection

Write a program with a `main` entry point that:

- holds a fixed list of 4 cashflows, in order: `-1000.0`, `300.0`, `400.0`,
  `500.0` (period 0 is the initial outlay, periods 1 to 3 are the returns)
- finds the discount rate `r` such that the net present value

      NPV(r) = sum over t of cashflow[t] / (1 + r)^t

  equals zero, using bisection over the bracket `lo = -0.5`, `hi = 1.0`
  (the sign of NPV differs at the two endpoints, so a root lies between
  them)
- runs the bisection for exactly 60 iterations, halving the bracket each
  time by comparing the sign of `NPV(lo) * NPV(mid)`
- takes the final rate as the midpoint of the last bracket
- prints the single integer produced by rounding the rate times
  `1000000.0` to the nearest whole number

Print nothing else.
