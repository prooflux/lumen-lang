#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Live-oracle verifier for json_kernel.lm.

For every document in the corpus:
  (a) parse with Python's json module -> ground truth Python value.
  (b) generate a Lumen main() that writes the document's UTF-8 bytes into the kernel's
      input buffer (the same "host writes bytes, kernel is the authority" seam as
      decide_kernel.lm/sha256_kernel.lm), calls json_parse + prints the token stream, then
      calls json_serialize + prints the re-serialized byte stream; run it through the real
      Lumen seed interpreter (`node seed/lumen.mjs run <file>`).
  (c) decode Lumen's token stream back into a Python value (walking the same recursive
      tag/len/payload grammar the kernel emits) and compare it structurally to (a).
  (d) decode Lumen's re-serialized byte stream into UTF-8 text, re-parse THAT with Python's
      json module, and compare the result to (a) as well - the parse -> serialize ->
      re-parse round trip.

Usage:
    uv run examples/hostdata/verify_json_kernel.py
"""

import json
import math
import random
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
KERNEL_PATH = Path(__file__).resolve().parent / "json_kernel.lm"
MAIN_MARKER = "fn main(console: Console) -> Unit {"
FLOAT_SCALE = 1_000_000_000.0
FLOAT_TOL = (
    1e-6  # relative tolerance: the kernel's own scale is 1e-9, this leaves margin
)


def kernel_prefix() -> str:
    """Everything in the kernel file up to (not including) the demo main()."""
    src = KERNEL_PATH.read_text()
    idx = src.index(MAIN_MARKER)
    return src[:idx]


def generate_main(doc_bytes: bytes) -> str:
    lines = [MAIN_MARKER]
    n = len(doc_bytes)
    for i, byte in enumerate(doc_bytes):
        lines.append(f"  store8(in_base() + {i}, {byte})")
    lines.append(f"  store32(in_len_addr(), {n})")
    cap = max(
        n * 4, 64
    )  # generous: token stream can exceed byte count (e.g. nested tags)
    lines.append(f"  let tok: Array = iarray({cap})")
    lines.append("  json_parse(tok)")
    lines.append("  print_tokens(console, tok)")
    lines.append(f"  let out: Array = iarray({cap})")
    lines.append("  json_serialize(tok, out)")
    lines.append("  print_bytes(console, out)")
    lines.append("  return ()")
    lines.append("}")
    return "\n".join(lines) + "\n"


def run_lumen(program_src: str) -> str:
    tmp_path = KERNEL_PATH.parent / "_gen_json_case.lm"
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
    return result.stdout


def parse_ints(stdout: str) -> list[int]:
    return [int(x) for x in stdout.split()]


def split_two_streams(nums: list[int]) -> tuple[list[int], list[int]]:
    """stdout is: <tok_count> <tok_count ints> <byte_count> <byte_count ints>"""
    tok_count = nums[0]
    toks = nums[1 : 1 + tok_count]
    rest = nums[1 + tok_count :]
    byte_count = rest[0]
    byts = rest[1 : 1 + byte_count]
    return toks, byts


def decode_tokens(toks: list[int], i: int):
    tag = toks[i]
    i += 1
    if tag == 0:
        return None, i
    if tag == 1:
        return True, i
    if tag == 2:
        return False, i
    if tag == 3:
        return toks[i], i + 1
    if tag == 4:
        scaled = toks[i]
        return scaled / FLOAT_SCALE, i + 1
    if tag == 5:
        length = toks[i]
        i += 1
        raw = bytes(b & 0xFF for b in toks[i : i + length])
        return raw.decode("utf-8"), i + length
    if tag == 6:
        n = toks[i]
        i += 1
        arr = []
        for _ in range(n):
            v, i = decode_tokens(toks, i)
            arr.append(v)
        return arr, i
    if tag == 7:
        n = toks[i]
        i += 1
        obj = {}
        for _ in range(n):
            k, i = decode_tokens(toks, i)
            v, i = decode_tokens(toks, i)
            obj[k] = v
        return obj, i
    raise ValueError(f"unknown tag {tag} at {i - 1}")


def values_equal(a, b) -> bool:
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, float) or isinstance(b, float):
        if not (isinstance(a, (int, float)) and isinstance(b, (int, float))):
            return False
        fa, fb = float(a), float(b)
        if fa == fb:
            return True
        denom = max(abs(fa), abs(fb), 1.0)
        return (
            math.isclose(fa, fb, rel_tol=FLOAT_TOL) or abs(fa - fb) / denom < FLOAT_TOL
        )
    if isinstance(a, int) and isinstance(b, int):
        return a == b
    if isinstance(a, dict) and isinstance(b, dict):
        if a.keys() != b.keys():
            return False
        return all(values_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(values_equal(x, y) for x, y in zip(a, b))
    return a == b


def check_one(label: str, doc, prefix: str) -> tuple[bool, str]:
    text = json.dumps(doc, ensure_ascii=False)
    doc_bytes = text.encode("utf-8")
    ground_truth = json.loads(
        text
    )  # re-parse so ground truth matches doc_bytes exactly

    program = prefix + generate_main(doc_bytes)
    stdout = run_lumen(program)
    nums = parse_ints(stdout)
    toks, byts = split_two_streams(nums)

    parsed, consumed = decode_tokens(toks, 0)
    parse_ok = consumed == len(toks) and values_equal(parsed, ground_truth)

    reserialized_text = bytes(b & 0xFF for b in byts).decode("utf-8")
    reparsed = json.loads(reserialized_text)
    roundtrip_ok = values_equal(reparsed, ground_truth)

    ok = parse_ok and roundtrip_ok
    status = "PASS" if ok else "FAIL"
    detail = f"{status}  {label:28s} parse_ok={parse_ok!s:5s} roundtrip_ok={roundtrip_ok!s:5s} len={len(doc_bytes):4d}"
    if not ok:
        detail += f"\n    doc={text!r}\n    parsed={parsed!r}\n    ground_truth={ground_truth!r}\n    reserialized={reserialized_text!r}"
    return ok, detail


def build_corpus() -> list[tuple[str, object]]:
    corpus: list[tuple[str, object]] = [
        ("scalar_int", 42),
        ("scalar_neg_int", -17),
        ("scalar_zero", 0),
        ("scalar_float", 3.14159),
        ("scalar_neg_float", -0.5),
        ("scalar_string", "hello world"),
        ("scalar_true", True),
        ("scalar_false", False),
        ("scalar_null", None),
        ("empty_object", {}),
        ("empty_array", []),
        ("empty_string", ""),
        ("array_of_ints", [1, 2, 3, -4, 5]),
        ("array_of_floats", [1.5, -2.25, 0.001, 1000.0]),
        ("array_mixed", [1, "two", 3.0, True, False, None]),
        ("nested_arrays", [[1, 2], [3, [4, 5, [6, 7]]], []]),
        ("simple_object", {"a": 1, "b": 2, "c": 3}),
        ("nested_object", {"outer": {"inner": {"deep": [1, 2, 3]}}}),
        ("object_with_array", {"items": [1, 2, 3], "count": 3}),
        (
            "object_array_of_objects",
            {"users": [{"id": 1, "name": "Alice"}, {"id": 2, "name": "Bob"}]},
        ),
        ("string_with_quote", 'he said "hi"'),
        ("string_with_backslash", "a\\b\\c"),
        ("string_with_newline_tab", "line1\nline2\ttabbed"),
        ("string_with_cr_bs_ff", "a\rb\bc\fd"),
        ("string_unicode_bmp", "café éè"),
        ("string_unicode_cjk", "中文测试"),
        ("string_unicode_escape_ascii_form", "unitABC"),
        ("string_emoji_surrogate_pair", "grin\U0001f600done"),
        ("string_mixed_escapes_and_unicode", 'quote:" back:\\ nl:\n uni:ü end'),
        (
            "rest_payload_user",
            {
                "id": 1001,
                "name": "Alice",
                "active": True,
                "balance": 1234.56,
                "tags": ["example", "lumen"],
            },
        ),
        (
            "rest_payload_error",
            {"error": {"code": 404, "message": "not found", "details": None}},
        ),
        (
            "rest_payload_list",
            {
                "page": 1,
                "per_page": 20,
                "total": 137,
                "items": [{"sku": "A1", "price": 9.99}, {"sku": "B2", "price": 19.5}],
            },
        ),
        ("deeply_nested", {"a": {"b": {"c": {"d": {"e": [1, [2, [3, [4, 5]]]]}}}}}),
        ("negative_zero_float", -0.0),
        ("large_int", 9007199254740992),
        (
            "float_exponent_pos",
            1.5e7,
        ),  # kept within the kernel's documented |value| < ~1e9 float-scale range
        ("float_exponent_neg", 2.5e-4),
        (
            "float_exponent_capital",
            6.022e23 / 1e23,
        ),  # keeps magnitude in-range; still exercises 'E'
        ("float_trailing_zero_frac", 2.50),
        ("array_of_bools", [True, False, True, True, False]),
        ("array_of_nulls", [None, None, None]),
        ("array_of_strings", ["alpha", "beta", "gamma", ""]),
        ("object_empty_values", {"a": {}, "b": [], "c": "", "d": 0, "e": None}),
        ("long_flat_array", list(range(-10, 10)) + [i / 2.0 for i in range(-5, 5)]),
        ("object_many_keys", {f"k{i}": i * i for i in range(15)}),
        ("string_all_control_escapes", "\b\f\n\r\t"),
        ("number_small_fraction", 0.000001),
        ("number_leading_minus_fraction", -0.125),
    ]
    # (b) fuzz: randomly generated nested JSON documents, deterministic seed.
    rng = random.Random(20260723)

    def rand_scalar():
        kind = rng.randrange(6)
        if kind == 0:
            return rng.randint(-100000, 100000)
        if kind == 1:
            return round(rng.uniform(-1000.0, 1000.0), 6)
        if kind == 2:
            return "".join(
                rng.choice('abcdefghij "\\\n\t') for _ in range(rng.randint(0, 8))
            )
        if kind == 3:
            return rng.choice([True, False])
        if kind == 4:
            return None
        return round(rng.uniform(-1.0, 1.0) * (10 ** rng.randint(-5, 5)), 9)

    def rand_value(depth):
        if depth <= 0 or rng.random() < 0.5:
            return rand_scalar()
        if rng.random() < 0.5:
            return [rand_value(depth - 1) for _ in range(rng.randint(0, 4))]
        return {f"f{i}": rand_value(depth - 1) for i in range(rng.randint(0, 4))}

    for i in range(20):
        corpus.append((f"fuzz_{i:03d}", rand_value(3)))

    return corpus


def main() -> int:
    prefix = kernel_prefix()
    corpus = build_corpus()
    results: list[tuple[bool, str]] = []
    for label, doc in corpus:
        try:
            results.append(check_one(label, doc, prefix))
        except Exception as exc:  # noqa: BLE001 - surface any failure as a FAIL row
            results.append((False, f"FAIL  {label:28s} EXCEPTION: {exc}"))

    for ok, detail in results:
        print(detail)

    n_pass = sum(1 for ok, _ in results if ok)
    n_total = len(results)
    print(f"\n{n_pass}/{n_total} cases passed")
    return 0 if n_pass == n_total else 1


if __name__ == "__main__":
    sys.exit(main())
