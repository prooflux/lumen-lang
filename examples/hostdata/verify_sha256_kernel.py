#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Live-oracle verifier for sha256_kernel.lm.

Generates a Lumen main() per test case (embeds the message bytes as an Int-array
literal via iaset calls), runs it through the real Lumen seed interpreter
(`node seed/lumen.mjs run <file>`), and compares the printed hex digest against
Python's hashlib.sha256 (the live oracle) byte for byte.

Usage:
    uv run examples/hostdata/verify_sha256_kernel.py
"""

import hashlib
import random
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL_PATH = Path(__file__).resolve().parent / "sha256_kernel.lm"
MAIN_MARKER = "fn main(console: Console) -> Unit {"


def kernel_prefix() -> str:
    """Everything in the kernel file up to (not including) the default smoke-test main()."""
    src = KERNEL_PATH.read_text()
    idx = src.index(MAIN_MARKER)
    return src[:idx]


def generate_main(msg: bytes) -> str:
    lines = [MAIN_MARKER]
    n = len(msg)
    if n == 0:
        # iarray(0) is a valid zero-length array; sha256_hex must handle it.
        lines.append("  let msg = iarray(0)")
    else:
        lines.append(f"  let msg = iarray({n})")
        for i, byte in enumerate(msg):
            lines.append(f"  iaset(msg, {i}, {byte})")
    lines.append(f"  console.print(sha256_hex(msg, {n}))")
    lines.append('  console.print("\\n")')
    lines.append("  return ()")
    lines.append("}")
    return "\n".join(lines) + "\n"


def run_lumen(program_src: str) -> str:
    tmp_path = KERNEL_PATH.parent / "_gen_case.lm"
    tmp_path.write_text(program_src)
    try:
        result = subprocess.run(
            ["node", str(REPO_ROOT / "seed" / "lumen.mjs"), "run", str(tmp_path)],
            capture_output=True,
            text=True,
            timeout=60,
        )
    finally:
        tmp_path.unlink(missing_ok=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"lumen run failed (exit {result.returncode}):\nstdout={result.stdout}\nstderr={result.stderr}"
        )
    return result.stdout.strip()


def check_one(msg: bytes, label: str, prefix: str) -> tuple[bool, str]:
    expected = hashlib.sha256(msg).hexdigest()
    program = prefix + generate_main(msg)
    actual = run_lumen(program)
    ok = actual == expected
    status = "PASS" if ok else "FAIL"
    detail = (
        f"{status}  {label:32s} len={len(msg):4d}  expected={expected}  actual={actual}"
    )
    return ok, detail


def main() -> int:
    prefix = kernel_prefix()
    results: list[tuple[bool, str]] = []

    # (a) FIPS 180-4 example vectors.
    official = [
        ("fips_abc", b"abc"),
        ("fips_empty", b""),
        (
            "fips_448bit_twoblock",
            b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
        ),
    ]
    for label, msg in official:
        results.append(check_one(msg, label, prefix))

    # (b) Fuzz: >=100 random byte strings, lengths spanning 0..300 bytes, deterministic seed.
    rng = random.Random(20260723)
    for i in range(120):
        length = rng.randint(0, 300)
        msg = bytes(rng.randrange(256) for _ in range(length))
        results.append(check_one(msg, f"fuzz_{i:03d}", prefix))

    for ok, detail in results:
        print(detail)

    n_pass = sum(1 for ok, _ in results if ok)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} cases passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
