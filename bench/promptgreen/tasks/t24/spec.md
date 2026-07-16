# t24: Collatz steps and peak

Write a program that, for a fixed starting whole number `START = 27`,
computes the Collatz sequence:

- if the current value is `1`, stop.
- if the current value is even, the next value is the current value divided
  by 2.
- if the current value is odd, the next value is `3 * current + 1`.

Track two things while iterating from `START` down to `1`:

- `steps`: the number of iterations it takes to reach `1` (each application
  of the even/odd rule counts as one step; a value that is already `1`
  before any rule is applied contributes `0` steps).
- `peak`: the largest value seen at any point in the sequence, including the
  starting value itself.

Print `steps` on its own line, then print `peak` on its own line, and print
nothing else.

Known reference values for `START = 27` (this is the classic long, high
overshoot Collatz example): the sequence takes exactly `111` steps to reach
`1`, and the largest value it ever reaches along the way is `9232`. Your
program's two printed numbers must match these exactly.
