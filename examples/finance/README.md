# Finance kernels

Worked examples of Lumen's core use case: **certified numeric kernels**. Small,
provably-correct routines that compile to native code with no runtime and no garbage
collector, so they are fast, cheap to run, and trivially parallel (stateless pure
functions over `Float`).

- `black_scholes.lm` - European call pricing (Black-Scholes, normal CDF in Lumen).
- `implied_vol.lm` - Newton-Raphson implied volatility (inverts Black-Scholes).

Run either with `node ../../seed/lumen.mjs run <file>.lm`. Prices/vols are scaled by
10000 and printed as integers (no float printing in the language yet): `104506` is
`10.4506`, `2000` is a 20.00% vol.

## Why these are the wedge

A number a system trusts should be provably correct, not merely plausible. Lumen gates
every layer of its toolchain bit-identical against a small reference interpreter, so a
kernel that compiles and passes its checks is verified end to end. Priced at native
speed, that makes verified quant math a cheap, scalable primitive - the direction the
language is growing toward broader backend capabilities.
