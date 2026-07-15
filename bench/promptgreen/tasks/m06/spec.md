# m06: sensor totals

A weather station stores three temperature-offset readings and needs their total, expressed
as a whole number of hundredths (to avoid ambiguous fractional output).

Write a program with:

- allocate a numeric list of length 3
- store `1.25` at position 0, `3.75` at position 1, `4.0` at position 2
- compute the total of all three positions using a loop bounded by the list's length
- an entry point that multiplies the total by `100`, rounds it to the nearest whole number,
  and prints that whole number

Print nothing else.
