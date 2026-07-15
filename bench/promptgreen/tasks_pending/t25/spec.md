# t25: digital root and additive persistence

Write a program that, for a given non-negative whole number, computes:

1. its digital root: repeatedly replace the number by the sum of its decimal digits
   until a single digit (0-9) remains, and report that final digit
2. its additive persistence: the number of digit-sum replacement steps it took to
   reach that single digit (0 if the input already has one digit)

Run this computation for exactly these three inputs, in order: 9875, 7, 0.

For each input, print two lines: the digital root, then the persistence count
(each as a plain integer on its own line, no other text). Do this for all three
inputs in order, so the full output is six lines total.

Edge case to handle correctly: an input that is already a single digit (such as 7,
or 0 itself) must report persistence 0 and a digital root equal to the input itself,
without performing any digit-sum step.

Print nothing else.
