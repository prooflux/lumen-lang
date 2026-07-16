# t27: Luhn checksum validation

Write a program with:

- a function that takes a sequence of decimal digits (0-9) representing a card-like number, from most significant to least significant digit, together with its length, and returns 1 if the number passes the Luhn checksum, or 0 if it does not.
- a main entry point that runs the checksum against two fixed 16-digit numbers and prints the result of each on its own line, in order: first number's result, then second number's result.

Numbers to check:

1. `4532015112830366`
2. `4532015112830367` (identical to the first number except the last digit, the check digit, has been incremented by 1)

The Luhn algorithm: starting from the rightmost digit and moving left, double every second digit (the digits at positions 1, 3, 5, ... counting from the right, 0-indexed). If doubling a digit produces a value greater than 9, subtract 9 from it. Sum all digits (the doubled-and-adjusted ones and the untouched ones). The number is valid if that sum is a multiple of 10.

Print exactly two lines: `1` or `0` for the first number, then `1` or `0` for the second number. Print nothing else.
