# tasks_pending: verified corpus growth, staged for the shard-aware runner

Twenty new benchmark tasks (`t11` through `t30`) authored by a 42-agent factory run
(14 authors, one adversarial verifier per task) and individually verified before staging:
reference.lm compiles and runs green against the current toolchain; hidden tests pass on the
reference and FAIL on a mutated reference (discrimination proof); the spec is language-neutral;
only shipped language surface is used; a Python twin (`py/reference.py` + `py/hidden_tests.py`,
plain asserts, no pytest) runs clean with semantically matching values.

Why staged here instead of `tasks/`: `runner.mjs` discovers every directory matching `t\d+`
and `selftest.mjs` hard-asserts exactly the 10 frozen tasks with their scripted-author
expectations, so dropping 20 new tasks into `tasks/` would break the deterministic CI selftest.
These move into `tasks/` in the W5 wiring change that makes the selftest shard-aware
(dev / sealed / pending) and defines the Python-arm layout; until then they are data, not
part of any measured run, and contribute no observation to PREREGISTRATION_v1.md's H1-H3.

Task themes: exact-decimal money kernels exercising the new `Dec` type (amortization,
currency split, compound interest, tax brackets, invoice rounding), float quant kernels
(binomial option, bisection root, Horner, drawdown, dot product, moving average, curve
interpolation, IRR, Welford stats), and integer algorithms (sieve, Collatz, digital root,
Zeller, Luhn, Fibonacci mod). Outputs are deterministic exact text (Int lines, Dec text,
or scaled-int lines).
