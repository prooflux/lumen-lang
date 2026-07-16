# t12: currency split

Write a program that divides an exact-decimal money amount into `n` equal
shares (`n` is a positive integer), where money has exactly 2 fractional
digits (whole cents):

1. Convert the amount to a whole number of cents.
2. Divide the cents into `n` shares as evenly as possible: every share gets
   `cents / n` (integer division, rounded down) as its base amount, then the
   leftover `cents % n` cents are distributed one extra cent at a time,
   starting from the first share and moving forward, until the leftover is
   used up.
3. Print each of the `n` shares in order (share 1 first, share 2 next, and so
   on), each as exact-decimal text on its own line.

Every share must be within 1 cent of every other share, and the `n` shares
must sum exactly back to the original amount.

Edge case: when the amount does not divide evenly, the earliest shares (by
index) are the ones that receive the extra cent, and the remaining shares
receive no extra cent.

Print nothing else.
