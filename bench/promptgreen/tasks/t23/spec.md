# t23: prime count via sieve

Write a program that counts how many prime numbers are strictly less than
`N = 1000`, using a numeric array as a flag store (one slot per number from
`0` to `N-1`, where a nonzero value marks the number as composite and zero
means "not yet marked composite").

Rules:

- Allocate a flag store of length `N` and initialize every slot to `0`
  (meaning "assume prime" for now).
- Starting from `2`, for each number `n` less than `N` whose flag is still
  `0`, count it as a prime, then mark every multiple of `n` starting at
  `n * n` (stepping by `n`, up to but not including `N`) with a nonzero flag.
- After the sieve finishes, print the total count of primes found below `N`
  as a single integer, with nothing else printed.

The correct count of primes below 1000 is 168, and 997 (the largest prime
below 1000) must be correctly counted as prime by the sieve logic.
