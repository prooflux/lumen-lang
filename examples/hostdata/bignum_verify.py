#!/usr/bin/env python3
"""
bignum_verify.py - live-oracle differential test for bignum_kernel.lm.

Uses Python's native arbitrary-precision ints as the ground truth. For each test case, this
script:
  1. Picks random operands with Python's `random` module (fixed seed for reproducibility).
  2. Decomposes them into 8 little-endian 32-bit limbs (the kernel's fixed representation).
  3. Generates a `main()` that builds those limbs into Int arrays, calls the target kernel
     function, and prints the result (bn_print: one decimal limb per line).
  4. Writes kernel-body + generated-main to a temp .lm file and runs it via
     `node seed/lumen.mjs run <file>` (the same command the /lumen skill treats as the
     canonical "run a program" entry point).
  5. Reconstructs the big integer from the printed limbs and compares against Python's own
     arithmetic (`+`, `-`, `*`, `%`, `pow(base, exp, mod)`).

Run from the repo root:
    python3 examples/hostdata/bignum_verify.py
"""

import random
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LUMEN_CLI = REPO_ROOT / "seed" / "lumen.mjs"
KERNEL_PATH = Path(__file__).resolve().parent / "bignum_kernel.lm"

NLIMBS = 8
LIMB_BITS = 32
WIDTH_BITS = NLIMBS * LIMB_BITS  # 256
MASK32 = 0xFFFFFFFF

SEED = 20260723


def load_kernel_body() -> str:
    """Everything in bignum_kernel.lm up to (not including) the smoke-test main()."""
    src = KERNEL_PATH.read_text()
    marker = "fn main(console: Console) -> Unit {"
    idx = src.index(marker)
    return src[:idx]


KERNEL_BODY = load_kernel_body()


def limbs_le(x: int, n: int) -> list[int]:
    assert x >= 0
    return [(x >> (LIMB_BITS * i)) & MASK32 for i in range(n)]


def from_limbs(lims: list[int]) -> int:
    v = 0
    for i, l in enumerate(lims):
        v += l << (LIMB_BITS * i)
    return v


def emit_array(name: str, lims: list[int]) -> list[str]:
    lines = [f"  let {name} = iarray({len(lims)})"]
    for i, l in enumerate(lims):
        lines.append(f"  iaset({name}, {i}, {l})")
    return lines


