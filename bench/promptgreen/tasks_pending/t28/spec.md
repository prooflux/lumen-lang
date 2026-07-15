# t28: Fibonacci modulo, computed iteratively

Write a program with:

- a function that computes the n-th Fibonacci number modulo 1000000007 (one billion and seven), using indices where fib(0) = 0, fib(1) = 1, and fib(k) = fib(k-1) + fib(k-2) for k >= 2. The function must compute the result **iteratively** (a loop, not recursion), and it must apply the modulo operation at every addition step (never let an intermediate sum grow larger than necessary before reducing it), so that no intermediate value ever needs more range than the final reduced result.
- a main entry point that computes and prints fib(90) mod 1000000007 on its own line.

Print exactly one line: the integer result. Print nothing else.
