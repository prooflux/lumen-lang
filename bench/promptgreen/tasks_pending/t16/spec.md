# t16: 3-step binomial call option price

Price a European call option with a 3-step binomial (recombining) tree, using these fixed
constants:

- initial underlying price `S = 100.0`
- strike price `K = 100.0`
- up factor per step `u = 1.1`
- down factor per step `d = 0.9`
- risk-free rate per step `r = 0.05` (so the per-step growth factor is `R = 1 + r`)

Steps:

1. Compute the risk-neutral up-probability `q = (R - d) / (u - d)` and the down-probability
   `1 - q`.
2. There are four possible terminal underlying prices after 3 steps, one for each count of
   up-moves `k` in `{0, 1, 2, 3}`: `S * u^k * d^(3-k)`.
3. Each terminal price has binomial probability `C(3, k) * q^k * (1 - q)^(3 - k)`, where
   `C(3, k)` is the binomial coefficient (`1, 3, 3, 1` for `k = 0, 1, 2, 3`).
4. The call payoff at a terminal price `S_T` is `max(S_T - K, 0)`.
5. The option price is the probability-weighted average payoff, discounted by dividing by
   `R^3`.

Write a program with:

- a function `call_price() -> Float` that returns the option price computed as above
- a main entry point that computes `call_price() * 10000.0`, rounds it to the nearest
  integer, and prints that integer with no other output

(Rounding to the nearest integer of a value scaled by 10000 is how this program reports a
fractional price exactly and deterministically.)