def run_lm(body_lines: list[str]) -> list[int]:
    main_src = (
        "fn main(console: Console) -> Unit {\n"
        + "\n".join(body_lines)
        + "\n  return ()\n}\n"
    )
    full_src = KERNEL_BODY + main_src
    with tempfile.NamedTemporaryFile(
        "w", suffix=".lm", dir=str(KERNEL_PATH.parent), delete=False
    ) as f:
        f.write(full_src)
        tmp_path = f.name
    try:
        proc = subprocess.run(
            ["node", str(LUMEN_CLI), "run", tmp_path],
            capture_output=True,
            text=True,
            timeout=60,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"lumen run failed (exit {proc.returncode}):\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    lines = [ln for ln in proc.stdout.splitlines() if ln.strip() != ""]
    return [int(ln.strip()) for ln in lines]


# ---------------------------------------------------------------------------
# Per-operation drivers
# ---------------------------------------------------------------------------


def check_add(a: int, b: int) -> tuple[bool, str]:
    a_lims, b_lims = limbs_le(a, NLIMBS), limbs_le(b, NLIMBS)
    body = (
        emit_array("a", a_lims)
        + emit_array("b", b_lims)
        + [
            "  let out = iarray(8)",
            "  let carry = bn_add(a, b, out, 8)",
            "  bn_print(console, out, 8)",
            "  console.print_int(carry)",
        ]
    )
    out = run_lm(body)
    out_lims, carry = out[:NLIMBS], out[NLIMBS]
    got = from_limbs(out_lims) + (carry << WIDTH_BITS)
    expected = a + b
    ok = got == expected and carry in (0, 1)
    return ok, f"a={a} b={b} expected={expected} got={got} carry={carry}"


def check_sub(a: int, b: int) -> tuple[bool, str]:
    assert a >= b
    a_lims, b_lims = limbs_le(a, NLIMBS), limbs_le(b, NLIMBS)
    body = (
        emit_array("a", a_lims)
        + emit_array("b", b_lims)
        + [
            "  let out = iarray(8)",
            "  let borrow = bn_sub(a, b, out, 8)",
            "  bn_print(console, out, 8)",
            "  console.print_int(borrow)",
        ]
    )
    out = run_lm(body)
    out_lims, borrow = out[:NLIMBS], out[NLIMBS]
    got = from_limbs(out_lims)
    expected = a - b
    ok = got == expected and borrow == 0
    return ok, f"a={a} b={b} expected={expected} got={got} borrow={borrow}"


def check_mul(a: int, b: int) -> tuple[bool, str]:
    a_lims, b_lims = limbs_le(a, NLIMBS), limbs_le(b, NLIMBS)
    body = (
        emit_array("a", a_lims)
        + emit_array("b", b_lims)
        + [
            "  let out = iarray(16)",
            "  bn_mul(a, b, out, 8)",
            "  bn_print(console, out, 16)",
        ]
    )
    out = run_lm(body)
    got = from_limbs(out)
    expected = a * b
    ok = got == expected
    return ok, f"a={a} b={b} expected={expected} got={got}"


def check_mod(a: int, m: int) -> tuple[bool, str]:
    assert m > 0
    a_lims, m_lims = limbs_le(a, NLIMBS), limbs_le(m, NLIMBS)
    body = (
        emit_array("a", a_lims)
        + emit_array("m", m_lims)
        + [
            "  let r = iarray(8)",
            "  bn_mod(a, 8, m, 8, r)",
            "  bn_print(console, r, 8)",
        ]
    )
    out = run_lm(body)
    got = from_limbs(out)
    expected = a % m
    ok = got == expected
    return ok, f"a={a} m={m} expected={expected} got={got}"


def check_modpow(base: int, exp: int, m: int) -> tuple[bool, str]:
    assert m > 0
    base_lims, exp_lims, m_lims = (
        limbs_le(base, NLIMBS),
        limbs_le(exp, NLIMBS),
        limbs_le(m, NLIMBS),
    )
    body = (
        emit_array("base", base_lims)
        + emit_array("exp", exp_lims)
        + emit_array("m", m_lims)
        + [
            "  let result = iarray(8)",
            "  bn_modpow(base, exp, m, 8, result)",
            "  bn_print(console, result, 8)",
        ]
    )
    out = run_lm(body)
    got = from_limbs(out)
    expected = pow(base, exp, m)
    ok = got == expected
    return ok, f"base={base} exp={exp} m={m} expected={expected} got={got}"


# ---------------------------------------------------------------------------
# Test-case generation
# ---------------------------------------------------------------------------


def rand_bits(rng: random.Random, lo: int, hi: int) -> int:
    """A random positive int with a random bit-length in [lo, hi] (top bit forced set so the
    bit-length claim is exact, not just an upper bound)."""
    nbits = rng.randint(lo, hi)
    if nbits <= 1:
        return rng.randint(0, 1)
    return (1 << (nbits - 1)) | rng.getrandbits(nbits - 1)


def gen_add_cases(rng: random.Random, n: int) -> list[tuple[int, int]]:
    # Scoping note: capped so a+b < 2^256 (see NOTES.md). Each operand's bit-length is drawn
    # from [199, 254] so the sum's bit-length is at most ~255, safely inside the 8-limb width.
    cases = []
    for _ in range(n):
        a = rand_bits(rng, 199, 254)
        b = rand_bits(rng, 199, 254)
        while a + b >= (1 << WIDTH_BITS):
            b = rand_bits(rng, 199, 220)
        cases.append((a, b))
    return cases


def gen_sub_cases(rng: random.Random, n: int) -> list[tuple[int, int]]:
    cases = []
    for _ in range(n):
        a = rand_bits(rng, 200, 256)
        b = rng.randint(0, a)
        cases.append((a, b))
    return cases


def gen_mul_cases(rng: random.Random, n: int) -> list[tuple[int, int]]:
    cases = []
    for _ in range(n):
        a = rand_bits(rng, 200, 256)
        b = rand_bits(rng, 200, 256)
        cases.append((a, b))
    return cases


def gen_mod_cases(rng: random.Random, n: int) -> list[tuple[int, int]]:
    cases = []
    for _ in range(n):
        a = rand_bits(rng, 200, 256)
        m = rand_bits(rng, 200, 256)
        if m == 0:
            m = 1
        cases.append((a, m))
    return cases


def gen_modpow_cases(rng: random.Random, n: int) -> list[tuple[int, int, int]]:
    cases = []
    for i in range(n):
        m = rand_bits(rng, 254, 256) | 1  # force odd, ~256-bit, RSA-modulus-shaped
        base = rng.randint(
            0, m + 5
        )  # occasionally >= m, exercises the reduce-base-first path
        if i % 3 == 0:
            exp = 3
        elif i % 3 == 1:
            exp = 65537
        else:
            exp = rand_bits(rng, 240, 256)
        cases.append((base, exp, m))
    return cases


def edge_cases() -> dict[str, list]:
    """Directed edge cases named in the brief: modulus near a limb boundary, subtraction that
    produces leading-zero limbs, base >= modulus in modpow."""
    two32 = 1 << 32
    two64 = 1 << 64
    cases: dict[str, list] = {}
    cases["add"] = [
        (0, 0),
        (1, 1),
        (two32 - 1, 1),  # single-limb carry propagation
        ((1 << WIDTH_BITS) - 1 - 5, 5),  # sum lands exactly at the 256-bit ceiling
    ]
    cases["sub"] = [
        (0, 0),
        (1, 1),
        (two32, 1),  # borrow across a limb boundary
        (12345, 12345),  # a == b -> result is all-zero limbs (leading zeros)
        ((1 << 100) + 7, (1 << 100)),  # high limbs cancel to zero after subtraction
    ]
    cases["mul"] = [
        (0, 0),
        (1, 0),
        (1, 1),
        (two32 - 1, two32 - 1),
        (two64 - 1, two64 - 1),
    ]
    cases["mod"] = [
        (0, 7),
        (5, 5),  # a == m -> remainder 0
        (two32 - 1, two32),  # numerator just under a limb boundary
        (two32, two32 - 1),  # modulus just under a limb boundary
        ((1 << 250) + 3, two64 + 1),
    ]
    cases["modpow"] = [
        (0, 5, 7),  # 0^5 mod 7 = 0
        (1, 0, 7),  # x^0 mod m = 1
        (10, 3, 1),  # modulus 1 -> result always 0
        (100, 65537, (two32 - 1) | 1),  # base < modulus, modulus near a limb boundary
        (
            two64 + 500,
            17,
            1000000007,
        ),  # base >= modulus, forces the reduce-base-first path
    ]
    return cases


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> int:
    rng = random.Random(SEED)
    total = 0
    failures: list[str] = []

    def run_batch(label: str, cases: list, fn) -> None:
        nonlocal total
        for case in cases:
            total += 1
            ok, detail = fn(*case)
            status = "PASS" if ok else "FAIL"
            if not ok:
                failures.append(f"{label} {status}: {detail}")
            print(f"{label:8s} {status}  {detail[:160]}")

    edges = edge_cases()

    run_batch("add", gen_add_cases(rng, 50) + edges["add"], check_add)
    run_batch("sub", gen_sub_cases(rng, 50) + edges["sub"], check_sub)
    run_batch("mul", gen_mul_cases(rng, 50) + edges["mul"], check_mul)
    run_batch("mod", gen_mod_cases(rng, 50) + edges["mod"], check_mod)
    run_batch("modpow", gen_modpow_cases(rng, 20) + edges["modpow"], check_modpow)

    print()
    print(f"{total} cases run, {len(failures)} failed")
    if failures:
        print("FAILURES:")
        for f in failures:
            print(" ", f)
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
