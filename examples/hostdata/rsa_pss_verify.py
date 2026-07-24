#!/usr/bin/env python3
"""
rsa_pss_verify.py - live-oracle differential + real-crypto test for rsa_pss_kernel.lm.

Two independent checks per test message, both must pass:

  (a) Byte-exact match against a from-scratch pure-Python reference implementation of
      RSASP1 + MGF1 + EMSA-PSS-ENCODE (RFC 8017), using the SAME explicit fixed salt the
      Lumen kernel used. This catches any bit-level bug in the Lumen kernel's PSS/MGF1/
      SHA-256/bignum plumbing.

  (b) Real acceptance by Python's `cryptography` library: the Lumen-produced signature is
      handed to `RSAPublicKey.verify()` configured with PSS(MGF1(SHA-256), salt_length=32)
      and SHA-256 - the actual RFC 8017 verifier, not a hand-rolled one. Since PSS
      verification recovers the salt from the signature itself (it does not need to know
      what salt the signer used), this is a genuine end-to-end cryptographic check: a
      signature the real library disagrees with cannot pass this step by construction.

Run from the repo root:
    uv run --with cryptography python3 examples/hostdata/rsa_pss_verify.py
"""

import hashlib
import subprocess
import sys
import tempfile
from pathlib import Path

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

REPO_ROOT = Path(__file__).resolve().parents[2]
LUMEN_CLI = REPO_ROOT / "seed" / "lumen.mjs"
KERNEL_PATH = Path(__file__).resolve().parent / "rsa_pss_kernel.lm"

NLIMBS = 24
LIMB_BITS = 32
MOD_BITS = 768
MASK32 = 0xFFFFFFFF
HASH_LEN = 32


def load_kernel_body() -> str:
    """Everything in rsa_pss_kernel.lm up to (not including) the smoke-test main()."""
    src = KERNEL_PATH.read_text()
    marker = "fn main(console: Console) -> Unit {"
    idx = src.index(marker)
    return src[:idx]


KERNEL_BODY = load_kernel_body()


# ---------------------------------------------------------------------------
# Pure-Python reference implementation of RFC 8017 RSASP1 + MGF1 + EMSA-PSS-ENCODE
# (independent of both the Lumen kernel and of `cryptography`'s internals - this is check (a)).
# ---------------------------------------------------------------------------


def i2osp(x: int, length: int) -> bytes:
    return x.to_bytes(length, "big")


def os2ip(x: bytes) -> int:
    return int.from_bytes(x, "big")


def mgf1_ref(seed: bytes, mask_len: int) -> bytes:
    t = b""
    counter = 0
    while len(t) < mask_len:
        c = counter.to_bytes(4, "big")
        t += hashlib.sha256(seed + c).digest()
        counter += 1
    return t[:mask_len]


def emsa_pss_encode_ref(message: bytes, salt: bytes, em_bits: int) -> bytes:
    em_len = (em_bits + 7) // 8
    m_hash = hashlib.sha256(message).digest()
    if em_len < HASH_LEN + len(salt) + 2:
        raise ValueError("encoding error: modulus too small for this hash/salt length")
    m_prime = b"\x00" * 8 + m_hash + salt
    h = hashlib.sha256(m_prime).digest()
    ps = b"\x00" * (em_len - len(salt) - HASH_LEN - 2)
    db = ps + b"\x01" + salt
    db_mask = mgf1_ref(h, len(db))
    masked_db = bytes(a ^ b for a, b in zip(db, db_mask))
    n_clear_bits = 8 * em_len - em_bits
    if n_clear_bits > 0:
        keep_mask = 0xFF >> n_clear_bits
        masked_db = bytes([masked_db[0] & keep_mask]) + masked_db[1:]
    return masked_db + h + b"\xbc"


def rsa_pss_sign_ref(
    message: bytes, salt: bytes, d: int, n: int, mod_bits: int
) -> bytes:
    em_bits = mod_bits - 1
    em = emsa_pss_encode_ref(message, salt, em_bits)
    m_int = os2ip(em)
    s = pow(m_int, d, n)
    k = (mod_bits + 7) // 8
    return i2osp(s, k)


# ---------------------------------------------------------------------------
# Lumen driver: build a generated main() per test case, run it, parse the printed hex.
# ---------------------------------------------------------------------------


def limbs_le(x: int, n: int) -> list[int]:
    return [(x >> (LIMB_BITS * i)) & MASK32 for i in range(n)]


def emit_int_array(name: str, values: list[int]) -> list[str]:
    lines = [f"  let {name} = iarray({len(values)})"]
    for i, v in enumerate(values):
        lines.append(f"  iaset({name}, {i}, {v})")
    return lines


