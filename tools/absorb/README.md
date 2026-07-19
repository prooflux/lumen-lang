# lumen absorb: trustly absorb foreign functions into Lumen

The problem this solves: every useful behavior that already exists in another language's
library had to be reimplemented in Lumen from scratch, on faith. This tool replaces faith
with the repo's standing discipline: an executable oracle and a frozen, tamper-evident gate.

## The trust contract

1. At absorption time, the foreign implementation is EXECUTED as a live oracle (today:
   CPython via `python3 -I`) on a deterministic, seeded input set derived from the Lumen
   candidate's own type signature. The candidate is accepted only if every case matches.
2. Acceptance freezes the oracle's outputs into `examples/absorbed/fixtures/<fn>.fixture.json`
   together with the sha256 of the accepted `.lm`, the sha256 of the oracle source, the
   Python version, the seed, the input ranges, and the comparison mode.
3. `tools/absorb/absorb_gate.mjs` (in `gate.yml`) re-verifies every absorbed kernel against
   its frozen oracle outputs on every commit, HERMETICALLY: the foreign runtime is needed
   only at the moment of absorption, never in CI. Editing an absorbed kernel breaks the sha
   pin; editing a fixture's expectations breaks the comparison; either turns CI red until a
   deliberate re-absorption against the live oracle re-pins it.

## Usage

```
node tools/absorb/absorb.mjs \
  --py examples/absorbed/py/gcd.py --fn gcd \
  --candidate examples/absorbed/gcd.lm \
  --n 200 --seed 42 --emit-fixture examples/absorbed/fixtures

node tools/absorb/absorb.mjs --check-fixture examples/absorbed/fixtures/gcd.fixture.json
```

The candidate is authored by a person or an AI; the tool never generates code. Generation
is deliberately outside the trust boundary: whoever writes the candidate, the oracle and
the frozen fixture decide whether it is accepted. Wiring an LLM author into the front of
this pipeline reuses the promptgreen author adapters once they land (W5 P-C).

## Comparison modes

- `Int` return: exact decimal text equality.
- `Float` return: scaled-1e12 equality, `floor(v * 1e12 + 0.5)` computed as float64 on both
  sides, mirroring FROUND and the repo's scaled-int printing convention. This certifies 12
  decimal digits, not bit equality. A foreign implementation with an algorithmically
  different libm path (for example a fused hypot) can legitimately land within a half-ulp
  of a rounding boundary and fail; that is the gate working. The move is a tighter kernel
  or a narrower certified domain, never a looser comparison.

## Domains are part of the certificate

An absorbed kernel is verified ON THE FIXTURE'S RECORDED DOMAIN, no further. Python
integers are bignums; Lumen's Int is i64. Ranges keep the oracle inside i64 and are stored
in the fixture. Behavior outside the certified domain is the kernel's own documented
extension (each absorbed `.lm` header states it), not an oracle-verified claim.

## What is absorbed so far

| Kernel | Oracle | Cases | Mode |
|---|---|---|---|
| `examples/absorbed/gcd.lm` | `math.gcd` | 200 | exact |
| `examples/absorbed/isqrt.lm` | `math.isqrt` | 200 | exact |
| `examples/absorbed/comb.lm` | `math.comb` | 200 | exact |
| `examples/absorbed/root.lm` | `math.sqrt` of magnitude | 200 | scaled-1e12 |

## v1 limits, stated plainly

Param types: `Int` and `Float`. Return types: `Int` and `Float`. One function per
absorption. Text params, arrays, records, multi-function modules, and non-Python oracles
are future work; the fixture format carries a version field for that evolution. The
selftest (`absorb_selftest.mjs`) proves accept, reject, sha-drift, and expected-tampering
behavior on throwaway kernels in a temp directory.
