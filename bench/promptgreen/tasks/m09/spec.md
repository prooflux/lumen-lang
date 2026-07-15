# m09: discounted payoff

Write a program with:

- a function `discounted_payoff` taking a payoff amount, a per-period discount rate, and
  a number of periods (term), all as decimal numbers, that returns
  `payoff / (1 + discount_rate) ^ term`
- a main routine that computes `discounted_payoff(245.80, 0.08, 3.0)`, multiplies the
  result by 100, rounds it to the nearest whole number, and prints that whole number

Print nothing else.
