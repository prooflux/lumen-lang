# t20: dot product and vector norm

Write a program with:

- a function that takes two lists of 8 numbers and a count, and returns their
  dot product (sum of elementwise products)
- a function that takes a list of 8 numbers and a count, and returns the
  Euclidean norm (square root of the sum of squares of the elements)
- a main routine that:
  1. builds `u = 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0` and `v = 8.0, 7.0,
     6.0, 5.0, 4.0, 3.0, 2.0, 1.0`, then prints the dot product of `u` and `v`
     scaled by 10000 and rounded to the nearest whole number, as a plain
     integer, on its own line
  2. prints the Euclidean norm of `u` scaled by 10000 and rounded to the
     nearest whole number, as a plain integer, on its own line
  3. builds `w = 1.0, 0.0, -1.0, 0.0, 1.0, 0.0, -1.0, 0.0` and `x = 0.0, 1.0,
     0.0, 1.0, 0.0, 1.0, 0.0, 1.0` (orthogonal to each other), then prints the
     dot product of `w` and `x` scaled by 10000 and rounded to the nearest
     whole number, as a plain integer, on its own line

Print nothing else. Output is exactly three lines, each a plain integer.
