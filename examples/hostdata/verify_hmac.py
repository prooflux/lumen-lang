#!/usr/bin/env python3
"""Live-oracle verifier for hmac_kernel.lm against Python's hmac.new(..., hashlib.sha256).

For each test case (7 RFC 4231 vectors + N random fuzz cases):
  1. Compute the expected hex digest with Python's hmac module (the oracle).
  2. Generate a throwaway .lm file: the hmac_kernel.lm library (everything above the
     "TEST-DRIVER MARKER" line) plus a generated main() that builds the key/message as
     Int byte arrays and prints hmac_sha256_hex(...).
  3. Run it with `node seed/lumen.mjs run <file>.lm` and compare stdout (stripped) to the
     oracle's hex digest, exact text equality.

Usage: python3 verify_hmac.py
"""

import hashlib
import hmac
import os
import random
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
KERNEL_PATH = os.path.join(HERE, "hmac_kernel.lm")
MARKER = "# ==== TEST-DRIVER MARKER:"


def load_library_prefix() -> str:
    with open(KERNEL_PATH, "r") as f:
        text = f.read()
    idx = text.index(MARKER)
    return text[:idx]


def emit_int_array(var: str, data: bytes) -> str:
    lines = [f"  let {var} = iarray({len(data)})"]
    for i, b in enumerate(data):
        lines.append(f"  iaset({var}, {i}, {b})")
    return "\n".join(lines) + "\n"


def build_program(prefix: str, key: bytes, msg: bytes) -> str:
    body = []
    body.append("fn main(console: Console) -> Unit {")
    body.append(emit_int_array("key", key))
    body.append(emit_int_array("msg", msg))
    body.append(f"  console.print(hmac_sha256_hex(key, {len(key)}, msg, {len(msg)}))")
    body.append('  console.print("\\n")')
    body.append("  return ()")
    body.append("}")
    return prefix + "\n".join(body) + "\n"


def run_case(prefix: str, key: bytes, msg: bytes) -> str:
    src = build_program(prefix, key, msg)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".lm", dir=HERE, delete=False
    ) as f:
        f.write(src)
        path = f.name
    try:
        result = subprocess.run(
            ["node", "seed/lumen.mjs", "run", path],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise RuntimeError(
                f"lumen run failed (rc={result.returncode}): {result.stderr.strip()}"
            )
        return result.stdout.strip()
    finally:
        os.remove(path)


def oracle(key: bytes, msg: bytes) -> str:
    return hmac.new(key, msg, hashlib.sha256).hexdigest()


# RFC 4231 official test vectors (case 6 and 7 use a 131-byte key, longer than the SHA-256
# block size of 64 bytes, exercising the key-hashing branch of build_key_block).
RFC4231_CASES = [
    ("1", bytes([0x0B] * 20), b"Hi There"),
    ("2", b"Jefe", b"what do ya want for nothing?"),
    ("3", bytes([0xAA] * 20), bytes([0xDD] * 50)),
    (
        "4",
        bytes(range(0x01, 0x19)),  # 0x01..0x18, 25 bytes
        bytes([0xCD] * 50),
    ),
    ("5-truncated-ignored", bytes([0x0C] * 20), b"Test With Truncation"),
    (
        "6",
        bytes([0xAA] * 131),
        b"Test Using Larger Than Block-Size Key - Hash Key First",
    ),
    (
        "7",
        bytes([0xAA] * 131),
        b"This is a test using a larger than block-size key and a larger "
        b"than block-size data. The key needs to be hashed before being "
        b"used by the HMAC algorithm.",
    ),
]


def main() -> int:
    prefix = load_library_prefix()
    total = 0
    failed = []

    print("== RFC 4231 official vectors ==")
    for name, key, msg in RFC4231_CASES:
        total += 1
        expected = oracle(key, msg)
        got = run_case(prefix, key, msg)
        ok = got == expected
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] RFC4231 case {name}: key_len={len(key)} msg_len={len(msg)}")
        if not ok:
            print(f"    expected={expected}")
            print(f"    got     ={got}")
            failed.append(f"RFC4231-{name}")

    print("\n== Random fuzz cases ==")
    rng = random.Random(20260723)
    n_fuzz = 30
    for i in range(n_fuzz):
        total += 1
        # Vary key length across short, block-sized, and longer-than-block-size (to
        # exercise the key-hashing branch), and message length from 0 up to a few blocks.
        key_len = rng.choice(
            [0, 1, 5, 16, 32, 63, 64, 65, 90, 128, 200, rng.randint(1, 300)]
        )
        msg_len = rng.choice(
            [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 121, 200, rng.randint(0, 500)]
        )
        key = bytes(rng.randrange(256) for _ in range(key_len))
        msg = bytes(rng.randrange(256) for _ in range(msg_len))
        expected = oracle(key, msg)
        got = run_case(prefix, key, msg)
        ok = got == expected
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] fuzz {i}: key_len={key_len} msg_len={msg_len}")
        if not ok:
            print(f"    key={key.hex()}")
            print(f"    msg={msg.hex()}")
            print(f"    expected={expected}")
            print(f"    got     ={got}")
            failed.append(f"fuzz-{i}")

    print(f"\n{total - len(failed)}/{total} cases passed")
    if failed:
        print(f"FAILED: {failed}")
        return 1
    print("ALL PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