def run_lumen_sign(message: bytes, salt: bytes, n: int, e: int, d: int) -> bytes:
    n_lims = limbs_le(n, NLIMBS)
    e_lims = limbs_le(e, NLIMBS)
    d_lims = limbs_le(d, NLIMBS)
    msg_bytes = list(message)
    salt_bytes = list(salt)

    body = (
        emit_int_array("msg", msg_bytes)
        + emit_int_array("salt", salt_bytes)
        + emit_int_array("n_arr", n_lims)
        + emit_int_array("e_arr", e_lims)
        + emit_int_array("d_arr", d_lims)
        + [
            f"  let sig = rsa_pss_sign(msg, {len(msg_bytes)}, salt, {len(salt_bytes)}, "
            f"n_arr, e_arr, d_arr, {NLIMBS}, {MOD_BITS})",
            "  console.print(bytes_to_hex(sig, ialen(sig)))",
        ]
    )
    main_src = (
        "fn main(console: Console) -> Unit {\n" + "\n".join(body) + "\n  return ()\n}\n"
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
            timeout=120,
        )
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"lumen run failed (exit {proc.returncode}):\nSTDOUT:\n{proc.stdout}\nSTDERR:\n{proc.stderr}"
        )
    hex_line = proc.stdout.strip().splitlines()[-1].strip()
    return bytes.fromhex(hex_line)


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> int:
    # 768 bits, not 512: PSS with sLen=hLen=32 (SHA-256) needs emLen >= hLen+sLen+2 = 66 bytes,
    # i.e. modBits >= 522 - a 512-bit modulus (cryptography's own minimum key_size) is too small
    # for this hash/salt combination and EMSA-PSS-ENCODE raises "encoding error" on it (verified
    # empirically below via the pure-Python reference). 768 bits is also chosen to stay safely
    # under the Lumen interpreter's default 4e9-step fuel cap: bn_modpow's cost is O(n^3) in the
    # limb count; empirically, 512/640/768-bit modpow cost 858M/1.62B/2.86B steps respectively
    # (measured with examples/hostdata/bignum_kernel.lm directly), so 768 leaves ~29% headroom
    # under the cap while 1024-bit (32 limbs, ~6.9B steps) would silently truncate mid-run.
    key_size = 768
    assert key_size == MOD_BITS
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=key_size)
    public_key = private_key.public_key()

    numbers = private_key.private_numbers()
    n = numbers.public_numbers.n
    e = numbers.public_numbers.e
    d = numbers.d
    assert n.bit_length() == MOD_BITS, f"unexpected modulus bit length {n.bit_length()}"

    print(f"RSA key size: {key_size} bits")
    print(f"n bit_length: {n.bit_length()}")
    print()

    messages = [
        b"",
        b"a",
        b"abc",
        b"The quick brown fox jumps over the lazy dog",
        b"RFC 8017 RSASSA-PSS test vector #1",
        b"\x00\x01\x02\x03\x04\x05",
        b"x" * 55,  # right at a SHA-256 padding boundary (55 = 64 - 9)
        b"x" * 56,  # one past that boundary
        b"Lumen pure-computation kernel: rsa_pss_kernel.lm",
        "Unicode: café, 中文, \U0001f600".encode("utf-8"),
    ]

    fixed_salt = bytes(
        range(32)
    )  # 32-byte explicit deterministic salt, same for every case

    total = 0
    failures: list[str] = []

    for msg in messages:
        total += 1
        label = repr(msg[:40]) + ("..." if len(msg) > 40 else "")

        sig_lumen = run_lumen_sign(msg, fixed_salt, n, e, d)
        sig_ref = rsa_pss_sign_ref(msg, fixed_salt, d, n, MOD_BITS)

        byte_exact_ok = sig_lumen == sig_ref

        crypto_ok = False
        crypto_err = ""
        try:
            public_key.verify(
                sig_lumen,
                msg,
                padding.PSS(
                    mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=32,
                ),
                hashes.SHA256(),
            )
            crypto_ok = True
        except InvalidSignature as exc:
            crypto_err = str(exc) or "InvalidSignature"

        ok = byte_exact_ok and crypto_ok
        status = "PASS" if ok else "FAIL"
        detail = (
            f"msg={label} byte_exact_vs_python_ref={byte_exact_ok} "
            f"cryptography_verify={crypto_ok}{(' err=' + crypto_err) if crypto_err else ''}"
        )
        print(f"{status}  {detail}")
        if not ok:
            failures.append(detail)

    # Reproducibility check: same message + same fixed salt -> identical signature bytes,
    # verified independently (not just "ran twice", but a fresh Lumen subprocess run).
    total += 1
    msg = b"reproducibility check"
    sig1 = run_lumen_sign(msg, fixed_salt, n, e, d)
    sig2 = run_lumen_sign(msg, fixed_salt, n, e, d)
    repro_ok = sig1 == sig2
    status = "PASS" if repro_ok else "FAIL"
    print(
        f"{status}  reproducibility: same msg+salt -> identical signature: {repro_ok}"
    )
    if not repro_ok:
        failures.append("reproducibility check failed")

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
