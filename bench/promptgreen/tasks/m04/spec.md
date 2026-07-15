# m04: boundary check

There is no built-in true/false marker in this exercise; instead, encode a yes/no result as
the whole number 1 for yes and 0 for no. Write a program with:

- a function that takes a whole-number reading and two whole-number fence posts, a lower
  fence and an upper fence, and returns 1 when the reading is greater than or equal to the
  lower fence AND less than or equal to the upper fence (an inclusive range check on both
  ends), otherwise returns 0.
- a main entry point that calls the function twice and prints each result on its own line,
  using whatever integer-printing operation your language provides:
  1. reading 7, lower fence 3, upper fence 7 (the reading sits exactly on the upper fence)
  2. reading 20, lower fence 3, upper fence 7 (the reading is outside the fence)

Print nothing else.
