# t19: maximum drawdown

Write a program with:

- a function that takes a list of 12 numbers (prices, in order over time) and
  a count, and returns the maximum peak-to-trough drawdown fraction seen over
  the series. The drawdown fraction at any point is `(running_peak - price) /
  running_peak`, where `running_peak` is the highest price seen so far at or
  before that point. The maximum drawdown is the largest such fraction over
  the whole series (0 if the price never drops below any prior peak).
- a main routine that:
  1. builds the price series `100.0, 105.0, 102.0, 110.0, 90.0, 95.0, 80.0,
     85.0, 88.0, 120.0, 118.0, 130.0` and prints the maximum drawdown fraction
     scaled by 1000000 and rounded to the nearest whole number, as a plain
     integer, on its own line
  2. builds a second, strictly increasing price series `100.0, 101.0, 102.0,
     103.0, 104.0, 105.0, 106.0, 107.0, 108.0, 109.0, 110.0, 111.0` and prints
     its maximum drawdown fraction scaled by 1000000 and rounded to the
     nearest whole number, as a plain integer, on its own line

Print nothing else. Output is exactly two lines, each a plain integer.
