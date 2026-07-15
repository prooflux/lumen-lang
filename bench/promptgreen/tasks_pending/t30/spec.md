# t30: running mean and variance (Welford)

Write a program with a `main` entry point that:

- holds a fixed list of 10 values, in order: `2.0`, `4.0`, `4.0`, `4.0`,
  `5.0`, `5.0`, `7.0`, `9.0`, `10.0`, `3.0`
- computes the running (Welford) mean and population variance over the
  list: start `n = 0`, `mean = 0`, `m2 = 0`; for each value `x`, in order,
  set `n = n + 1`, `delta = x - mean`, `mean = mean + delta / n`,
  `delta2 = x - mean`, `m2 = m2 + delta * delta2`
- after processing all 10 values, the population variance is `m2 / n`
- prints two integers, each on its own line, in this order:
  1. the mean times `10000.0`, rounded to the nearest whole number
  2. the variance times `10000.0`, rounded to the nearest whole number

Print nothing else.
