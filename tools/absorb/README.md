# lumen absorb: trustly absorb foreign functions into Lumen

The problem this solves: every useful behavior that already exists in another language's
library had to be reimplemented in Lumen from scratch, on faith. This tool replaces faith
with the repo's standing discipline: an executable oracle and a frozen, tamper-evident gate.

## The trust contract

1. At absorption time, the foreign implementation is EXECUTED as a live oracle (CPython via
   `python3 -I`, or a real C/C++ compiler, see "Oracle backends" below) on a deterministic,
   seeded input set derived from the Lumen candidate's own type signature. The candidate is
   accepted only if every case matches.
2. Acceptance freezes the oracle's outputs into `examples/absorbed/fixtures/<fn>.fixture.json`
   together with the sha256 of the accepted `.lm`, the sha256 of the oracle source, the
   Python version, the seed, the input ranges, and the comparison mode.
3. `tools/absorb/absorb_gate.mjs` (in `gate.yml`) re-verifies every absorbed kernel against
   its frozen oracle outputs on every commit, HERMETICALLY: the foreign runtime is needed
   only at the moment of absorption, never in CI. Editing an absorbed kernel breaks the sha
   pin; editing a fixture's expectations breaks the comparison; either turns CI red until a
   deliberate re-absorption against the live oracle re-pins it.
4. Absorbed results RUN AS NATIVE LUMEN CODE, and that is verified, not assumed: both the
   acceptance run and every fixture re-check execute the kernel twice, once on the
   interpreter and once through the full native toolchain (native compile, native optimize,
   emit_fn C, clang -O2, execute), and BOTH must reproduce the oracle. Absorbed kernels are
   not census members, so this leg is what extends the repo's interpreter==native guarantee
   to them.

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

## Oracle backends

`--oracle py|c|cpp` selects which live foreign implementation is executed at absorption
time (default `py`, kept fully backward compatible: `--py <file>` still works with no
`--oracle` flag). The other absorption mechanics (seeded input generation from the
candidate's own signature, the interpreter+native double-check, fixture freezing, sha
pinning, hermetic `absorb_gate.mjs` re-verification) are IDENTICAL across all three
backends: the oracle only supplies the ground-truth output lines, nothing else changes.

```
# C oracle: --src is a .c file, the oracle function is called directly (no header needed
# beyond what the .c file itself includes; wrap a libc call or a compiler builtin exactly
# like the Python oracle .py files wrap a stdlib call).
node tools/absorb/absorb.mjs \
  --oracle c --src examples/absorbed/c/llabs.c --fn iabs \
  --candidate examples/absorbed/iabs.lm \
  --n 200 --seed 42 --emit-fixture examples/absorbed/fixtures

# C++ oracle: --src is a .cpp file, compiled as C++20 so std::midpoint/std::clamp/etc are
# available.
node tools/absorb/absorb.mjs \
  --oracle cpp --src examples/absorbed/cpp/midpoint.cpp --fn midpoint \
  --candidate examples/absorbed/midpoint.lm \
  --n 200 --seed 42 --emit-fixture examples/absorbed/fixtures
```

For a C/C++ oracle, `absorb.mjs` writes a throwaway harness that `#include`s the oracle
source verbatim, then a `main()` that calls the real function once per generated input row
and prints its output using the exact same convention as the Lumen driver and the Python
oracle (`Int` return: decimal text; `Float` return: `floor(v * 1e12 + 0.5)` as a `double`,
printed as decimal text), compiles it with a real compiler, executes the binary, and reads
its stdout as ground truth. Nothing about the foreign function is transcribed by hand: the
harness calls the actual compiled code.

**Compiler discovery (documented honestly, not assumed):** for `--oracle c` this repo
prefers a prebuilt `xgcc` under the cloned `/Users/freedom/repos-languages/gcc` sources, and
for `--oracle cpp` a prebuilt `clang++` under the cloned `/Users/freedom/repos-languages/llvm`
sources, falling back to whatever `gcc`/`clang` (C) or `clang++`/`g++` (C++) is on `PATH` if
the clone has no prebuilt binary at that path yet, exactly the same fallback discipline the
repo's bench/vs-lang track already uses. Whichever compiler is actually used, its binary path,
a human label (`"cloned gcc (prebuilt, repos-languages/gcc)"` vs `"system gcc"` etc.), and
its `--version` banner are recorded in the frozen fixture's `oracle.compiler` /
`oracle.compiler_bin` / `oracle.version_at_absorption` fields, so it is always inspectable
after the fact which compiler produced the ground truth, never silently assumed. As of this
writing the cloned `repos-languages/gcc` and `repos-languages/llvm` trees are source-only
(no build products yet), so every C/C++ absorption to date in this repo used the **system**
compiler (Apple clang, both as `gcc`/`clang` and as `clang++`), visible per-fixture in the
`oracle.compiler` field.

**Hermeticity is unchanged by the new backends.** `tools/absorb/absorb_gate.mjs` (the CI
gate) never re-executes any oracle, Python or C/C++: it only re-runs the Lumen candidate
(interpreter and native) against the fixture's already-frozen `expected` lines. No C/C++
compiler is required in CI for a `c`/`cpp`-oracled kernel to stay verified, exactly like no
Python is required for a `py`-oracled one.

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
| `examples/absorbed/gcd.lm` | Python `math.gcd` | 200 | exact |
| `examples/absorbed/isqrt.lm` | Python `math.isqrt` | 200 | exact |
| `examples/absorbed/comb.lm` | Python `math.comb` | 200 | exact |
| `examples/absorbed/root.lm` | Python `math.sqrt` of magnitude | 200 | scaled-1e12 |
| `examples/absorbed/iabs.lm` | C `llabs` (`<stdlib.h>`) | 200 | exact |
| `examples/absorbed/popcount.lm` | C `__builtin_popcountll` (GCC/Clang builtin) | 200 | exact |
| `examples/absorbed/midpoint.lm` | C++ `std::midpoint<long long>` (`<numeric>`) | 200 | exact |

## v1 limits, stated plainly

Param types: `Int` and `Float`. Return types: `Int` and `Float`. One function per
absorption. Text params, arrays, records, and multi-function modules are future work; the
fixture format carries a version field for that evolution. Oracle backends now cover
Python, C, and C++ (see "Oracle backends" above); other foreign languages are future work
on the same plugin shape (a signature-driven input generator, a live-execute step, and a
line-based comparison already factor cleanly per backend). The selftest
(`absorb_selftest.mjs`) proves accept, reject, sha-drift, and expected-tampering behavior
on throwaway kernels in a temp directory, for the Python oracle and, since this backend
landed, for the C and C++ oracles too.
